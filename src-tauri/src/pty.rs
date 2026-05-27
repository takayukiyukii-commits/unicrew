//! 対話モード PTY セッション（ハイブリッド方針 B の土台）。
//!
//! VSCode の統合ターミナルと同じく、本物の対話 CLI（claude 等）を
//! 擬似端末（PTY）で動かす。これにより /mcp・/compact 等の REPL
//! コマンドは CLI 本体がネイティブに処理する。
//!
//! 既存の headless provider 群（claude.rs 等）とは完全に独立しており、
//! 互いに一切干渉しない（＝今の機能を維持したまま追加できる）。

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

struct PtyEntry {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

static REGISTRY: OnceLock<Mutex<HashMap<String, PtyEntry>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, PtyEntry>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(serde::Serialize, Clone)]
struct PtyData {
    id: String,
    /// base64(raw bytes)
    data: String,
}

#[derive(serde::Serialize, Clone)]
struct PtyExit {
    id: String,
}

/// 対話 PTY セッションを開始する。program は "claude" 等。
/// Windows の `.cmd` シム（npm 経由）も解決して起動する。
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    id: String,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // 同一 id が残っていれば閉じてから作り直す。
    let _ = pty_kill(id.clone());

    // resolve_on_path は Windows 専用（#[cfg(target_os="windows")]）。
    // 非 Windows では claude は PATH 上にあり exec が PATH 解決するため
    // そのままで良い。OS で分岐しないと非 Windows で E0425 になる。
    #[cfg(target_os = "windows")]
    let resolved = crate::resolve_on_path(&program)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| program.clone());
    #[cfg(not(target_os = "windows"))]
    let resolved = program.clone();

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty 失敗: {e}"))?;

    let mut cmd = CommandBuilder::new(&resolved);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
    }
    // 親プロセスの環境を引き継ぐ（claude が node / PATH を見つけられるように）。
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    // PTY 上で動く対話 TUI（claude/Ink 等）が方向キーと複数行編集を正しく扱えるよう
    // TERM を明示する。GUI 親プロセス（unicrew.exe）は TERM を持たないことが多く、
    // 未設定のままだと Ink の入力エディタが劣化モードになる。フロントは xterm.js なので
    // xterm-256color を名乗らせる。親から継承した値があっても上書きするため loop の後に置く。
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // VSCode 統合ターミナル相当の識別子を名乗る。claude(Ink) は端末を識別して描画モードを
    // 変えるため（同期描画 ?2026 等）、VSCode と同じ TERM_PROGRAM を渡してリッチ描画を促す。
    cmd.env("TERM_PROGRAM", "vscode");
    cmd.env("TERM_PROGRAM_VERSION", "1.96.0");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn 失敗（{resolved}）: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer 失敗: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader 失敗: {e}"))?;

    // portable-pty は同期 IO のため出力読み取りは std::thread。
    let app_r = app.clone();
    let id_r = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let b64 = base64::engine::general_purpose::STANDARD
                        .encode(&buf[..n]);
                    if app_r
                        .emit(
                            "pty://data",
                            PtyData {
                                id: id_r.clone(),
                                data: b64,
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_r.emit("pty://exit", PtyExit { id: id_r.clone() });
        if let Ok(mut reg) = registry().lock() {
            reg.remove(&id_r);
        }
    });

    registry().lock().map_err(|_| "registry lock".to_string())?.insert(
        id,
        PtyEntry {
            writer,
            master: pair.master,
            child,
        },
    );
    Ok(())
}

/// フロントからのキー入力（base64）を PTY に書き込む。
#[tauri::command]
pub fn pty_write(id: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("base64 デコード失敗: {e}"))?;
    let mut reg = registry().lock().map_err(|_| "registry lock".to_string())?;
    let entry = reg
        .get_mut(&id)
        .ok_or_else(|| "pty セッションが見つかりません".to_string())?;
    entry
        .writer
        .write_all(&bytes)
        .map_err(|e| format!("pty 書き込み失敗: {e}"))?;
    let _ = entry.writer.flush();
    Ok(())
}

/// 端末リサイズ（cols/rows）を PTY に伝える（SIGWINCH 相当）。
#[tauri::command]
pub fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let reg = registry().lock().map_err(|_| "registry lock".to_string())?;
    if let Some(entry) = reg.get(&id) {
        entry
            .master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize 失敗: {e}"))?;
    }
    Ok(())
}

/// PTY セッションを終了（子プロセス kill＋登録解除）。
#[tauri::command]
pub fn pty_kill(id: String) -> Result<(), String> {
    let removed = registry()
        .lock()
        .map_err(|_| "registry lock".to_string())?
        .remove(&id);
    if let Some(mut entry) = removed {
        let _ = entry.child.kill();
    }
    Ok(())
}
