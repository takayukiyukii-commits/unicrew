//! Kiro CLI（AWS Labs 製）プロバイダ。
//!
//! UNICREW から `kiro-cli acp --trust-all-tools` subprocess を起動し、業界標準 ACP プロトコル
//! （JSON-RPC over stdio）で Amazon Bedrock backed のエージェントと通信する。
//!
//! ## 起動コマンド
//!
//! ```text
//! kiro-cli acp --trust-all-tools
//! ```
//!
//! - binary 名は `kiro-cli`（`kiro` ではない）
//! - `--trust-all-tools` フラグでツール実行の許可プロンプトを自動承認（auto-approve）
//! - 認証は AWS credentials（`~/.aws/credentials` または環境変数）に依存し、Bedrock の利用権限が必要
//!
//! ## 参考
//!
//! - aws-samples/sample-acp-bridge で `kiro-cli acp --trust-all-tools` の起動が公式に示されている
//! - 本プロバイダ自体は Sprint 1 で導入した `acp_transport` を流用するため、Goose / OpenCode と同形

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

pub struct KiroProvider;

impl KiroProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for KiroProvider {
    fn id(&self) -> &'static str {
        "kiro"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: mpsc::UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // `kiro-cli acp --trust-all-tools` を subprocess として起動。
        let mut cmd = crate::build_silent_command("kiro-cli");
        cmd.arg("acp").arg("--trust-all-tools");
        if let Some(ws) = &opts.workspace {
            cmd.current_dir(ws);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut tokio_cmd = Command::from(cmd);
        let mut child = tokio_cmd
            .spawn()
            .map_err(|e| ProviderError::SpawnFailed(format!("kiro-cli acp spawn failed: {e}")))?;

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

        // 注: kiro は `--trust-all-tools` 起動なので permission 要求はそもそも来ないが、
        // 他 ACP プロバイダと同じ shape で broker を組んで将来の trust 制御に備える。
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
                        let request_id = broker_for_perm.next_request_id("kiro");
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
                                            "[unicrew/kiro] send_prompt error: {e:?}"
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
                                            "[unicrew/kiro] read_to_string error: {e:?}"
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
                    message: format!("kiro ACP error: {e:?}"),
                });
            }

            let mut guard = child_for_cleanup.lock().await;
            if let Some(mut ch) = guard.take() {
                let _ = ch.start_kill();
            }
        });

        Ok(Box::new(KiroSessionHandle {
            session_id,
            prompt_tx,
            child: child_arc,
            broker,
        }))
    }
}

pub struct KiroSessionHandle {
    #[allow(dead_code)]
    session_id: String,
    prompt_tx: mpsc::UnboundedSender<String>,
    child: Arc<Mutex<Option<Child>>>,
    broker: acp_transport::PermissionBroker,
}

#[async_trait::async_trait]
impl SessionHandle for KiroSessionHandle {
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
