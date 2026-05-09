//! Claude CLI driver。
//!
//! `claude` CLI（Anthropic公式）を `--input-format stream-json --output-format stream-json --verbose`
//! のヘッドレスモードで spawn し、永続セッションとして使う。
//!
//! ToS 遵守メモ:
//!  - SDK は import しない
//!  - OAuth トークンは UNICREW 側で読み書きしない（CLI が `~/.claude/credentials` 等で自前管理）
//!  - サブスクモード時は `ANTHROPIC_API_KEY` を env から外して CLI のサブスク認証経路に乗せる

use crate::providers::types::{AuthMode, NormalizedEvent, ProviderError, SpawnOpts};
use crate::providers::{stream_parser, CliProvider, SessionHandle};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

pub struct ClaudeProvider;

impl ClaudeProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for ClaudeProvider {
    fn id(&self) -> &'static str {
        "claude"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        let mut cmd = crate::build_silent_command("claude");

        // ヘッドレス stream-json モード。
        // 注: --include-partial-messages は付けない。付けると assistant 最終確定メッセージと
        // stream_event の delta の両方から AssistantText が流れて二重表示になる。
        // 完全ストリーミングUIが必要になったら parse_assistant 側で text ブロックをスキップする
        // ように切り替える設計に変える。
        cmd.args([
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
        ]);

        // システムプロンプト（人格＋キャラ合成済の文字列）
        if !opts.system_prompt.is_empty() {
            cmd.arg("--append-system-prompt").arg(&opts.system_prompt);
        }

        // モデル
        if !opts.model.is_empty() {
            cmd.arg("--model").arg(&opts.model);
        }

        // ワークスペース
        if let Some(ws) = &opts.workspace {
            cmd.current_dir(ws);
        }

        // 認証モードに応じた env 制御
        match opts.auth_mode {
            AuthMode::Subscription => {
                // CLI の OAuth トークンを使わせるため API_KEY 系を必ず外す
                cmd.env_remove("ANTHROPIC_API_KEY");
                cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
            }
            AuthMode::ApiKey => {
                if let Some(k) = opts.api_key.as_ref() {
                    cmd.env("ANTHROPIC_API_KEY", k);
                }
            }
        }

        // パーミッション：UNICREW UI 側で許可UIを今すぐ提供しないので、acceptEdits を既定にしておく。
        // 将来 PermissionRequest の UI を実装したら "default" に戻して --allowedTools で制御する。
        cmd.arg("--permission-mode").arg("acceptEdits");

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            ProviderError::SpawnFailed(format!(
                "claude CLI を起動できませんでした（インストール / PATH を確認してください）: {}",
                e
            ))
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            ProviderError::Session("claude subprocess の stdin が取得できません".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderError::Session("claude subprocess の stdout が取得できません".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProviderError::Session("claude subprocess の stderr が取得できません".into())
        })?;

        let session_id = opts.session_id.clone();
        let session_id_for_stdout = session_id.clone();
        let event_sender_stdout = event_sender.clone();
        let stdout_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            // session start で Ready を送る
            let _ = event_sender_stdout.send(NormalizedEvent::Ready {
                session_id: session_id_for_stdout.clone(),
            });
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let events = stream_parser::parse_line(&session_id_for_stdout, &line);
                        for ev in events {
                            if event_sender_stdout.send(ev).is_err() {
                                return;
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        });

        // stderr は内部ログとして emit（デバッグ用）
        let session_id_for_stderr = session_id.clone();
        let event_sender_stderr = event_sender.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                // stderr の "Error:" だけ React に通知。それ以外はノイズなのでドロップ。
                let lower = line.to_lowercase();
                if lower.contains("error") || lower.contains("failed") {
                    let _ = event_sender_stderr.send(NormalizedEvent::Error {
                        session_id: session_id_for_stderr.clone(),
                        message: line,
                    });
                }
            }
        });

        Ok(Box::new(ClaudeSessionHandle {
            session_id,
            stdin,
            child,
            _stdout_handle: stdout_handle,
        }))
    }
}

pub struct ClaudeSessionHandle {
    session_id: String,
    stdin: ChildStdin,
    child: Child,
    _stdout_handle: JoinHandle<()>,
}

#[async_trait::async_trait]
impl SessionHandle for ClaudeSessionHandle {
    async fn send_user_message(&mut self, text: &str) -> Result<(), ProviderError> {
        // stream-json input 形式で1行JSON
        let payload = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": text,
            },
        });
        let mut line = serde_json::to_string(&payload)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn send_permission_response(
        &mut self,
        _request_id: &str,
        _decision: &str,
    ) -> Result<(), ProviderError> {
        // 現状 --permission-mode=acceptEdits 固定なので CLI は permission_request を出さない。
        // 将来 dontAsk / default モードに切り替えた際に CLI 側のプロトコルに合わせて実装する。
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ProviderError> {
        let _ = self.stdin.shutdown().await;
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        let _ = &self.session_id;
        Ok(())
    }
}
