//! ACP（Agent Client Protocol、Zed 主導の業界標準）共通レイヤー。
//!
//! Goose / OpenCode / Codex-acp / Kiro 等の ACP 対応エージェントが
//! 同じパスで動くよう、SessionUpdate → NormalizedEvent の変換と
//! 共通の subprocess 起動ヘルパをここに集める。
//!
//! 個別プロバイダ（providers/goose.rs 等）はこのモジュールを呼ぶだけで済む。
//!
//! ## 設計メモ
//!
//! - `agent-client-protocol = "0.11"` を依存追加（crates.io 公開済、Apache-2.0）
//! - example: `crates/goose-sdk/examples/acp_client.rs` を参照
//! - transport: stdio over subprocess（`<bin> acp` を spawn → ByteStreams で wrap）
//! - 多ターン会話: 同じ session に `session/prompt` を繰り返し送信
//! - turn 完了: agent から StopReason（end_turn / cancelled 等）が返る
//!
//! ## 現状（2026-05-10 Sprint 1 着手版）
//!
//! - SessionUpdate の網羅マッピングは TODO（最低限 AgentMessageChunk / ToolCall は対応）
//! - 詳細な on_receive_request の dispatch は次 Sprint で拡充
//! - cancel / interrupt の実装は kill による粗い実装で開始

use crate::providers::types::NormalizedEvent;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

/// agent-client-protocol の SessionUpdate を NormalizedEvent に変換する。
///
/// 未対応の variant は None を返す（呼び出し側で捨てる）。
/// 実装は順次拡張する想定。
pub fn map_session_update(
    session_id: &str,
    update: &agent_client_protocol::schema::SessionUpdate,
) -> Option<NormalizedEvent> {
    use agent_client_protocol::schema::{ContentBlock, SessionUpdate};

    match update {
        SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
            ContentBlock::Text(text) => Some(NormalizedEvent::AssistantText {
                session_id: session_id.to_string(),
                text: text.text.clone(),
            }),
            _ => None,
        },
        SessionUpdate::ToolCall(tool_call) => Some(NormalizedEvent::ToolUse {
            session_id: session_id.to_string(),
            // ToolCallId は `pub struct ToolCallId(pub Arc<str>)` の tuple struct。
            // &Arc<str> → String に変換して NormalizedEvent に詰める。
            tool_use_id: tool_call.tool_call_id.0.to_string(),
            tool_name: tool_call.title.clone(),
            // raw_input が無い場合（agent が省略した場合）は Null を入れる。
            tool_input: tool_call
                .raw_input
                .clone()
                .unwrap_or(serde_json::Value::Null),
        }),
        SessionUpdate::ToolCallUpdate(_update) => {
            // status 更新は現状 React 側に対応 UI が無いため捨てる。
            // 将来 NormalizedEvent::ToolStatus を追加して流す。
            None
        }
        _ => None,
    }
}

/// ACP プロバイダ間で共有する許可要求ブローカー。
///
/// 動作:
///   1. ACP agent が `RequestPermissionRequest` を送ってきたら、
///      `register(request_id)` で oneshot Receiver を作って await する
///   2. その間 `NormalizedEvent::PermissionRequest` をフロントに送る
///   3. ユーザーが UI で決断 → `agent_permission_response` Tauri コマンド
///      → SessionHandle.send_permission_response が `complete(request_id, decision)` を呼ぶ
///   4. oneshot が wake され、closure が `RequestPermissionOutcome` で respond する
///
/// 1 プロバイダインスタンス（= 1 ACP セッション）あたり 1 ブローカー。
/// 同時に複数の許可要求が立ち上がってもよい（HashMap で並列管理）。
#[derive(Default, Clone)]
pub struct PermissionBroker {
    inner: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
    counter: Arc<AtomicU64>,
}

impl PermissionBroker {
    pub fn new() -> Self {
        Self::default()
    }

    /// この ACP セッション内で一意な request_id を発行する。
    /// `<provider>-perm-<counter>` 形式。フロントの key 衝突は session_id で防げる。
    pub fn next_request_id(&self, prefix: &str) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("{}-perm-{}", prefix, n)
    }

    /// 新しい pending request を登録し、ユーザー決断を待つ Receiver を返す。
    /// `complete()` が呼ばれるか、Receiver が drop されるまで待機。
    pub async fn register(&self, request_id: String) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        self.inner.lock().await.insert(request_id, tx);
        rx
    }

    /// フロントの決断を該当 oneshot に届ける。該当 id が無ければ false。
    pub async fn complete(&self, request_id: &str, decision: &str) -> bool {
        let mut guard = self.inner.lock().await;
        if let Some(tx) = guard.remove(request_id) {
            // Receiver が drop 済の場合は send が Err 返すが、ここでは戻り値を捨てる。
            // どちらにせよ pending エントリは消えるのが正しい。
            tx.send(decision.to_string()).ok();
            true
        } else {
            false
        }
    }
}

/// フロントから来る決断文字列を ACP の RequestPermissionOutcome に射影する。
///
/// ACP `PermissionOption.kind` は `allow_once` / `allow_always` / `reject_once` / `reject_always`。
/// UNICREW は "allow" / "allow_once" / "deny" の3択を送ってくるので、
/// kind が一致するものを優先選択し、見つからなければ first option / Cancelled に fallback。
pub fn select_outcome_for_decision(
    request: &agent_client_protocol::schema::RequestPermissionRequest,
    decision: &str,
) -> agent_client_protocol::schema::RequestPermissionOutcome {
    use agent_client_protocol::schema::{
        PermissionOptionKind, RequestPermissionOutcome, SelectedPermissionOutcome,
    };

    let prefer_kinds: Vec<PermissionOptionKind> = match decision {
        "allow" => vec![
            PermissionOptionKind::AllowAlways,
            PermissionOptionKind::AllowOnce,
        ],
        "allow_once" => vec![
            PermissionOptionKind::AllowOnce,
            PermissionOptionKind::AllowAlways,
        ],
        "deny" => vec![
            PermissionOptionKind::RejectOnce,
            PermissionOptionKind::RejectAlways,
        ],
        _ => Vec::new(),
    };

    for kind in &prefer_kinds {
        if let Some(opt) = request.options.iter().find(|o| &o.kind == kind) {
            return RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                opt.option_id.clone(),
            ));
        }
    }

    // 厳密マッチが取れなかった時の fallback。
    if decision == "deny" {
        // deny を allow フォールバックさせるのは危険。明示的に Cancelled に。
        RequestPermissionOutcome::Cancelled
    } else if let Some(first) = request.options.first() {
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(first.option_id.clone()))
    } else {
        RequestPermissionOutcome::Cancelled
    }
}

/// 許可要求イベントをフロントに送るためのヘルパ。
///
/// ACP 0.11 の `RequestPermissionRequest.tool_call` は `ToolCallUpdate` で
/// 直接 `title` / `raw_input` は持たない（fields 子オブジェクト経由になることが多い）。
/// 構造差分に強い実装にするため一度 serde_json::Value に変換して動的に抽出する。
/// 取れなかった場合は tool_name = "permission" / input = Null に fallback。
pub fn build_permission_request_event(
    session_id: &str,
    request_id: &str,
    request: &agent_client_protocol::schema::RequestPermissionRequest,
) -> NormalizedEvent {
    let tool_call_value: serde_json::Value =
        serde_json::to_value(&request.tool_call).unwrap_or(serde_json::Value::Null);

    fn pick_str<'a>(v: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
        for key in keys {
            if let Some(s) = v.get(*key).and_then(|x| x.as_str()) {
                return Some(s);
            }
        }
        None
    }

    let tool_name = pick_str(&tool_call_value, &["title"])
        .or_else(|| {
            tool_call_value
                .get("fields")
                .and_then(|f| pick_str(f, &["title"]))
        })
        .unwrap_or("permission")
        .to_string();

    let input = tool_call_value
        .get("fields")
        .and_then(|f| f.get("raw_input"))
        .cloned()
        .or_else(|| tool_call_value.get("raw_input").cloned())
        .unwrap_or(serde_json::Value::Null);

    NormalizedEvent::PermissionRequest {
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        tool_name,
        input,
    }
}
