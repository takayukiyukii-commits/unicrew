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
    /// 同一 id の開き直しレース対策（2026-08-27 監査R1）。
    /// 旧 reader thread の終了処理が、開き直された新しい entry を
    /// registry から消してしまわないよう、世代が一致する時だけ remove する。
    generation: u64,
}

/// PTY 開始ごとに増える世代カウンタ。
static PTY_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
    /// 子プロセスの終了コード。取得できなかった場合は None。
    /// 旧実装は id しか運んでおらず、フロントは「なぜ落ちたか」を示せなかった。
    code: Option<u32>,
    /// 正常終了か（signal 終了は false）。取得できなかった場合は None。
    success: Option<bool>,
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
    let generation = PTY_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;

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
    let generation_r = generation;
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
        // 🚨 世代ガード（監査R1）: 同一 id で開き直された後に旧 reader が
        // ここへ到達すると、無条件 remove では「動いている新しい PTY」を
        // registry から消してしまい、以後 write/resize/kill が全部効かなくなる。
        // exit イベントも同様に、現世代のときだけ通知する。
        //
        // 終了コードの取得（2026-09-04 追加）:
        // EOF は「出力が閉じた」だけで終了コードは分からないため try_wait で拾う。
        // wait（ブロッキング）を registry のロックを持ったまま呼ぶと、その間
        // pty_write / pty_resize / pty_kill が全部止まるので使わない。
        // ロックは 1 回の try_wait ごとに取って即離し、最大 ~500ms だけ待つ。
        // 取れなければ None（＝「分からない」）を返す。0 で埋めない。
        let mut status: Option<(u32, bool)> = None;
        let mut is_current = false;
        for _ in 0..20 {
            let mut gone = false;
            {
                match registry().lock() {
                    Ok(mut reg) => match reg.get_mut(&id_r) {
                        // 現世代のエントリだけ触る。世代違い＝開き直された後なので
                        // 触らずに黙って降りる（通知もしない）。
                        Some(e) if e.generation == generation_r => {
                            is_current = true;
                            if let Ok(Some(st)) = e.child.try_wait() {
                                status = Some((st.exit_code(), st.success()));
                            }
                        }
                        // 自分で pty_kill した後（entry が既に無い）／世代違いは
                        // 通知しない（旧実装と同じ＝閉じた瞬間に終了通知を出さない）。
                        _ => {
                            is_current = false;
                            gone = true;
                        }
                    },
                    Err(_) => {
                        is_current = false;
                        gone = true;
                    }
                }
            }
            if gone || status.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if is_current {
            let _ = app_r.emit(
                "pty://exit",
                PtyExit {
                    id: id_r.clone(),
                    code: status.map(|(c, _)| c),
                    success: status.map(|(_, ok)| ok),
                },
            );
            if let Ok(mut reg) = registry().lock() {
                if reg.get(&id_r).map(|e| e.generation) == Some(generation_r) {
                    reg.remove(&id_r);
                }
            }
        }
    });

    registry().lock().map_err(|_| "registry lock".to_string())?.insert(
        id.clone(),
        PtyEntry {
            writer,
            master: pair.master,
            child,
            generation,
        },
    );

    // 🚨 子プロセスの見張り（2026-09-04 実機で発覚した不具合の根治）。
    //
    // Windows の ConPTY では、**子が終了しても master 側の read が返らない**。
    // master のハンドルを保持している限りブロックしたままなので、
    // 「reader が EOF を見たら終了を通知する」という作りでは
    // *終了が一度も通知されない*（実機で `exit 3` を打っても
    // 「プロセスが終了しました」が 12 秒待っても出なかった）。
    //
    // そこで子プロセスを別スレッドで見張り、終了したら
    //   ① 終了コードつきで通知し
    //   ② registry から外す（＝ master が drop され reader も解放される）
    // 二重通知は起きない。reader 側は「現世代のエントリが有るときだけ通知する」
    // ので、先にここで外れていれば黙って降りる（逆順でも同じ）。
    let app_w = app.clone();
    let id_w = id.clone();
    let generation_w = generation;
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let mut done: Option<(u32, bool)> = None;
            {
                let mut reg = match registry().lock() {
                    Ok(r) => r,
                    Err(_) => return,
                };
                match reg.get_mut(&id_w) {
                    Some(e) if e.generation == generation_w => match e.child.try_wait() {
                        Ok(Some(st)) => done = Some((st.exit_code(), st.success())),
                        Ok(None) => {}
                        Err(_) => return,
                    },
                    // 自分で kill した／開き直された＝見張る対象がもう無い
                    _ => return,
                }
                if done.is_some()
                    && reg.get(&id_w).map(|e| e.generation) == Some(generation_w)
                {
                    reg.remove(&id_w);
                }
            }
            if let Some((code, success)) = done {
                let _ = app_w.emit(
                    "pty://exit",
                    PtyExit {
                        id: id_w.clone(),
                        code: Some(code),
                        success: Some(success),
                    },
                );
                return;
            }
        }
    });
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
