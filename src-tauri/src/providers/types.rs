//! Provider 共通型。
//!
//! `NormalizedEvent` は React 側に流す統一スキーマ。lib.rs の旧 `SidecarOut` と
//! ほぼ同じ形を保ち、フロントエンドの変更を最小化する。

use serde::{Deserialize, Serialize};

/// セッション起動オプション。
#[derive(Debug, Clone)]
pub struct SpawnOpts {
    /// UNICREW 内のセッション識別子（CLI 側の session_id とは別）
    pub session_id: String,
    /// 作業ディレクトリ
    pub workspace: Option<String>,
    /// 効果的なシステムプロンプト（人格＋キャラ合成済）
    pub system_prompt: String,
    /// CLI に渡す model alias or full name（"sonnet" "opus" "claude-sonnet-4-6" 等）
    pub model: String,
    /// 認証モード："subscription"（OAuth）または "apikey"
    pub auth_mode: AuthMode,
    /// auth_mode == "apikey" のときのみ使う
    pub api_key: Option<String>,
    /// 既存 CLI セッションを再開する場合の CLI 側 session_id。
    /// Claude: `--resume <sid>` に使う。Codex: `exec resume <sid>` に使う。
    /// None なら新規セッション。
    pub resume_cli_session_id: Option<String>,
    /// Shift+Tab で切替するパーミッションモード（フロントから受け取る）。
    /// AcceptEdits（既定）= 自動編集 / Plan = 読み取り・分析のみ。
    pub permission_mode: PermissionMode,
}

/// Shift+Tab トグルで切替するパーミッションモード。
///
/// 各 provider への射影:
/// - Claude: AcceptEdits → `--permission-mode acceptEdits`、Plan → `--permission-mode plan`
/// - Codex : AcceptEdits → 既存の `--dangerously-bypass-approvals-and-sandbox`、
///           Plan → `--sandbox read-only --ask-for-approval never`（書込・実行を拒否）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    AcceptEdits,
    Plan,
}

impl PermissionMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "plan" => PermissionMode::Plan,
            _ => PermissionMode::AcceptEdits,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthMode {
    /// CLI が自前で持っている OAuth トークンを使う（Pro/Max サブスク）
    Subscription,
    /// ANTHROPIC_API_KEY を CLI に渡す（Anthropic 従量課金 / OpenAI Platform）
    ApiKey,
}

impl AuthMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "apikey" | "api_key" => AuthMode::ApiKey,
            _ => AuthMode::Subscription,
        }
    }
}

/// React 側に emit する統一イベント。
///
/// 旧 `SidecarOut` と互換のあるシリアライズ形式（`tag = "kind"`）を維持し、
/// 既存 React コンポーネントを大幅に書き換えなくて済むようにする。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind")]
pub enum NormalizedEvent {
    #[serde(rename = "ready")]
    Ready { session_id: String },

    /// CLI（Claude / Codex）が割り当てた本物のセッションID。
    /// フロント側で thread に保存しておくことで、将来 `--resume` / `exec resume` で
    /// アプリ再起動後も同じ会話文脈を続けられる。
    #[serde(rename = "cli_session_id")]
    CliSessionId {
        /// UNICREW 内部のセッションID（slot 単位）
        session_id: String,
        /// CLI が割り当てた実セッション ID（Claude の system.init / Codex の task_started から）
        cli_session_id: String,
    },

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

    #[serde(rename = "usage_delta")]
    UsageDelta {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_read_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_creation_tokens: Option<u64>,
    },

    #[serde(rename = "result")]
    Result {
        session_id: String,
        subtype: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<serde_json::Value>,
    },

    #[serde(rename = "error")]
    Error {
        session_id: String,
        message: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("CLI binary not found: {0}")]
    CliNotFound(String),
    #[error("subprocess spawn failed: {0}")]
    SpawnFailed(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("session error: {0}")]
    Session(String),
}

impl From<ProviderError> for String {
    fn from(e: ProviderError) -> String {
        e.to_string()
    }
}
