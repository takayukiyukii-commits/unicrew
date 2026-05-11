//! Kimi Code CLI（Moonshot AI 製）プロバイダ。
//!
//! UNICREW から `kimi acp` subprocess を起動し、業界標準 ACP プロトコル
//! （JSON-RPC over stdio）で型付き通信する。Goose / OpenCode と同形、起動 CLI のみ差異。
//!
//! ## Sprint 3
//!
//! Moonshot AI が `kimi acp` をネイティブサポート（multi-session Agent Client Protocol
//! server。docs: <https://github.com/moonshotai/kimi-cli/blob/main/docs/en/reference/kimi-acp.md>、
//! 2026-05-11 確認）。Zed / JetBrains 等の ACP-compatible エディタからも同経路で動かせる。
//!
//! 認証は Kimi CLI 側が OAuth で扱う（`/login` で完了 → CLI が自前で credentials を保存）。
//! UNICREW 側は env 注入もキー管理も持たない。
//!
//! インストール経路は Python + uv（`curl install.sh | bash` か `uv tool install kimi-cli`）。
//! UNICREW は npm/winget ベースの自動 install しか持っていないため、manual 枠扱いとし
//! SettingsModal の OSS accordion で「手動のみ」タグ付き行として案内する。
//!
//! ## アーキテクチャ
//!
//! Goose / OpenCode と完全に同じ（`providers/goose.rs` のドキュメント参照）。
//! 違いは `Command::new("kimi")` を `acp` サブコマンドで起動する点のみ。

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

pub struct KimiProvider;

impl KimiProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for KimiProvider {
    fn id(&self) -> &'static str {
        "kimi"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: mpsc::UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // `kimi acp` を subprocess として起動。
        let mut cmd = crate::build_silent_command("kimi");
        cmd.arg("acp");
        if let Some(ws) = &opts.workspace {
            cmd.current_dir(ws);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut tokio_cmd = Command::from(cmd);
        let mut child = tokio_cmd
            .spawn()
            .map_err(|e| ProviderError::SpawnFailed(format!("kimi acp spawn failed: {e}")))?;

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
        let event_sender_for_loop = event_sender.clone();
        let event_sender_for_notif = event_sender.clone();
        let event_sender_for_perm = event_sender.clone();

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
                        let request_id = broker_for_perm.next_request_id("kimi");
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
                                            "[unicrew/kimi] send_prompt error: {e:?}"
                                        );
                                        break;
                                    }
                                    if let Err(e) = session.read_to_string().await {
                                        eprintln!(
                                            "[unicrew/kimi] read_to_string error: {e:?}"
                                        );
                                        break;
                                    }
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
                    message: format!("kimi ACP error: {e:?}"),
                });
            }

            let mut guard = child_for_cleanup.lock().await;
            if let Some(mut ch) = guard.take() {
                let _ = ch.start_kill();
            }
        });

        Ok(Box::new(KimiSessionHandle {
            session_id,
            prompt_tx,
            child: child_arc,
            broker,
        }))
    }
}

pub struct KimiSessionHandle {
    #[allow(dead_code)]
    session_id: String,
    prompt_tx: mpsc::UnboundedSender<String>,
    child: Arc<Mutex<Option<Child>>>,
    broker: acp_transport::PermissionBroker,
}

#[async_trait::async_trait]
impl SessionHandle for KimiSessionHandle {
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
