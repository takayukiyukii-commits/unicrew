//! Codex CLI driver。
//!
//! Codex CLI（OpenAI公式）は Claude と違って `codex exec` が単発実行モデル。
//! 永続 stdin パイプを開いておく方式ではなく、メッセージごとに `codex exec resume`
//! を呼び直すパターンにする。
//!
//! ToS 遵守メモ:
//!  - `codex-sdk` Node SDK は import しない
//!  - ChatGPT Plus/Pro の OAuth は CLI 側で完結（UNICREW は触らない）
//!  - サブスク or API キーの切替は CLI が認識する標準 env / 認証ファイルに任せる

use crate::providers::types::{AuthMode, NormalizedEvent, ProviderError, SpawnOpts};
use crate::providers::{CliProvider, SessionHandle};
use serde_json::Value;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

pub struct CodexProvider;

impl CodexProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for CodexProvider {
    fn id(&self) -> &'static str {
        "codex"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // Codex は send 時に都度 subprocess を立てるので、ここでは Ready だけ送って
        // ハンドルを返す。実セッション ID は最初の send 後に CLI から取得して保持。
        let _ = event_sender.send(NormalizedEvent::Ready {
            session_id: opts.session_id.clone(),
        });
        Ok(Box::new(CodexSessionHandle {
            session_id: opts.session_id,
            workspace: opts.workspace,
            model: opts.model,
            auth_mode: opts.auth_mode,
            api_key: opts.api_key,
            system_prompt: opts.system_prompt,
            cli_session_id: Arc::new(Mutex::new(None)),
            event_sender,
            stopped: Arc::new(Mutex::new(false)),
        }))
    }
}

pub struct CodexSessionHandle {
    /// UNICREW 内部 ID（React 側で使う）
    session_id: String,
    workspace: Option<String>,
    model: String,
    auth_mode: AuthMode,
    api_key: Option<String>,
    system_prompt: String,
    /// Codex CLI 側のセッションID（最初の exec で取得）
    cli_session_id: Arc<Mutex<Option<String>>>,
    event_sender: UnboundedSender<NormalizedEvent>,
    stopped: Arc<Mutex<bool>>,
}

#[async_trait::async_trait]
impl SessionHandle for CodexSessionHandle {
    async fn send_user_message(&mut self, text: &str) -> Result<(), ProviderError> {
        if *self.stopped.lock().await {
            return Ok(());
        }

        let cli_session = self.cli_session_id.lock().await.clone();
        let mut cmd = crate::build_silent_command("codex");

        if let Some(sid) = cli_session.as_ref() {
            cmd.arg("exec").arg("resume").arg(sid);
        } else {
            cmd.arg("exec");
        }

        cmd.args([
            "--json",
            "--skip-git-repo-check",
            "--full-auto",
        ]);

        if !self.model.is_empty() {
            cmd.arg("-m").arg(&self.model);
        }

        if let Some(ws) = &self.workspace {
            cmd.arg("-C").arg(ws);
        }

        // システムプロンプトは Codex の config 経由（-c instructions=...）。
        // ただし長文の場合 TOML エスケープに弱いので、最初のメッセージ前置きとして合成する。
        let prompt = if cli_session.is_none() && !self.system_prompt.is_empty() {
            format!("{}\n\n---\n\n{}", self.system_prompt, text)
        } else {
            text.to_string()
        };
        cmd.arg(prompt);

        // 認証モード制御
        match self.auth_mode {
            AuthMode::Subscription => {
                cmd.env_remove("OPENAI_API_KEY");
            }
            AuthMode::ApiKey => {
                if let Some(k) = self.api_key.as_ref() {
                    cmd.env("OPENAI_API_KEY", k);
                }
            }
        }

        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            ProviderError::SpawnFailed(format!(
                "codex CLI を起動できませんでした（インストール / PATH を確認してください）: {}",
                e
            ))
        })?;

        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderError::Session("codex subprocess の stdout が取得できません".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProviderError::Session("codex subprocess の stderr が取得できません".into())
        })?;

        let session_id_for_stdout = self.session_id.clone();
        let event_sender_stdout = self.event_sender.clone();
        let cli_session_for_stdout = Arc::clone(&self.cli_session_id);

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let parsed: Result<Value, _> = serde_json::from_str(&line);
                let v = match parsed {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // Codex CLI の JSONL イベント正規化
                let events = normalize_codex_event(&session_id_for_stdout, &v);

                // 初回 session_id を捕捉
                if let Some(sid) = extract_session_id(&v) {
                    let mut guard = cli_session_for_stdout.lock().await;
                    if guard.is_none() {
                        *guard = Some(sid);
                    }
                }

                for ev in events {
                    if event_sender_stdout.send(ev).is_err() {
                        return;
                    }
                }
            }
        });

        let session_id_for_stderr = self.session_id.clone();
        let event_sender_stderr = self.event_sender.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let lower = line.to_lowercase();
                if lower.contains("error") || lower.contains("failed") {
                    let _ = event_sender_stderr.send(NormalizedEvent::Error {
                        session_id: session_id_for_stderr.clone(),
                        message: line,
                    });
                }
            }
        });

        // child は send 関数のスコープを抜けると drop される。
        // Codex は exec 単位で完結するので、終了を待つ必要はないが、
        // ゾンビ防止のためバックグラウンドで wait する。
        tokio::spawn(async move {
            let _ = child.wait().await;
        });

        Ok(())
    }

    async fn send_permission_response(
        &mut self,
        _request_id: &str,
        _decision: &str,
    ) -> Result<(), ProviderError> {
        // Codex は --full-auto モードなので permission prompt を出さない
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ProviderError> {
        *self.stopped.lock().await = true;
        // 個別 child は send ごとに background wait してるので明示 kill 不要
        Ok(())
    }
}

/// Codex JSONL イベントを NormalizedEvent に変換。
///
/// Codex の JSONL イベント形（観測される主なもの）:
///   - {"id":"...","msg":{"type":"agent_message","message":"..."}}
///   - {"id":"...","msg":{"type":"task_started", "session_id": "uuid"}}
///   - {"id":"...","msg":{"type":"command_executed", "stdout":"...", ...}}
///   - {"id":"...","msg":{"type":"task_complete","last_agent_message":"..."}}
///   - {"id":"...","msg":{"type":"error", "message":"..."}}
fn normalize_codex_event(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    let Some(msg) = v.get("msg") else {
        return vec![];
    };
    let msg_type = msg.get("type").and_then(|x| x.as_str()).unwrap_or("");

    match msg_type {
        "agent_message" | "agent_message_delta" => {
            if let Some(text) = msg
                .get("message")
                .or_else(|| msg.get("delta"))
                .and_then(|x| x.as_str())
            {
                vec![NormalizedEvent::AssistantText {
                    session_id: session_id.to_string(),
                    text: text.to_string(),
                }]
            } else {
                vec![]
            }
        }
        "exec_command_begin" | "command_started" | "tool_use" => {
            let tool_use_id = msg
                .get("call_id")
                .or_else(|| msg.get("id"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let tool_name = msg
                .get("tool")
                .or_else(|| msg.get("command"))
                .and_then(|x| x.as_str())
                .unwrap_or("Bash")
                .to_string();
            let tool_input = msg.clone();
            vec![NormalizedEvent::ToolUse {
                session_id: session_id.to_string(),
                tool_use_id,
                tool_name,
                tool_input,
            }]
        }
        "exec_command_end" | "command_executed" | "tool_result" => {
            let tool_use_id = msg
                .get("call_id")
                .or_else(|| msg.get("id"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = msg
                .get("exit_code")
                .and_then(|x| x.as_i64())
                .map(|c| c != 0)
                .unwrap_or(false);
            let content = msg
                .get("stdout")
                .or_else(|| msg.get("output"))
                .cloned()
                .unwrap_or(Value::Null);
            vec![NormalizedEvent::ToolResult {
                session_id: session_id.to_string(),
                tool_use_id,
                is_error,
                content,
            }]
        }
        "task_complete" => {
            let cost = msg.get("cost_usd").and_then(|x| x.as_f64());
            let usage = msg.get("usage").cloned();
            vec![NormalizedEvent::Result {
                session_id: session_id.to_string(),
                subtype: "success".to_string(),
                cost_usd: cost,
                usage,
            }]
        }
        "error" => {
            let message = msg
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            vec![NormalizedEvent::Error {
                session_id: session_id.to_string(),
                message,
            }]
        }
        _ => vec![],
    }
}

fn extract_session_id(v: &Value) -> Option<String> {
    if let Some(s) = v.get("msg").and_then(|m| m.get("session_id")).and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    if let Some(s) = v.get("session_id").and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    None
}
