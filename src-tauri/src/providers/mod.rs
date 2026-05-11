//! Provider 抽象レイヤ。
//!
//! UNICREW は SDK を使わず、公式 CLI を subprocess として spawn する。
//! ここでは provider ごとの差異（CLI 名、フラグ、stream-json フォーマット）を
//! 共通 trait で吸収する。
//!
//! 現在の provider:
//!  - claude  → `claude` CLI（Anthropic公式、Pro/Max OAuth または ANTHROPIC_API_KEY）
//!  - codex   → `codex` CLI（OpenAI公式、ChatGPT Plus/Pro OAuth または OPENAI_API_KEY）
//!  - gemini  → `gemini` CLI（Google、stream-json対応待ちで現在 stub）
//!  - goose     → `goose acp` subprocess（業界標準 ACP プロトコル経由、Apache-2.0、Sprint 1 で追加）
//!  - opencode  → `opencode acp` subprocess（同上、MIT、Sprint 2 で追加）
//!  - codex-acp → `codex-acp` binary（zed-industries 製、Apache-2.0、OPENAI_API_KEY BYOK 経路、Sprint 2）
//!  - kiro      → `kiro-cli acp --trust-all-tools`（AWS Bedrock backed、Sprint 2）
//!  - qwen      → `qwen` CLI（QwenLM/Alibaba、Apache-2.0、Claude Code fork、DASHSCOPE_API_KEY BYOK、Sprint 3）
//!
//! 将来追加候補:
//!  - copilot   → `copilot` CLI（GitHub）
//!  - kimi     （独自 stream-json 経路、`kimi acp` 対応有無で L2/L3 判定）

pub mod acp_transport;
pub mod claude;
pub mod codex;
pub mod codex_acp;
pub mod gemini;
pub mod goose;
pub mod kiro;
pub mod opencode;
pub mod qwen;
pub mod stream_parser;
pub mod types;

use crate::providers::types::{NormalizedEvent, ProviderError, SpawnOpts};
use std::sync::Arc;

/// 全 provider 共通インターフェイス。
#[async_trait::async_trait]
pub trait CliProvider: Send + Sync {
    /// プロバイダ識別子（"claude" / "codex" / 等）
    fn id(&self) -> &'static str;

    /// CLI subprocess を起動して、永続セッションハンドルを返す。
    ///
    /// 返ってきたハンドルに対して `send_user_message` / `stop` を呼ぶことで
    /// 会話を継続できる。stdout から流れてくる stream-json は内部で
    /// `NormalizedEvent` に正規化されて event_sender に流される。
    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: tokio::sync::mpsc::UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError>;
}

/// セッションハンドル：spawn 済 subprocess を制御する。
#[async_trait::async_trait]
pub trait SessionHandle: Send + Sync {
    /// ユーザーメッセージを送信。CLI の stdin に stream-json で書き込む。
    async fn send_user_message(&mut self, text: &str) -> Result<(), ProviderError>;

    /// 許可応答（permission prompt が来た時）を送信。
    async fn send_permission_response(
        &mut self,
        request_id: &str,
        decision: &str,
    ) -> Result<(), ProviderError>;

    /// セッション終了（subprocess kill）。
    async fn stop(&mut self) -> Result<(), ProviderError>;
}

/// provider id から具象 provider を生成。
pub fn build_provider(id: &str) -> Option<Arc<dyn CliProvider>> {
    match id {
        "claude" => Some(Arc::new(claude::ClaudeProvider::new())),
        "codex" => Some(Arc::new(codex::CodexProvider::new())),
        "gemini" => Some(Arc::new(gemini::GeminiProvider::new())),
        "goose" => Some(Arc::new(goose::GooseProvider::new())),
        "opencode" => Some(Arc::new(opencode::OpenCodeProvider::new())),
        "codex-acp" => Some(Arc::new(codex_acp::CodexAcpProvider::new())),
        "kiro" => Some(Arc::new(kiro::KiroProvider::new())),
        "qwen" => Some(Arc::new(qwen::QwenProvider::new())),
        _ => None,
    }
}
