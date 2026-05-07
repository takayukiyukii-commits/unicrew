use anyhow::Result;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

const KEYRING_SERVICE: &str = "unicrew";
const KEYRING_USER: &str = "anthropic-api-key";
const KEYRING_USER_OPENAI: &str = "openai-api-key";

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
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("画像の読み込みに失敗: {}", e))?;
    let ext = std::path::Path::new(&path)
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
}

fn home_dir() -> Result<std::path::PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "ホームディレクトリが取得できません".to_string())
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
    servers.insert(req.name, serde_json::Value::Object(entry));
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| format!("~/.claude.json 書き込み失敗: {}", e))?;
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
    std::fs::write(&path, pretty).map_err(|e| format!("~/.claude.json 書き込み失敗: {}", e))?;
    Ok(())
}

/// claude CLI 経由でプラグインをインストール。
/// 内部で `claude --print "/plugin install <id>"` を CREATE_NO_WINDOW で spawn。
/// 成功時は stdout テキストを返す（呼び出し側でログ表示用）。
#[tauri::command]
async fn install_claude_plugin(id: String) -> Result<String, String> {
    let id_trim = id.trim();
    if id_trim.is_empty() {
        return Err("プラグイン ID が空です".into());
    }
    let mut cmd = build_silent_command("claude");
    cmd.arg("--print")
        .arg(format!("/plugin install {}", id_trim))
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
            "プラグイン追加に失敗しました（exit={}）\nstdout: {}\nstderr: {}",
            output.status.code().unwrap_or(-1),
            stdout.trim(),
            stderr.trim()
        ));
    }
    Ok(stdout)
}

/// claude CLI 経由でプラグインをアンインストール。
/// 失敗時は installed_plugins.json を直接編集してフォールバック削除。
#[tauri::command]
async fn uninstall_claude_plugin(id: String) -> Result<String, String> {
    let id_trim = id.trim().to_string();
    if id_trim.is_empty() {
        return Err("プラグイン ID が空です".into());
    }
    let mut cmd = build_silent_command("claude");
    cmd.arg("--print")
        .arg(format!("/plugin uninstall {}", id_trim))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let cli_attempt = cmd.output().await;
    if let Ok(output) = cli_attempt {
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
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
            "claude CLI 経由のアンインストールに失敗し、{} も存在しません",
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
            "プラグイン '{}' が installed_plugins.json に見つかりませんでした",
            id_trim
        ));
    }
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(format!(
        "プラグイン '{}' を installed_plugins.json から削除しました（CLI 経由は不可だったためファイル直編集）",
        id_trim
    ))
}

/// 任意 marketplace（GitHub repo）を known_marketplaces.json に登録 + git clone。
/// 上級者モード専用。
#[tauri::command]
async fn add_claude_marketplace(id: String, repo: String) -> Result<String, String> {
    let id_t = id.trim().to_string();
    let repo_t = repo.trim().to_string();
    if id_t.is_empty() || repo_t.is_empty() {
        return Err("marketplace ID と GitHub repo の両方が必要です".into());
    }
    let home = home_dir()?;
    let mp_dir = home.join(".claude").join("plugins").join("marketplaces").join(&id_t);
    let known_path = home
        .join(".claude")
        .join("plugins")
        .join("known_marketplaces.json");

    if !mp_dir.exists() {
        let mut cmd = build_silent_command("git");
        cmd.arg("clone")
            .arg(format!("https://github.com/{}.git", repo_t))
            .arg(&mp_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("git CLI を起動できませんでした: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git clone に失敗（exit={}）\n{}",
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    // known_marketplaces.json を更新
    let mut v: serde_json::Value = if known_path.exists() {
        let text = std::fs::read_to_string(&known_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !v.is_object() {
        v = serde_json::json!({});
    }
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
    if let Some(parent) = known_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&known_path, pretty).map_err(|e| e.to_string())?;
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
    std::fs::write(&path, pretty).map_err(|e| format!("~/.claude.json の書き込み失敗: {}", e))?;
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
            });
        }
        // 1 個見つかれば終わり
        if !out.is_empty() {
            break;
        }
    }
    out
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

    let mut out: Vec<AddonItem> = Vec::new();
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
            let mp_json = parse_marketplace_json(&mp_path, &mp_id, &installed_ids, "codex");
            let known: std::collections::HashSet<String> =
                mp_json.iter().map(|x| x.name.clone()).collect();
            out.extend(mp_json);
            let mut walked: Vec<AddonItem> = Vec::new();
            find_plugin_jsons(&mp_path, &mp_id, &installed_ids, &mut walked, 0);
            for mut item in walked {
                if !known.contains(&item.name) {
                    item.source = "codex".into();
                    out.push(item);
                }
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
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .ok_or("home directory not found")?;
    let path = std::path::PathBuf::from(home)
        .join("Documents")
        .join("UNICREW");
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().to_string())
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

    // Detect logged-in state by checking `~/.claude/.credentials.json` (Linux/macOS)
    // or platform-specific locations; the file's presence is a reasonable proxy.
    let logged_in = if installed {
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
#[cfg(target_os = "windows")]
fn resolve_on_path(name: &str) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let path = std::env::var_os("PATH")?;
    let pathext_raw = std::env::var("PATHEXT").unwrap_or_else(|_| {
        ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC".into()
    });
    let exts: Vec<String> = pathext_raw
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect();
    let already_has_ext = std::path::Path::new(name).extension().is_some();
    for dir in std::env::split_paths(&path) {
        if already_has_ext {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        for ext in &exts {
            let mut candidate: PathBuf = dir.clone();
            candidate.push(format!("{}{}", name, ext));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn build_silent_command(program: &str) -> Command {
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

#[tauri::command]
async fn start_claude_login(app: AppHandle) -> Result<(), String> {
    // Spawn `claude` silently. Read stdout; when we see a URL, open it in the user's browser.
    // Emit progress events so the UI can show what's happening.
    let mut cmd = build_silent_command("claude");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Claude Code の起動に失敗しました: {}", e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Parse stdout for the OAuth URL and open it in the user's default browser.
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let url_re_chunks = ["https://", "http://"];
        let mut opened = false;
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("claude_login:line", &line);
            if !opened {
                for prefix in url_re_chunks {
                    if let Some(idx) = line.find(prefix) {
                        let tail = &line[idx..];
                        let end = tail
                            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                            .unwrap_or(tail.len());
                        let url = &tail[..end];
                        // Use Tauri's shell plugin to open in default browser
                        if let Err(e) = tauri_plugin_shell::ShellExt::shell(&app_clone)
                            .open(url, None)
                        {
                            let _ = app_clone.emit(
                                "claude_login:line",
                                format!("ブラウザを開けませんでした: {}", e),
                            );
                        } else {
                            opened = true;
                            let _ = app_clone.emit(
                                "claude_login:browser_opened",
                                url.to_string(),
                            );
                        }
                        break;
                    }
                }
            }
        }
    });

    // Forward stderr lines for debugging
    let app_err = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit("claude_login:stderr", line);
        }
    });

    // Wait for child to exit (success means OAuth completed)
    let app_done = app.clone();
    tauri::async_runtime::spawn(async move {
        let exit = child.wait().await;
        let success = matches!(&exit, Ok(s) if s.success());
        let _ = app_done.emit("claude_login:done", success);
    });

    Ok(())
}

#[tauri::command]
async fn install_claude_code(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = build_silent_command("winget");
        cmd.args([
            "install",
            "--silent",
            "--id",
            "Anthropic.ClaudeCode",
            "--accept-source-agreements",
            "--accept-package-agreements",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "winget の起動に失敗しました（Windows 10 1809以降が必要）: {}",
                e
            )
        })?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_clone.emit("claude_install:line", line);
            }
        });

        let app_done = app.clone();
        tauri::async_runtime::spawn(async move {
            let exit = child.wait().await;
            let success = matches!(&exit, Ok(s) if s.success());
            let _ = app_done.emit("claude_install:done", success);
        });

        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        // Try Homebrew first; fall back to npm
        let mut cmd = build_silent_command("sh");
        cmd.args([
            "-c",
            "command -v brew >/dev/null 2>&1 && brew install anthropic-ai/claude-code/claude-code || npm install -g @anthropic-ai/claude-code",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app_clone.emit("claude_install:line", line);
            }
        });
        let app_done = app.clone();
        tauri::async_runtime::spawn(async move {
            let exit = child.wait().await;
            let success = matches!(&exit, Ok(s) if s.success());
            let _ = app_done.emit("claude_install:done", success);
        });
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = app;
        Err("Linux では `npm install -g @anthropic-ai/claude-code` を手動で実行してください。".into())
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
    // Codex は npm 配布が公式。Node.js が前提（UNICREW も Node 必須なので問題なし）。
    let mut cmd = build_silent_command("npm");
    cmd.args(["install", "-g", "@openai/codex"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("npm の起動に失敗しました: {}", e))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_clone.emit("codex_install:line", line);
        }
    });

    let app_done = app.clone();
    tauri::async_runtime::spawn(async move {
        let exit = child.wait().await;
        let success = matches!(&exit, Ok(s) if s.success());
        let _ = app_done.emit("codex_install:done", success);
    });
    Ok(())
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

// ---------- Agent SDK Sidecar ----------

#[derive(Default)]
struct AgentState {
    sessions: Mutex<HashMap<String, AgentSession>>,
}

struct AgentSession {
    stdin: ChildStdin,
    child: Child,
    _stdout_handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AgentStartRequest {
    session_id: String,
    workspace: Option<String>,
    system_prompt: String,
    model: String,
    /// "subscription" (claude.ai OAuth) or "apikey"
    auth_mode: String,
    /// Required only when auth_mode == "apikey"
    api_key: Option<String>,
    /// "claude" (default) or "codex"
    #[serde(default = "default_provider")]
    provider: String,
}

fn default_provider() -> String {
    "claude".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
struct AgentSendRequest {
    session_id: String,
    text: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AgentStopRequest {
    session_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind")]
enum SidecarOut {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "assistant_text")]
    AssistantText {
        session_id: String,
        text: String,
    },
    #[serde(rename = "tool_use")]
    ToolUse {
        session_id: String,
        tool_use_id: String,
        tool_name: String,
        tool_input: serde_json::Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        session_id: String,
        tool_use_id: String,
        is_error: bool,
        content: serde_json::Value,
    },
    #[serde(rename = "permission_request")]
    PermissionRequest {
        session_id: String,
        request_id: String,
        tool_name: String,
        input: serde_json::Value,
    },
    #[serde(rename = "result")]
    Result {
        session_id: String,
        subtype: String,
        cost_usd: Option<f64>,
        usage: Option<serde_json::Value>,
    },
    #[serde(rename = "error")]
    Error {
        session_id: String,
        message: String,
    },
}

#[tauri::command]
async fn agent_start(
    app: AppHandle,
    state: State<'_, AgentState>,
    req: AgentStartRequest,
) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?;
    let sidecar_filename = match req.provider.as_str() {
        "codex" => "codex-agent.mjs",
        _ => "agent.mjs",
    };
    let sidecar_path = resource_dir.join("sidecar").join(sidecar_filename);

    // Fall back to repo-relative path during dev
    let final_path = if sidecar_path.exists() {
        sidecar_path
    } else {
        let dev_path = std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join("..")
            .join("sidecar")
            .join(sidecar_filename);
        if dev_path.exists() {
            dev_path
        } else {
            return Err(format!(
                "sidecar not found ({} provider). tried: {} and {}",
                req.provider,
                sidecar_path.display(),
                dev_path.display()
            ));
        }
    };

    // node.exe は通常 PATH に出るが、nvm-windows 等でシム経由のことがあるため
    // build_silent_command 経由で確実に解決する。
    let mut cmd = build_silent_command("node");
    cmd.arg(final_path);
    if req.auth_mode == "apikey" {
        if let Some(key) = req.api_key.as_ref() {
            cmd.env("ANTHROPIC_API_KEY", key);
        }
    } else {
        // subscription mode: SDK は Claude Code の OAuth トークンを使う
        cmd.env_remove("ANTHROPIC_API_KEY");
        cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
    }
    cmd.env("UNICREW_AUTH_MODE", &req.auth_mode);
    if let Some(ws) = &req.workspace {
        cmd.env("UNICREW_WORKSPACE", ws);
    }
    cmd.env("UNICREW_MODEL", &req.model);
    cmd.env("UNICREW_SYSTEM_PROMPT", &req.system_prompt);
    cmd.env("UNICREW_SESSION_ID", &req.session_id);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "failed to spawn node sidecar (is Node.js installed and on PATH?): {}",
            e
        )
    })?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let session_id = req.session_id.clone();
    let app_clone = app.clone();
    let stdout_handle = tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            // Each line is a JSON SidecarOut event
            if line.trim().is_empty() {
                continue;
            }
            let _ = app_clone.emit("agent:event", &line);
        }
    });

    // Capture stderr to a separate channel for debugging
    let app_err = app.clone();
    let session_err = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit(
                "agent:stderr",
                serde_json::json!({"session_id": session_err, "line": line}),
            );
        }
    });

    let session = AgentSession {
        stdin,
        child,
        _stdout_handle: stdout_handle,
    };
    state
        .sessions
        .lock()
        .await
        .insert(req.session_id.clone(), session);
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
    let payload = serde_json::json!({
        "kind": "user_message",
        "text": req.text,
    });
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    session
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    session
        .stdin
        .flush()
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
    let payload = serde_json::json!({
        "kind": "permission_response",
        "request_id": request_id,
        "decision": decision,
    });
    let mut line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    line.push('\n');
    session
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    session
        .stdin
        .flush()
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
    if let Some(mut session) = sessions.remove(&req.session_id) {
        // 1) graceful: stdin に "stop" を流して sidecar 自身に終了させる
        let payload = serde_json::json!({"kind": "stop"});
        if let Ok(mut line) = serde_json::to_string(&payload) {
            line.push('\n');
            let _ = session.stdin.write_all(line.as_bytes()).await;
            let _ = session.stdin.flush().await;
        }
        // 2) hard kill: ツール実行で詰まってる場合 stdin を読まないので、
        //    プロセスを直接 SIGKILL/TerminateProcess する。
        let _ = session.child.start_kill();
        // 3) wait はバックグラウンドへ。ここでブロックすると UI が固まる。
        tauri::async_runtime::spawn(async move {
            let _ = session.child.wait().await;
        });
    }
    Ok(())
}

// ---------- Lightweight FS helpers (workspace-scoped is enforced by the Agent SDK cwd) ----------

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
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

// ---------- App setup ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .manage(AgentState::default())
        .invoke_handler(tauri::generate_handler![
            get_api_key,
            set_api_key,
            delete_api_key,
            default_workspace_path,
            save_avatar_image,
            delete_avatar_image,
            read_image_as_data_url,
            claude_status,
            start_claude_login,
            install_claude_code,
            codex_status,
            start_codex_login,
            install_codex,
            agent_start,
            agent_send,
            agent_stop,
            agent_permission_response,
            read_text_file,
            list_directory,
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
            add_claude_marketplace,
            list_claude_marketplace_catalog,
            list_codex_marketplace_catalog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
