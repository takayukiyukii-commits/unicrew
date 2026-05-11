//! Workspace Trust 台帳。
//!
//! - 保存先: `<config_dir>/unicrew/trusted_workspaces.json`
//! - 形式: `{ "paths": ["C:/...","C:/..."], "updated_at": "..." }`
//! - パスは `std::fs::canonicalize` で正規化してから比較する（symlink 対策）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TrustLedger {
    pub paths: BTreeSet<String>,
    pub updated_at: Option<String>,
}

fn ledger_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir()
        .ok_or_else(|| "config_dir 取得失敗".to_string())?;
    let dir = base.join("unicrew");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("trusted_workspaces.json"))
}

fn canonical(p: &str) -> String {
    match std::fs::canonicalize(Path::new(p)) {
        Ok(c) => c.to_string_lossy().to_string(),
        // canonicalize 失敗時は raw path をそのまま返す。
        // 既知の落とし穴: 一度 canonicalize 成功して `\\?\C:\...` 形式で保存された後、
        // ドライブ未マウント等で canonicalize が失敗するようになると raw `C:\...` 形式と
        // 比較されて永続的に "信頼なし" 判定になる。掃除は将来 issue で対応。
        Err(_) => p.to_string(),
    }
}

fn load() -> TrustLedger {
    let path = match ledger_path() {
        Ok(p) => p,
        Err(_) => return TrustLedger::default(),
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return TrustLedger::default(),
    };
    serde_json::from_str::<TrustLedger>(&text).unwrap_or_default()
}

fn save(ledger: &TrustLedger) -> Result<(), String> {
    let path = ledger_path()?;
    let pretty = serde_json::to_string_pretty(ledger).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn is_workspace_trusted(path: String) -> Result<bool, String> {
    let ledger = load();
    let target = canonical(&path);
    Ok(ledger.paths.iter().any(|p| canonical(p) == target))
}

#[tauri::command]
pub fn trust_workspace(path: String) -> Result<(), String> {
    let mut ledger = load();
    ledger.paths.insert(canonical(&path));
    ledger.updated_at = Some(unix_timestamp_str());
    save(&ledger)
}

#[tauri::command]
pub fn untrust_workspace(path: String) -> Result<(), String> {
    let mut ledger = load();
    let target = canonical(&path);
    ledger.paths.retain(|p| canonical(p) != target);
    ledger.updated_at = Some(unix_timestamp_str());
    save(&ledger)
}

#[tauri::command]
pub fn list_trusted_workspaces() -> Result<Vec<String>, String> {
    let ledger = load();
    Ok(ledger.paths.into_iter().collect())
}

/// unix 秒を `@<秒>` 形式で返す（ISO 8601 ではない、比較・デバッグ用の素朴な形）。
/// chrono 依存を増やしたくないので、std::time から手作りしている。
fn unix_timestamp_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("@{}", secs)
}
