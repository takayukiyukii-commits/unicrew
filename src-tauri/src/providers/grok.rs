//! Grok CLI（xAI 公式 `@xai-official/grok`）プロバイダ。
//!
//! UNICREW から `grok --no-auto-update agent stdio` subprocess を起動し、業界標準 ACP
//! プロトコル（JSON-RPC over stdio）で型付き通信する。Goose / OpenCode / Kimi と同形、
//! 起動 CLI のみ差異。
//!
//! ## 実測（2026-08-27・grok 1.0.5 / Windows ネイティブ）
//!
//! - `grok agent stdio` の initialize 応答: protocolVersion 1 / loadSession /
//!   authMethods=[{id:"grok.com"}] / モデル grok-4.6（context 500k）・grok-4.5
//! - Windows ネイティブ対応（Rust 製・rustls）。導入は `npm install -g @xai-official/grok`
//!   または `curl x.ai | bash`（mac/Linux）
//! - `--no-auto-update` を付けて背景アップデートチェックを止める（公式 docs の
//!   headless / ACP 推奨フラグ。https://docs.x.ai/build/cli/headless-scripting）
//!
//! 認証は Grok CLI 側が扱う（`grok login` のデバイスコード認証 → CLI が保存。
//! または env `XAI_API_KEY`）。UNICREW 側は env 注入もキー管理も持たない。
//!
//! ## アーキテクチャ
//!
//! Goose / OpenCode / Kimi と完全に同じ（`providers/goose.rs` のドキュメント参照）。

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

pub struct GrokProvider;

impl GrokProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for GrokProvider {
    fn id(&self) -> &'static str {
        "grok"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: mpsc::UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // `grok --no-auto-update agent stdio` を subprocess として起動。
        let mut cmd = crate::build_silent_command("grok");
        cmd.arg("--no-auto-update").arg("agent").arg("stdio");
        // 🚨 Claude/Cursor 設定の自動輸入を止める（2026-08-27 実測）。
        // Grok は既定で ~/.claude.json の MCP・Claude hooks を勝手に取り込み、
        // MCP 21本へ接続して session 開始+30秒、さらに Claude 用 stop フックまで
        // Grok から実行された（誤発火）。無効化で prompt 応答 69秒→4.7秒。
        // SKILLS/RULES/AGENTS(CLAUDE.md) はプロジェクト文脈として有益なので既定のまま。
        cmd.env("GROK_CLAUDE_MCPS_ENABLED", "0");
        cmd.env("GROK_CLAUDE_HOOKS_ENABLED", "0");
        cmd.env("GROK_CURSOR_MCPS_ENABLED", "0");
        cmd.env("GROK_CURSOR_HOOKS_ENABLED", "0");
        if let Some(ws) = &opts.workspace {
            cmd.current_dir(ws);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut tokio_cmd = Command::from(cmd);
        let mut child = tokio_cmd
            .spawn()
            .map_err(|e| ProviderError::SpawnFailed(format!("grok agent stdio spawn failed: {e}")))?;

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
                        let request_id = broker_for_perm.next_request_id("grok");
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
                                            "[unicrew/grok] send_prompt error: {e:?}"
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
                                            "[unicrew/grok] read_to_string error: {e:?}"
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
                    message: format!("grok ACP error: {e:?}"),
                });
            }

            let mut guard = child_for_cleanup.lock().await;
            if let Some(mut ch) = guard.take() {
                let _ = ch.start_kill();
            }
        });

        Ok(Box::new(GrokSessionHandle {
            session_id,
            prompt_tx,
            child: child_arc,
            broker,
        }))
    }
}

pub struct GrokSessionHandle {
    #[allow(dead_code)]
    session_id: String,
    prompt_tx: mpsc::UnboundedSender<String>,
    child: Arc<Mutex<Option<Child>>>,
    broker: acp_transport::PermissionBroker,
}

#[async_trait::async_trait]
impl SessionHandle for GrokSessionHandle {
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

// ---------- 実機E2E（診断用・CI では #[ignore]） ----------
//
// `grok` CLI がインストール＆ログイン済みの実機で、UNICREW の実コード
// （GrokProvider → acp_transport）を通して 1 問投げ、AssistantText が
// 返ることを確かめる。実行:
//   cargo test grok_e2e -- --ignored --nocapture
#[cfg(test)]
mod grok_e2e {
    use super::*;
    use crate::providers::types::{AuthMode, PermissionMode, SpawnOpts};
    use crate::providers::CliProvider;

    #[test]
    #[ignore = "実機の grok CLI 導入・ログイン状況に依存する診断用"]
    fn ask_one_question() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        local.block_on(&rt, async {
            let (tx, mut rx) = mpsc::unbounded_channel::<NormalizedEvent>();
            let provider = Arc::new(GrokProvider::new());
            let opts = SpawnOpts {
                session_id: "e2e-grok".to_string(),
                workspace: std::env::temp_dir().to_str().map(|s| s.to_string()),
                system_prompt: String::new(),
                model: String::new(),
                auth_mode: AuthMode::Subscription,
                api_key: None,
                resume_cli_session_id: None,
                permission_mode: PermissionMode::Plan,
            };
            let mut handle = provider
                .spawn_session(opts, tx)
                .await
                .expect("spawn_session failed");
            handle
                .send_user_message("1+1の答えを数字1文字だけ返して")
                .await
                .expect("send failed");

            let mut got_text = String::new();
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
            loop {
                let ev = tokio::time::timeout_at(deadline, rx.recv()).await;
                match ev {
                    Ok(Some(NormalizedEvent::AssistantText { text, .. })) => {
                        print!("{}", text);
                        got_text.push_str(&text);
                    }
                    Ok(Some(NormalizedEvent::Result { subtype, .. })) => {
                        println!("\n[turn complete: {}]", subtype);
                        break;
                    }
                    Ok(Some(NormalizedEvent::Error { message, .. })) => {
                        panic!("provider error: {}", message);
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => panic!("event channel closed"),
                    Err(_) => panic!("timeout: 180s以内に応答が完了しなかった"),
                }
            }
            let _ = handle.stop().await;
            assert!(
                got_text.contains('2'),
                "応答に 2 が含まれない: {:?}",
                got_text
            );
        });
    }
}
