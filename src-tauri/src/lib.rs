use anyhow::Result;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

pub mod providers;
pub mod trust;
pub mod observability;
pub mod pty;

use providers::types::{AuthMode, NormalizedEvent, PermissionMode, SpawnOpts};
use providers::{build_provider, SessionHandle};

const KEYRING_SERVICE: &str = "unicrew";
const KEYRING_USER: &str = "anthropic-api-key";
const KEYRING_USER_OPENAI: &str = "openai-api-key";

// ---------- CLI インストールの多重起動ガード ----------
//
// 🚨 2026-08-22 追加。install_claude_code / install_codex は「裏で spawn して即 Ok を
// 返す」非同期コマンドなので、フロントが待たずにボタンを押せる状態へ戻ると連打できて
// しまう。連打すると `irm install.ps1 | iex` と `winget install` が同時に走り、winget の
// 一時フォルダが固定パス（%TEMP%\WinGet\<PackageId>.<ver>\）で並行実行に耐えないため
//   remove: The process cannot access the file because it is being used by another process
// で落ちる（実ユーザー環境で発生）。走行中の再入はここで弾く。
// フロント側のガード（ボタン disabled）と二重で持つ＝どちらかが壊れても事故らない。
static CLAUDE_INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);
static CODEX_INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);

/// 取得できた場合のみ生成され、drop 時に必ずフラグを戻す RAII ロック。
/// （途中の `?` で早期 return しても解放漏れが起きない）
struct InstallLock(&'static AtomicBool);

impl Drop for InstallLock {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

static GEMINI_INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);

/// ACP / OSS CLI は provider 単位でロックする（別 provider の同時インストールは許す）。
static ACP_INSTALL_RUNNING: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

struct AcpInstallLock(String);

impl Drop for AcpInstallLock {
    fn drop(&mut self) {
        if let Ok(mut set) = ACP_INSTALL_RUNNING.lock() {
            set.remove(&self.0);
        }
    }
}

fn try_acquire_acp_install_lock(provider: &str) -> Option<AcpInstallLock> {
    let mut set = ACP_INSTALL_RUNNING.lock().ok()?;
    if set.contains(provider) {
        return None;
    }
    set.insert(provider.to_string());
    Some(AcpInstallLock(provider.to_string()))
}

/// バイナリが「今この瞬間」起動できるかを確認する。**インストール完了の判定はこれで行う**。
///
/// 🚨 インストーラの終了コードだけを信じてはいけない。npm / winget が 0 で終わっても、
/// PATH に出ない場所へ入る・prefix が違う等で UNICREW からは見えないことがある。
/// その場合「成功しました」と出たのにステータスは「未インストール」のままになり、
/// ユーザーは何をすればいいか分からなくなる（実際に起きた詰みの型）。
async fn cli_is_available(bin: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        let _ = bin;
        resolve_on_path(bin).is_some()
    }
    #[cfg(not(target_os = "windows"))]
    {
        match build_silent_command(bin).arg("--version").output().await {
            Ok(_) => true,
            // NotFound 以外（--version 非対応で異常終了 等）は「在る」と扱う
            Err(e) => !matches!(e.kind(), std::io::ErrorKind::NotFound),
        }
    }
}

fn try_acquire_install_lock(flag: &'static AtomicBool) -> Option<InstallLock> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| InstallLock(flag))
}

// ---------- Keychain ----------

#[tauri::command]
fn get_api_key() -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    if key.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    let _ = entry.delete_credential();
    Ok(())
}

#[tauri::command]
fn get_openai_api_key() -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER_OPENAI).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_openai_api_key(key: String) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_USER_OPENAI).map_err(|e| e.to_string())?;
    if key.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(&key).map_err(|e| e.to_string())
}

/// 録音音声を OpenAI Whisper API に送って書き起こす。
///
/// renderer から渡される base64 を bytes に戻し、`/v1/audio/transcriptions` に
/// multipart で投げる。失敗時はユーザー向けのわかりやすい日本語エラーを返す。
#[tauri::command]
async fn transcribe_audio(audio_base64: String, mime: String) -> Result<String, String> {
    use base64::Engine;
    let key = match Entry::new(KEYRING_SERVICE, KEYRING_USER_OPENAI)
        .map_err(|e| e.to_string())?
        .get_password()
    {
        Ok(k) => k,
        Err(_) => {
            return Err(
                "OpenAI API キーが未設定です。設定 → 接続 → 音声入力 から登録してください。"
                    .into(),
            )
        }
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| format!("音声データの復元に失敗: {}", e))?;
    let ext = match mime.as_str() {
        "audio/webm" | "audio/webm;codecs=opus" => "webm",
        "audio/ogg" | "audio/ogg;codecs=opus" => "ogg",
        "audio/mp4" => "mp4",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        _ => "webm",
    };
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("audio.{}", ext))
        .mime_str(if mime.is_empty() { "audio/webm" } else { mime.as_str() })
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("model", "whisper-1")
        .text("language", "ja")
        .text("response_format", "json")
        .part("file", part);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(&key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("OpenAI へのリクエスト失敗: {}", e))?;
    let status = resp.status();
    let body_text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("OpenAI API エラー ({}): {}", status, body_text));
    }
    let v: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("OpenAI 応答のパース失敗: {} body={}", e, body_text))?;
    let text = v
        .get("text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(text)
}

// ---------- Avatar image handling ----------

#[tauri::command]
async fn save_avatar_image(app: AppHandle, source_path: String) -> Result<String, String> {
    use std::path::Path;
    let src = Path::new(&source_path);
    if !src.exists() {
        return Err(format!("ファイルが見つかりません: {}", source_path));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif", "svg"].contains(&ext.as_str()) {
        return Err("対応していない画像形式です（png/jpg/webp/gif/svg のみ）".into());
    }
    let dest_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("avatars");
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| e.to_string())?;

    // 一意なファイル名（タイムスタンプ + 元ファイル名）
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("avatar");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dest_dir.join(format!("{}-{}.{}", stem, ts, ext));
    tokio::fs::copy(src, &dest)
        .await
        .map_err(|e| format!("コピー失敗: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Drag&Drop で webview に落とされた画像のバイト列をそのまま AppData/avatars/ に保存する。
///
/// `pickAndSaveAvatar` が `dialog.open` で取得した OS パスを受け取る経路なのに対し、
/// こちらは「OS パスを取れない（webview File API 経由）」ケースのために用意する。
/// 呼び出し側で File.arrayBuffer() → Uint8Array → btoa して bytes_b64 に詰める。
#[tauri::command]
async fn save_avatar_bytes(
    app: AppHandle,
    bytes_b64: String,
    ext: String,
) -> Result<String, String> {
    use base64::Engine;
    let ext = ext.to_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif", "svg"].contains(&ext.as_str()) {
        return Err("対応していない画像形式です（png/jpg/webp/gif/svg のみ）".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&bytes_b64)
        .map_err(|e| format!("base64 デコード失敗: {}", e))?;
    if bytes.is_empty() {
        return Err("空のファイルです".into());
    }
    // 上限 10MB（プロフィール用としては十分。誤って巨大ファイルを掴まないように）
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("ファイルサイズが大きすぎます（10MB 以下にしてください）".into());
    }
    let dest_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("avatars");
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dest_dir.join(format!("dropped-{}.{}", ts, ext));
    tokio::fs::write(&dest, &bytes)
        .await
        .map_err(|e| format!("書き込み失敗: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_avatar_image(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        let _ = tokio::fs::remove_file(&p).await;
    }
    Ok(())
}

/// ローカル画像を読み込んで base64 data URL を返す。
/// Tauri 2 の asset protocol を設定せずに renderer で表示できるようにする最簡パターン。
#[tauri::command]
async fn read_image_as_data_url(path: String) -> Result<String, String> {
    use base64::Engine;
    let path = expand_user_path(&path);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("画像の読み込みに失敗: {}", e))?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

// ---------- Addons (plugins / skills / MCP) ----------
//
// 設計方針:
//  - 重い処理（インストール・marketplace 取得）は公式 CLI に委譲し、UNICREW は **設定ファイルの
//    読み書き＋表示** のみを担う薄い層にする。
//  - SDK 側は既に `settingSources: ["user", "project"]` を渡しているため、~/.claude/skills や
//    ~/.claude.json の mcpServers は次回起動時に自動で拾われる。
//  - 4種を統一スキーマで扱い、フロントの 1 コンポーネントで描画できるようにする。

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AddonItem {
    pub id: String,
    pub name: String,
    pub namespace: Option<String>,
    pub version: Option<String>,
    pub enabled: bool,
    pub scope: String,
    pub description: Option<String>,
    pub kind: String,
    pub source: String,
    pub path: Option<String>,
    pub category: Option<String>,
    pub author: Option<String>,
    /// 説明ページ（plugin.json の homepage / repository）。UIの「くわしく」リンク用。
    pub homepage: Option<String>,
}

fn home_dir() -> Result<std::path::PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "ホームディレクトリが取得できません".to_string())
}

/// AI 応答やファイルツリーから渡されるパス文字列を実ファイルパスへ正規化する。
/// - 前後の空白／囲みクォートを除去
/// - 先頭 `~` / `~/` / `~\` をホームディレクトリへ展開
/// `~/.claude/...` のようなパスのクリックで os error 3 になる問題を防ぐ。
/// パス文字列の %XX を UTF-8 として復元する純粋関数（ベストエフォート）。
/// 例: 全角括弧 （ ） が %EF%BC%88 のまま来ても解決できるようにする。
fn percent_decode_utf8(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = (bytes[i + 1] as char).to_digit(16);
            let l = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    match String::from_utf8(out) {
        Ok(decoded) => decoded,
        Err(_) => input.to_string(),
    }
}

fn expand_user_path(input: &str) -> std::path::PathBuf {
    let mut s = input.trim();
    if s.len() >= 2
        && ((s.starts_with('"') && s.ends_with('"'))
            || (s.starts_with('\'') && s.ends_with('\'')))
    {
        s = &s[1..s.len() - 1];
    }
    // %XX が残っていれば復元（どの入口でも全角括弧パス等を解決できるように）。
    let decoded_holder;
    let s: &str = if s.contains('%') {
        decoded_holder = percent_decode_utf8(s);
        &decoded_holder
    } else {
        s
    };
    if s == "~" {
        if let Some(h) = dirs::home_dir() {
            return h;
        }
    }
    if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        if let Some(h) = dirs::home_dir() {
            return h.join(rest);
        }
    }
    // WSL パス /mnt/<drive>/... を Windows パス <DRIVE>:\... に変換する。
    // Codex は WSL 上で動くため成果物のパスを /mnt/d/... 形式で返すことがあり、
    // そのままだと Windows 側の fs が読めない（forbidden path / not found）。
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = s.strip_prefix("/mnt/") {
            let mut it = rest.chars();
            if let Some(drive) = it.next() {
                let after = it.as_str();
                if drive.is_ascii_alphabetic() && (after.is_empty() || after.starts_with('/')) {
                    let win = format!(
                        "{}:{}",
                        drive.to_ascii_uppercase(),
                        after.replace('/', "\\")
                    );
                    return std::path::PathBuf::from(win);
                }
            }
        }
    }
    std::path::PathBuf::from(s)
}

fn read_json_file(path: &std::path::Path) -> Option<serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
}

#[tauri::command]
fn list_claude_plugins() -> Result<Vec<AddonItem>, String> {
    let home = home_dir()?;
    let installed_path = home.join(".claude").join("plugins").join("installed_plugins.json");
    let claude_json_path = home.join(".claude.json");

    let installed = read_json_file(&installed_path);
    let claude_json = read_json_file(&claude_json_path);

    let mut out: Vec<AddonItem> = Vec::new();

    if let Some(v) = installed {
        if let Some(plugins) = v.get("plugins").and_then(|p| p.as_object()) {
            for (key, entries) in plugins {
                let (name, namespace) = match key.split_once('@') {
                    Some((n, ns)) => (n.to_string(), Some(ns.to_string())),
                    None => (key.to_string(), None),
                };
                if let Some(arr) = entries.as_array() {
                    for entry in arr {
                        let scope = entry
                            .get("scope")
                            .and_then(|s| s.as_str())
                            .unwrap_or("user")
                            .to_string();
                        let version = entry
                            .get("version")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        let path = entry
                            .get("installPath")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        let enabled = claude_json
                            .as_ref()
                            .and_then(|c| c.get("disabledPlugins"))
                            .and_then(|d| d.as_array())
                            .map(|arr| !arr.iter().any(|x| x.as_str() == Some(key.as_str())))
                            .unwrap_or(true);
                        out.push(AddonItem {
                            id: key.clone(),
                            name: name.clone(),
                            namespace: namespace.clone(),
                            version,
                            enabled,
                            scope,
                            description: None,
                            kind: "plugin".into(),
                            source: "claude".into(),
                            path,
                            category: None,
                            author: None,
                            homepage: None,
                        });
                    }
                }
            }
        }
    }
    Ok(out)
}

fn parse_skill_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return (None, None);
    }
    let after_first = &trimmed[3..];
    let end = match after_first.find("\n---") {
        Some(i) => i,
        None => return (None, None),
    };
    let block = &after_first[..end];
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    for line in block.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("name:") {
            name = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
        } else if let Some(rest) = line.strip_prefix("description:") {
            description = Some(rest.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    (name, description)
}

fn collect_skills_from(dir: &std::path::Path, scope: &str, source: &str) -> Vec<AddonItem> {
    let mut out: Vec<AddonItem> = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let folder_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let text = std::fs::read_to_string(&skill_md).unwrap_or_default();
        let (name, description) = parse_skill_frontmatter(&text);
        out.push(AddonItem {
            id: format!("{}::{}", source, folder_name),
            name: name.unwrap_or(folder_name.clone()),
            namespace: Some(scope.to_string()),
            version: None,
            enabled: true,
            scope: scope.to_string(),
            description,
            kind: "skill".into(),
            source: source.to_string(),
            path: Some(path.to_string_lossy().to_string()),
            category: Some("skill".into()),
            author: None,
            homepage: None,
        });
    }
    out
}

#[tauri::command]
fn list_claude_skills(workspace: Option<String>) -> Result<Vec<AddonItem>, String> {
    let home = home_dir()?;
    let mut out = collect_skills_from(&home.join(".claude").join("skills"), "user", "claude");
    if let Some(ws) = workspace {
        let ws_path = std::path::PathBuf::from(ws).join(".claude").join("skills");
        out.extend(collect_skills_from(&ws_path, "project", "claude"));
    }
    Ok(out)
}

#[tauri::command]
fn list_claude_mcp() -> Result<Vec<AddonItem>, String> {
    let home = home_dir()?;
    let claude_json_path = home.join(".claude.json");
    let v = match read_json_file(&claude_json_path) {
        Some(v) => v,
        None => return Ok(Vec::new()),
    };
    let servers = match v.get("mcpServers").and_then(|s| s.as_object()) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let enabled_list: Vec<String> = v
        .get("enabledMcpjsonServers")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let disabled_list: Vec<String> = v
        .get("disabledMcpjsonServers")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let mut out: Vec<AddonItem> = Vec::new();
    for (name, cfg) in servers {
        let kind_str = cfg
            .get("type")
            .and_then(|s| s.as_str())
            .unwrap_or("stdio")
            .to_string();
        let cmd = cfg
            .get("command")
            .and_then(|s| s.as_str())
            .or_else(|| cfg.get("url").and_then(|s| s.as_str()))
            .unwrap_or("")
            .to_string();
        let enabled = if !enabled_list.is_empty() {
            enabled_list.iter().any(|x| x == name)
        } else {
            !disabled_list.iter().any(|x| x == name)
        };
        out.push(AddonItem {
            id: name.clone(),
            name: name.clone(),
            namespace: Some(kind_str),
            version: None,
            enabled,
            scope: "user".into(),
            description: Some(cmd),
            kind: "mcp".into(),
            source: "claude".into(),
            path: None,
            category: Some("mcp".into()),
            author: None,
            homepage: None,
        });
    }
    Ok(out)
}

fn read_codex_config() -> Option<toml::Value> {
    let home = home_dir().ok()?;
    let path = home.join(".codex").join("config.toml");
    let text = std::fs::read_to_string(&path).ok()?;
    text.parse::<toml::Value>().ok()
}

#[tauri::command]
fn list_codex_plugins() -> Result<Vec<AddonItem>, String> {
    let cfg = match read_codex_config() {
        Some(c) => c,
        None => return Ok(Vec::new()),
    };
    let mut out: Vec<AddonItem> = Vec::new();
    if let Some(plugins) = cfg.get("plugins").and_then(|p| p.as_table()) {
        for (key, val) in plugins {
            let (name, namespace) = match key.split_once('@') {
                Some((n, ns)) => (n.to_string(), Some(ns.to_string())),
                None => (key.to_string(), None),
            };
            let enabled = val
                .get("enabled")
                .and_then(|x| x.as_bool())
                .unwrap_or(true);
            out.push(AddonItem {
                id: key.clone(),
                name,
                namespace,
                version: None,
                enabled,
                scope: "user".into(),
                description: None,
                kind: "plugin".into(),
                source: "codex".into(),
                path: None,
                category: None,
                author: None,
                homepage: None,
            });
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct McpAddRequest {
    pub name: String,
    /// "stdio" | "sse" | "http"
    pub kind: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub env: Option<HashMap<String, String>>,
    /// http/sse タイプ用の HTTP ヘッダ（Bearer 認証等）。Claude Code が
    /// `headers` キーを公式サポートするため、UNI製品の認証に必須。
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
}

/// ~/.claude.json の `mcpServers` に新規 MCP サーバーを追加（同名は上書き）。
#[tauri::command]
fn add_claude_mcp(req: McpAddRequest) -> Result<(), String> {
    let home = home_dir()?;
    let path = home.join(".claude.json");
    let mut v: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string())?,
        Err(_) => serde_json::json!({}),
    };
    if !v.is_object() {
        v = serde_json::json!({});
    }
    let obj = v.as_object_mut().unwrap();
    if !obj.contains_key("mcpServers")
        || !obj.get("mcpServers").map(|x| x.is_object()).unwrap_or(false)
    {
        obj.insert("mcpServers".into(), serde_json::json!({}));
    }
    let servers = obj.get_mut("mcpServers").unwrap().as_object_mut().unwrap();
    let mut entry = serde_json::Map::new();
    match req.kind.as_str() {
        "stdio" => {
            let cmd = req
                .command
                .ok_or_else(|| "stdio タイプには command が必要です".to_string())?;
            entry.insert("type".into(), serde_json::Value::String("stdio".into()));
            entry.insert("command".into(), serde_json::Value::String(cmd));
            if let Some(args) = req.args {
                entry.insert(
                    "args".into(),
                    serde_json::Value::Array(
                        args.into_iter().map(serde_json::Value::String).collect(),
                    ),
                );
            }
        }
        "sse" | "http" => {
            let url = req
                .url
                .ok_or_else(|| "sse/http タイプには url が必要です".to_string())?;
            entry.insert("type".into(), serde_json::Value::String(req.kind.clone()));
            entry.insert("url".into(), serde_json::Value::String(url));
        }
        _ => return Err(format!("未対応の MCP タイプ: {}", req.kind)),
    }
    if let Some(env) = req.env {
        let mut env_obj = serde_json::Map::new();
        for (k, val) in env {
            env_obj.insert(k, serde_json::Value::String(val));
        }
        entry.insert("env".into(), serde_json::Value::Object(env_obj));
    }
    if let Some(headers) = req.headers {
        let mut h = serde_json::Map::new();
        for (k, val) in headers {
            h.insert(k, serde_json::Value::String(val));
        }
        entry.insert("headers".into(), serde_json::Value::Object(h));
    }
    servers.insert(req.name, serde_json::Value::Object(entry));
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    write_json_atomic(&path, &pretty)?;
    Ok(())
}

#[tauri::command]
fn remove_claude_mcp(name: String) -> Result<(), String> {
    let home = home_dir()?;
    let path = home.join(".claude.json");
    let mut v: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string())?,
        Err(_) => return Ok(()),
    };
    if let Some(obj) = v.as_object_mut() {
        if let Some(servers) = obj.get_mut("mcpServers").and_then(|x| x.as_object_mut()) {
            servers.remove(&name);
        }
        // 各種 enabled/disabled リストからも除去
        for key in ["enabledMcpjsonServers", "disabledMcpjsonServers"] {
            if let Some(arr) = obj.get_mut(key).and_then(|x| x.as_array_mut()) {
                arr.retain(|x| x.as_str() != Some(&name));
            }
        }
    }
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    write_json_atomic(&path, &pretty)?;
    Ok(())
}

// ---------- Codex MCP 1-click ----------
//
// Codex CLI の `codex mcp add/remove/list` サブコマンドを spawn する。
// Claude 側と違い、Codex は config.toml ベースで管理されるため、
// CLI 経由で操作するのが正規ルート（直接 toml を書き換えるよりも安全）。

/// `~/.codex/config.toml` の `[mcp_servers]` セクションを AddonItem 配列として返す。
#[tauri::command]
fn list_codex_mcp() -> Result<Vec<AddonItem>, String> {
    let cfg = match read_codex_config() {
        Some(c) => c,
        None => return Ok(Vec::new()),
    };
    let mut out: Vec<AddonItem> = Vec::new();
    if let Some(servers) = cfg.get("mcp_servers").and_then(|p| p.as_table()) {
        for (name, val) in servers {
            // Codex の MCP は基本「設定があれば有効」なので enabled=true 既定。
            // UNICREW 側で擬似的にトグルしたい場合は別途 "_unicrew_disabled = true" を立てる。
            let unicrew_disabled = val
                .get("_unicrew_disabled")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let kind = if val.get("url").is_some() { "http" } else { "stdio" };
            let description = val
                .get("description")
                .and_then(|x| x.as_str())
                .map(String::from)
                .or_else(|| Some(format!("{} MCP server", kind)));
            out.push(AddonItem {
                id: name.clone(),
                name: name.clone(),
                namespace: None,
                version: None,
                enabled: !unicrew_disabled,
                scope: "user".into(),
                description,
                kind: "mcp".into(),
                source: "codex".into(),
                path: None,
                category: None,
                author: None,
                homepage: None,
            });
        }
    }
    Ok(out)
}

/// `codex mcp add` を spawn して MCP サーバを登録。
/// stdio: `codex mcp add <NAME> [--env KEY=VAL ...] -- <COMMAND> [ARGS...]`
/// http : `codex mcp add <NAME> --url <URL>`
#[tauri::command]
async fn add_codex_mcp(req: McpAddRequest) -> Result<String, String> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err("MCP 名が空です".into());
    }

    let mut cmd = build_silent_command("codex");
    cmd.arg("mcp").arg("add").arg(name);

    match req.kind.as_str() {
        "stdio" => {
            let command = req
                .command
                .ok_or_else(|| "stdio タイプには command が必要です".to_string())?;
            // env 変数
            if let Some(env_map) = &req.env {
                for (k, v) in env_map {
                    cmd.arg("--env").arg(format!("{}={}", k, v));
                }
            }
            cmd.arg("--");
            cmd.arg(&command);
            if let Some(args) = req.args {
                for a in args {
                    cmd.arg(a);
                }
            }
        }
        "sse" | "http" => {
            let url = req
                .url
                .ok_or_else(|| "http/sse タイプには url が必要です".to_string())?;
            cmd.arg("--url").arg(url);
        }
        _ => return Err(format!("未対応の MCP タイプ: {}", req.kind)),
    }

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("codex CLI 起動に失敗: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "codex mcp add 失敗（終了コード {:?}）: {}",
            out.status.code(),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(stdout)
}

/// `codex mcp remove <NAME>` を spawn して MCP サーバを削除。
#[tauri::command]
async fn remove_codex_mcp(name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("MCP 名が空です".into());
    }
    let mut cmd = build_silent_command("codex");
    cmd.arg("mcp").arg("remove").arg(name);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("codex CLI 起動に失敗: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "codex mcp remove 失敗（終了コード {:?}）: {}",
            out.status.code(),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(stdout)
}

/// Codex MCP サーバの有効/無効を擬似的にトグル。
///
/// Codex CLI には標準の有効/無効切替コマンドが無いため、`~/.codex/config.toml`
/// の該当セクションに `_unicrew_disabled = true/false` を立てる UNICREW 独自運用。
/// 実際に無効化したい場合は `remove_codex_mcp` で削除を推奨。これは UI 表示用。
#[tauri::command]
fn toggle_codex_mcp(name: String, enabled: bool) -> Result<(), String> {
    let home = home_dir()?;
    let path = home.join(".codex").join("config.toml");
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!("~/.codex/config.toml が読み込めません: {}", e)
    })?;
    let mut doc: toml::Value = text
        .parse()
        .map_err(|e| format!("config.toml パース失敗: {}", e))?;

    let servers = doc
        .as_table_mut()
        .and_then(|t| t.get_mut("mcp_servers"))
        .and_then(|s| s.as_table_mut())
        .ok_or_else(|| "mcp_servers セクションがありません".to_string())?;

    let server = servers
        .get_mut(&name)
        .and_then(|s| s.as_table_mut())
        .ok_or_else(|| format!("MCP サーバ '{}' が見つかりません", name))?;

    if enabled {
        server.remove("_unicrew_disabled");
    } else {
        server.insert(
            "_unicrew_disabled".into(),
            toml::Value::Boolean(true),
        );
    }

    let serialized = toml::to_string_pretty(&doc)
        .map_err(|e| format!("config.toml シリアライズ失敗: {}", e))?;
    std::fs::write(&path, serialized).map_err(|e| {
        format!("~/.codex/config.toml 書き込み失敗: {}", e)
    })?;
    Ok(())
}

/// JSON を atomic に書き込む（監査R2）。同一ディレクトリの一時ファイルへ全量書き→
/// flush→rename で置換する。書き込み途中失敗で既存ファイルが空/半端になるのを防ぐ。
fn write_json_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| "書き込み先の親ディレクトリが不明です".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
        let _ = f.sync_all();
    }
    // Windows は既存ファイルがあると rename が失敗するため、成功優先で置換する
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = std::fs::remove_file(path);
            std::fs::rename(&tmp, path).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                e.to_string()
            })
        }
    }
}

// ---------- プラグイン/マーケットプレイス入力の検証（2026-08-27 監査） ----------
//
// build_silent_command は Command::new+.arg なので OS シェル注入は起きないが、
// (a) id は `claude plugin install <id>` の引数として渡す（2026-08-28 に --print
//     文字列埋め込みを廃止）。引数分離でも改行・制御文字は CLI 側の解釈事故に
//     なりうるため、検証は引き続き行う（Codex 監査 HIGH の再発防止）。
// (b) marketplace の id を `marketplaces/<id>` に join するため、`..` やパス区切り・
//     絶対パスで clone 先が想定外の場所に化ける（Path::join は `..` を正規化せず、
//     絶対パスは base を丸ごと置換することを実測。両系統一致 HIGH）。
// いずれも入力を厳格に検証して弾く。

/// Claude プラグイン ID の形式検証。
/// 実形式 `plugin@marketplace` を想定し、英数と `. _ - @ /` のみ許可。
/// 空白・改行・制御文字・クォート・その他記号を拒否する。
fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("プラグイン ID が空です".into());
    }
    if id.len() > 200 {
        return Err("プラグイン ID が長すぎます".into());
    }
    let ok = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | '/'));
    if !ok {
        return Err(format!(
            "プラグイン ID に使えない文字が含まれています（許可: 英数字 . _ - @ /）: {:?}",
            id
        ));
    }
    Ok(())
}

/// マーケットプレイス ID（= ディレクトリ名）の検証。単一パスセグメントに限定する。
/// `.` / `..` / パス区切り / ドライブレター / 制御文字を拒否する。
fn validate_marketplace_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("marketplace ID が空です".into());
    }
    if id.len() > 100 {
        return Err("marketplace ID が長すぎます".into());
    }
    if id == "." || id == ".." {
        return Err("marketplace ID にその値は使えません".into());
    }
    let ok = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok {
        return Err(format!(
            "marketplace ID に使えない文字が含まれています（許可: 英数字 . _ -。パス区切り不可）: {:?}",
            id
        ));
    }
    Ok(())
}

/// GitHub repo の `owner/name` 形式の検証。
/// 先頭 `-`（git オプション誤認）・空白・別 URL・`@` 等を弾く。
fn validate_github_repo(repo: &str) -> Result<(), String> {
    if repo.is_empty() {
        return Err("GitHub repo が空です".into());
    }
    if repo.len() > 200 {
        return Err("GitHub repo が長すぎます".into());
    }
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("GitHub repo は owner/name の形式で指定してください".into());
    }
    for seg in parts {
        if seg == "." || seg == ".." || seg.starts_with('-') {
            return Err("GitHub repo の各要素が不正です".into());
        }
        let ok = seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !ok {
            return Err(format!(
                "GitHub repo に使えない文字が含まれています（許可: 英数字 . _ -）: {:?}",
                repo
            ));
        }
    }
    Ok(())
}

/// `claude plugin <subcommand> <id>` を実行する共通処理。
///
/// 🚨【2026-08-28 根治】旧実装は `claude --print "/plugin install <id>"` だった。
/// `--print` はヘッドレスの1回対話であり、スラッシュコマンドは実行されず
/// **モデルが文章で返答して exit=0 で終わるだけ**（実測）。そのため
/// 「くるくる→成功トースト→でも一覧に出ない（何も入っていない）」という
/// ユーザー報告の直接原因になっていた。本物のサブコマンド
/// `claude plugin install|uninstall|update` を使う。
///
/// 実測（2026-08-28・パイプ無しで計測）: 失敗時は exit=1 を正しく返す。
/// 念のため出力の失敗マーカー「✘」も補助判定に使う（成功出力には出ない）。
/// ※当初「exit=0 で偽成功」と観測したのは `| head` 越しに測った誤り（head の
///   終了コードを拾っていた）。
async fn run_claude_plugin_cmd(subcommand: &str, id: &str) -> Result<String, String> {
    let mut cmd = build_silent_command("claude");
    cmd.arg("plugin")
        .arg(subcommand)
        .arg(id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("claude CLI を起動できませんでした: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{}\n{}", stdout.trim(), stderr.trim());
    let failed_marker = combined.contains('✘');
    if !output.status.success() || failed_marker {
        return Err(format!(
            "claude plugin {} が失敗しました（exit={}）\n{}",
            subcommand,
            output.status.code().unwrap_or(-1),
            combined.trim()
        ));
    }
    Ok(stdout)
}

/// `claude plugin marketplace update <id>` を実行する（install 失敗時の自動復旧用）。
async fn run_claude_marketplace_update(marketplace_id: &str) -> Result<String, String> {
    let mut cmd = build_silent_command("claude");
    cmd.arg("plugin")
        .arg("marketplace")
        .arg("update")
        .arg(marketplace_id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("claude CLI を起動できませんでした: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "marketplace update が失敗しました（exit={}）\n{}\n{}",
            output.status.code().unwrap_or(-1),
            stdout.trim(),
            stderr.trim()
        ));
    }
    Ok(stdout)
}

/// claude CLI 経由でプラグインをインストール。
/// 内部で `claude plugin install <id>` を CREATE_NO_WINDOW で spawn。
/// 成功時は stdout テキストを返す（呼び出し側でログ表示用）。
///
/// 🚨【2026-08-28】「not found in marketplace」で失敗したら、marketplace を
/// 更新して1回だけ再試行する。実測: ローカルのマーケットプレイスのコピーが
/// 古いと、一覧には出るのに install できないプラグインが生まれる
/// （例: security-review は上流で security-guidance に置き換わっており、
/// 古いローカルコピーにだけ残っていた）。CLI のエラー文自身が
/// 「try claude plugin marketplace update」と案内している操作を自動化した。
#[tauri::command]
async fn install_claude_plugin(id: String) -> Result<String, String> {
    let id_trim = id.trim();
    validate_plugin_id(id_trim)?;
    match run_claude_plugin_cmd("install", id_trim).await {
        Ok(out) => Ok(out),
        Err(first_err) => {
            // 大小文字差に強くする（監査MED 2026-08-28）
            let stale = first_err.to_lowercase().contains("not found in marketplace");
            let mp = id_trim.split_once('@').map(|(_, m)| m);
            if stale {
                if let Some(mp) = mp {
                    if validate_marketplace_id(mp).is_ok() {
                        // update の失敗は握りつぶさず、最終エラーに併記する（監査MED）。
                        // 「更新して再試行したが無かった」と「更新自体に失敗した」は別の病気。
                        let update_result = run_claude_marketplace_update(mp).await;
                        return run_claude_plugin_cmd("install", id_trim).await.map_err(|e| {
                            match &update_result {
                                Ok(_) => format!(
                                    "{}
（マーケットプレイス {} を更新して再試行しても見つかりませんでした。このプラグインは提供終了か改名の可能性があります。「再読み込み」を押すと一覧が最新になります）",
                                    e, mp
                                ),
                                Err(update_err) => format!(
                                    "{}
（マーケットプレイス {} の更新にも失敗したため、一覧が古いままの可能性があります: {}）",
                                    e, mp, update_err
                                ),
                            }
                        });
                    }
                }
            }
            Err(first_err)
        }
    }
}

/// claude CLI 経由でプラグインをアンインストール。
/// 失敗時は installed_plugins.json を直接編集してフォールバック削除。
#[tauri::command]
async fn uninstall_claude_plugin(id: String) -> Result<String, String> {
    let id_trim = id.trim().to_string();
    validate_plugin_id(&id_trim)?;
    // 本物のサブコマンド `claude plugin uninstall` を使う（2026-08-28 根治。
    // 旧 `--print "/plugin uninstall"` はモデルへの文章になるだけで実行されず、
    // exit=0 の偽成功で early return し、フォールバック削除にも到達しなかった）。
    // 監査R3: CLI 失敗の原因（起動失敗/exit/stderr）を保持し、フォールバックも
    // 失敗したときのエラーに併記する（"claude 不在" 等の本当の原因を失わない）。
    let cli_reason: String;
    match run_claude_plugin_cmd("uninstall", &id_trim).await {
        Ok(stdout) => return Ok(stdout),
        Err(e) => {
            cli_reason = e;
        }
    }
    // フォールバック: installed_plugins.json から直接除去
    let home = home_dir()?;
    let path = home
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    if !path.exists() {
        return Err(format!(
            "アンインストールに失敗しました。{}／さらに {} も存在しません",
            cli_reason,
            path.display()
        ));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut removed = false;
    if let Some(plugins) = v.get_mut("plugins").and_then(|x| x.as_object_mut()) {
        if plugins.remove(&id_trim).is_some() {
            removed = true;
        }
    }
    if !removed {
        return Err(format!(
            "アンインストールに失敗しました。{}／プラグイン '{}' は installed_plugins.json にも見つかりませんでした",
            cli_reason, id_trim
        ));
    }
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    write_json_atomic(&path, &pretty)?;
    Ok(format!(
        "プラグイン '{}' を installed_plugins.json から削除しました（CLI 経由は不可だったためファイル直編集）",
        id_trim
    ))
}

/// `codex plugin <add|remove> <id>` を実行する共通処理。
///
/// 実測（2026-08-28・codex v0.147）: `codex plugin add/remove` が公式に実在し、
/// `PLUGIN@MARKETPLACE` 形式を受け付ける。失敗時は exit=1 を正しく返す
/// （存在しないプラグインで「Error: plugin ... was not found」＋ exit=1 を確認）。
/// ※以前コード内に書かれていた「Codex CLI には install 相当が無い」は旧版の話。
async fn run_codex_plugin_cmd(subcommand: &str, id: &str) -> Result<String, String> {
    let mut cmd = build_silent_command("codex");
    cmd.arg("plugin")
        .arg(subcommand)
        .arg(id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("codex CLI を起動できませんでした: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "codex plugin {} が失敗しました（exit={}）\n{}\n{}",
            subcommand,
            output.status.code().unwrap_or(-1),
            stdout.trim(),
            stderr.trim()
        ));
    }
    Ok(stdout)
}

/// codex CLI 経由でプラグインをインストール（`codex plugin add <id>`）。
#[tauri::command]
async fn install_codex_plugin(id: String) -> Result<String, String> {
    let id_trim = id.trim();
    validate_plugin_id(id_trim)?;
    run_codex_plugin_cmd("add", id_trim).await
}

/// codex CLI 経由でプラグインを削除（`codex plugin remove <id>`）。
#[tauri::command]
async fn uninstall_codex_plugin(id: String) -> Result<String, String> {
    let id_trim = id.trim();
    validate_plugin_id(id_trim)?;
    run_codex_plugin_cmd("remove", id_trim).await
}

/// 任意 marketplace（GitHub repo）を known_marketplaces.json に登録 + git clone。
/// 上級者モード専用。
#[tauri::command]
async fn add_claude_marketplace(id: String, repo: String) -> Result<String, String> {
    let id_t = id.trim().to_string();
    let repo_t = repo.trim().to_string();
    validate_marketplace_id(&id_t)?;
    validate_github_repo(&repo_t)?;
    let home = home_dir()?;
    let marketplaces_root = home.join(".claude").join("plugins").join("marketplaces");
    let mp_dir = marketplaces_root.join(&id_t);
    // 二重の防御（監査）: 検証を通っても、join 結果が marketplaces 直下の
    // 単一セグメントであることを最終確認する（正規化してルート配下を保証）。
    if mp_dir.parent() != Some(marketplaces_root.as_path()) {
        return Err("marketplace ID が不正です（marketplaces 直下以外は不可）".into());
    }
    let known_path = home
        .join(".claude")
        .join("plugins")
        .join("known_marketplaces.json");

    // 既存ディレクトリが「壊れたclone残骸」（.git が無い）なら掃除して clone し直す（監査R2）。
    let looks_valid = mp_dir.exists() && mp_dir.join(".git").exists();
    if mp_dir.exists() && !looks_valid {
        std::fs::remove_dir_all(&mp_dir)
            .map_err(|e| format!("壊れた marketplace ディレクトリの削除に失敗: {}", e))?;
    }
    if !mp_dir.join(".git").exists() {
        // 一時ディレクトリへ clone → 成功したら rename（監査R2: 途中失敗の残骸を残さない）。
        let tmp_dir = marketplaces_root.join(format!(".{}.cloning", id_t));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let mut cmd = build_silent_command("git");
        cmd.arg("clone")
            .arg("--")
            .arg(format!("https://github.com/{}.git", repo_t))
            .arg(&tmp_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("git CLI を起動できませんでした: {}", e))?;
        if !output.status.success() {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(format!(
                "git clone に失敗（exit={}）\n{}",
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        std::fs::rename(&tmp_dir, &mp_dir).map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            format!("clone 済みディレクトリの配置に失敗: {}", e)
        })?;
    }

    // known_marketplaces.json を更新（監査R2: 破損を握りつぶして既存登録を消さない）
    let mut v: serde_json::Value = if known_path.exists() {
        let text = std::fs::read_to_string(&known_path).map_err(|e| e.to_string())?;
        match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(val) if val.is_object() => val,
            _ => {
                // 壊れている/オブジェクトでない → 上書きせず .bak に退避してからエラー。
                // （既存登録を黙って消さない。ユーザーが確認して直せるようにする）
                let bak = known_path.with_extension("json.bak");
                let _ = std::fs::copy(&known_path, &bak);
                return Err(format!(
                    "known_marketplaces.json が壊れています。{} に退避しました。中身を確認して修復するか削除してから再実行してください。",
                    bak.display()
                ));
            }
        }
    } else {
        serde_json::json!({})
    };
    let obj = v.as_object_mut().unwrap();
    obj.insert(
        id_t.clone(),
        serde_json::json!({
            "source": {
                "source": "github",
                "repo": repo_t,
            },
            "installLocation": mp_dir.to_string_lossy(),
            "lastUpdated": chrono_now_iso(),
        }),
    );
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    write_json_atomic(&known_path, &pretty)?;
    Ok(format!("marketplace '{}' を追加しました", id_t))
}

/// std だけで現時刻を ISO 8601-ish に整形（chrono クレート未導入のため最小実装）。
fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // very rough; UI 表示には十分
    let days = secs / 86400;
    let year = 1970 + (days / 365);
    let leftover_days = days % 365;
    let month = (leftover_days / 30 + 1).min(12);
    let day = (leftover_days % 30 + 1).min(31);
    let hour = (secs % 86400) / 3600;
    let minute = (secs % 3600) / 60;
    let second = secs % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

/// ~/.claude.json の `disabledMcpjsonServers` 配列を編集して MCP の有効/無効を切替。
/// `enabledMcpjsonServers`（明示有効化リスト）が存在する場合はそちらも整合させる。
#[tauri::command]
fn toggle_claude_mcp(name: String, enabled: bool) -> Result<(), String> {
    let home = home_dir()?;
    let path = home.join(".claude.json");
    let mut v: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string())?,
        Err(_) => serde_json::json!({}),
    };
    if !v.is_object() {
        v = serde_json::json!({});
    }
    let obj = v.as_object_mut().unwrap();

    fn ensure_array<'a>(
        obj: &'a mut serde_json::Map<String, serde_json::Value>,
        key: &str,
    ) -> &'a mut Vec<serde_json::Value> {
        if !obj.contains_key(key) || !obj.get(key).map(|x| x.is_array()).unwrap_or(false) {
            obj.insert(key.to_string(), serde_json::json!([]));
        }
        obj.get_mut(key).unwrap().as_array_mut().unwrap()
    }

    let disabled = ensure_array(obj, "disabledMcpjsonServers");
    let already_disabled = disabled.iter().any(|x| x.as_str() == Some(&name));
    if enabled {
        if already_disabled {
            disabled.retain(|x| x.as_str() != Some(&name));
        }
    } else if !already_disabled {
        disabled.push(serde_json::Value::String(name.clone()));
    }

    // enabledMcpjsonServers が登場している場合は、そちら基準のホワイトリスト動作なので
    // 名前を含める／除外する。存在しなければ作らない（既存の挙動を尊重）。
    if obj
        .get("enabledMcpjsonServers")
        .map(|x| x.is_array())
        .unwrap_or(false)
    {
        let enabled_list = obj
            .get_mut("enabledMcpjsonServers")
            .unwrap()
            .as_array_mut()
            .unwrap();
        let already_enabled = enabled_list.iter().any(|x| x.as_str() == Some(&name));
        if enabled {
            if !already_enabled {
                enabled_list.push(serde_json::Value::String(name.clone()));
            }
        } else if already_enabled {
            enabled_list.retain(|x| x.as_str() != Some(&name));
        }
    }

    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    write_json_atomic(&path, &pretty)?;
    Ok(())
}

/// `~/.claude/plugins/marketplaces/<id>/` を walk し、各 marketplace 内の
/// `plugin.json` を読み込んで「実在の全プラグイン」を返す。
///
/// レイアウトは marketplace ごとに揺れる（claude-code-plugins は
/// `plugins/<name>/.claude-plugin/plugin.json`、awesome-claude-plugins は
/// `<name>/.claude-plugin/plugin.json`）ので、深さ 4 まで再帰探索する。
#[tauri::command]
fn list_claude_marketplace_catalog() -> Result<Vec<AddonItem>, String> {
    let home = home_dir()?;
    let marketplaces_dir = home.join(".claude").join("plugins").join("marketplaces");
    if !marketplaces_dir.exists() {
        return Ok(Vec::new());
    }
    let installed = read_json_file(
        &home.join(".claude").join("plugins").join("installed_plugins.json"),
    );
    let installed_ids: Vec<String> = installed
        .as_ref()
        .and_then(|v| v.get("plugins"))
        .and_then(|p| p.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    let mut out: Vec<AddonItem> = Vec::new();
    let mp_entries = match std::fs::read_dir(&marketplaces_dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for mp in mp_entries.flatten() {
        let mp_path = mp.path();
        if !mp_path.is_dir() {
            continue;
        }
        let mp_id = mp_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        // Prefer marketplace.json (richer metadata: category/author/tags)
        let mp_json = parse_marketplace_json(&mp_path, &mp_id, &installed_ids, "claude");
        let known: std::collections::HashSet<String> =
            mp_json.iter().map(|x| x.name.clone()).collect();
        out.extend(mp_json);
        // Fallback: walk plugin.json files for anything not covered
        let mut walked: Vec<AddonItem> = Vec::new();
        find_plugin_jsons(&mp_path, &mp_id, &installed_ids, &mut walked, 0);
        for item in walked {
            if !known.contains(&item.name) {
                out.push(item);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// GitHub のユーザー/組織アバターを `~/.claude/plugins/cache/avatars/<key>.png` に保存し、
/// data URL を返す。
///
/// 戦略:
///   1. キャッシュにあり、かつ 7 日以内ならそれを使う
///   2. なければ `https://github.com/<user>.png?size=128` を取りに行く
///   3. 取れなかった場合は `Ok(None)` を返し、UI 側でフォールバック表示
///
/// PC の LAN IP（IPv4）を返す。スマホ連携モーダルが「スマホからアクセスするアドレス」候補として表示する。
///
/// UDP ソケットを 8.8.8.8:80 に connect だけして、ルーティングテーブル経由で
/// 「外向き通信に使われるローカル IP」を取り出す。実パケットは送らない。
/// Wi-Fi 接続時はそのインターフェースの 192.168.x.x / 10.x.x.x が返る。
#[tauri::command]
fn get_lan_ip() -> Result<String, String> {
    use std::net::UdpSocket;
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket
        .connect("8.8.8.8:80")
        .map_err(|e| format!("LAN IP 取得失敗（外向きルートなし）: {}", e))?;
    let addr = socket
        .local_addr()
        .map_err(|e| format!("local_addr 失敗: {}", e))?;
    Ok(addr.ip().to_string())
}

/// graphify ナレッジグラフを指定ワークスペースで更新する（Tauri コマンド）。
///
/// AI が write/edit したらフロントエンドが debounce して呼んでくる想定。
/// `graphify update . --force` を当該ワークスペースで実行する。
/// graphify CLI が PATH に無ければエラー文字列を返す（UI 側でトーストに出す）。
///
/// AST-only 処理でトークン消費0、5〜30秒で完了する設計（graphify-rolloutメモ参照）。
/// 万一 CLI が固まっても UI 側のトーストが永久に残らないよう、
/// 120 秒のハードタイムアウトを設けて確実に Result を返す（ナレッジ更新中…無限固着バグ対策）。
#[tauri::command]
async fn graphify_update(workspace: String) -> Result<String, String> {
    if workspace.trim().is_empty() {
        return Err("workspace が空です".into());
    }
    let path = std::path::PathBuf::from(&workspace);
    if !path.exists() {
        return Err(format!("workspace が存在しません: {}", workspace));
    }
    let mut cmd = build_silent_command("graphify");
    cmd.arg("update").arg(".").arg("--force").current_dir(&path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // 子プロセスを spawn してから timeout で待つ。
    // タイムアウト時は kill して固着を断ち切る（PTY を持たないバッチ実行なので安全に kill 可）。
    let child = cmd.spawn().map_err(|e| {
        format!(
            "graphify CLI を起動できませんでした（pipx install graphifyy で導入してください）: {}",
            e
        )
    })?;
    let wait_fut = child.wait_with_output();
    let output = match tokio::time::timeout(std::time::Duration::from_secs(120), wait_fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("graphify update 実行エラー: {}", e)),
        Err(_) => {
            // タイムアウト。child の所有権はすでに wait_with_output に渡っているので
            // ここから kill はできないが、Drop で stdin/stdout がクローズされ
            // graphify 側も短時間で abort される想定。
            return Err("graphify update がタイムアウト（120秒）しました".into());
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("graphify update 失敗: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().last().unwrap_or("").to_string())
}

/// ネットワーク失敗時はログに出すだけで Err を投げない（UX を阻害しない）。
#[tauri::command]
async fn fetch_github_avatar(user: String) -> Result<Option<String>, String> {
    use base64::Engine;
    if user.trim().is_empty() {
        return Ok(None);
    }
    let safe_user: String = user
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe_user.is_empty() {
        return Ok(None);
    }
    let home = home_dir()?;
    let cache_dir = home.join(".claude").join("plugins").join("cache").join("avatars");
    let _ = std::fs::create_dir_all(&cache_dir);
    let cache_path = cache_dir.join(format!("{}.png", safe_user));
    let max_age_secs: u64 = 7 * 24 * 60 * 60;
    let cache_fresh = std::fs::metadata(&cache_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs() < max_age_secs)
        .unwrap_or(false);

    if !cache_fresh {
        let url = format!("https://github.com/{}.png?size=128", safe_user);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .user_agent("unicrew-avatar-fetcher/0.1")
            .build()
            .map_err(|e| e.to_string())?;
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        if !resp.status().is_success() {
            return Ok(None);
        }
        let bytes = match resp.bytes().await {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        if bytes.len() < 100 {
            return Ok(None);
        }
        let _ = std::fs::write(&cache_path, &bytes);
    }

    let bytes = match std::fs::read(&cache_path) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:image/png;base64,{}", b64)))
}

/// `<marketplace>/.claude-plugin/marketplace.json` または `<marketplace>/marketplace.json`
/// から plugins[] を抽出し、richer メタデータ付き AddonItem を返す。
fn parse_marketplace_json(
    marketplace_dir: &std::path::Path,
    marketplace_id: &str,
    installed_ids: &[String],
    source: &str,
) -> Vec<AddonItem> {
    let candidates = [
        marketplace_dir.join(".claude-plugin").join("marketplace.json"),
        marketplace_dir.join(".codex-plugin").join("marketplace.json"),
        marketplace_dir.join(".agents").join("plugins").join("marketplace.json"),
        marketplace_dir.join("marketplace.json"),
    ];
    let mut out: Vec<AddonItem> = Vec::new();
    for path in &candidates {
        if !path.exists() {
            continue;
        }
        let v = match read_json_file(path) {
            Some(v) => v,
            None => continue,
        };
        let plugins = match v.get("plugins").and_then(|p| p.as_array()) {
            Some(p) => p,
            None => continue,
        };
        for entry in plugins {
            let name = match entry.get("name").and_then(|s| s.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let description = entry
                .get("description")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let version = entry
                .get("version")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let category = entry
                .get("category")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let author = entry.get("author").and_then(|a| {
                if let Some(s) = a.as_str() {
                    Some(s.to_string())
                } else {
                    a.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
                }
            });
            let id = format!("{}@{}", name, marketplace_id);
            let installed = installed_ids.iter().any(|x| x == &id);
            out.push(AddonItem {
                id,
                name,
                namespace: Some(marketplace_id.to_string()),
                version,
                enabled: installed,
                scope: if installed { "user".into() } else { "marketplace".into() },
                description,
                kind: "plugin".into(),
                source: source.to_string(),
                path: None,
                category,
                author,
                // http(s) 以外（javascript: 等）はリンクにしない（UI で <a href> に入るため）
                homepage: entry
                    .get("homepage")
                    .and_then(|s| s.as_str())
                    .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
                    .map(|s| s.to_string()),
            });
        }
        // 1 個見つかれば終わり
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// `codex plugin marketplace list` の出力から「マーケットプレイス名 → ルート」を取る。
///
/// 実測（2026-08-28・codex v0.150）: マーケットプレイスの実体は
/// `~/.cache/codex-runtimes/.../plugins/<name>` や `~/.codex/.tmp/plugins` にあり、
/// 旧来の `~/.codex/.tmp/bundled-marketplaces` だけを見ると **現行カタログの
/// 未インストール分（linear / slack / teams 等）が一覧に出ない**。
/// CLI に在処を聞くのが唯一の追従方法（パス規約は codex 側の内部実装で変わる）。
/// codex 不在・失敗時は空を返し、呼び出し側が旧ディレクトリ探索へフォールバックする。
fn codex_marketplace_roots() -> Vec<(String, std::path::PathBuf)> {
    let program: String = {
        #[cfg(target_os = "windows")]
        {
            resolve_on_path("codex")
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "codex".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            "codex".to_string()
        }
    };
    let mut cmd = std::process::Command::new(&program);
    cmd.args(["plugin", "marketplace", "list"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut roots: Vec<(String, std::path::PathBuf)> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with("MARKETPLACE") {
            continue; // 空行とヘッダ行
        }
        // 「名前 <空白> ルートパス」。パスには空白が入り得るので最初の空白で割る
        let Some(idx) = line.find(char::is_whitespace) else {
            continue;
        };
        let name = line[..idx].trim().to_string();
        let root = line[idx..].trim().to_string();
        if name.is_empty() || root.is_empty() {
            continue;
        }
        let path = std::path::PathBuf::from(&root);
        if path.is_dir() {
            roots.push((name, path));
        }
    }
    roots
}

/// Codex 側 marketplace（~/.codex/.tmp/bundled-marketplaces/, ~/.codex/plugins/marketplaces/）の全件カタログ。
#[tauri::command]
fn list_codex_marketplace_catalog() -> Result<Vec<AddonItem>, String> {
    let home = home_dir()?;
    let cfg = read_codex_config();
    let installed_ids: Vec<String> = cfg
        .as_ref()
        .and_then(|c| c.get("plugins"))
        .and_then(|p| p.as_table())
        .map(|t| t.keys().cloned().collect())
        .unwrap_or_default();

    // 一次情報源: codex CLI 自身に marketplace の在処を聞く（2026-08-28 修正。
    // 旧来のディレクトリ決め打ちでは現行カタログの未インストール分が出なかった）。
    let mut sources: Vec<(String, std::path::PathBuf)> = codex_marketplace_roots();
    // フォールバック: 旧ディレクトリ探索（codex CLI が実行できない環境用）
    for root in [
        home.join(".codex").join(".tmp").join("bundled-marketplaces"),
        home.join(".codex").join("plugins").join("marketplaces"),
    ] {
        if !root.exists() {
            continue;
        }
        let entries = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for mp in entries.flatten() {
            let mp_path = mp.path();
            if !mp_path.is_dir() {
                continue;
            }
            let mp_id = mp_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            sources.push((mp_id, mp_path));
        }
    }

    let mut out: Vec<AddonItem> = Vec::new();
    let mut seen_mp: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (mp_id, mp_path) in sources {
        if mp_id.is_empty() || !seen_mp.insert(mp_id.clone()) {
            continue; // 同名 marketplace は CLI 由来（先頭）を優先
        }
        let mut mp_json = parse_marketplace_json(&mp_path, &mp_id, &installed_ids, "codex");
        let mut walked: Vec<AddonItem> = Vec::new();
        find_plugin_jsons(&mp_path, &mp_id, &installed_ids, &mut walked, 0);
        // 【2026-08-28 修正】Codex の marketplace.json は name/category だけで
        // description が無い（実測: openai-curated 180件すべて説明なし）。
        // 一方 各プラグインの plugin.json には description / homepage / author が
        // 実在する。旧実装は marketplace.json を優先して plugin.json 側を捨てて
        // いたため「一覧に説明が無くて何のプラグインか分からない」状態だった。
        // → 一覧は marketplace.json を正としつつ、欠けたメタを plugin.json で補完する。
        let walked_by_name: std::collections::HashMap<String, &AddonItem> =
            walked.iter().map(|w| (w.name.clone(), w)).collect();
        for item in mp_json.iter_mut() {
            if let Some(w) = walked_by_name.get(&item.name) {
                if item.description.is_none() {
                    item.description = w.description.clone();
                }
                if item.homepage.is_none() {
                    item.homepage = w.homepage.clone();
                }
                if item.author.is_none() {
                    item.author = w.author.clone();
                }
                if item.version.is_none() {
                    item.version = w.version.clone();
                }
            }
        }
        let known: std::collections::HashSet<String> =
            mp_json.iter().map(|x| x.name.clone()).collect();
        out.extend(mp_json);
        for mut item in walked {
            if !known.contains(&item.name) {
                item.source = "codex".into();
                out.push(item);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn find_plugin_jsons(
    dir: &std::path::Path,
    marketplace_id: &str,
    installed_ids: &[String],
    out: &mut Vec<AddonItem>,
    depth: usize,
) {
    if depth > 4 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name == "node_modules" || name == "target" || name.starts_with(".git") {
            continue;
        }
        if p.is_file() && name == "plugin.json" {
            if let Some(item) = parse_plugin_json(&p, marketplace_id, installed_ids) {
                out.push(item);
            }
        } else if p.is_dir() {
            find_plugin_jsons(&p, marketplace_id, installed_ids, out, depth + 1);
        }
    }
}

fn parse_plugin_json(
    path: &std::path::Path,
    marketplace_id: &str,
    installed_ids: &[String],
) -> Option<AddonItem> {
    let v = read_json_file(path)?;
    let name = v.get("name").and_then(|s| s.as_str())?.to_string();
    let description = v
        .get("description")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let version = v
        .get("version")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let category = v
        .get("category")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let author = v
        .get("author")
        .and_then(|a| {
            if let Some(s) = a.as_str() {
                Some(s.to_string())
            } else {
                a.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
            }
        });
    // 説明ページ: homepage が無ければ repository で代用（両方 plugin.json の実フィールド）
    let homepage = v
        .get("homepage")
        .and_then(|s| s.as_str())
        .or_else(|| v.get("repository").and_then(|s| s.as_str()))
        .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
        .map(|s| s.to_string());
    let id = format!("{}@{}", name, marketplace_id);
    let installed = installed_ids.iter().any(|x| x == &id);
    Some(AddonItem {
        id,
        name,
        namespace: Some(marketplace_id.to_string()),
        version,
        enabled: installed,
        scope: if installed { "user".into() } else { "marketplace".into() },
        description,
        kind: "plugin".into(),
        source: "claude".into(),
        path: Some(path.parent()?.to_string_lossy().to_string()),
        category,
        author,
        homepage,
    })
}

#[tauri::command]
fn list_codex_skills() -> Result<Vec<AddonItem>, String> {
    let home = home_dir()?;
    Ok(collect_skills_from(
        &home.join(".codex").join("skills"),
        "user",
        "codex",
    ))
}

// ---------- Default workspace ----------

#[tauri::command]
async fn default_workspace_path() -> Result<String, String> {
    // Documents は Known Folder API 経由で解決する（dirs::document_dir）。
    // ユーザーが Documents を別ドライブ（D: など）へリダイレクトしていても
    // 正しい実体パスを返す。`%USERPROFILE%\Documents` 直結だと
    // リダイレクトを無視して C: 固定になってしまうため避ける。
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or("documents directory not found")?;
    let path = base.join("UNICREW");
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().to_string())
}

// ---------- CLI version comparison（claude / codex 共通） ----------

#[derive(Debug, Serialize)]
struct CliVersionInfo {
    /// 表示用ラベル。"Claude Code" / "Codex" 等
    name: String,
    /// npm パッケージ名。`@anthropic-ai/claude-code` 等
    package: String,
    /// インストール済バージョン（未インストールなら None）
    current: Option<String>,
    /// npm registry 上の最新バージョン（取得失敗なら None）
    latest: Option<String>,
    /// current != latest かつ両方存在のとき true
    update_available: bool,
}

#[derive(Debug, Serialize)]
struct CliVersions {
    claude: CliVersionInfo,
    codex: CliVersionInfo,
}

/// `<pkg> --version` の生出力からセマンティック部分（"x.y.z"）だけ取り出す。
/// claude: `1.x.y (Claude Code)` / codex: `codex-cli 0.130.0` どちらにも対応。
fn extract_semver(raw: &str) -> Option<String> {
    raw.split_whitespace()
        .find(|tok| tok.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
        .map(|s| s.to_string())
}

async fn npm_view_latest(pkg: &str) -> Option<String> {
    let mut cmd = build_silent_command("npm");
    cmd.args(["view", pkg, "version"]);
    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// "x.y.z" を数値タプルに。パースできない部分は 0 扱い。
fn parse_semver(v: &str) -> (u64, u64, u64) {
    let mut it = v.split('.').map(|s| {
        s.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .unwrap_or(0)
    });
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

fn build_version_info(
    name: &str,
    package: &str,
    current: Option<String>,
    latest: Option<String>,
) -> CliVersionInfo {
    // 🚨 2026-08 修正: 旧実装の `c != l` は、stable チャネルや winget 版
    // （npm latest より数版古いのが常態）の利用者に**永久に「更新あり」**を
    // 出し続けた。current < latest のときだけ更新ありにする。
    let update_available = match (&current, &latest) {
        (Some(c), Some(l)) => parse_semver(c) < parse_semver(l),
        _ => false,
    };
    CliVersionInfo {
        name: name.to_string(),
        package: package.to_string(),
        current,
        latest,
        update_available,
    }
}

/// claude / codex のインストール済バージョンと npm 最新バージョンを返す。
/// CLI が古い時に Settings で警告＋更新ボタンを出すための情報源。
#[tauri::command]
async fn cli_versions() -> Result<CliVersions, String> {
    // 4 つのコマンドを並列実行（npm view は外部HTTP）
    let (claude_raw, codex_raw, claude_latest, codex_latest) = tokio::join!(
        async {
            build_silent_command("claude")
                .arg("--version")
                .output()
                .await
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        },
        async {
            build_silent_command("codex")
                .arg("--version")
                .output()
                .await
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        },
        npm_view_latest("@anthropic-ai/claude-code"),
        npm_view_latest("@openai/codex"),
    );

    let claude_current = claude_raw.as_deref().and_then(extract_semver);
    let codex_current = codex_raw.as_deref().and_then(extract_semver);

    Ok(CliVersions {
        claude: build_version_info(
            "Claude Code",
            "@anthropic-ai/claude-code",
            claude_current,
            claude_latest,
        ),
        codex: build_version_info(
            "Codex",
            "@openai/codex",
            codex_current,
            codex_latest,
        ),
    })
}

/// 指定 provider の CLI を更新する。
/// 🚨 2026-08 改修: 旧実装は常に `npm install -g <pkg>@latest` だったが、
/// 現行の導入経路（ネイティブインストーラ/winget/brew）と食い違うと **同じ CLI が
/// 2 系統インストールされ、どちらが起動するか PATH 順次第になる事故**を起こす。
/// 現行 CLI はどちらも自己更新サブコマンド（`claude update` / `codex update`）を持ち、
/// 自分の導入経路を認識して適切に更新するため、これを第1経路にする。
/// （npm 導入の CLI でも `claude update` は npm 向けの案内/更新を行う）
/// 進捗は `cli_update:line` イベントで stream する。
/// program + args を実行し、stdout/stderr を `cli_update:line` に stream して
/// 終了ステータスを返す（update_cli の 2 経路で共用）。
async fn run_streamed_update(
    app: &AppHandle,
    program: &str,
    args: &[&str],
) -> Result<bool, String> {
    let mut cmd = build_silent_command(program);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} の起動に失敗しました: {}", program, e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("cli_update:line", line);
        }
    });
    let app_clone2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone2.emit("cli_update:line", line);
        }
    });
    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok(status.success())
}

#[tauri::command]
async fn update_cli(app: AppHandle, provider: String) -> Result<(), String> {
    let (bin, pkg) = match provider.as_str() {
        "claude" => ("claude", "@anthropic-ai/claude-code"),
        "codex" => ("codex", "@openai/codex"),
        other => return Err(format!("unknown provider: {}", other)),
    };
    // 第1経路: CLI 自己更新（導入経路を自認して適切に更新する）
    if run_streamed_update(&app, bin, &["update"]).await? {
        return Ok(());
    }
    // 第2経路: npm グローバル更新。
    //
    // 🚨 ただし「その CLI が npm で入っている場合」に限る。
    // 公式インストーラ（~/.local/bin）で入れた CLI に対して npm install -g を走らせると、
    // **同じ CLI が2箇所に並ぶ**（実測: %APPDATA%\npm\claude.cmd = 2.1.154 と
    // ~/.local/bin\claude.exe = 2.1.240 が同居していた）。
    // どちらが動くかは PATH の順番次第なので、更新したつもりで古い方が起動し続ける。
    if !cli_is_npm_managed(bin).await {
        let _ = app.emit(
            "cli_update:line",
            format!(
                "{} は公式インストーラ経由で入っています（npm 管理ではありません）。npm での更新は二重インストールになるため行いません。",
                bin
            ),
        );
        return Err(format!(
            "{bin} の自己更新に失敗しました。この CLI は公式インストーラで入っているため、npm では更新しません（二重インストールを避けるため）。ターミナルで `{bin} update` を実行するか、公式インストーラを再実行してください。"
        ));
    }
    let _ = app.emit(
        "cli_update:line",
        format!(
            "{} update が使えないため npm でフォールバック更新します…",
            bin
        ),
    );
    let target = format!("{}@latest", pkg);
    if run_streamed_update(&app, "npm", &["install", "-g", &target]).await? {
        return Ok(());
    }
    Err(format!(
        "{} の更新に失敗しました（self-update / npm の両経路とも失敗）",
        bin
    ))
}

/// その CLI が npm グローバルで入っているか（＝npm で更新してよいか）。
///
/// 実体のパスに `npm` / `node_modules` が含まれるかで判定する。
/// 判定できないときは **false（npm で触らない）** に倒す。二重インストールを作るより、
/// 「更新できませんでした」と正直に出して手順を案内する方が事故が小さい。
async fn cli_is_npm_managed(bin: &str) -> bool {
    let path = {
        #[cfg(target_os = "windows")]
        {
            resolve_on_path(bin).map(|p| p.to_string_lossy().to_lowercase())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let out = build_silent_command("sh")
                .args(["-c", &format!("command -v {}", bin)])
                .output()
                .await
                .ok();
            out.and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_lowercase())
                } else {
                    None
                }
            })
        }
    };
    let Some(path) = path else {
        return false;
    };
    let path = path.replace('\\', "/");
    // よくある npm / パッケージマネージャ配下の置き場
    const NPM_ISH: [&str; 7] = [
        "/npm/",
        "/node_modules/",
        "/.npm-global/",
        "/.nvm/versions/node/",
        "/.volta/",
        "/pnpm/",
        "/.fnm/",
    ];
    if NPM_ISH.iter().any(|frag| path.contains(frag)) {
        return true;
    }
    // 決め打ちで拾えない構成（asdf / mise / nodenv 等）は npm 自身に聞く。
    // `npm prefix -g` の下にあるなら npm で更新してよい。
    let prefix = build_silent_command("npm")
        .args(["prefix", "-g"])
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_lowercase());
    match prefix {
        Some(prefix) if !prefix.is_empty() => {
            path.starts_with(&prefix.replace('\\', "/"))
        }
        _ => false,
    }
}

// ---------- Aggregated update checker (Phase 1) ----------

/// 「設定 → 機能の追加」に並んでいる CLI / Plugin / Skill が
/// 最新版より古くないかを 1 回でまとめて確認するための集約結果。
///
/// フロント側はバッジ (`has_update_count`) と、各 item 横の「更新」ボタンを描画する。
#[derive(Debug, Serialize)]
struct AddonUpdateSummary {
    /// epoch millis。フロントで「最終チェック: HH:mm」表示用。
    checked_at: u64,
    items: Vec<AddonUpdateItem>,
}

#[derive(Debug, Serialize)]
struct AddonUpdateItem {
    /// 更新の種類: "cli" | "claude_plugin" | "codex_plugin" | "skill"
    kind: String,
    /// 識別子。apply_addon_update に渡すと適切なコマンドが実行される。
    /// - cli: "claude" / "codex"
    /// - claude_plugin: "<name>@<marketplace>"（installed_plugins.json の key）
    /// - codex_plugin: "<name>@<marketplace>"
    /// - skill: 絶対パス
    id: String,
    /// 表示用名前
    name: String,
    /// 現在のバージョン or git short hash。取れなければ None
    current: Option<String>,
    /// 最新バージョン or "N commits behind" の右辺
    latest: Option<String>,
    /// このアイテムに更新があるか。フロントは true のものだけバッジに含める。
    has_update: bool,
    /// 追加情報 (例: "3 commits behind origin")
    detail: Option<String>,
}

/// 全ての更新可能アドオン（CLI / git-backed Skill / Plugin）を 1 ショットで集約。
///
/// 設計メモ:
/// - 外部 HTTP は npm view（claude / codex CLI）と git ls-remote（skill）のみ
/// - 1 つの取得が失敗しても他は止めず、`has_update` を判断不能なら false を返す（控えめ運用）
/// - 結果のキャッシュはフロント側で localStorage 管理（バックエンドはステートレス）
#[tauri::command]
async fn check_addon_updates() -> Result<AddonUpdateSummary, String> {
    let mut items: Vec<AddonUpdateItem> = Vec::new();

    // ----- CLI 本体（既存 cli_versions ロジックを再利用） -----
    let cli_summary = cli_versions().await.ok();
    if let Some(v) = cli_summary {
        let mut push_cli = |id: &str, name: &str, info: &CliVersionInfo| {
            let has_update = match (&info.current, &info.latest) {
                (Some(c), Some(l)) => semver_lt(c, l),
                _ => false,
            };
            items.push(AddonUpdateItem {
                kind: "cli".to_string(),
                id: id.to_string(),
                name: name.to_string(),
                current: info.current.clone(),
                latest: info.latest.clone(),
                has_update,
                detail: None,
            });
        };
        push_cli("claude", "Claude Code", &v.claude);
        push_cli("codex", "Codex", &v.codex);
    }

    // ----- Skills（git 管理されたものだけバージョン判定可能） -----
    if let Ok(home) = home_dir() {
        let skills_dir = home.join(".claude").join("skills");
        if skills_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&skills_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    // .git ディレクトリがあるものだけが「リモート由来」なので、上流と比較できる。
                    // それ以外（手書き skill）は更新検知の対象外。
                    if !path.join(".git").exists() {
                        continue;
                    }
                    let name = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    if name.is_empty() {
                        continue;
                    }
                    match check_skill_git_update(&path).await {
                        Ok((current, latest, behind)) => {
                            let detail = if behind > 0 {
                                Some(format!("{} commits behind origin", behind))
                            } else {
                                None
                            };
                            items.push(AddonUpdateItem {
                                kind: "skill".to_string(),
                                id: path.to_string_lossy().to_string(),
                                name,
                                current: Some(current),
                                latest: Some(latest),
                                has_update: behind > 0,
                                detail,
                            });
                        }
                        Err(_) => {
                            // 取得失敗（オフライン等）は静かにスキップ
                        }
                    }
                }
            }
        }
    }

    // ----- Codex marketplaces（git管理）の更新検知 -----
    // Codex は plugin ごとの version が config.toml に保存されない設計のため、
    // marketplace ディレクトリそのものを git で更新するアプローチを採る。
    // 個別 plugin 単位ではなく marketplace 単位の "N commits behind" を表示する。
    if let Ok(home) = home_dir() {
        for root in [
            home.join(".codex").join(".tmp").join("bundled-marketplaces"),
            home.join(".codex").join("plugins").join("marketplaces"),
        ] {
            if !root.is_dir() {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    if !path.join(".git").exists() {
                        continue;
                    }
                    let mp_name = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_string();
                    if mp_name.is_empty() {
                        continue;
                    }
                    match check_skill_git_update(&path).await {
                        Ok((current, latest, behind)) => {
                            let detail = if behind > 0 {
                                Some(format!("{} commits behind", behind))
                            } else {
                                None
                            };
                            items.push(AddonUpdateItem {
                                kind: "codex_marketplace".to_string(),
                                id: path.to_string_lossy().to_string(),
                                name: format!("Codex: {}", mp_name),
                                current: Some(current),
                                latest: Some(latest),
                                has_update: behind > 0,
                                detail,
                            });
                        }
                        Err(_) => {
                            /* オフライン等は静かにスキップ */
                        }
                    }
                }
            }
        }
    }

    // ----- Claude プラグイン（installed_plugins.json の version vs marketplace.json の version） -----
    if let Ok(home) = home_dir() {
        let installed_path = home
            .join(".claude")
            .join("plugins")
            .join("installed_plugins.json");
        if let Some(installed) = read_json_file(&installed_path) {
            if let Some(plugins) = installed.get("plugins").and_then(|p| p.as_object()) {
                let marketplaces_dir =
                    home.join(".claude").join("plugins").join("marketplaces");
                for (key, entries) in plugins {
                    // entries は [{ scope, version, installPath, ... }] の配列
                    let installed_version: Option<String> = entries
                        .as_array()
                        .and_then(|arr| arr.first())
                        .and_then(|e| e.get("version"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    let (plugin_name, marketplace_id) = match key.split_once('@') {
                        Some((n, ns)) => (n.to_string(), ns.to_string()),
                        None => (key.clone(), String::new()),
                    };
                    if marketplace_id.is_empty() {
                        continue;
                    }
                    let mp_path = marketplaces_dir.join(&marketplace_id);
                    let latest_version =
                        find_plugin_latest_version(&mp_path, &plugin_name);
                    let has_update = match (&installed_version, &latest_version) {
                        (Some(c), Some(l)) => semver_lt(c, l),
                        _ => false,
                    };
                    items.push(AddonUpdateItem {
                        kind: "claude_plugin".to_string(),
                        id: key.clone(),
                        name: plugin_name,
                        current: installed_version,
                        latest: latest_version,
                        has_update,
                        detail: None,
                    });
                }
            }
        }
    }

    let checked_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(AddonUpdateSummary { checked_at, items })
}

/// 指定 skill ディレクトリで `git fetch` し、HEAD と upstream の差分を取得する。
/// 戻り値: (current_short_hash, latest_short_hash, commits_behind)
async fn check_skill_git_update(
    path: &std::path::Path,
) -> Result<(String, String, usize), String> {
    // 1) git fetch --quiet
    let mut fetch = build_silent_command("git");
    fetch.current_dir(path).args(["fetch", "--quiet"]);
    let _ = fetch
        .output()
        .await
        .map_err(|e| format!("git fetch failed: {}", e))?;

    // 2) HEAD short hash
    let head = build_silent_command("git")
        .current_dir(path)
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .await
        .map_err(|e| format!("git rev-parse HEAD: {}", e))?;
    let head_str = String::from_utf8_lossy(&head.stdout).trim().to_string();

    // 3) upstream short hash
    let upstream = build_silent_command("git")
        .current_dir(path)
        .args(["rev-parse", "--short", "@{u}"])
        .output()
        .await
        .map_err(|e| format!("git rev-parse @{{u}}: {}", e))?;
    if !upstream.status.success() {
        // upstream branch が未設定なら検知対象外として扱う
        return Err("no upstream".into());
    }
    let upstream_str = String::from_utf8_lossy(&upstream.stdout).trim().to_string();

    // 4) commits behind
    let count = build_silent_command("git")
        .current_dir(path)
        .args(["rev-list", "--count", "HEAD..@{u}"])
        .output()
        .await
        .map_err(|e| format!("git rev-list: {}", e))?;
    let behind: usize = String::from_utf8_lossy(&count.stdout)
        .trim()
        .parse()
        .unwrap_or(0);

    Ok((head_str, upstream_str, behind))
}

/// marketplace 配下の plugin.json から該当 plugin の version を取得。
/// `<mp>/.claude-plugin/marketplace.json` の plugins[] を最優先で見る。
fn find_plugin_latest_version(
    marketplace_dir: &std::path::Path,
    plugin_name: &str,
) -> Option<String> {
    let candidates = [
        marketplace_dir.join(".claude-plugin").join("marketplace.json"),
        marketplace_dir.join("marketplace.json"),
    ];
    for path in &candidates {
        if let Some(v) = read_json_file(path) {
            if let Some(arr) = v.get("plugins").and_then(|p| p.as_array()) {
                for entry in arr {
                    let name = entry
                        .get("name")
                        .and_then(|s| s.as_str())
                        .unwrap_or("");
                    if name == plugin_name {
                        return entry
                            .get("version")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                    }
                }
            }
        }
    }
    None
}

/// 雑な semver 比較: current < latest なら true。
/// pre-release / build metadata は無視（最初の 3 つの数値だけ見る）。
fn semver_lt(current: &str, latest: &str) -> bool {
    fn parts(v: &str) -> [u64; 3] {
        let core = v.trim_start_matches('v');
        let core = core.split(|c: char| c == '-' || c == '+').next().unwrap_or("");
        let mut it = core.split('.');
        let a = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let b = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let c = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        [a, b, c]
    }
    parts(current) < parts(latest)
}

/// 指定アドオンを実際に更新する。
///
/// - kind="cli", id="claude"|"codex": npm install -g <pkg>@latest（既存 update_cli を流用）
/// - kind="claude_plugin", id="<name>@<marketplace>": claude plugin update <id>
///   （反映にはアプリ/CLI の再起動が必要）
/// - kind="skill", id=<absolute path>: git pull --ff-only
#[tauri::command]
async fn apply_addon_update(
    app: AppHandle,
    kind: String,
    id: String,
) -> Result<String, String> {
    match kind.as_str() {
        "cli" => {
            update_cli(app, id).await?;
            Ok("CLI を更新しました".into())
        }
        "claude_plugin" => {
            let id_trim = id.trim();
            if id_trim.is_empty() {
                return Err("プラグイン ID が空です".into());
            }
            validate_plugin_id(id_trim)?;
            // 本物のサブコマンド `claude plugin update`（2026-08-28 根治。
            // 旧 --print 経由は実行されない偽成功だった）。反映には再起動が要る。
            run_claude_plugin_cmd("update", id_trim).await
        }
        "skill" | "codex_marketplace" => {
            // skill / codex marketplace どちらも git ディレクトリのフォルダ更新で同じ動作。
            let path = std::path::PathBuf::from(&id);
            if !path.join(".git").exists() {
                return Err(format!(
                    "git 管理ではないため自動更新できません: {}",
                    id
                ));
            }
            let output = build_silent_command("git")
                .current_dir(&path)
                .args(["pull", "--ff-only"])
                .output()
                .await
                .map_err(|e| format!("git pull failed: {}", e))?;
            if !output.status.success() {
                return Err(format!(
                    "git pull が失敗しました（exit={}）\nstderr: {}",
                    output.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        other => Err(format!("未対応の更新種別: {}", other)),
    }
}

// ---------- Claude Code (CLI) status & login ----------

#[derive(Debug, Serialize)]
struct ClaudeStatus {
    installed: bool,
    logged_in: bool,
    version: Option<String>,
    hint: String,
}

#[tauri::command]
async fn claude_status() -> Result<ClaudeStatus, String> {
    // Check claude CLI presence by running `claude --version`
    // build_silent_command 経由で .cmd シムも解決する（npm install 経由でも動く）
    let output = build_silent_command("claude").arg("--version").output().await;
    let (installed, version) = match output {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (true, Some(v))
        }
        _ => (false, None),
    };

    // ログイン判定は `claude auth status --json` を一次情報源にする
    // （credentials ファイルの場所推測はインストール形態で揺れるため補助に降格）。
    let logged_in = if installed {
        let auth_out = build_silent_command("claude")
            .args(["auth", "status", "--json"])
            .output()
            .await;
        let by_cli = match auth_out {
            Ok(o) if o.status.success() => {
                serde_json::from_slice::<serde_json::Value>(&o.stdout)
                    .ok()
                    .and_then(|v| v.get("loggedIn").and_then(|b| b.as_bool()))
            }
            _ => None,
        };
        by_cli.unwrap_or_else(|| {
            // 旧CLI等で auth status が無い場合は従来のファイル存在チェックに退避
            let home = std::env::var("USERPROFILE")
                .ok()
                .or_else(|| std::env::var("HOME").ok())
                .map(std::path::PathBuf::from);
            let candidates: Vec<std::path::PathBuf> = home
                .iter()
                .flat_map(|h| {
                    vec![
                        h.join(".claude").join(".credentials.json"),
                        h.join(".claude").join("credentials.json"),
                        h.join(".config").join("claude").join(".credentials.json"),
                    ]
                })
                .collect();
            candidates.iter().any(|p| p.exists())
        })
    } else {
        false
    };

    let hint = if !installed {
        "Claude Code が見つかりません。先にインストールしてください。".into()
    } else if !logged_in {
        "Claude Code はインストール済み。次は『Claude にログイン』を押してください。".into()
    } else {
        "準備OK。Claude のサブスクリプションで動作します。".into()
    };

    Ok(ClaudeStatus {
        installed,
        logged_in,
        version,
        hint,
    })
}

// CREATE_NO_WINDOW: Windowsで子プロセスのコンソールを表示しない
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Windows で `.cmd` / `.bat` / `.ps1` シムを PATH+PATHEXT で解決する。
/// npm / codex / pnpm 等は `name.cmd` シムなので、Command::new("npm") では
/// 見つからない（既定では .exe しか探さない）。
///
/// PATH に見つからなかった場合は、既知のインストール先（winget/Squirrel/MSIX 等が
/// 利用する LOCALAPPDATA / ProgramFiles 配下の標準パス）をフォールバック探索する。
/// これにより winget install 直後で UNICREW プロセスの PATH に新パスがまだ
/// 伝播してない状況でも binary を発見できる。
/// Windows の実行可能拡張子リスト（PATHEXT）。未設定時は既定値。
#[cfg(target_os = "windows")]
fn windows_path_exts() -> Vec<String> {
    let raw = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC".into());
    raw.split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect()
}

/// 1つのディレクトリの中から `name` の実体を探す（PATHEXT を展開する）。
///
/// 🚨 npm -g のシムは `<name>.cmd`、公式インストーラは `<name>.exe` と実体が違う。
/// 拡張子を決め打ちすると **npm 経由で入れた gemini / opencode / qwen / codex-acp を
/// 取りこぼす**（＝入れたのに「未インストール」）。PATH 探索と既知パス探索で
/// 同じロジックを使うため、ここに集約する。
#[cfg(target_os = "windows")]
pub(crate) fn find_executable_in_dir(
    dir: &std::path::Path,
    name: &str,
) -> Option<std::path::PathBuf> {
    if std::path::Path::new(name).extension().is_some() {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    for ext in windows_path_exts() {
        let candidate = dir.join(format!("{}{}", name, ext));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // 拡張子なしの実体（WSL 由来のスクリプト等）も一応見る
    let bare = dir.join(name);
    if bare.is_file() {
        return Some(bare);
    }
    None
}

#[cfg(target_os = "windows")]
pub(crate) fn resolve_on_path(name: &str) -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&p) {
            if let Some(found) = find_executable_in_dir(&dir, name) {
                return Some(found);
            }
        }
    }

    // PATH で見つからない場合のフォールバック。winget 等で入れた直後、
    // 既に走っているプロセス（UNICREW）の PATH キャッシュに新パスが反映されてない
    // 状況をカバーする。OSS CLI 系の代表的なインストール場所を列挙して探す。
    resolve_known_install_location(name)
}

/// 既知のインストール先で `<name>` バイナリを探す Windows 専用フォールバック。
/// PATH に未反映でも winget/Squirrel/MSIX 経路のインストールを発見できるようにする。
#[cfg(target_os = "windows")]
fn resolve_known_install_location(name: &str) -> Option<std::path::PathBuf> {
    let local_appdata = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
    let roaming_appdata = std::env::var_os("APPDATA").map(std::path::PathBuf::from);
    let program_files = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)").map(std::path::PathBuf::from);
    let user_profile = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
    let system_root = std::env::var_os("SystemRoot").map(std::path::PathBuf::from);

    // (root_prefix, relative_path_template, exe_name) のテーブル。
    // `{name}` プレースホルダを引数で置換。プロバイダ追加時はここに 1 行足す。
    let recipes: Vec<(Option<&std::path::PathBuf>, &str)> = vec![
        // 🚨 並び順に意味がある。公式インストーラ（~/.local/bin）を先頭に置く。
        // npm シムを先に見ると、同居している古い npm 版を掴む（自動更新されない）。
        (user_profile.as_ref(), ".local/bin"),
        // winget portable パッケージ共通のシム置き場（Anthropic.ClaudeCode 等）。
        // winget はユーザー PATH（レジストリ）に Links を足すが、起動中プロセスの
        // PATH には反映されないため、ここを直接探す。
        // ＝「ワンクリックインストール成功直後なのに claude が見つからない」の根治。
        (local_appdata.as_ref(), "Microsoft/WinGet/Links"),
        // Codex 公式インストーラ（chatgpt.com/codex/install.ps1）の既定 visible bin。
        // 2026-08-14 実物スクリプトで確認: %LOCALAPPDATA%/Programs/OpenAI/Codex/bin。
        // これが無いと、公式インストーラ成功直後に resolve_on_path("codex") が失敗して
        // npm フォールバックへ落ち、同一 CLI が二重インストールされる。
        (local_appdata.as_ref(), "Programs/OpenAI/Codex/bin"),
        // winget の Ollama.Ollama 既定
        (local_appdata.as_ref(), "Programs/Ollama"),
        // kiro-cli の既定配置（実測）
        (local_appdata.as_ref(), "Kiro-Cli"),
        // 一般的な ProgramFiles 配置
        (program_files.as_ref(), "Ollama"),
        (program_files_x86.as_ref(), "Ollama"),
        // Goose の Block 公式 zip 展開先候補
        (local_appdata.as_ref(), "Programs/Goose"),
        (local_appdata.as_ref(), "Programs/Block.Goose"),
        (local_appdata.as_ref(), "Programs/OpenCode"),
        // npm / node 本体（npm.cmd を spawn できないと install 自体が始まらない）
        (program_files.as_ref(), "nodejs"),
        // winget 本体（App Execution Alias）と PowerShell。PATH から漏れている PC で
        // 「インストーラを起動すらできない」を防ぐ。
        (local_appdata.as_ref(), "Microsoft/WindowsApps"),
        (program_files.as_ref(), "PowerShell/7"),
        (system_root.as_ref(), "System32/WindowsPowerShell/v1.0"),
        // npm -g のシム置き場。gemini / opencode / qwen / codex-acp はここに
        // `<name>.cmd` として入る（実測: %APPDATA%\npm\gemini.cmd）。
        // 通常は Node 導入時に PATH へ入るが、UNICREW 起動後に Node を入れた場合や
        // prefix を変えている場合は PATH に無いのでここで拾う。**最後に見る**。
        (roaming_appdata.as_ref(), "npm"),
    ];

    for (root, subdir) in recipes {
        let Some(root) = root else { continue };
        let dir = root.join(subdir);
        if !dir.is_dir() {
            continue;
        }
        // PATHEXT を展開して探す（.exe だけでなく npm シムの .cmd も拾う）
        if let Some(found) = find_executable_in_dir(&dir, name) {
            return Some(found);
        }
    }
    None
}

/// CLI が入る「よくある場所」を PATH に追記する（起動時に1回だけ呼ぶ）。
///
/// 🚨 これが無いと macOS の .app を Finder / Dock から起動したとき、PATH が
/// launchd の最小値（/usr/bin:/bin:/usr/sbin:/sbin）のままになり、
/// - `claude`（公式インストーラは ~/.local/bin）
/// - `gemini` / `opencode` / `qwen`（npm -g）
/// - Homebrew 配下の全部
/// が **インストール済みでも「未インストール」と判定される**。
/// インストール処理側だけは sh -c で PATH を前置していたが、検出（*_status）と
/// 実行（providers/*）は素の PATH を使っていたため、
/// 「インストールは成功と出るのに、ずっと未インストール表示」という詰みが起きる。
///
/// 方針:
/// - **既存 PATH の後ろに足すだけ**（前に入れるとユーザーの解決順を壊す）
/// - 実在するディレクトリだけ、重複なしで足す
/// - 外部シェルは起動しない（`$SHELL -ilc` 方式は遅く、環境によって固まるため）
fn augment_cli_path() {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();
    let mut known: Vec<std::path::PathBuf> = Vec::new();

    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);

    #[cfg(target_os = "windows")]
    {
        // 🚨 並び順に意味がある。**公式インストーラの置き場を npm シムより先に**置く。
        // 同じ CLI が両方に居ることがあり（例: 古い npm 版 claude と、公式
        // インストーラ版 ~/.local/bin\claude.exe）、npm を先に見ると
        // 自動更新されない古い方を掴む（実測: 2.1.154 と 2.1.240 が同居していた）。
        if let Some(h) = home.as_ref() {
            known.push(h.join(".local").join("bin"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from) {
            known.push(local.join("Microsoft").join("WinGet").join("Links"));
            known.push(local.join("Programs").join("OpenAI").join("Codex").join("bin"));
            known.push(local.join("Programs").join("Ollama"));
            known.push(local.join("Kiro-Cli"));
            // winget 本体（App Execution Alias）。PATH から漏れている PC では
            // フォールバック側の winget install が「起動すらできない」になる。
            known.push(local.join("Microsoft").join("WindowsApps"));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from) {
            known.push(pf.join("nodejs"));
            known.push(pf.join("PowerShell").join("7"));
        }
        if let Some(sysroot) = std::env::var_os("SystemRoot").map(std::path::PathBuf::from) {
            // Windows PowerShell 5.1 本体。System32 が PATH にあっても、この
            // サブディレクトリが無いと powershell.exe は解決できない（実測）。
            known.push(
                sysroot
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0"),
            );
        }
        if let Some(appdata) = std::env::var_os("APPDATA").map(std::path::PathBuf::from) {
            // npm -g のシム置き場（gemini / opencode / qwen / codex-acp 等）。最後に置く。
            known.push(appdata.join("npm"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // 公式インストーラ（claude.ai/install.sh）の置き場を最優先で見る
        if let Some(h) = home.as_ref() {
            known.push(h.join(".local/bin"));
        }
        known.push(std::path::PathBuf::from("/opt/homebrew/bin"));
        known.push(std::path::PathBuf::from("/opt/homebrew/sbin"));
        known.push(std::path::PathBuf::from("/usr/local/bin"));
        known.push(std::path::PathBuf::from("/usr/local/sbin"));
        known.push(std::path::PathBuf::from("/snap/bin"));
        // Linuxbrew（Linux 版 Homebrew）
        known.push(std::path::PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
        known.push(std::path::PathBuf::from("/home/linuxbrew/.linuxbrew/sbin"));
        if let Some(h) = home.as_ref() {
            known.push(h.join(".npm-global/bin"));
            known.push(h.join(".volta/bin"));
            known.push(h.join(".bun/bin"));
            known.push(h.join(".deno/bin"));
            known.push(h.join(".cargo/bin"));
            // Node / ツールのバージョンマネージャ各種。
            // どれか1つでも使っていると、GUI 起動時の最小 PATH からは全部見えない。
            known.push(h.join(".local/share/pnpm"));
            known.push(h.join(".asdf/shims"));
            known.push(h.join(".local/share/mise/shims"));
            known.push(h.join(".nodenv/shims"));
            known.push(h.join(".local/share/fnm/aliases/default/bin"));
            known.push(h.join("Library/Application Support/fnm/aliases/default/bin"));
            known.push(h.join(".linuxbrew/bin"));
            // nvm は複数バージョンが並ぶ。名前順で最後（＝概ね最新）を1つだけ足す。
            let nvm = h.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(&nvm) {
                let mut versions: Vec<std::path::PathBuf> =
                    entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                versions.sort();
                if let Some(latest) = versions.last() {
                    known.push(latest.join("bin"));
                }
            }
        }
    }

    if let Some(joined) = merge_path_dirs(&mut dirs, known) {
        std::env::set_var("PATH", joined);
    }
}

/// `dirs`（現在の PATH）に `known` の中で「実在し、まだ入っていない」ものだけを
/// **末尾へ**足して、新しい PATH 文字列を返す。足すものが無ければ None。
///
/// 末尾に足すのは、ユーザーが自分で通した PATH の解決順を壊さないため
/// （先頭に入れると、意図的に別バージョンを前に置いている環境を壊す）。
fn merge_path_dirs(
    dirs: &mut Vec<std::path::PathBuf>,
    known: Vec<std::path::PathBuf>,
) -> Option<std::ffi::OsString> {
    let mut added = false;
    for dir in known {
        if !dir.is_dir() {
            continue;
        }
        if dirs.iter().any(|d| d == &dir) {
            continue;
        }
        dirs.push(dir);
        added = true;
    }
    if !added {
        return None;
    }
    std::env::join_paths(dirs.iter()).ok()
}

pub fn build_silent_command(program: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        if let Some(resolved) = resolve_on_path(program) {
            let mut cmd = Command::new(resolved);
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd;
        }
    }
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// ANSIエスケープ（CSI/OSC等）を素朴に除去する。regex依存なし。
fn strip_ansi_simple(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ ... 終端は @-~
            Some('[') => {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL または ESC \
            Some(']') => {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            // 2文字エスケープ（ESC = / ESC > 等）
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}


// ===== CLI 検出の実機プローブ（監査用・普段は走らせない） =====
//
// 実行: cargo test --lib probe_all_clis -- --ignored --nocapture
// PATH を最小（macOS の Finder 起動を模した状態）にしてから augment_cli_path() を呼び、
// 各 CLI が「解決できるか」「実際に起動できるか」を実測する。
// CI では環境に CLI が無いため #[ignore]。手元で導入経路を変えたとき等に使う。
#[cfg(test)]
mod cli_detection_probe {
    use super::{build_silent_command, resolve_on_path};

    #[test]
    #[ignore = "実機の CLI 導入状況に依存する診断用"]
    fn probe_all_clis() {
        let names = [
            "claude", "codex", "gemini", "npm", "node", "ollama", "opencode",
            "qwen", "goose", "kiro-cli", "kimi", "grok", "codex-acp", "winget", "powershell",
        ];
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        // 最小 PATH（macOS の Finder 起動を模す）にしてから augment_cli_path を呼び、
        // それでも全部見つかるかを確かめる。
        let original = std::env::var_os("PATH").unwrap_or_default();
        std::env::set_var("PATH", r"C:\Windows\System32;C:\Windows");
        println!("
=== フェーズA: 最小PATH・augment なし（既知パス探索だけで解決できるか）===");
        for n in names {
            let r = resolve_on_path(n)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "<NOT RESOLVED>".into());
            println!("{:<12} {}", n, r);
        }

        super::augment_cli_path();
        println!("
=== PATH after augment ===
{}", std::env::var("PATH").unwrap_or_default());
        println!("
=== resolve_on_path + spawn probe (最小PATH + augment) ===");
        // 最後に元の PATH へ戻す（他テストへ影響させない）
        struct Restore(std::ffi::OsString);
        impl Drop for Restore {
            fn drop(&mut self) {
                std::env::set_var("PATH", &self.0);
            }
        }
        let _restore = Restore(original);
        for n in names {
            let resolved = resolve_on_path(n)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "<NOT RESOLVED>".into());
            let spawn = rt.block_on(async {
                let out = build_silent_command(n).arg("--version").output().await;
                match out {
                    Ok(o) => format!(
                        "exit={} stdout={:?}",
                        o.status.code().map(|c| c.to_string()).unwrap_or("?".into()),
                        String::from_utf8_lossy(&o.stdout).trim().chars().take(40).collect::<String>()
                    ),
                    Err(e) => format!("SPAWN ERROR: {:?} ({})", e.kind(), e),
                }
            });
            println!("{:<12} resolve={:<70} {}", n, resolved, spawn);
        }
    }
}

#[cfg(test)]
#[cfg(target_os = "windows")]
mod find_executable_tests {
    use super::find_executable_in_dir;

    /// 🚨 回帰テスト: npm -g のシムは `<name>.cmd`。ここが .exe 決め打ちだと
    /// PATH に npm の置き場が無い環境で gemini / opencode / qwen を取りこぼし、
    /// 「インストールしたのに未インストール」になる（Codex 監査の指摘）。
    #[test]
    fn finds_cmd_shim_not_only_exe() {
        let dir = std::env::temp_dir().join("unicrew-find-exe-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("probe_tool.cmd"), b"@echo off\r\n").unwrap();

        let found = find_executable_in_dir(&dir, "probe_tool");
        assert!(
            found.is_some(),
            ".cmd シムを見つけられない（npm -g で入れた CLI を取りこぼす）"
        );
        assert!(found.unwrap().to_string_lossy().to_lowercase().ends_with(".cmd"));

        assert!(
            find_executable_in_dir(&dir, "no_such_tool").is_none(),
            "存在しないものを見つけたことにしている"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod path_merge_tests {
    use super::merge_path_dirs;
    use std::path::PathBuf;

    #[test]
    fn adds_existing_dir_once_and_skips_missing_and_duplicates() {
        let tmp = std::env::temp_dir();
        let missing = tmp.join("unicrew-does-not-exist-9f3a");
        let mut dirs: Vec<PathBuf> = vec![PathBuf::from("/already/in/path")];

        // 実在するもの1つ + 実在しないもの + 同じものの重複
        let merged = merge_path_dirs(
            &mut dirs,
            vec![tmp.clone(), missing.clone(), tmp.clone()],
        );
        assert!(merged.is_some(), "実在ディレクトリが1つあるのに追記されない");
        assert_eq!(
            dirs.iter().filter(|d| **d == tmp).count(),
            1,
            "同じディレクトリが2回入っている"
        );
        assert!(!dirs.iter().any(|d| *d == missing), "実在しないディレクトリを足している");
        // 既存の解決順を壊さない（末尾に足す）
        assert_eq!(dirs[0], PathBuf::from("/already/in/path"));

        // 2回目は足すものが無いので None
        assert!(
            merge_path_dirs(&mut dirs, vec![tmp.clone()]).is_none(),
            "既に入っているのに再追記しようとしている"
        );
    }
}

#[cfg(test)]
mod install_lock_tests {
    use super::{try_acquire_install_lock, InstallLock};
    use std::sync::atomic::{AtomicBool, Ordering};

    static TEST_FLAG: AtomicBool = AtomicBool::new(false);

    #[test]
    fn second_acquire_is_refused_and_released_on_drop() {
        // 1本目は取れる
        let first: Option<InstallLock> = try_acquire_install_lock(&TEST_FLAG);
        assert!(first.is_some(), "1本目のロックが取れない");
        assert!(TEST_FLAG.load(Ordering::SeqCst));

        // 走行中の2本目は弾く（＝winget/install.ps1 の同時実行を防ぐ）
        assert!(
            try_acquire_install_lock(&TEST_FLAG).is_none(),
            "走行中なのに2本目のインストーラが起動できてしまう"
        );

        // drop で必ず解放（失敗・パニック経路でも詰まらない）
        drop(first);
        assert!(!TEST_FLAG.load(Ordering::SeqCst));

        // 解放後は再度取れる（リトライ可能）
        let again = try_acquire_install_lock(&TEST_FLAG);
        assert!(again.is_some(), "解放後に再取得できない");
    }
}

#[cfg(test)]
mod path_norm_tests {
    use super::{expand_user_path, percent_decode_utf8};

    #[test]
    fn percent_decode_fullwidth_parens() {
        assert_eq!(percent_decode_utf8("AB%EF%BC%88x%EF%BC%89"), "AB（x）");
    }

    #[test]
    fn percent_decode_noop_when_no_percent() {
        assert_eq!(percent_decode_utf8("plain/path.png"), "plain/path.png");
    }

    #[test]
    fn percent_decode_keeps_literal_when_invalid() {
        assert_eq!(percent_decode_utf8("100%zz"), "100%zz");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn wsl_mnt_path_to_windows() {
        let p = expand_user_path("/mnt/d/work/icons/phone.png");
        assert_eq!(p.to_string_lossy(), "D:\\work\\icons\\phone.png");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn wsl_drive_root() {
        let p = expand_user_path("/mnt/c");
        assert_eq!(p.to_string_lossy(), "C:");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn non_wsl_unix_path_untouched_as_pathbuf() {
        // /mnt 以外の Unix 絶対パスはそのまま
        let p = expand_user_path("/usr/local/bin");
        assert_eq!(p.to_string_lossy(), "/usr/local/bin");
    }
}

#[cfg(test)]
mod login_helper_tests {
    use super::{find_first_url, strip_ansi_simple};

    #[test]
    fn strip_ansi_removes_csi_and_osc() {
        let raw = "\u{1b}[2J\u{1b}[1;1H\u{1b}]0;title\u{7}Opening browser to sign in…\u{1b}[0m";
        assert_eq!(strip_ansi_simple(raw), "Opening browser to sign in…");
    }

    #[test]
    fn strip_ansi_passes_plain_text() {
        assert_eq!(strip_ansi_simple("Login successful."), "Login successful.");
    }

    #[test]
    fn find_url_extracts_oauth_url() {
        let text = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here";
        assert_eq!(
            find_first_url(text).as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&state=abc")
        );
    }

    #[test]
    fn find_url_rejects_tiny_fragment() {
        assert_eq!(find_first_url("see https:// for info"), None);
        assert_eq!(find_first_url("no url here"), None);
    }
}

/// 蓄積テキストから最初の https:// URL を抜き出す。
fn find_first_url(text: &str) -> Option<String> {
    let idx = text.find("https://")?;
    let tail = &text[idx..];
    let end = tail
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .unwrap_or(tail.len());
    let url = &tail[..end];
    // OAuth URLとして妥当な長さのみ採用（描画断片の誤検出を避ける）
    if url.len() > 12 {
        Some(url.to_string())
    } else {
        None
    }
}

#[tauri::command]
async fn start_claude_login(app: AppHandle) -> Result<(), String> {
    // 旧実装はパイプ（非TTY）で `claude` を起動していたが、現行 claude CLI は
    // 非TTYだと print モード扱いになり対話ログインが一切始まらない（無出力で終了
    // →「ログインに失敗しました」）。TTY必須のため PTY 上で
    // `claude auth login --claudeai` を実行する。CLI 自身がブラウザを開き、
    // フォールバックURLも出力するので、それを検出して UI に渡す。
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    #[cfg(target_os = "windows")]
    let resolved = resolve_on_path("claude")
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "claude".to_string());
    #[cfg(not(target_os = "windows"))]
    let resolved = "claude".to_string();

    let pty = native_pty_system();
    // cols は OAuth URL（400文字超）が折り返されないよう大きく取る
    let pair = pty
        .openpty(PtySize {
            rows: 40,
            cols: 512,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty 失敗: {e}"))?;

    let mut cmd = CommandBuilder::new(&resolved);
    cmd.arg("auth");
    cmd.arg("login");
    cmd.arg("--claudeai");
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Claude Code の起動に失敗しました: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader 失敗: {e}"))?;

    let app_clone = app.clone();
    // portable-pty は同期IOのため std::thread で読む（pty.rs と同方針）
    std::thread::spawn(move || {
        // master を thread 内で生かしておく（drop すると PTY が閉じる）
        let master = pair.master;
        let mut acc = String::new();
        let mut emitted_len = 0usize;
        let mut opened = false;
        let mut success = false;
        let mut buf = [0u8; 8192];
        use std::io::Read;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                    let clean = strip_ansi_simple(&acc);
                    // 新規分の行をUIへ（デバッグ表示用）
                    let from = emitted_len.min(clean.len());
                    for line in clean[from..].lines() {
                        let t = line.trim();
                        if !t.is_empty() {
                            let _ = app_clone.emit("claude_login:line", t.to_string());
                        }
                    }
                    emitted_len = clean.len();
                    if !opened {
                        if let Some(url) = find_first_url(&clean) {
                            opened = true;
                            // CLI 自身がブラウザを開くため、ここでは開かず URL を UI に
                            // 渡すだけにする（二重タブ防止。開かない環境はリンク押下）。
                            let _ = app_clone
                                .emit("claude_login:browser_opened", url.clone());
                        }
                    }
                    if !success
                        && (clean.contains("Login successful")
                            || clean.contains("Logged in")
                            || clean.contains("ログインに成功"))
                    {
                        success = true;
                    }
                }
                Err(_) => break,
            }
        }
        let exit_ok = child.wait().map(|s| s.success()).unwrap_or(false);
        let _ = app_clone.emit("claude_login:done", success || exit_ok);
        drop(master);
    });

    Ok(())
}

/// インストールコマンドを隠しウィンドウで実行し、stdout / stderr の両方を
/// 指定イベント（`claude_install:line` / `codex_install:line` 等）としてフロントに流す。
/// 終了コード成功なら true。
/// （旧実装は stderr を読み捨てており、失敗理由がユーザーに見えなかった）
#[cfg(target_os = "windows")]
async fn run_streamed_install_to(
    app: &AppHandle,
    event: &'static str,
    program: &str,
    args: &[&str],
) -> bool {
    let mut cmd = build_silent_command(program);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(event, format!("{program} の起動に失敗しました: {e}"));
            return false;
        }
    };
    if let Some(out) = child.stdout.take() {
        let a = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut r = BufReader::new(out).lines();
            while let Ok(Some(l)) = r.next_line().await {
                let _ = a.emit(event, l);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let a = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut r = BufReader::new(err).lines();
            while let Ok(Some(l)) = r.next_line().await {
                let _ = a.emit(event, l);
            }
        });
    }
    matches!(child.wait().await, Ok(s) if s.success())
}

/// 後方互換ラッパ: Claude 用の既存呼び出し（claude_install:line 固定）。
#[cfg(target_os = "windows")]
async fn run_streamed_install(app: &AppHandle, program: &str, args: &[&str]) -> bool {
    run_streamed_install_to(app, "claude_install:line", program, args).await
}

#[tauri::command]
async fn install_claude_code(app: AppHandle) -> Result<(), String> {
    // 多重起動ガード（詳細は InstallLock のコメント）。実行中の再呼び出しは
    // 新しいインストーラを起こさず、進捗行だけ返して黙って握りつぶす。
    // ここで done を emit してはいけない（走行中の本物のインストールの UI が
    // 失敗表示に化ける）。
    let Some(lock) = try_acquire_install_lock(&CLAUDE_INSTALL_RUNNING) else {
        let _ = app.emit(
            "claude_install:line",
            "インストールは既に実行中です。完了までお待ちください…".to_string(),
        );
        return Ok(());
    };

    #[cfg(target_os = "windows")]
    {
        // ワンクリックインストール（Windows）— 2026-08 の公式仕様に追従:
        //   第1経路: 公式ネイティブインストーラ irm https://claude.ai/install.ps1 | iex
        //            （公式の「推奨」。管理者不要・Node 不要・**バックグラウンド自動更新あり**。
        //              %USERPROFILE%\.local\bin に入る）
        //   第2経路: winget (Anthropic.ClaudeCode)
        //            （PowerShell が制限された PC の救済。winget 版は自動更新されない）
        // どちらも完了後に resolve_on_path("claude") で「本当に検出できるか」を検証して
        // から done を通知する（インストーラの成功コードだけを信用しない）。
        let app_done = app.clone();
        tauri::async_runtime::spawn(async move {
            // 完了（成功/失敗どちらでも）でロック解放。
            let _lock = lock;
            let ps_ok = run_streamed_install(
                &app_done,
                "powershell",
                &[
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "irm https://claude.ai/install.ps1 | iex",
                ],
            )
            .await;
            let mut success = ps_ok && resolve_on_path("claude").is_some();
            if !success {
                let _ = app_done.emit(
                    "claude_install:line",
                    "公式インストーラでの導入に失敗または検出できませんでした。winget で再試行します…"
                        .to_string(),
                );
                let winget_ok = run_streamed_install(
                    &app_done,
                    "winget",
                    &[
                        "install",
                        "--silent",
                        "--id",
                        "Anthropic.ClaudeCode",
                        "--accept-source-agreements",
                        "--accept-package-agreements",
                    ],
                )
                .await;
                success = winget_ok && resolve_on_path("claude").is_some();
            }
            let _ = app_done.emit("claude_install:done", success);
        });

        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        // macOS の .app を Finder/Dock から起動すると、ユーザーのシェル PATH
        // （.zshrc 等）を継承せず最小 PATH（/usr/bin:/bin:...）になる。
        // そのままだと brew も npm も見つからずインストールボタンが
        // 「押しても無反応」になる。Homebrew(arm64/x86)・Volta・npm-global・
        // nvm の代表 bin を PATH 先頭に足してから実行する。
        // Try Homebrew first; fall back to npm.
        let mut cmd = build_silent_command("sh");
        cmd.args([
            "-c",
            // 🚨 旧 tap `anthropic-ai/claude-code` は 2026-08 時点で GitHub 404＝消滅済み。
            // 現行公式: ①ネイティブインストーラ（推奨・自動更新あり・~/.local/bin）
            //           ②brew install --cask claude-code ③npm（最後の砦）。
            // curl は最小 PATH でも /usr/bin にあるため、GUI 起動（Finder/Dock）でも確実に動く。
            // 🚨 `sort -V` は使わない。macOS の BSD sort には無い環境があり、その場合
            // nvm の bin が PATH に入らず npm フォールバックが動かない（監査指摘）。
            // どのバージョンでも npm さえ動けばよいので単純な `sort | tail -1` で足りる。
            // 🚨 末尾の `command -v claude` が成功判定（実在確認）。Windows 側の
            // resolve_on_path("claude") と同じ基準にそろえてある。
            "export PATH=\"/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.npm-global/bin:$([ -d \"$HOME/.nvm/versions/node\" ] && ls -d \"$HOME\"/.nvm/versions/node/*/bin 2>/dev/null | sort | tail -1):$PATH\"; curl -fsSL https://claude.ai/install.sh | bash || { command -v brew >/dev/null 2>&1 && brew install --cask claude-code; } || npm install -g @anthropic-ai/claude-code; command -v claude >/dev/null 2>&1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        // 🚨 stderr も必ず読み切る。piped にしたまま放置すると OS の pipe バッファが
        // 埋まった時点でインストーラが書き込みでブロックし、child.wait() が返らず
        // done も出ず InstallLock も解放されない（＝アプリ再起動まで再試行不能）。
        if let Some(stderr) = child.stderr.take() {
            let app_err = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app_err.emit("claude_install:line", line);
                }
            });
        }
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_clone.emit("claude_install:line", line);
            }
        });
        let app_done = app.clone();
        tauri::async_runtime::spawn(async move {
            let _lock = lock;
            let exit = child.wait().await;
            let success = matches!(&exit, Ok(s) if s.success());
            let _ = app_done.emit("claude_install:done", success);
        });
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux: npm 経由でユーザースコープにインストール。
        // `sudo` を使わずに済むよう NPM_CONFIG_PREFIX=$HOME/.npm-global を設定。
        // PATH に `~/.npm-global/bin` が無いとログイン後でも CLI が見えない可能性が
        // あるため、失敗時は SettingsModal の InstallFailedFallback で手動コマンドが出る。
        let mut cmd = build_silent_command("sh");
        cmd.args([
            "-c",
            // 第1経路: 公式ネイティブインストーラ（推奨・Node 不要・自動更新あり）。
            // 第2経路: npm。sudo を避けるため NPM_CONFIG_PREFIX=$HOME/.npm-global に入れる。
            // 🚨 成功判定は終了コードではなく最後の `command -v claude`（＝実在確認）。
            // インストーラが 0 で終わっても claude が見つからない場所に入ると、
            // done(true) なのにステータスは「未インストール」のままでユーザーが詰む。
            "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$PATH\"; \
             curl -fsSL https://claude.ai/install.sh | bash || { \
               mkdir -p \"$HOME/.npm-global\" && \
               NPM_CONFIG_PREFIX=\"$HOME/.npm-global\" \
               npm install -g @anthropic-ai/claude-code; }; \
             command -v claude >/dev/null 2>&1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        // 🚨 stderr も必ず読み切る。piped にしたまま放置すると OS の pipe バッファが
        // 埋まった時点でインストーラが書き込みでブロックし、child.wait() が返らず
        // done も出ず InstallLock も解放されない（＝アプリ再起動まで再試行不能）。
        if let Some(stderr) = child.stderr.take() {
            let app_err = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app_err.emit("claude_install:line", line);
                }
            });
        }
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_clone.emit("claude_install:line", line);
            }
        });
        let app_done = app.clone();
        tauri::async_runtime::spawn(async move {
            let _lock = lock;
            let exit = child.wait().await;
            let success = matches!(&exit, Ok(s) if s.success());
            let _ = app_done.emit("claude_install:done", success);
        });
        Ok(())
    }
}

// ---------- Codex CLI status & login ----------

#[derive(Debug, Serialize)]
struct CodexStatus {
    installed: bool,
    logged_in: bool,
    version: Option<String>,
    hint: String,
}

#[tauri::command]
async fn codex_status() -> Result<CodexStatus, String> {
    let mut cmd = build_silent_command("codex");
    cmd.arg("--version");
    let output = cmd.output().await;
    let (installed, version) = match output {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (true, Some(v))
        }
        _ => (false, None),
    };

    let logged_in = if installed {
        let home = std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOME").ok())
            .map(std::path::PathBuf::from);
        let candidates: Vec<std::path::PathBuf> = home
            .iter()
            .flat_map(|h| {
                vec![
                    h.join(".codex").join("auth.json"),
                    h.join(".codex").join("credentials.json"),
                    h.join(".codex").join(".credentials.json"),
                    h.join(".config").join("codex").join("auth.json"),
                ]
            })
            .collect();
        candidates.iter().any(|p| p.exists())
    } else {
        false
    };

    let hint = if !installed {
        "Codex CLI が見つかりません。先にインストールしてください。".into()
    } else if !logged_in {
        "Codex CLI はインストール済み。次は『Codex にログイン』を押してください。".into()
    } else {
        "準備OK。ChatGPT のサブスクリプションで Codex が動作します。".into()
    };

    Ok(CodexStatus {
        installed,
        logged_in,
        version,
        hint,
    })
}

#[tauri::command]
async fn install_codex(app: AppHandle) -> Result<(), String> {
    // 多重起動ガード（Claude と同じ理由。install.ps1 と npm が重なる事故を防ぐ）
    let Some(lock) = try_acquire_install_lock(&CODEX_INSTALL_RUNNING) else {
        let _ = app.emit(
            "codex_install:line",
            "インストールは既に実行中です。完了までお待ちください…".to_string(),
        );
        return Ok(());
    };

    // Codex 導入 — 2026-08 の公式仕様に追従。
    // 公式が推奨するのはスタンドアロンインストーラ（Node 不要）:
    //   Win: irm https://chatgpt.com/codex/install.ps1 | iex
    //   mac/Linux: curl -fsSL https://chatgpt.com/codex/install.sh | sh
    // フォールバックに npm（旧来経路・Node が要る）。
    // 完了判定は Claude と同じく resolve_on_path("codex") の実検出で行う。
    #[cfg(target_os = "windows")]
    {
        let app_done = app.clone();
        tauri::async_runtime::spawn(async move {
            let _lock = lock;
            let ps_ok = run_streamed_install_to(
                &app_done,
                "codex_install:line",
                "powershell",
                &[
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    "irm https://chatgpt.com/codex/install.ps1 | iex",
                ],
            )
            .await;
            let mut success = ps_ok && resolve_on_path("codex").is_some();
            if !success {
                let _ = app_done.emit(
                    "codex_install:line",
                    "公式インストーラでの導入に失敗または検出できませんでした。npm で再試行します…"
                        .to_string(),
                );
                let npm_ok = run_streamed_install_to(
                    &app_done,
                    "codex_install:line",
                    "npm",
                    &["install", "-g", "@openai/codex"],
                )
                .await;
                success = npm_ok && resolve_on_path("codex").is_some();
            }
            let _ = app_done.emit("codex_install:done", success);
        });
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // mac/Linux: 公式インストーラ → npm フォールバック。
        // macOS の GUI 起動は最小 PATH のため、Claude と同じ PATH 前置を行う。
        let mut cmd = build_silent_command("sh");
        cmd.args([
            "-c",
            // 導入後の実在確認まで shell 内で行う（resolve_on_path は Windows 専用 cfg。
            // 2026-08-14: 非 Windows から呼んで CI の mac/Linux ビルドが E0425 で落ちた）。
            "export PATH=\"/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.npm-global/bin:$PATH\"; { curl -fsSL https://chatgpt.com/codex/install.sh | sh || npm install -g @openai/codex; } && command -v codex >/dev/null 2>&1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("インストーラの起動に失敗しました: {}", e))?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        // stderr も読み切る（理由は install_claude_code 側の同じコメントを参照）
        if let Some(stderr) = child.stderr.take() {
            let app_err = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = app_err.emit("codex_install:line", line);
                }
            });
        }

        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_clone.emit("codex_install:line", line);
            }
        });

        let app_done = app.clone();
        tauri::async_runtime::spawn(async move {
            let _lock = lock;
            let exit = child.wait().await;
            // 実在確認は上の sh スクリプト末尾の `command -v codex` が担う
            let success = matches!(&exit, Ok(s) if s.success());
            let _ = app_done.emit("codex_install:done", success);
        });
        Ok(())
    }
}

#[tauri::command]
async fn start_codex_login(app: AppHandle) -> Result<(), String> {
    let mut cmd = build_silent_command("codex");
    cmd.arg("login");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Codex CLI の起動に失敗しました: {}", e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut opened = false;
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("codex_login:line", &line);
            if !opened {
                for prefix in ["https://", "http://"].iter() {
                    if let Some(idx) = line.find(prefix) {
                        let tail = &line[idx..];
                        let end = tail
                            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                            .unwrap_or(tail.len());
                        let url = &tail[..end];
                        if let Err(e) = tauri_plugin_shell::ShellExt::shell(&app_clone)
                            .open(url, None)
                        {
                            let _ = app_clone.emit(
                                "codex_login:line",
                                format!("ブラウザを開けませんでした: {}", e),
                            );
                        } else {
                            opened = true;
                            let _ =
                                app_clone.emit("codex_login:browser_opened", url.to_string());
                        }
                        break;
                    }
                }
            }
        }
    });

    let app_err = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit("codex_login:stderr", line);
        }
    });

    let app_done = app.clone();
    tauri::async_runtime::spawn(async move {
        let exit = child.wait().await;
        let success = matches!(&exit, Ok(s) if s.success());
        let _ = app_done.emit("codex_login:done", success);
    });
    Ok(())
}

// ---------- Gemini (CLI) status & install ----------

#[derive(Debug, Serialize)]
struct GeminiStatus {
    installed: bool,
    /// gemini-cli の OAuth ログイン or `GEMINI_API_KEY` env のいずれかで使える状態
    logged_in: bool,
    version: Option<String>,
    /// API キー（`GEMINI_API_KEY` env）が現在セットされてるか。UIでは「APIキーモードで使える」と表示
    has_api_key_env: bool,
    hint: String,
}

#[tauri::command]
async fn gemini_status() -> Result<GeminiStatus, String> {
    let mut cmd = build_silent_command("gemini");
    cmd.arg("--version");
    let output = cmd.output().await;
    let (installed, version) = match output {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (true, Some(v))
        }
        _ => (false, None),
    };

    let logged_in = if installed {
        // gemini-cli の OAuth は `~/.gemini/oauth_creds.json` 等に保存される
        let home = std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOME").ok())
            .map(std::path::PathBuf::from);
        let candidates: Vec<std::path::PathBuf> = home
            .iter()
            .flat_map(|h| {
                vec![
                    h.join(".gemini").join("oauth_creds.json"),
                    h.join(".gemini").join("credentials.json"),
                    h.join(".config").join("gemini").join("oauth_creds.json"),
                ]
            })
            .collect();
        candidates.iter().any(|p| p.exists())
    } else {
        false
    };

    let has_api_key_env = std::env::var("GEMINI_API_KEY")
        .ok()
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    let hint = if !installed {
        "Gemini CLI が見つかりません。先にインストールしてください。".into()
    } else if !logged_in && !has_api_key_env {
        "Gemini CLI はインストール済み。OAuth ログインまたは API キー登録が必要です。".into()
    } else {
        "準備OK。Gemini が利用可能です。".into()
    };

    Ok(GeminiStatus {
        installed,
        logged_in,
        version,
        has_api_key_env,
        hint,
    })
}

#[tauri::command]
async fn install_gemini(app: AppHandle) -> Result<(), String> {
    // 多重起動ガード（詳細は InstallLock のコメント）。npm の global install を
    // 並行させるとキャッシュとリンク先を取り合う。
    let Some(lock) = try_acquire_install_lock(&GEMINI_INSTALL_RUNNING) else {
        let _ = app.emit(
            "gemini_install:line",
            "インストールは既に実行中です。完了までお待ちください…".to_string(),
        );
        return Ok(());
    };

    // gemini-cli は npm 配布。`@google/gemini-cli`。
    let mut cmd = build_silent_command("npm");
    cmd.args(["install", "-g", "@google/gemini-cli"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("npm の起動に失敗しました: {}", e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("gemini_install:line", line);
        }
    });
    let app_clone2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone2.emit("gemini_install:line", line);
        }
    });
    let app_done = app.clone();
    tauri::async_runtime::spawn(async move {
        let _lock = lock;
        let exit = child.wait().await;
        // 終了コード + 実在確認の両方で成功判定する
        let success = matches!(&exit, Ok(s) if s.success()) && cli_is_available("gemini").await;
        let _ = app_done.emit("gemini_install:done", success);
    });
    Ok(())
}

// ---------- ACP / OSS CLI status & install ----------
//
// L3（業界標準 ACP）プロバイダ + ローカル LLM ランタイム（Ollama）の
// installed/version 検出と自動インストール。1コマンドで provider 引数を切り替える
// 統一API。既存の claude/codex/gemini 系個別コマンドと並列に動く。
//
// 対応プロバイダ:
//   - "goose"    : Block 製 OSS、`goose --version` で検出、winget install Block.Goose
//   - "opencode" : sst 製 OSS、`opencode --version` で検出、npm install -g opencode-ai
//   - "ollama"   : ローカル LLM ランタイム、`ollama --version` で検出、winget install Ollama.Ollama
//
// 進捗イベント: 全 provider 共通で `acp_install:line` / `acp_install:done` を emit
// （payload に provider 名を含むため UI 側で振り分け可能）。

#[derive(Debug, Serialize)]
struct AcpCliStatus {
    provider: String,
    installed: bool,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct AcpInstallLine {
    provider: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
struct AcpInstallDone {
    provider: String,
    success: bool,
}

fn acp_cli_command_name(provider: &str) -> Option<&'static str> {
    match provider {
        "goose" => Some("goose"),
        "opencode" => Some("opencode"),
        "ollama" => Some("ollama"),
        // detection 専用（install_acp_cli は manual install のみ）
        "codex-acp" => Some("codex-acp"),
        "kiro" => Some("kiro-cli"),
        // Qwen Code（Sprint 3）。ACP ではないが、CLI install/status 検出は同じ仕組みに乗せる。
        "qwen" => Some("qwen"),
        // Kimi Code（Sprint 3）。ACP 対応（kimi acp）。Python+uv ベースで自動 install 非対応 → manual 枠。
        "kimi" => Some("kimi"),
        // Grok CLI（xAI 公式・2026-08-27）。ACP 対応（grok agent stdio）。npm 配布で auto install 可。
        "grok" => Some("grok"),
        // Cursor Agent（2026-08-27）。stream-json 経路。Windows ネイティブ版が無いため
        // ここでの検出は mac/Linux 用（Windows は WSL 内にあれば実行はできるが検出は未対応）。
        "cursor" => Some("cursor-agent"),
        _ => None,
    }
}

#[tauri::command]
async fn acp_cli_status(provider: String) -> Result<AcpCliStatus, String> {
    let bin = acp_cli_command_name(&provider)
        .ok_or_else(|| format!("unknown acp cli: {}", provider))?;

    // Step 1: バイナリ存在確認。PATH 探索 + 既知 install location フォールバック。
    // 見つかれば installed=true。`--version` 未対応バイナリ（codex-acp 等）もここで救う。
    #[cfg(target_os = "windows")]
    let exists = resolve_on_path(bin).is_some();
    #[cfg(not(target_os = "windows"))]
    let exists = {
        // Unix: `which`/path 確認は std で完結。`Command::new(bin).spawn()` を試して
        // NotFound 系 error なら installed=false、それ以外（exit !=0 でも）は installed=true。
        let probe = build_silent_command(bin).arg("--version").output().await;
        match probe {
            Ok(_) => true,
            Err(e) => !matches!(e.kind(), std::io::ErrorKind::NotFound),
        }
    };

    if !exists {
        return Ok(AcpCliStatus {
            provider,
            installed: false,
            version: None,
        });
    }

    // Step 2: バージョン取得は best-effort。--version 非対応のバイナリでも installed は維持。
    let probe = build_silent_command(bin).arg("--version").output().await;
    let version = match probe {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let v = if v.is_empty() {
                String::from_utf8_lossy(&o.stderr).trim().to_string()
            } else {
                v
            };
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        }
        _ => None,
    };

    Ok(AcpCliStatus {
        provider,
        installed: true,
        version,
    })
}

/// インストールコマンドを (program, args) に解決する。
///
/// OS 非対応の組み合わせは `Err` を返し、UI 側で外部リンクへ誘導する。
/// winget は Windows 10 1809+ で標準搭載、npm は UNICREW 自身が Node 必須なので OK。
fn resolve_acp_install_command(provider: &str) -> Result<(String, Vec<String>), String> {
    match provider {
        "opencode" => {
            // sst/opencode は npm パッケージ。Node が無い環境では npm 自体が失敗するが
            // UNICREW は npm 前提（Claude/Codex CLI 自動 install と同じ前提）。
            Ok((
                "npm".to_string(),
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "opencode-ai".to_string(),
                ],
            ))
        }
        "codex-acp" => {
            // zed-industries/codex-acp は npm パッケージ。`codex-acp` バイナリが
            // PATH に出る。実行時に OPENAI_API_KEY env が必要だが、install 自体は
            // npm のみで完結する。
            Ok((
                "npm".to_string(),
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "@zed-industries/codex-acp".to_string(),
                ],
            ))
        }
        "goose" => Err(
            "Goose の自動インストールは未対応です（winget 公式パッケージ未提供、ZIP/PowerShell 手動配置が必要）。https://block.github.io/goose/docs/getting-started/installation から手動でインストールしてください。"
                .to_string(),
        ),
        "ollama" => {
            #[cfg(target_os = "windows")]
            {
                Ok((
                    "winget".to_string(),
                    vec![
                        "install".to_string(),
                        "--id".to_string(),
                        "Ollama.Ollama".to_string(),
                        "--silent".to_string(),
                        "--accept-source-agreements".to_string(),
                        "--accept-package-agreements".to_string(),
                    ],
                ))
            }
            #[cfg(not(target_os = "windows"))]
            Err(
                "macOS/Linux の Ollama 自動インストールは未対応です。https://ollama.com/download から手動でインストールしてください。"
                    .to_string(),
            )
        }
        "kiro" => Err(
            "kiro-cli の自動インストールは未対応です。公式手順 https://kiro.dev/ を参照してください（AWS Builder ID 必須）。"
                .to_string(),
        ),
        "qwen" => {
            // QwenLM/qwen-code は npm パッケージ（Apache-2.0）。`qwen` バイナリが PATH に出る。
            // 実行時に DASHSCOPE_API_KEY env が必要。
            Ok((
                "npm".to_string(),
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "@qwen-code/qwen-code".to_string(),
                ],
            ))
        }
        "kimi" => Err(
            "Kimi Code CLI の自動インストールは未対応です。公式手順 https://code.kimi.com/ または `uv tool install kimi-cli` を使ってください（Python 3.12+ / uv 必須）。"
                .to_string(),
        ),
        "grok" => {
            // xAI 公式 Grok CLI。npm 配布（@xai-official/grok）。`grok` バイナリが PATH に出る。
            // 認証は初回に `grok login`（デバイスコード）を CLI 側で行う。
            Ok((
                "npm".to_string(),
                vec![
                    "install".to_string(),
                    "-g".to_string(),
                    "@xai-official/grok".to_string(),
                ],
            ))
        }
        "cursor" => Err(
            "Cursor Agent の自動インストールは未対応です。macOS/Linux/WSL で `curl https://cursor.com/install -fsS | bash` を実行してください（Windows ネイティブ版はありません。WSL 内に導入すれば UNICREW が WSL 経由で起動します）。"
                .to_string(),
        ),
        other => Err(format!("unknown acp cli: {}", other)),
    }
}

// ---------- Ollama model pull ----------
//
// 完全自動 Free モード（FreeModeWizard）が呼ぶ primitive。
// `ollama pull <model>` を spawn し、進捗を `ollama_pull:line` / `ollama_pull:done` で emit。
//
// Ollama 本体の install は `install_acp_cli("ollama")` で行う。順序は
//   1) install_acp_cli("ollama")  → winget 完了
//   2) ollama_pull("qwen2.5-coder:7b")  → 数GBダウンロード
//   3) install_acp_cli("opencode")  → npm 一瞬
//   4) agent_start(provider:"opencode", ...)
// を Wizard 側で順次叩く。

#[derive(Debug, Clone, Serialize)]
struct OllamaPullLine {
    model: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
struct OllamaPullDone {
    model: String,
    success: bool,
}

#[tauri::command]
async fn ollama_pull(app: AppHandle, model: String) -> Result<(), String> {
    // Ollama 本体が無いと NotFound で落ちる。Wizard 側で acp_cli_status("ollama")
    // を必ず先にチェックしている前提だが、ここでもバイナリ存在は確認しておく。
    // resolve_on_path は Windows 専用なので、cross-platform に動くよう --version probe を使う。
    let exists = {
        let probe = build_silent_command("ollama")
            .arg("--version")
            .output()
            .await;
        match probe {
            Ok(_) => true,
            Err(e) => !matches!(e.kind(), std::io::ErrorKind::NotFound),
        }
    };
    if !exists {
        return Err(
            "Ollama がインストールされていません。先にローカル/OSS 系で Ollama を導入してください。"
                .to_string(),
        );
    }

    let mut cmd = build_silent_command("ollama");
    cmd.arg("pull")
        .arg(&model)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("ollama pull の起動に失敗しました: {}", e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app_stdout = app.clone();
    let model_for_stdout = model.clone();
    let h_out = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_stdout.emit(
                "ollama_pull:line",
                OllamaPullLine {
                    model: model_for_stdout.clone(),
                    line,
                },
            );
        }
    });
    let app_err = app.clone();
    let model_for_stderr = model.clone();
    let h_err = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit(
                "ollama_pull:line",
                OllamaPullLine {
                    model: model_for_stderr.clone(),
                    line,
                },
            );
        }
    });
    let app_done = app.clone();
    let model_for_done = model.clone();
    tauri::async_runtime::spawn(async move {
        let exit = child.wait().await;
        let _ = h_out.await;
        let _ = h_err.await;
        let success = matches!(&exit, Ok(s) if s.success());
        let _ = app_done.emit(
            "ollama_pull:done",
            OllamaPullDone {
                model: model_for_done,
                success,
            },
        );
    });
    Ok(())
}

#[tauri::command]
async fn install_acp_cli(app: AppHandle, provider: String) -> Result<(), String> {
    let (program, args) = resolve_acp_install_command(&provider)?;

    // provider 単位の多重起動ガード（npm / winget の並行実行を防ぐ）
    let Some(lock) = try_acquire_acp_install_lock(&provider) else {
        let _ = app.emit(
            "acp_install:line",
            AcpInstallLine {
                provider: provider.clone(),
                line: "インストールは既に実行中です。完了までお待ちください…".to_string(),
            },
        );
        return Ok(());
    };

    let mut cmd = build_silent_command(&program);
    cmd.args(args.iter().map(|s| s.as_str()))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} の起動に失敗しました: {}", program, e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let app_stdout = app.clone();
    let provider_for_stdout = provider.clone();
    let h_out = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_stdout.emit(
                "acp_install:line",
                AcpInstallLine {
                    provider: provider_for_stdout.clone(),
                    line,
                },
            );
        }
    });
    let app_err = app.clone();
    let provider_for_stderr = provider.clone();
    let h_err = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit(
                "acp_install:line",
                AcpInstallLine {
                    provider: provider_for_stderr.clone(),
                    line,
                },
            );
        }
    });
    let app_done = app.clone();
    let provider_for_done = provider.clone();
    // child.wait() より先に stdout/stderr リーダーを drain させてから done を emit する。
    // 順番を逆にすると npm/winget の末尾行（"added N packages" 等）が done の後に届く。
    let bin_for_check = acp_cli_command_name(&provider_for_done).unwrap_or("");
    tauri::async_runtime::spawn(async move {
        let _lock = lock;
        let exit = child.wait().await;
        let _ = h_out.await;
        let _ = h_err.await;
        // 終了コード + 実在確認の両方で成功判定する（理由は cli_is_available 参照）
        let success = matches!(&exit, Ok(s) if s.success())
            && (bin_for_check.is_empty() || cli_is_available(bin_for_check).await);
        let _ = app_done.emit(
            "acp_install:done",
            AcpInstallDone {
                provider: provider_for_done,
                success,
            },
        );
    });
    Ok(())
}

// ---------- Agent (Pure CLI Conductor) ----------
//
// 旧版（unipilot）は Node sidecar 経由で `claude-agent-sdk` / `codex-sdk` を呼び出していた。
// 新版（unicrew 配布版）は Anthropic / OpenAI 公式 CLI を直接 subprocess として spawn し、
// stream-json で会話する Pure CLI Conductor 方式に統一。
//
// 詳細は DESIGN.md / AGENTS.md を参照。SDK は import しない（ToS 適合のため）。

#[derive(Default)]
struct AgentState {
    sessions: Mutex<HashMap<String, Box<dyn SessionHandle>>>,
    /// セッション ID → OTel span ハンドル。agent_start で追加し、agent_stop / drop で閉じる。
    spans: Mutex<HashMap<String, observability::SessionSpan>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AgentStartRequest {
    session_id: String,
    workspace: Option<String>,
    system_prompt: String,
    model: String,
    /// "subscription" (CLI が持つ OAuth) or "apikey"
    auth_mode: String,
    /// Required only when auth_mode == "apikey"
    api_key: Option<String>,
    /// "claude" (default) or "codex"
    #[serde(default = "default_provider")]
    provider: String,
    /// 既存 CLI セッションを再開する場合の CLI 側 session_id（任意）。
    /// Claude: `--resume <sid>` / Codex: `exec resume <sid>` に渡される。
    #[serde(default)]
    resume_cli_session_id: Option<String>,
    /// "acceptEdits"（既定）または "plan"。Shift+Tab で切替されるパーミッションモード。
    #[serde(default = "default_permission_mode")]
    permission_mode: String,
}

fn default_provider() -> String {
    "claude".to_string()
}

fn default_permission_mode() -> String {
    "acceptEdits".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
struct AgentSendRequest {
    session_id: String,
    text: String,
    /// 添付画像（パスのみ）。Claude 経路ではこれを base64 の image ブロックに
    /// して本物の画像として渡す。他プロバイダは無視する（従来どおり本文の
    /// パス行だけが渡る）。
    ///
    /// `serde(default)` なので、画像を送らない既存の呼び出しはそのまま通る。
    #[serde(default)]
    images: Vec<crate::providers::images::InputImage>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AgentStopRequest {
    session_id: String,
}

#[tauri::command]
async fn agent_start(
    app: AppHandle,
    state: State<'_, AgentState>,
    req: AgentStartRequest,
) -> Result<(), String> {
    let provider = build_provider(&req.provider)
        .ok_or_else(|| format!("unknown provider: {}", req.provider))?;

    let opts = SpawnOpts {
        session_id: req.session_id.clone(),
        workspace: req.workspace,
        system_prompt: req.system_prompt,
        model: req.model,
        auth_mode: AuthMode::from_str(&req.auth_mode),
        api_key: req.api_key,
        resume_cli_session_id: req.resume_cli_session_id,
        permission_mode: PermissionMode::from_str(&req.permission_mode),
    };

    // event channel: provider → ここ → React に emit
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<NormalizedEvent>();

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            // 旧 SidecarOut と同じ JSON 形式で emit（React 側を変えなくて済む）
            if let Ok(s) = serde_json::to_string(&ev) {
                let _ = app_clone.emit("agent:event", &s);
            }
        }
    });

    let provider_id: &'static str = match req.provider.as_str() {
        "claude" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        "goose" => "goose",
        "opencode" => "opencode",
        "codex-acp" => "codex-acp",
        "kiro" => "kiro",
        _ => "unknown",
    };
    let span = observability::start_session_span(req.session_id.clone(), provider_id);

    let handle = match provider.spawn_session(opts, tx).await {
        Ok(h) => h,
        Err(e) => {
            let msg = e.to_string();
            span.finish_err(&msg);
            return Err(msg);
        }
    };

    state
        .sessions
        .lock()
        .await
        .insert(req.session_id.clone(), handle);
    state.spans.lock().await.insert(req.session_id, span);
    Ok(())
}

#[tauri::command]
async fn agent_send(
    state: State<'_, AgentState>,
    req: AgentSendRequest,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&req.session_id)
        .ok_or_else(|| format!("session not found: {}", req.session_id))?;
    session
        .send_user_message_with_images(&req.text, &req.images)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn agent_permission_response(
    state: State<'_, AgentState>,
    session_id: String,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("session not found: {}", session_id))?;
    session
        .send_permission_response(&request_id, &decision)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn agent_stop(
    state: State<'_, AgentState>,
    req: AgentStopRequest,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(mut handle) = sessions.remove(&req.session_id) {
        // ブロックすると UI が固まるのでバックグラウンドで kill＋wait
        tauri::async_runtime::spawn(async move {
            let _ = handle.stop().await;
        });
    }
    drop(sessions);
    if let Some(span) = state.spans.lock().await.remove(&req.session_id) {
        span.finish_ok();
    }
    Ok(())
}

// ---------- Lightweight FS helpers (workspace-scoped is enforced by the Agent SDK cwd) ----------

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    let p = expand_user_path(&path);
    tokio::fs::read_to_string(&p)
        .await
        .map_err(|e| e.to_string())
}

/// 設計書③: workspace 配下で相対パス／裸ファイル名の実体を探索する。
/// 1) workspace/rel が存在すればそれを返す（絶対パスは呼び出し側でスキップ済み）
/// 2) 無ければ workspace 配下を BFS 探索し、rel をサフィックスとして含む最初の一致、
///    無ければベース名一致を返す。BFS（浅い階層優先）なので workspace 直下に近い
///    ものが優先される。見つからなければ None。
#[tauri::command]
async fn resolve_file_candidate(
    workspace: String,
    rel: String,
) -> Result<Option<String>, String> {
    let ws = expand_user_path(&workspace);
    let rel = rel.trim().to_string();
    if rel.is_empty() {
        return Ok(None);
    }
    let rel_clean = rel
        .trim_start_matches("./")
        .trim_start_matches(".\\")
        .to_string();
    let direct = ws.join(&rel_clean);
    if tokio::fs::try_exists(&direct).await.unwrap_or(false) {
        return Ok(Some(direct.to_string_lossy().into_owned()));
    }
    // 再帰探索はブロッキング IO なので専用スレッドで行う（ランタイムを塞がない）。
    let found = tokio::task::spawn_blocking(move || find_file_candidate(&ws, &rel_clean))
        .await
        .map_err(|e| e.to_string())?;
    Ok(found.map(|p| p.to_string_lossy().into_owned()))
}


/// パスの実在確認（③改: 実在しない絶対パスで壊れたエディタ画面を開かないための事前チェック）。
#[tauri::command]
async fn path_exists(path: String) -> Result<bool, String> {
    let p = expand_user_path(&path);
    Ok(tokio::fs::try_exists(&p).await.unwrap_or(false))
}

/// 設計書⑤: シェル情報（default_shell の返り値）。
#[derive(serde::Serialize, Clone)]
struct ShellInfo {
    program: String,
    args: Vec<String>,
    label: String,
}

/// 設計書⑤: ターミナルで claude 以外に bash 等のシェルを起動するための既定シェル解決。
/// Windows: Git Bash（明示パスのみ。System32 の bash.exe は WSL ランチャーなので使わない）
///          → PowerShell → %ComSpec%（cmd）。
/// macOS / Linux: $SHELL → /bin/bash。
#[tauri::command]
fn default_shell() -> Result<ShellInfo, String> {
    #[cfg(target_os = "windows")]
    {
        let mut git_bash: Vec<std::path::PathBuf> = Vec::new();
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            git_bash.push(
                std::path::PathBuf::from(&pf)
                    .join("Git")
                    .join("bin")
                    .join("bash.exe"),
            );
        }
        if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
            git_bash.push(
                std::path::PathBuf::from(&pf86)
                    .join("Git")
                    .join("bin")
                    .join("bash.exe"),
            );
        }
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            git_bash.push(
                std::path::PathBuf::from(&la)
                    .join("Programs")
                    .join("Git")
                    .join("bin")
                    .join("bash.exe"),
            );
        }
        for p in git_bash {
            if p.is_file() {
                return Ok(ShellInfo {
                    program: p.to_string_lossy().into_owned(),
                    // -l: login シェルにして Git Bash の /etc/profile を読ませ、
                    // /usr/bin 等の PATH（ls / git などの Unix コマンド）を整える。
                    args: vec!["-l".into()],
                    label: "Git Bash".into(),
                });
            }
        }
        if let Some(p) = resolve_on_path("powershell") {
            return Ok(ShellInfo {
                program: p.to_string_lossy().into_owned(),
                args: vec!["-NoLogo".into()],
                label: "PowerShell".into(),
            });
        }
        if let Ok(comspec) = std::env::var("ComSpec") {
            if !comspec.is_empty() {
                return Ok(ShellInfo {
                    program: comspec,
                    args: Vec::new(),
                    label: "cmd".into(),
                });
            }
        }
        Err("シェルが見つかりません（Git Bash / PowerShell / cmd のいずれも検出できませんでした）"
            .into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let sh = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/bash".to_string());
        let label = std::path::Path::new(&sh)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "shell".to_string());
        Ok(ShellInfo {
            program: sh,
            args: Vec::new(),
            label,
        })
    }
}

/// 候補探索から除外するディレクトリ（暴走・誤爆防止）。
const CANDIDATE_SKIP_DIRS: [&str; 9] = [
    "node_modules",
    ".git",
    "target",
    "out",
    ".next",
    "dist",
    "build",
    ".venv",
    "__pycache__",
];
/// BFS の深さ上限。
const CANDIDATE_MAX_DEPTH: usize = 6;
/// 走査エントリ数の上限。
const CANDIDATE_MAX_ENTRIES: usize = 5000;

/// workspace 配下を幅優先で探索し、rel（相対パス or 裸ファイル名）の実体を返す。
/// 同期・純関数（単体テスト可）。resolve_file_candidate から spawn_blocking で呼ぶ。
fn find_file_candidate(ws: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    use std::collections::VecDeque;
    let rel_norm = rel.replace('\\', "/");
    let base = std::path::Path::new(&rel_norm)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())?;
    let suffix = format!("/{rel_norm}");
    let mut queue: VecDeque<(std::path::PathBuf, usize)> = VecDeque::new();
    queue.push_back((ws.to_path_buf(), 0));
    let mut seen = 0usize;
    let mut base_hit: Option<std::path::PathBuf> = None;
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            seen += 1;
            if seen > CANDIDATE_MAX_ENTRIES {
                return base_hit;
            }
            let path = ent.path();
            let name = ent.file_name().to_string_lossy().into_owned();
            let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if depth + 1 <= CANDIDATE_MAX_DEPTH
                    && !CANDIDATE_SKIP_DIRS.contains(&name.as_str())
                {
                    queue.push_back((path, depth + 1));
                }
            } else if name == base {
                // rel がサブパス付き（lib/file-link.ts 等）ならサフィックス一致を優先
                let full_norm = path.to_string_lossy().replace('\\', "/");
                if full_norm.ends_with(&suffix) {
                    return Some(path);
                }
                if base_hit.is_none() {
                    base_hit = Some(path);
                }
            }
        }
    }
    base_hit
}

#[cfg(test)]
mod file_candidate_tests {
    use super::find_file_candidate;

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "unicrew_cand_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn 裸ファイル名でサブディレクトリの実体を発見する() {
        let root = temp_root("bare");
        std::fs::create_dir_all(root.join("lib")).unwrap();
        std::fs::write(root.join("lib").join("file-link.ts"), "a").unwrap();
        let hit = find_file_candidate(&root, "file-link.ts").unwrap();
        assert!(hit.ends_with(std::path::Path::new("lib").join("file-link.ts")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn サブパス付きはサフィックス一致を優先する() {
        let root = temp_root("suffix");
        std::fs::create_dir_all(root.join("src").join("lib")).unwrap();
        std::fs::create_dir_all(root.join("other")).unwrap();
        std::fs::write(root.join("other").join("mod.ts"), "x").unwrap();
        std::fs::write(root.join("src").join("lib").join("mod.ts"), "y").unwrap();
        let hit = find_file_candidate(&root, "lib/mod.ts").unwrap();
        let norm = hit.to_string_lossy().replace('\\', "/");
        assert!(norm.ends_with("src/lib/mod.ts"), "{norm}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 存在しない名前は_none() {
        let root = temp_root("none");
        assert!(find_file_candidate(&root, "nope.md").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn node_modules_は探索しない() {
        let root = temp_root("skip");
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        std::fs::write(root.join("node_modules").join("pkg").join("index.js"), "x").unwrap();
        assert!(find_file_candidate(&root, "index.js").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// 画像など任意のファイルをバイナリ読みして base64 で返す。
/// プレビュー窓は editor と同じく fs プラグイン(スコープ制限)ではなく
/// この自前コマンドで読む（plugin-fs 直読みは "forbidden path" になる）。
#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let p = expand_user_path(&path);
    let bytes = tokio::fs::read(&p).await.map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let p = expand_user_path(&path);
    tokio::fs::write(&p, contents)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let path = expand_user_path(&path);
    let mut entries = vec![];
    let mut rd = tokio::fs::read_dir(&path).await.map_err(|e| e.to_string())?;
    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = entry.file_type().await.map_err(|e| e.to_string())?;
        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: ft.is_dir(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(entries)
}

#[derive(Debug, Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// ファイル/フォルダ名として安全か（パス区切り・親参照・空を拒否）
fn validate_entry_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名前が空です".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        return Err("使用できない名前です".into());
    }
    Ok(trimmed)
}

#[tauri::command]
async fn fs_rename(path: String, new_name: String) -> Result<String, String> {
    let src = expand_user_path(&path);
    let name = validate_entry_name(&new_name)?.to_string();
    let parent = src
        .parent()
        .ok_or_else(|| "親フォルダがありません".to_string())?;
    let dst = parent.join(&name);
    if dst.exists() {
        return Err("同名のファイル/フォルダが既にあります".into());
    }
    tokio::fs::rename(&src, &dst)
        .await
        .map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// OS のゴミ箱へ移動（完全削除はしない）
#[tauri::command]
async fn fs_delete(path: String) -> Result<(), String> {
    let p = expand_user_path(&path);
    tauri::async_runtime::spawn_blocking(move || trash::delete(&p).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_create_file(dir: String, name: String) -> Result<String, String> {
    let d = expand_user_path(&dir);
    let name = validate_entry_name(&name)?.to_string();
    let target = d.join(&name);
    if target.exists() {
        return Err("同名のファイルが既にあります".into());
    }
    tokio::fs::write(&target, "")
        .await
        .map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
async fn fs_create_dir(dir: String, name: String) -> Result<String, String> {
    let d = expand_user_path(&dir);
    let name = validate_entry_name(&name)?.to_string();
    let target = d.join(&name);
    if target.exists() {
        return Err("同名のフォルダが既にあります".into());
    }
    tokio::fs::create_dir(&target)
        .await
        .map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// OS のファイルマネージャーで対象を表示（Windows/macOS は選択状態で開く）
#[tauri::command]
async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let p = expand_user_path(&path);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.to_string_lossy()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let target = if p.is_dir() {
            p.clone()
        } else {
            p.parent().map(|x| x.to_path_buf()).unwrap_or(p.clone())
        };
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- worktree 隔離（v0.4.0・並列/議論モードで AI ごとに作業場を分ける） ----------
//
// 並列・議論モードは全スロットが同じ workspace を acceptEdits（自動編集）で共有していた
// （4極議論なら4プロセスが同じフォルダを同時に書き換えうる）。git worktree で AI ごとに
// 独立したチェックアウトを切り、cwd を差し替えるだけで 11 プロバイダ全部に効かせる。
// - worktree の実体はリポジトリの外（AppData/worktrees 配下）に置き、利用者の `git status` を汚さない
// - ブランチ名は unicrew/<thread8>/<slot>。AI の成果はブランチとして残る（削除しない）
// - 取り込み（merge）で衝突したら abort して人に渡す。自動では解決しない

#[derive(Debug, Serialize)]
struct GitProbe {
    is_repo: bool,
    has_head: bool,
    toplevel: Option<String>,
}

#[derive(Debug, Serialize)]
struct WorktreeInfo {
    path: String,
    branch: String,
    toplevel: String,
}

#[derive(Debug, Serialize)]
struct IntegrateResult {
    ok: bool,
    message: String,
    conflicts: Vec<String>,
    patch_path: Option<String>,
}

/// スレッド/スロットIDをパス・ブランチ名に使える文字だけに絞る。
fn sanitize_id(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(max)
        .collect()
}

/// リポジトリのパスから worktree 置き場のフォルダ名を作る（同一リポジトリ→同一名）。
fn short_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.to_lowercase().replace('\\', "/").hash(&mut h);
    format!("{:016x}", h.finish())[..12].to_string()
}

/// git を1回実行して stdout（trim済み）を返す。失敗時は stderr（無ければ stdout）を Err にする。
async fn git_out(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let raw = git_raw(cwd, args).await?;
    Ok(String::from_utf8_lossy(&raw).trim().to_string())
}

/// git を1回実行して stdout を生のまま返す（diff 等の改行保持用）。
async fn git_raw(cwd: &std::path::Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = build_silent_command("git");
    cmd.current_dir(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git を起動できませんでした: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let so = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if err.is_empty() { so } else { err });
    }
    Ok(out.stdout)
}

fn worktrees_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("worktrees"))
}

/// workspace が git 管理下か・最初のコミットがあるかを返す（UI の案内文分岐用）。
#[tauri::command]
async fn git_probe(workspace: String) -> Result<GitProbe, String> {
    let ws = std::path::PathBuf::from(&workspace);
    if !ws.is_dir() {
        return Ok(GitProbe { is_repo: false, has_head: false, toplevel: None });
    }
    let toplevel = match git_out(&ws, &["rev-parse", "--show-toplevel"]).await {
        Ok(t) => t,
        Err(_) => return Ok(GitProbe { is_repo: false, has_head: false, toplevel: None }),
    };
    let has_head = git_out(&ws, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .await
        .is_ok();
    Ok(GitProbe { is_repo: true, has_head, toplevel: Some(toplevel) })
}

/// スロット用の worktree を用意する（冪等：既にあればそのまま返す）。
#[tauri::command]
async fn worktree_prepare(
    app: AppHandle,
    workspace: String,
    thread_id: String,
    slot_id: String,
) -> Result<WorktreeInfo, String> {
    let ws = std::path::PathBuf::from(&workspace);
    let toplevel = git_out(&ws, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| "このフォルダは git 管理外です（git init すると AI ごとの作業場を分けられます）".to_string())?;
    git_out(&ws, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .await
        .map_err(|_| "まだコミットが1つもありません（最初のコミットを作ると作業場を分けられます）".to_string())?;
    let top = std::path::PathBuf::from(&toplevel);
    let t8 = sanitize_id(&thread_id, 8);
    let slot = sanitize_id(&slot_id, 16);
    if t8.is_empty() || slot.is_empty() {
        return Err("スレッド/スロットIDが不正です".into());
    }
    let branch = format!("unicrew/{}/{}", t8, slot);
    let base = worktrees_root(&app)?.join(short_hash(&toplevel)).join(&t8);
    tokio::fs::create_dir_all(&base)
        .await
        .map_err(|e| e.to_string())?;
    let path = base.join(&slot);
    let path_s = path.to_string_lossy().to_string();
    // 既に有効な worktree ならそのまま使う（再起動・再開で同じ場所に戻る）
    if path.join(".git").exists()
        && git_out(&path, &["rev-parse", "--is-inside-work-tree"]).await.is_ok()
    {
        return Ok(WorktreeInfo { path: path_s, branch, toplevel });
    }
    // 残骸（消されたフォルダの登録など）を掃除してから作り直す
    let _ = git_out(&top, &["worktree", "prune"]).await;
    if path.exists() {
        let _ = tokio::fs::remove_dir_all(&path).await;
    }
    git_out(&top, &["worktree", "add", "-B", &branch, &path_s, "HEAD"])
        .await
        .map_err(|e| format!("worktree を作れませんでした: {}", e))?;
    Ok(WorktreeInfo { path: path_s, branch, toplevel })
}

/// スロットの worktree を消す（ブランチは残す＝AI の成果を勝手に捨てない）。
#[tauri::command]
async fn worktree_remove(app: AppHandle, workspace: String, path: String) -> Result<(), String> {
    let ws = std::path::PathBuf::from(&workspace);
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        // 安全弁: UNICREW の worktree 置き場の外は消さない
        let root = worktrees_root(&app)?;
        let cp = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
        let cr = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
        if !cp.starts_with(&cr) {
            return Err("worktree の場所が想定外なので削除しません".into());
        }
        let _ = git_out(&ws, &["worktree", "remove", "--force", &path]).await;
        if p.exists() {
            tokio::fs::remove_dir_all(&p)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    let _ = git_out(&ws, &["worktree", "prune"]).await;
    Ok(())
}

/// AI のブランチを取り込む。mode="merge" は --no-ff --no-commit（衝突なら abort して人に渡す）、
/// mode="patch" は差分ファイルを書き出す。
#[tauri::command]
async fn worktree_integrate(
    app: AppHandle,
    workspace: String,
    branch: String,
    mode: String,
) -> Result<IntegrateResult, String> {
    let ws = std::path::PathBuf::from(&workspace);
    let toplevel = git_out(&ws, &["rev-parse", "--show-toplevel"]).await?;
    let top = std::path::PathBuf::from(&toplevel);
    if !branch.starts_with("unicrew/") || branch.contains("..") {
        return Err("UNICREW が作ったブランチ以外は取り込みません".into());
    }
    let refname = format!("refs/heads/{}", branch);
    git_out(&top, &["rev-parse", "--verify", "--quiet", &refname])
        .await
        .map_err(|_| "ブランチが見つかりません（worktree を削除済みか、まだ何も変更していません）".to_string())?;
    if mode == "patch" {
        let base = git_out(&top, &["merge-base", "HEAD", &branch]).await?;
        let diff = git_raw(&top, &["diff", "--binary", &base, &branch]).await?;
        if diff.is_empty() {
            return Ok(IntegrateResult {
                ok: false,
                message: "このAIのブランチには変更がありません".into(),
                conflicts: vec![],
                patch_path: None,
            });
        }
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("patches");
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let file = dir.join(format!("{}_{}.patch", branch.replace('/', "_"), ts));
        tokio::fs::write(&file, &diff).await.map_err(|e| e.to_string())?;
        let lines = diff.iter().filter(|b| **b == b'\n').count();
        return Ok(IntegrateResult {
            ok: true,
            message: format!("パッチを書き出しました（{} 行）", lines),
            conflicts: vec![],
            patch_path: Some(file.to_string_lossy().to_string()),
        });
    }
    // merge: 取り込み先に未コミットの変更があれば止める（人の作業を巻き込まない）
    let dirty = git_out(&top, &["status", "--porcelain", "--untracked-files=no"]).await?;
    if !dirty.is_empty() {
        return Ok(IntegrateResult {
            ok: false,
            message: "取り込み先にコミットされていない変更があります。先にコミットか退避（stash）してください".into(),
            conflicts: vec![],
            patch_path: None,
        });
    }
    match git_out(&top, &["merge", "--no-ff", "--no-commit", &branch]).await {
        Ok(_) => Ok(IntegrateResult {
            ok: true,
            message: "取り込みました（まだコミットしていません。内容を確認してからコミットしてください）".into(),
            conflicts: vec![],
            patch_path: None,
        }),
        Err(e) => {
            let conflicts: Vec<String> = git_out(&top, &["diff", "--name-only", "--diff-filter=U"])
                .await
                .unwrap_or_default()
                .lines()
                .map(String::from)
                .collect();
            let _ = git_out(&top, &["merge", "--abort"]).await;
            Ok(IntegrateResult {
                ok: false,
                message: format!("衝突があるため取り込みを中止しました（自動では解決しません）: {}", e),
                conflicts,
                patch_path: None,
            })
        }
    }
}

/// git 管理外のフォルダを git 管理下にする（作業場の隔離とチェックポイントの前提）。
/// 既にリポジトリで HEAD が無いだけなら初期コミットだけ作る。
#[tauri::command]
async fn git_init_workspace(workspace: String) -> Result<String, String> {
    let ws = std::path::PathBuf::from(&workspace);
    if !ws.is_dir() {
        return Err("フォルダが見つかりません".into());
    }
    let is_repo = git_out(&ws, &["rev-parse", "--show-toplevel"]).await.is_ok();
    if !is_repo {
        git_out(&ws, &["init", "-q"]).await?;
        // 巨大な生成物を最初のコミットに巻き込まないための最小 .gitignore（無いときだけ）
        let gi = ws.join(".gitignore");
        if !gi.exists() {
            let _ = tokio::fs::write(
                &gi,
                "node_modules/\n.next/\ndist/\nbuild/\ntarget/\n.env\n.env.*\n*.log\n",
            )
            .await;
        }
    }
    if git_out(&ws, &["rev-parse", "--verify", "--quiet", "HEAD"]).await.is_ok() {
        return Ok("既に git 管理下です".into());
    }
    git_out(&ws, &["add", "-A"]).await?;
    git_out(
        &ws,
        &[
            "-c",
            "user.name=UNICREW",
            "-c",
            "user.email=unicrew@localhost",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "UNICREW: 初期コミット（AI ごとの作業場の隔離と巻き戻しのため）",
        ],
    )
    .await?;
    Ok("git 管理下にしました（初期コミットを作成）".into())
}

// ---------- 変更の差分ビュー（v0.4.0・AI が何を変えたかを一覧と左右比較で見せる） ----------
//
// 「AI が動いた後に何が変わったか」を、利用者の git の状態（index・HEAD・作業ツリー）を
// 一切動かさずに数える。手順は 1-3 チェックポイントと同じ土台：
//   一時 index（GIT_INDEX_FILE）に read-tree HEAD → add -A → write-tree
// で「今の作業ツリー（未追跡含む・.gitignore 尊重）」を tree オブジェクトにし、基準の tree と比べる。
// - 基準は「ターン開始時の tree」（ユーザー送信のたびに workspace_snapshot で記録）か HEAD
// - 差分の本文は「基準側」「今側」の2本文で返し、UI 側の DiffEditor で左右比較する
// - worktree 隔離中は cwd を差し替えるだけで同じ関数が効く（1-1 と同じ考え方）

#[derive(Debug, Serialize)]
struct ChangedFile {
    path: String,
    /// A=追加 M=変更 D=削除 R=改名 T=種別変更 U=不明
    status: String,
    /// 改名時のみ旧パス
    old_path: Option<String>,
    additions: i64,
    deletions: i64,
    binary: bool,
}

#[derive(Debug, Serialize)]
struct WorkspaceChanges {
    /// 実際に比べた基準（tree oid か HEAD の commit oid）
    base: String,
    /// "turn"（ターン開始時の tree）/ "head"（最後のコミット）/ "empty"（コミット無し・全部が追加扱い）
    base_kind: String,
    files: Vec<ChangedFile>,
    additions: i64,
    deletions: i64,
    /// 上限（500件）で打ち切ったか
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct FileDiff {
    /// 基準側の本文（追加ファイルなら空）
    original: String,
    /// 今の作業ツリーの本文（削除ファイルなら空）
    modified: String,
    binary: bool,
    too_large: bool,
}

const CHANGES_MAX_FILES: usize = 500;
const DIFF_MAX_BYTES: usize = 2 * 1024 * 1024;
const EMPTY_TREE_OID: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// 環境変数付きで git を1回実行し stdout を生のまま返す。
async fn git_raw_env(
    cwd: &std::path::Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<Vec<u8>, String> {
    let mut cmd = build_silent_command("git");
    cmd.current_dir(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git を起動できませんでした: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let so = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if err.is_empty() { so } else { err });
    }
    Ok(out.stdout)
}

async fn git_out_env(
    cwd: &std::path::Path,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<String, String> {
    let raw = git_raw_env(cwd, args, envs).await?;
    Ok(String::from_utf8_lossy(&raw).trim().to_string())
}

/// 一時 index のパス（AppData/tmp/index-<nanos>）。利用者の .git/index には触れない。
fn temp_index_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(dir.join(format!("index-{}-{}", std::process::id(), nanos)))
}

/// 今の作業ツリー（未追跡含む・.gitignore 尊重）を一時 index に写して tree oid を返す。
/// 戻り値の index ファイルは呼び出し側が消す（diff --cached に使い回すため）。
async fn snapshot_tree(
    app: &AppHandle,
    cwd: &std::path::Path,
) -> Result<(String, std::path::PathBuf), String> {
    let index = temp_index_path(app)?;
    let index_s = index.to_string_lossy().to_string();
    let envs = [("GIT_INDEX_FILE", index_s.as_str())];
    // HEAD があれば追跡状態を引き継ぐ（無ければ空 index から全部を add）
    if git_out(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).await.is_ok() {
        git_out_env(cwd, &["read-tree", "HEAD"], &envs).await?;
    }
    git_out_env(cwd, &["add", "-A", "--", "."], &envs).await?;
    let tree = git_out_env(cwd, &["write-tree"], &envs).await?;
    Ok((tree, index))
}

/// 基準を決める：since_ref が実在する tree/commit ならそれ（turn）、無ければ HEAD、それも無ければ空 tree。
async fn resolve_base(cwd: &std::path::Path, since_ref: Option<&str>) -> (String, String) {
    if let Some(r) = since_ref {
        let r = r.trim();
        // oid 以外（ブランチ名・`..`・オプション）は受け付けない
        if !r.is_empty()
            && r.len() <= 64
            && r.chars().all(|c| c.is_ascii_hexdigit())
            && git_out(cwd, &["cat-file", "-e", &format!("{}^{{tree}}", r)]).await.is_ok()
        {
            return (r.to_string(), "turn".into());
        }
    }
    if let Ok(h) = git_out(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).await {
        return (h, "head".into());
    }
    (EMPTY_TREE_OID.into(), "empty".into())
}

/// `git diff --numstat -z` の出力を (path, additions, deletions, binary, old_path) に分解する。
/// 改名は `add\tdel\t\0old\0new\0`、それ以外は `add\tdel\tpath\0`。
fn parse_numstat_z(raw: &[u8]) -> Vec<(String, i64, i64, bool, Option<String>)> {
    let text = String::from_utf8_lossy(raw);
    let toks: Vec<&str> = text.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let tok = toks[i];
        i += 1;
        if tok.is_empty() {
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let a = parts.next().unwrap_or("");
        let d = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        let binary = a == "-" || d == "-";
        let add = a.parse::<i64>().unwrap_or(0);
        let del = d.parse::<i64>().unwrap_or(0);
        if rest.is_empty() {
            // 改名：次の2トークンが old / new
            let old = toks.get(i).copied().unwrap_or("").to_string();
            let new = toks.get(i + 1).copied().unwrap_or("").to_string();
            i += 2;
            if !new.is_empty() {
                out.push((new, add, del, binary, Some(old)));
            }
        } else {
            out.push((rest.to_string(), add, del, binary, None));
        }
    }
    out
}

/// `git diff --name-status -z` の出力を path → status(先頭1文字) に分解する。改名は `R100\0old\0new\0`。
fn parse_name_status_z(raw: &[u8]) -> HashMap<String, String> {
    let text = String::from_utf8_lossy(raw);
    let toks: Vec<&str> = text.split('\0').collect();
    let mut out = HashMap::new();
    let mut i = 0;
    while i < toks.len() {
        let st = toks[i];
        i += 1;
        if st.is_empty() {
            continue;
        }
        let letter = st.chars().next().unwrap_or('U').to_string();
        if letter == "R" || letter == "C" {
            let new = toks.get(i + 1).copied().unwrap_or("").to_string();
            i += 2;
            if !new.is_empty() {
                out.insert(new, letter);
            }
        } else {
            let p = toks.get(i).copied().unwrap_or("").to_string();
            i += 1;
            if !p.is_empty() {
                out.insert(p, letter);
            }
        }
    }
    out
}

/// ターン開始時の作業ツリーを tree オブジェクトとして記録し oid を返す（利用者の index/HEAD は動かさない）。
/// ユーザー送信のたびに呼び、「このターンで変わったファイル」の基準にする。
#[tauri::command]
async fn workspace_snapshot(app: AppHandle, workspace: String) -> Result<String, String> {
    let ws = std::path::PathBuf::from(&workspace);
    git_out(&ws, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| "このフォルダは git 管理外です".to_string())?;
    let (tree, index) = snapshot_tree(&app, &ws).await?;
    let _ = tokio::fs::remove_file(&index).await;
    Ok(tree)
}

/// 変更されたファイルの一覧（基準＝since_ref の tree／無ければ HEAD）。
#[tauri::command]
async fn workspace_changes(
    app: AppHandle,
    workspace: String,
    since_ref: Option<String>,
) -> Result<WorkspaceChanges, String> {
    let ws = std::path::PathBuf::from(&workspace);
    if !ws.is_dir() {
        return Err("フォルダが見つかりません".into());
    }
    git_out(&ws, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| "NOT_A_REPO".to_string())?;
    let (base, base_kind) = resolve_base(&ws, since_ref.as_deref()).await;
    let (_tree, index) = snapshot_tree(&app, &ws).await?;
    let index_s = index.to_string_lossy().to_string();
    let envs = [("GIT_INDEX_FILE", index_s.as_str())];
    let numstat = git_raw_env(
        &ws,
        &["diff", "--cached", "--numstat", "-M", "-z", "--no-color", &base, "--"],
        &envs,
    )
    .await;
    let names = git_raw_env(
        &ws,
        &["diff", "--cached", "--name-status", "-M", "-z", "--no-color", &base, "--"],
        &envs,
    )
    .await;
    let _ = tokio::fs::remove_file(&index).await;
    let numstat = numstat?;
    let statuses = parse_name_status_z(&names?);
    let mut files: Vec<ChangedFile> = parse_numstat_z(&numstat)
        .into_iter()
        .map(|(path, add, del, binary, old)| {
            let status = statuses
                .get(&path)
                .cloned()
                .unwrap_or_else(|| if old.is_some() { "R".into() } else { "U".into() });
            ChangedFile { path, status, old_path: old, additions: add, deletions: del, binary }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let additions = files.iter().map(|f| f.additions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    let truncated = files.len() > CHANGES_MAX_FILES;
    files.truncate(CHANGES_MAX_FILES);
    Ok(WorkspaceChanges { base, base_kind, files, additions, deletions, truncated })
}

/// 1ファイルの「基準側」「今側」の本文（DiffEditor 用・読み取り専用）。
#[tauri::command]
async fn workspace_file_diff(
    workspace: String,
    file: String,
    since_ref: Option<String>,
) -> Result<FileDiff, String> {
    let ws = std::path::PathBuf::from(&workspace);
    let toplevel = git_out(&ws, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| "このフォルダは git 管理外です".to_string())?;
    let top = std::path::PathBuf::from(&toplevel);
    // リポジトリの外を読ませない（相対パス・`..` 無し・絶対パス無し）
    let rel = file.replace('\\', "/");
    let p = std::path::Path::new(&rel);
    if p.is_absolute()
        || rel.starts_with('/')
        || rel.contains(':')
        || p.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("リポジトリ内の相対パスだけ開けます".into());
    }
    let (base, _) = resolve_base(&ws, since_ref.as_deref()).await;
    let spec = format!("{}:{}", base, rel);
    // 基準側：無ければ「追加されたファイル」として空
    let original = git_raw(&top, &["show", &spec]).await.unwrap_or_default();
    // 今側：無ければ「削除されたファイル」として空
    let modified = tokio::fs::read(top.join(&rel)).await.unwrap_or_default();
    let too_large = original.len() > DIFF_MAX_BYTES || modified.len() > DIFF_MAX_BYTES;
    let is_bin = |b: &[u8]| b.iter().take(8192).any(|c| *c == 0);
    let binary = is_bin(&original) || is_bin(&modified);
    if too_large || binary {
        return Ok(FileDiff { original: String::new(), modified: String::new(), binary, too_large });
    }
    Ok(FileDiff {
        original: String::from_utf8_lossy(&original).to_string(),
        modified: String::from_utf8_lossy(&modified).to_string(),
        binary: false,
        too_large: false,
    })
}

#[cfg(test)]
mod changes_parse_tests {
    use super::{parse_name_status_z, parse_numstat_z};

    #[test]
    fn numstat_z_handles_plain_binary_and_rename() {
        // 実測（2026-09-03 uc_changes_probe.sh）: 改名は `add\tdel\t\0old\0new\0`、それ以外は `add\tdel\tpath\0`
        let raw = b"2\t1\ta.txt\0-\t-\timg.png\00\t0\t\0c.txt\0c2.txt\01\t0\tnew.txt\0";
        let v = parse_numstat_z(raw);
        assert_eq!(v.len(), 4);
        assert_eq!(v[0], ("a.txt".to_string(), 2, 1, false, None));
        assert_eq!(v[1], ("img.png".to_string(), 0, 0, true, None));
        assert_eq!(v[2], ("c2.txt".to_string(), 0, 0, false, Some("c.txt".to_string())));
        assert_eq!(v[3], ("new.txt".to_string(), 1, 0, false, None));
    }

    #[test]
    fn name_status_z_maps_rename_to_new_path() {
        let raw = b"M\0a.txt\0D\0b.txt\0R100\0c.txt\0c2.txt\0A\0new.txt\0";
        let m = parse_name_status_z(raw);
        assert_eq!(m.get("a.txt").map(String::as_str), Some("M"));
        assert_eq!(m.get("b.txt").map(String::as_str), Some("D"));
        assert_eq!(m.get("c2.txt").map(String::as_str), Some("R"));
        assert!(m.get("c.txt").is_none());
        assert_eq!(m.get("new.txt").map(String::as_str), Some("A"));
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(parse_numstat_z(b"").is_empty());
        assert!(parse_name_status_z(b"").is_empty());
    }
}

// ---------- App setup ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 🚨 何よりも先に PATH を補強する。これ以降に spawn される子プロセス
    //（CLI の検出・インストール・エージェント実行のすべて）がこの PATH を継承する。
    augment_cli_path();

    observability::init(None);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        // コピー＆ペースト用。WebView のネイティブ clipboard/paste イベント依存だと
        // WebView2 等でコピペが効かない事例があるため、OS レベルの clipboard-manager を
        // 第一経路にして readText/writeText を確実に動かす。
        .plugin(tauri_plugin_clipboard_manager::init())
        // 自動アップデート用。フロントから @tauri-apps/plugin-updater 経由で check / download_and_install を叩く。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AgentState::default())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            delete_api_key,
            default_workspace_path,
            git_probe,
            worktree_prepare,
            worktree_remove,
            worktree_integrate,
            git_init_workspace,
            workspace_snapshot,
            workspace_changes,
            workspace_file_diff,
            save_avatar_image,
            save_avatar_bytes,
            delete_avatar_image,
            read_image_as_data_url,
            claude_status,
            start_claude_login,
            install_claude_code,
            codex_status,
            start_codex_login,
            install_codex,
            gemini_status,
            install_gemini,
            acp_cli_status,
            install_acp_cli,
            ollama_pull,
            cli_versions,
            update_cli,
            check_addon_updates,
            apply_addon_update,
            agent_start,
            agent_send,
            agent_stop,
            agent_permission_response,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            read_text_file,
            resolve_file_candidate,
            path_exists,
            default_shell,
            read_file_base64,
            write_text_file,
            list_directory,
            fs_rename,
            fs_delete,
            fs_create_file,
            fs_create_dir,
            reveal_in_file_manager,
            trust::is_workspace_trusted,
            trust::trust_workspace,
            trust::untrust_workspace,
            trust::list_trusted_workspaces,
            observability::observability_status,
            list_claude_plugins,
            list_claude_skills,
            list_claude_mcp,
            list_codex_plugins,
            list_codex_skills,
            get_openai_api_key,
            set_openai_api_key,
            transcribe_audio,
            toggle_claude_mcp,
            add_claude_mcp,
            remove_claude_mcp,
            install_claude_plugin,
            uninstall_claude_plugin,
            install_codex_plugin,
            uninstall_codex_plugin,
            add_claude_marketplace,
            list_claude_marketplace_catalog,
            list_codex_marketplace_catalog,
            list_codex_mcp,
            add_codex_mcp,
            remove_codex_mcp,
            toggle_codex_mcp,
            fetch_github_avatar,
            graphify_update,
            get_lan_ip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod plugin_input_validation_tests {
    use super::{validate_github_repo, validate_marketplace_id, validate_plugin_id};

    #[test]
    fn plugin_id_accepts_real_forms() {
        assert!(validate_plugin_id("my-plugin@my-market").is_ok());
        assert!(validate_plugin_id("foo.bar_baz@org/repo").is_ok());
    }

    #[test]
    fn plugin_id_rejects_injection() {
        assert!(validate_plugin_id("foo\n/plugin uninstall victim").is_err());
        assert!(validate_plugin_id("foo bar").is_err());
        assert!(validate_plugin_id("foo\"; rm -rf").is_err());
        assert!(validate_plugin_id("").is_err());
    }

    #[test]
    fn marketplace_id_rejects_traversal_and_absolute() {
        assert!(validate_marketplace_id("my-market").is_ok());
        assert!(validate_marketplace_id("..").is_err());
        assert!(validate_marketplace_id("../../evil").is_err());
        assert!(validate_marketplace_id(r"..\..\evil").is_err());
        assert!(validate_marketplace_id(r"C:\Windows\Temp\evil").is_err());
        assert!(validate_marketplace_id("a/b").is_err());
    }

    #[test]
    fn github_repo_requires_owner_slash_name() {
        assert!(validate_github_repo("anthropics/claude-code").is_ok());
        assert!(validate_github_repo("owner").is_err());
        assert!(validate_github_repo("owner/name/extra").is_err());
        assert!(validate_github_repo("-oProxyCommand/name").is_err());
        assert!(validate_github_repo("owner/na me").is_err());
        assert!(validate_github_repo("../etc/passwd").is_err());
    }

    #[test]
    fn atomic_write_replaces_existing_and_survives_overwrite() {
        use super::write_json_atomic;
        let dir = std::env::temp_dir().join(format!("unicrew_atomic_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("known.json");
        write_json_atomic(&path, "{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        // 既存があっても上書きできる（Windows の rename 失敗フォールバック確認）
        write_json_atomic(&path, "{\"b\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"b\":2}");
        // .tmp が残っていない
        assert!(!path.with_extension("tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
