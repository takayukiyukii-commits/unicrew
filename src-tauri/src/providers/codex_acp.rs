//! codex-acp（zed-industries 製、Apache-2.0）プロバイダ。
//!
//! UNICREW から `codex-acp` binary を spawn し、業界標準 ACP プロトコル
//! （JSON-RPC over stdio）で OpenAI Codex モデルと通信する。
//!
//! ## 既存 `codex` プロバイダ（providers/codex.rs）との違い
//!
//! | | `codex` (CLI) | `codex-acp` (本プロバイダ) |
//! |---|---|---|
//! | 配布元 | OpenAI 公式 | Zed Industries（OSS Apache-2.0） |
//! | 認証 | ChatGPT Plus/Pro OAuth | **OPENAI_API_KEY 必須**（BYOK 経路） |
//! | プロトコル | 独自 stream-json | 業界標準 ACP |
//! | UNICREW のコスト構造 | A案（BYO ChatGPT） | B案（BYOK） |
//!
//! BYOK 経路の販売需要に応えるため、両者を併存させる（competing ではなく complementary）。
//!
//! ## 起動コマンド
//!
//! ```text
//! OPENAI_API_KEY=sk-... codex-acp
//! ```
//!
//! サブコマンド不要。`current_dir(ws)` で workspace を反映、env は親プロセスから継承。
//!
//! ## 参考
//!
//! - repo: <https://github.com/zed-industries/codex-acp>
//! - 認証は `OPENAI_API_KEY` / `CODEX_API_KEY` / ChatGPT subscription のいずれか

use crate::providers::types::{NormalizedEvent, ProviderError, SpawnOpts};
use crate::providers::{acp_transport, CliProvider, SessionHandle};
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use agent_client_protocol::schema::{
    InitializeRequest, ProtocolVersion, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SessionNotification,
};
use agent_client_protocol::{Client, ConnectionTo};

pub struct CodexAcpProvider;

impl CodexAcpProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for CodexAcpProvider {
    fn id(&self) -> &'static str {
        "codex-acp"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: mpsc::UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // `codex-acp` を subprocess として起動（サブコマンド無し）。
        let mut cmd = crate::build_silent_command("codex-acp");
        if let Some(ws) = &opts.workspace {
            cmd.current_dir(ws);
        }
        // 実行時の OpenAI 認証。
        // AuthMode::ApiKey で結城さんが UI に登録した OpenAI key（Whisper 用と共用）が
        // opts.api_key として流れてくる場合はそれを OPENAI_API_KEY に注入する。
        // AuthMode::Subscription の場合は env を触らず、UNICREW を起動した shell が
        // 既に OPENAI_API_KEY / CODEX_API_KEY / ChatGPT subscription を持っている前提。
        if let crate::providers::types::AuthMode::ApiKey = opts.auth_mode {
            if let Some(k) = opts.api_key.as_ref() {
                cmd.env("OPENAI_API_KEY", k);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut tokio_cmd = Command::from(cmd);
        let mut child = tokio_cmd
            .spawn()
            .map_err(|e| ProviderError::SpawnFailed(format!("codex-acp spawn failed: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ProviderError::Session("stdin take failed".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Session("stdout take failed".to_string()))?;

        let _ = event_sender.send(NormalizedEvent::Ready {
            session_id: opts.session_id.clone(),
        });

        let (prompt_tx, mut prompt_rx) = mpsc::unbounded_channel::<String>();

        let session_id = opts.session_id.clone();
        let session_id_for_loop = session_id.clone();
        let session_id_for_notif = session_id.clone();
        let session_id_for_perm = session_id.clone();
        let session_id_for_turn = session_id.clone();
        let event_sender_for_loop = event_sender.clone();
        let event_sender_for_notif = event_sender.clone();
        let event_sender_for_perm = event_sender.clone();
        let event_sender_for_turn = event_sender.clone();

        let broker = acp_transport::PermissionBroker::new();
        let broker_for_perm = broker.clone();

        let child_arc = Arc::new(Mutex::new(Some(child)));
        let child_for_cleanup = child_arc.clone();

        tokio::spawn(async move {
            let transport = agent_client_protocol::ByteStreams::new(
                stdin.compat_write(),
                stdout.compat(),
            );

            let result = Client
                .builder()
                .name("unicrew")
                .on_receive_notification(
                    async move |notification: SessionNotification, _cx| {
                        if let Some(ev) = acp_transport::map_session_update(
                            &session_id_for_notif,
                            &notification.update,
                        ) {
                            let _ = event_sender_for_notif.send(ev);
                        }
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        let request_id = broker_for_perm.next_request_id("codex-acp");
                        let rx = broker_for_perm.register(request_id.clone()).await;
                        let event = acp_transport::build_permission_request_event(
                            &session_id_for_perm,
                            &request_id,
                            &request,
                        );
                        let _ = event_sender_for_perm.send(event);
                        let outcome = match rx.await {
                            Ok(decision) => {
                                acp_transport::select_outcome_for_decision(&request, &decision)
                            }
                            Err(_) => RequestPermissionOutcome::Cancelled,
                        };
                        responder.respond(RequestPermissionResponse::new(outcome))
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(
                    transport,
                    async move |cx: ConnectionTo<agent_client_protocol::Agent>| {
                        let _init = cx
                            .send_request(InitializeRequest::new(ProtocolVersion::LATEST))
                            .block_task()
                            .await?;

                        cx.build_session_cwd()?
                            .block_task()
                            .run_until(async move |mut session| {
                                while let Some(prompt) = prompt_rx.recv().await {
                                    if let Err(e) = session.send_prompt(&prompt) {
                                        eprintln!(
                                            "[unicrew/codex-acp] send_prompt error: {e:?}"
                                        );
                                        acp_transport::emit_turn_complete(
                                            &session_id_for_turn,
                                            "error",
                                            &event_sender_for_turn,
                                        );
                                        break;
                                    }
                                    if let Err(e) = session.read_to_string().await {
                                        eprintln!(
                                            "[unicrew/codex-acp] read_to_string error: {e:?}"
                                        );
                                        acp_transport::emit_turn_complete(
                                            &session_id_for_turn,
                                            "error",
                                            &event_sender_for_turn,
                                        );
                                        break;
                                    }
                                    acp_transport::emit_turn_complete(
                                        &session_id_for_turn,
                                        "success",
                                        &event_sender_for_turn,
                                    );
                                }
                                Ok(())
                            })
                            .await
                    },
                )
                .await;

            if let Err(e) = result {
                let _ = event_sender_for_loop.send(NormalizedEvent::Error {
                    session_id: session_id_for_loop.clone(),
                    message: format!("codex-acp ACP error: {e:?}"),
                });
            }

            let mut guard = child_for_cleanup.lock().await;
            if let Some(mut ch) = guard.take() {
                let _ = ch.start_kill();
            }
        });

        Ok(Box::new(CodexAcpSessionHandle {
            session_id,
            prompt_tx,
            child: child_arc,
            broker,
        }))
    }
}

pub struct CodexAcpSessionHandle {
    #[allow(dead_code)]
    session_id: String,
    prompt_tx: mpsc::UnboundedSender<String>,
    child: Arc<Mutex<Option<Child>>>,
    broker: acp_transport::PermissionBroker,
}

#[async_trait::async_trait]
impl SessionHandle for CodexAcpSessionHandle {
    async fn send_user_message(&mut self, text: &str) -> Result<(), ProviderError> {
        self.prompt_tx
            .send(text.to_string())
            .map_err(|_| ProviderError::Session("ACP loop not running".to_string()))?;
        Ok(())
    }

    async fn send_permission_response(
        &mut self,
        request_id: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        self.broker.complete(request_id, decision).await;
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ProviderError> {
        let mut guard = self.child.lock().await;
        if let Some(mut ch) = guard.take() {
            let _ = ch.start_kill();
            let _ = ch.wait().await;
        }
        Ok(())
    }
}
