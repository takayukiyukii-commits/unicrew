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

// ============================================================
// 診断ログ（日本語入力ズレの原因特定用・一時的）。
// claude が出す ANSI 制御コードと入出力・端末サイズを生のまま記録する。
// 同一マシン上で解析するため固定パスへ書き出す。原因確定後に削除する。
// ============================================================
const DBG_PATH: &str = "D:\\Downloads\\unicrew-term-debug.log";

/// 制御文字を可読化（ESC やカーソル移動が見えるように）。UTF-8 の多バイト
/// （日本語）はそのまま通すのでログ上で日本語が読める。
fn esc_bytes(buf: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(buf.len() * 2);
    for &b in buf {
        match b {
            0x1b => out.extend_from_slice(b"\\x1b"),
            0x0d => out.extend_from_slice(b"\\r"),
            0x0a => out.extend_from_slice(b"\\n\n"),
            0x09 => out.extend_from_slice(b"\\t"),
            0x00..=0x1f | 0x7f => out.extend_from_slice(format!("\\x{:02x}", b).as_bytes()),
            _ => out.push(b),
        }
    }
    out
}

fn dbg_truncate(header: &str) {
    if let Ok(mut f) = std::fs::File::create(DBG_PATH) {
        let _ = f.write_all(header.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

fn dbg_line(line: &str) {
    if let Ok(meta) = std::fs::metadata(DBG_PATH) {
        if meta.len() > 8 * 1024 * 1024 {
            return; // 暴走防止（8MB上限）
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(DBG_PATH) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.write_all(b"\n");
    }
}

fn dbg_data(prefix: &str, data: &[u8]) {
    if let Ok(meta) = std::fs::metadata(DBG_PATH) {
        if meta.len() > 8 * 1024 * 1024 {
            return;
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(DBG_PATH) {
        let _ = f.write_all(prefix.as_bytes());
        let _ = f.write_all(&esc_bytes(data));
        let _ = f.write_all(b"\n");
    }
}

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

    // 診断ログを毎セッション頭で初期化（クリーンな1回分を取る）。
    dbg_truncate(&format!(
        "=== OPEN id={id} program={resolved} cols={cols} rows={rows} ==="
    ));

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
    // 未設定のままだと Ink の入力エディタが劣化モードになり、入力欄での ↑↓ が
    // 「行内のカーソル移動」ではなく「プロンプト履歴送り（＝別の会話に飛ぶ）」に
    // なってしまう。フロントは xterm.js なので xterm-256color を名乗らせる。
    // 親から継承した値があっても、フロント実装に合わせて上書きするため loop の後に置く。
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

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
                    // 診断: claude が出した生の ANSI を記録
                    dbg_data("OUT| ", &buf[..n]);
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
    // 診断: フロントから PTY へ送る入力を記録
    dbg_data("IN | ", &bytes);
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
    dbg_line(&format!("RESIZE id={id} cols={cols} rows={rows}"));
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
