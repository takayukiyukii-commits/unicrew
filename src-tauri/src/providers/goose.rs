//! Goose（Block 製、Apache-2.0）プロバイダ。
//!
//! UNICREW から `goose acp` subprocess を起動し、業界標準 ACP プロトコル
//! （JSON-RPC over stdio）で型付き通信する。
//!
//! ## 経緯
//!
//! 当初は `goose-sdk` crate を Rust 側に embed する L4 案だったが、
//! `goose-sdk` は ACP client であって本体 embed ではないこと、
//! goose 本体 crate を取り込むと V8 同梱・MSRV 1.91.1 強制でコスト過大であることが判明。
//! 業界標準 ACP（Zed 主導）に統一し、Goose / OpenCode / Codex-acp / Kiro 等の
//! ACP 対応エージェント全般を共通実装で束ねる方針に変更した（2026-05-10）。
//!
//! ## アーキテクチャ
//!
//! ```text
//! UNICREW frontend
//!    ↓ send_user_message(text)
//! GooseSessionHandle.prompt_tx ─→ mpsc channel ─→ ACP loop task
//!                                                      ↓
//!                                              session.send_prompt(text)
//!                                                      ↓ (turn execution)
//!                                              session/update notifications
//!                                                      ↓ on_receive_notification callback
//!                                              acp_transport::map_session_update
//!                                                      ↓
//!                                              event_sender ─→ NormalizedEvent
//!                                                      ↓
//! UNICREW frontend ← Tauri event ←
//! ```
//!
//! ## 参考
//!
//! - example: <https://github.com/block/goose/blob/main/crates/goose-sdk/examples/acp_client.rs>
//! - protocol spec: <https://agentclientprotocol.com>

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

pub struct GooseProvider;

impl GooseProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for GooseProvider {
    fn id(&self) -> &'static str {
        "goose"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: mpsc::UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // `goose acp` を subprocess として起動。
        let mut cmd = crate::build_silent_command("goose");
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
            .map_err(|e| ProviderError::SpawnFailed(format!("goose acp spawn failed: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ProviderError::Session("stdin take failed".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Session("stdout take failed".to_string()))?;

        // フロントに「セッション開始」を伝える。
        let _ = event_sender.send(NormalizedEvent::Ready {
            session_id: opts.session_id.clone(),
        });

        // UNICREW → ACP loop へ送る user prompt のチャネル。
        // SessionHandle 側に prompt_tx、ACP loop 側に prompt_rx。
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

        // ACP loop を tokio task として起動。
        // SessionHandle はチャネル端点だけを持ち、実際の通信はこの task が担う。
        tokio::spawn(async move {
            let transport = agent_client_protocol::ByteStreams::new(
                stdin.compat_write(),
                stdout.compat(),
            );

            let result = Client
                .builder()
                .name("unicrew")
                // SessionUpdate（agent からの assistant text / tool call 等）を購読。
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
                // 許可要求をフロントに送ってユーザー決断を待つ。
                // PermissionBroker 経由で oneshot 通信、agent_permission_response Tauri
                // command が SessionHandle.send_permission_response → broker.complete
                // を呼ぶことで wake する。
                .on_receive_request(
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        let request_id = broker_for_perm.next_request_id("goose");
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
                            // session が落ちる等で Receiver が drop された場合は cancel。
                            Err(_) => RequestPermissionOutcome::Cancelled,
                        };
                        responder.respond(RequestPermissionResponse::new(outcome))
                    },
                    agent_client_protocol::on_receive_request!(),
                )
                .connect_with(
                    transport,
                    async move |cx: ConnectionTo<agent_client_protocol::Agent>| {
                        // ACP handshake
                        let _init = cx
                            .send_request(InitializeRequest::new(ProtocolVersion::LATEST))
                            .block_task()
                            .await?;

                        // session を確立して多ターンループに入る。
                        // run_until の closure は session の lifetime を借りるので、
                        // この中でループすることで session を破棄せず継続利用できる。
                        cx.build_session_cwd()?
                            .block_task()
                            .run_until(async move |mut session| {
                                while let Some(prompt) = prompt_rx.recv().await {
                                    if let Err(e) = session.send_prompt(&prompt) {
                                        eprintln!(
                                            "[unicrew/goose] send_prompt error: {e:?}"
                                        );
                                        acp_transport::emit_turn_complete(
                                            &session_id_for_turn,
                                            "error",
                                            &event_sender_for_turn,
                                        );
                                        break;
                                    }
                                    // 1 ターン完了を待つ。
                                    // SessionUpdate は on_receive_notification 経由でフロントに流れる。
                                    if let Err(e) = session.read_to_string().await {
                                        eprintln!(
                                            "[unicrew/goose] read_to_string error: {e:?}"
                                        );
                                        acp_transport::emit_turn_complete(
                                            &session_id_for_turn,
                                            "error",
                                            &event_sender_for_turn,
                                        );
                                        break;
                                    }
                                    // turn 完了 → UI の「応答中」を止めるため Result イベントを emit。
                                    // ACP プロトコルは SessionUpdate に turn 終端マーカーを持たないため、
                                    // ここで明示的に流さないと finalizeDraft が呼ばれない。
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
                    message: format!("goose ACP error: {e:?}"),
                });
            }

            // ループ終了 → child を確実に kill。
            let mut guard = child_for_cleanup.lock().await;
            if let Some(mut ch) = guard.take() {
                let _ = ch.start_kill();
            }
        });

        Ok(Box::new(GooseSessionHandle {
            session_id,
            prompt_tx,
            child: child_arc,
            broker,
        }))
    }
}

pub struct GooseSessionHandle {
    #[allow(dead_code)]
    session_id: String,
    prompt_tx: mpsc::UnboundedSender<String>,
    child: Arc<Mutex<Option<Child>>>,
    broker: acp_transport::PermissionBroker,
}

#[async_trait::async_trait]
impl SessionHandle for GooseSessionHandle {
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
        // フロントから来た決断を broker 経由で on_receive_request closure に渡す。
        // pending エントリが無い場合（タイムアウト後・session 死亡後等）は noop。
        self.broker.complete(request_id, decision).await;
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ProviderError> {
        // child を kill すれば ACP の transport が EOF を返し、
        // run_until の中の send_prompt / read_to_string が error して loop が抜ける。
        let mut guard = self.child.lock().await;
        if let Some(mut ch) = guard.take() {
            let _ = ch.start_kill();
            let _ = ch.wait().await;
        }
        Ok(())
    }
}
