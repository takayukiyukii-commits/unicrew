//! 会話（スレッド）の保存先＝アプリ専用フォルダの `threads/<id>.json`（1会話＝1ファイル）。
//!
//! 【背景（2026-10-13）】会話は全部まとめて localStorage の1キーに保存していた。
//! WebView の localStorage には上限（数MB）があり、使い続けると誰でもいつか保存できなくなる。
//! 2026-09-04 の監査で「失敗を黙って捨てずに知らせる」までは直したが、知らせた後に何が
//! 消えて何が残るのかが分からず、利用者が判断できずに止まっていた。
//! → 会話ごとのファイルに分けて、上限そのものを無くす（呼び出し側は lib/storage.ts）。
//!
//! - id は英数字・`_`・`-` だけを受け付ける（フォルダの外へ書かせない）
//! - 書き込みは一時ファイル（毎回別名・新規作成のみ）に書いてから置き換える（途中で落ちても前の内容が残る）
//! - 書き込みと削除は会話ごとの順番待ち（Queue）に載せ、「最新の操作だけ」を順番に実行する。
//!   画面側は変更をすぐここへ渡すだけ＝画面側に書き残しを持たない。アプリ終了時は flush_blocking で書き切る
//!   （2026-10-13 監査：画面側で待たせていた最新の変更が、終了時に失われる／書き込み中に消した会話が復活する）

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const DIR_NAME: &str = "threads";
/// 保存に失敗したとき画面へ送るイベント名（lib/storage.ts が受ける）
pub const SAVE_ERROR_EVENT: &str = "unicrew://thread-save-error";

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn threads_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(DIR_NAME))
}

fn file_for(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("会話の ID が不正です: {id}"));
    }
    Ok(dir.join(format!("{id}.json")))
}

/// フォルダ内の会話ファイルを全部読む。壊れて読めないファイルは飛ばして名前を返す。
pub fn load_all_in(dir: &Path) -> Result<(Vec<String>, Vec<String>), String> {
    let mut threads = Vec::new();
    let mut broken = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((threads, broken)),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if !valid_id(id) {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(text) if serde_json::from_str::<serde_json::Value>(&text).is_ok() => threads.push(text),
            _ => broken.push(name),
        }
    }
    Ok((threads, broken))
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn write_in(dir: &Path, id: &str, json: &str) -> Result<(), String> {
    use std::io::Write;
    let path = file_for(dir, id)?;
    // 壊れた JSON を書かない（読み込み時に1件丸ごと失うため）
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("会話の内容が JSON ではありません: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // 一時ファイルは毎回別名・新規作成のみ（2重起動のアプリ同士で同じ一時ファイルを取り合わない）
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{id}.{}.{seq}.tmp", std::process::id()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        drop(f);
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    let path = file_for(dir, id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 移行前の localStorage の中身を、そのまま控えとして書き出す（threads-backup/legacy-<ミリ秒>.json）。
/// 古い版へ戻したときに会話が「消えた」ように見えても、元の保存はここに残る。
pub fn backup_legacy_in(dir: &Path, json: &str, stamp_ms: u128) -> Result<PathBuf, String> {
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("控えの内容が JSON ではありません: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("legacy-{stamp_ms}.json"));
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path)
}

// ---------- 会話ごとの順番待ち ----------

#[derive(Clone)]
pub enum Op {
    Write(String),
    Delete,
}

/// 失敗の知らせ（id, 操作 "write" | "delete", メッセージ）
type OnError = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;

#[derive(Default)]
struct Slot {
    /// 次にやる操作（新しい操作が来たら置き換える＝最新だけ実行する）
    pending: Option<Op>,
    running: bool,
}

#[derive(Default)]
pub struct Queue {
    slots: Mutex<HashMap<String, Slot>>,
    idle: Condvar,
    /// いま失敗したままの会話（id → メッセージ）。後で同じ会話が成功したら消す。
    /// 終了時に残っていれば次回の起動へ引き継ぐ（画面が閉じた後の失敗は、その場では誰にも届かないため）
    errors: Mutex<HashMap<String, String>>,
}

impl Queue {
    /// 操作を積む。書き込み役がいなければ起こす。すぐ戻る（結果は失敗時だけ on_error で知らせる）
    pub fn enqueue(self: &Arc<Self>, dir: PathBuf, id: String, op: Op, on_error: OnError) -> Result<(), String> {
        if !valid_id(&id) {
            return Err(format!("会話の ID が不正です: {id}"));
        }
        let start = {
            let mut slots = self.slots.lock().map_err(|e| e.to_string())?;
            let slot = slots.entry(id.clone()).or_default();
            slot.pending = Some(op);
            if slot.running {
                false
            } else {
                slot.running = true;
                true
            }
        };
        if start {
            let q = Arc::clone(self);
            std::thread::spawn(move || q.worker(dir, id, on_error));
        }
        Ok(())
    }

    fn worker(self: Arc<Self>, dir: PathBuf, id: String, on_error: OnError) {
        loop {
            let op = {
                let Ok(mut slots) = self.slots.lock() else { return };
                let Some(slot) = slots.get_mut(&id) else { return };
                match slot.pending.take() {
                    Some(op) => op,
                    None => {
                        slots.remove(&id);
                        self.idle.notify_all();
                        return;
                    }
                }
            };
            let (res, op_name) = match &op {
                Op::Write(json) => (write_in(&dir, &id, json), "write"),
                Op::Delete => (delete_in(&dir, &id), "delete"),
            };
            match res {
                Ok(()) => {
                    if let Ok(mut errs) = self.errors.lock() {
                        errs.remove(&id);
                    }
                }
                Err(e) => {
                    if let Ok(mut errs) = self.errors.lock() {
                        errs.insert(id.clone(), e.clone());
                    }
                    on_error(&id, op_name, &e);
                }
            }
        }
    }

    /// 失敗したままの会話と、まだ終わっていない会話（終了時に次回へ引き継ぐ）
    pub fn unresolved(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .errors
            .lock()
            .map(|e| e.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        if let Ok(slots) = self.slots.lock() {
            for id in slots.keys() {
                if !out.iter().any(|(k, _)| k == id) {
                    out.push((id.clone(), "終了までに保存が終わりませんでした".to_string()));
                }
            }
        }
        out
    }

    /// 積まれている操作が全部終わるまで待つ（アプリ終了時）。待ち切れなければ false
    pub fn flush_blocking(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut slots) = self.slots.lock() else { return false };
        while !slots.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            match self.idle.wait_timeout(slots, deadline - now) {
                Ok((g, _)) => slots = g,
                Err(_) => return false,
            }
        }
        true
    }
}

fn queue() -> &'static Arc<Queue> {
    static Q: OnceLock<Arc<Queue>> = OnceLock::new();
    Q.get_or_init(|| Arc::new(Queue::default()))
}

/// 前回の終了時に保存できなかった会話の記録（次の起動で threads_load_all が読んで消す）
const EXIT_ERRORS_FILE: &str = "threads-save-errors.json";

/// アプリ終了時に呼ぶ（lib.rs の RunEvent::Exit）。書き残しを最大 timeout まで書き切り、
/// それでも失敗・未完了の会話があれば、次の起動で知らせるために記録する
pub fn flush_on_exit(app: &AppHandle, timeout: Duration) {
    let q = queue();
    let _ = q.flush_blocking(timeout);
    let unresolved = q.unresolved();
    if unresolved.is_empty() {
        return;
    }
    eprintln!("[unicrew/threads] 終了時に保存できなかった会話: {}", unresolved.len());
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = write_exit_errors(&dir, &unresolved);
    }
}

pub fn write_exit_errors(app_data: &Path, items: &[(String, String)]) -> Result<(), String> {
    let list: Vec<_> = items
        .iter()
        .map(|(id, message)| serde_json::json!({ "id": id, "message": message }))
        .collect();
    std::fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
    std::fs::write(app_data.join(EXIT_ERRORS_FILE), serde_json::Value::Array(list).to_string()).map_err(|e| e.to_string())
}

/// 前回の終了時の記録を読んで消す（読めなければ空）
pub fn take_exit_errors(app_data: &Path) -> Vec<ExitError> {
    let path = app_data.join(EXIT_ERRORS_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    let _ = std::fs::remove_file(&path);
    serde_json::from_str(&text).unwrap_or_default()
}

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
pub struct ExitError {
    id: String,
    message: String,
}

fn emitter(app: &AppHandle) -> OnError {
    let app = app.clone();
    Arc::new(move |id: &str, op: &str, message: &str| {
        let _ = app.emit(SAVE_ERROR_EVENT, serde_json::json!({ "id": id, "op": op, "message": message }));
    })
}

#[derive(serde::Serialize)]
pub struct LoadedThreads {
    /// 各会話の JSON 文字列
    threads: Vec<String>,
    /// 読めなかったファイル名（壊れている）
    broken: Vec<String>,
    /// 保存先フォルダ（案内に出す）
    dir: String,
    /// 前回の終了時に保存できなかった会話
    exit_errors: Vec<ExitError>,
}

#[tauri::command]
pub async fn threads_load_all(app: AppHandle) -> Result<LoadedThreads, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = threads_dir(&app)?;
    let d = dir.clone();
    let (threads, broken, exit_errors) = tokio::task::spawn_blocking(move || {
        let exit_errors = take_exit_errors(&app_data);
        load_all_in(&d).map(|(t, b)| (t, b, exit_errors))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(LoadedThreads { threads, broken, dir: dir.to_string_lossy().to_string(), exit_errors })
}

/// 保存を順番待ちに積む（すぐ戻る。失敗は SAVE_ERROR_EVENT で知らせる）
#[tauri::command]
pub fn thread_write(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let dir = threads_dir(&app)?;
    queue().enqueue(dir, id, Op::Write(json), emitter(&app))
}

/// 削除を順番待ちに積む（書き込み中でも、その後に必ず消える）
#[tauri::command]
pub fn thread_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = threads_dir(&app)?;
    queue().enqueue(dir, id, Op::Delete, emitter(&app))
}

/// 書き残しを書き切る（自動更新のインストール直前に画面から呼ぶ。Windows の updater は
/// RunEvent::Exit を通らずに終了するため）。書けなかった会話は次回の起動へ引き継ぐ
#[tauri::command]
pub async fn threads_flush(app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || flush_on_exit(&app, Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())
}

/// 移行用：書き終わるまで待って結果を返す（移行が全部書けたかを確かめてから localStorage を消すため）
#[tauri::command]
pub async fn thread_write_now(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let dir = threads_dir(&app)?;
    tokio::task::spawn_blocking(move || write_in(&dir, &id, &json))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn threads_backup_legacy(app: AppHandle, json: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("threads-backup");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    tokio::task::spawn_blocking(move || backup_legacy_in(&dir, &json, stamp))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        // 一時フォルダは UNICREW_TEST_TMP で指定できる（このPCは C: に書かない運用のため）
        let base = std::env::var("UNICREW_TEST_TMP").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
        let d = base.join(format!("unicrew-thread-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn no_error() -> OnError {
        Arc::new(|id: &str, op: &str, e: &str| panic!("想定外の失敗 {id} {op}: {e}"))
    }

    #[test]
    fn write_load_delete_roundtrip() {
        let d = tmpdir("roundtrip");
        write_in(&d, "abc_123-X", r#"{"id":"abc_123-X","messages":[]}"#).unwrap();
        write_in(&d, "def", r#"{"id":"def"}"#).unwrap();
        let (threads, broken) = load_all_in(&d).unwrap();
        assert_eq!(threads.len(), 2);
        assert!(broken.is_empty());
        write_in(&d, "def", r#"{"id":"def","title":"x"}"#).unwrap();
        let (threads, _) = load_all_in(&d).unwrap();
        assert!(threads.iter().any(|t| t.contains("\"title\":\"x\"")));
        delete_in(&d, "def").unwrap();
        delete_in(&d, "def").unwrap(); // 無くてもエラーにしない
        assert_eq!(load_all_in(&d).unwrap().0.len(), 1);
        // 一時ファイルが残っていない
        let leftovers: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rejects_ids_that_escape_the_folder() {
        let d = tmpdir("escape");
        for bad in ["../x", "a/b", "a\\b", "", "a.json", "..", "C:x"] {
            assert!(write_in(&d, bad, "{}").is_err(), "{bad} を受け付けてしまった");
            assert!(delete_in(&d, bad).is_err(), "{bad} を消せてしまった");
            let q = Arc::new(Queue::default());
            assert!(q.enqueue(d.clone(), bad.to_string(), Op::Delete, no_error()).is_err());
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn refuses_to_write_broken_json_and_reports_broken_files() {
        let d = tmpdir("broken");
        assert!(write_in(&d, "x", "{not json").is_err());
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("y.json"), "{oops").unwrap();
        write_in(&d, "z", "{}").unwrap();
        let (threads, broken) = load_all_in(&d).unwrap();
        assert_eq!(threads.len(), 1);
        assert_eq!(broken, vec!["y.json".to_string()]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_folder_is_empty_not_error() {
        let d = tmpdir("missing");
        let (threads, broken) = load_all_in(&d).unwrap();
        assert!(threads.is_empty() && broken.is_empty());
    }

    #[test]
    fn backup_writes_the_legacy_blob_as_is() {
        let d = tmpdir("backup");
        let p = backup_legacy_in(&d, r#"[{"id":"a"}]"#, 123).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), r#"[{"id":"a"}]"#);
        assert!(backup_legacy_in(&d, "{broken", 124).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn queue_keeps_only_the_latest_and_flush_waits() {
        let d = tmpdir("queue");
        let q = Arc::new(Queue::default());
        for i in 0..200 {
            q.enqueue(d.clone(), "a".into(), Op::Write(format!(r#"{{"id":"a","n":{i}}}"#)), no_error()).unwrap();
        }
        assert!(q.flush_blocking(Duration::from_secs(10)));
        let text = std::fs::read_to_string(d.join("a.json")).unwrap();
        assert!(text.contains(r#""n":199"#), "最後の内容が残っていない: {text}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn delete_after_write_wins_even_while_writing() {
        // 書き込みの直後に消したら、最後は必ず消えている（書き込み中に消した会話が復活しない）
        let d = tmpdir("delete");
        let q = Arc::new(Queue::default());
        let big = format!(r#"{{"id":"a","body":"{}"}}"#, "x".repeat(2_000_000));
        q.enqueue(d.clone(), "a".into(), Op::Write(big), no_error()).unwrap();
        q.enqueue(d.clone(), "a".into(), Op::Delete, no_error()).unwrap();
        assert!(q.flush_blocking(Duration::from_secs(10)));
        assert!(!d.join("a.json").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn write_errors_are_reported_not_swallowed() {
        let d = tmpdir("err");
        let q = Arc::new(Queue::default());
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let s2 = Arc::clone(&seen);
        let on_err: OnError = Arc::new(move |id: &str, op: &str, _e: &str| s2.lock().unwrap().push(format!("{id}:{op}")));
        q.enqueue(d.clone(), "a".into(), Op::Write("{broken".into()), on_err.clone()).unwrap();
        assert!(q.flush_blocking(Duration::from_secs(10)));
        assert_eq!(*seen.lock().unwrap(), vec!["a:write".to_string()]);
        // 失敗したままの会話は、終了時に次回へ引き継ぐ対象になる
        assert_eq!(q.unresolved().len(), 1);
        // 後で同じ会話が成功したら、引き継がない
        q.enqueue(d.clone(), "a".into(), Op::Write(r#"{"id":"a"}"#.into()), on_err).unwrap();
        assert!(q.flush_blocking(Duration::from_secs(10)));
        assert!(q.unresolved().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn exit_errors_are_handed_to_the_next_launch_once() {
        let d = tmpdir("exit");
        write_exit_errors(&d, &[("a".into(), "disk full".into())]).unwrap();
        let first = take_exit_errors(&d);
        assert_eq!(first, vec![ExitError { id: "a".into(), message: "disk full".into() }]);
        assert!(take_exit_errors(&d).is_empty(), "2回目は空（1回だけ知らせる）");
        let _ = std::fs::remove_dir_all(&d);
    }
}
