//! Cursor Agent CLI（`cursor-agent`）プロバイダ。
//!
//! ## 実測（2026-08-27・cursor-agent 2026.08.25-3e8eec8 / WSL Ubuntu）
//!
//! - ACP 非対応（`agent stdio` 等のサブコマンド無し）→ stream-json 経路で実装
//! - `cursor-agent -p --output-format stream-json --trust` は NDJSON を吐く:
//!   ```text
//!   {"type":"system","subtype":"init","apiKeySource":"login","cwd":..,"session_id":..,"model":..}
//!   {"type":"user","message":{...}}
//!   {"type":"thinking","subtype":"delta","text":..}          // docs 未記載・実測で確認
//!   {"type":"assistant","message":{"content":[{"type":"text","text":".."}]}}
//!   {"type":"tool_call","subtype":"started","call_id":..,"tool_call":{"editToolCall":{"args":{..}}}}
//!   {"type":"tool_call","subtype":"completed","call_id":..,"tool_call":{"editToolCall":{"args":..,"result":{"success":{..}}}}}
//!   {"type":"result","subtype":"success","result":..,"session_id":..,"usage":{..}}
//!   ```
//! - 継続は `--resume <chatId>`（session_id を渡す。履歴は CLI 側が保持。実測で
//!   2ターン目の inputTokens が差分のみ＝79 だった）
//! - prompt は **stdin パイプ**で渡す（改行安全・実測済み）。`-p` は付けたまま
//! - 🚨 **Windows ネイティブバイナリが存在しない**（インストーラが Linux/Darwin 限定・
//!   ダウンロード URL も 403）。Windows では **WSL フォールバック**で
//!   `wsl.exe -e bash -lc 'exec cursor-agent ...'` を起動する（cwd は wsl.exe が
//!   /mnt/<drive>/... に自動変換する。実測済み）
//!
//! ## 認証 / trust
//!
//! - 認証は CLI 側（`cursor-agent login` か env `CURSOR_API_KEY`）。UNICREW は持たない
//! - `--trust` を付ける: UNICREW 側で workspace は TrustPromptModal / pickWorkspaceWithTrust
//!   により承認済みのものしか渡ってこないため（未承認 dir では CLI が非対話で
//!   即エラー終了することを実測済み。--trust なしだと一切動かない）
//!
//! ## アーキテクチャ
//!
//! gemini.rs と同型の「1ターン=1プロセス」。ただし履歴は `--resume` で CLI 側に
//! 持たせる（gemini のような全文再送はしない）。

use crate::providers::types::{NormalizedEvent, PermissionMode, ProviderError, SpawnOpts};
use crate::providers::{CliProvider, SessionHandle};
use serde_json::Value;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

pub struct CursorProvider;

impl CursorProvider {
    pub fn new() -> Self {
        Self
    }
}

/// 外部入力を引数に埋めてよいか検証する（英数と . _ - のみ）。
/// resume の chatId（UUID）・model 名が対象。シェル経由（WSL フォールバック）でも
/// 安全なトークンだけを通す。
fn is_safe_token(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// cursor-agent の起動コマンドを OS 別に組む。
///
/// - 非 Windows: `cursor-agent` を直接
/// - Windows: WSL フォールバック。`bash -lc 'exec ... "$@"' cursor-agent <args...>` 形式で
///   引数は "$@" 経由で渡す（シェル文字列に外部入力を埋め込まない）
fn build_cursor_command(extra_args: &[String]) -> tokio::process::Command {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = crate::build_silent_command("wsl.exe");
        cmd.arg("-e").arg("bash").arg("-lc").arg(
            // login shell でも PATH に無い環境があるため ~/.local/bin をフォールバック
            r#"exec "$(command -v cursor-agent || echo "$HOME/.local/bin/cursor-agent")" "$@""#,
        );
        // bash -c の第1引数は $0。以降が "$@" に入る。
        cmd.arg("cursor-agent");
        for a in extra_args {
            cmd.arg(a);
        }
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = crate::build_silent_command("cursor-agent");
        for a in extra_args {
            cmd.arg(a);
        }
        cmd
    }
}

/// 1行の cursor stream-json を 0..n 個の NormalizedEvent に変換する（純関数・テスト対象）。
pub fn parse_cursor_line(session_id: &str, line: &str) -> Vec<NormalizedEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            // 認証エラー等は JSON でないプレーン行で出る（実測: "Error: Authentication required...")
            return vec![NormalizedEvent::Error {
                session_id: session_id.to_string(),
                message: line.to_string(),
            }];
        }
    };
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match ty {
        "system" => {
            let mut out = vec![];
            if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                if !sid.is_empty() {
                    out.push(NormalizedEvent::CliSessionId {
                        session_id: session_id.to_string(),
                        cli_session_id: sid.to_string(),
                    });
                }
            }
            out
        }
        "assistant" => {
            let mut text = String::new();
            if let Some(items) = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for item in items {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                            text.push_str(t);
                        }
                    }
                }
            }
            if text.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::AssistantText {
                    session_id: session_id.to_string(),
                    text,
                }]
            }
        }
        // thinking はプレビューノイズになるので流さない（実測で delta/completed を確認）
        "thinking" => vec![],
        "tool_call" => {
            let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            let call_id = v
                .get("call_id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            // tool_call オブジェクトの先頭キーがツール名（例: editToolCall / readToolCall）
            let tool_obj = v.get("tool_call").and_then(|t| t.as_object());
            let (tool_name, inner) = match tool_obj.and_then(|o| {
                o.iter()
                    .find(|(k, val)| k.ends_with("ToolCall") && val.is_object())
            }) {
                Some((k, val)) => (k.clone(), val.clone()),
                None => ("unknown".to_string(), Value::Null),
            };
            match subtype {
                "started" => vec![NormalizedEvent::ToolUse {
                    session_id: session_id.to_string(),
                    tool_use_id: call_id,
                    tool_name,
                    tool_input: inner.get("args").cloned().unwrap_or(Value::Null),
                }],
                "completed" => {
                    let result = inner.get("result").cloned().unwrap_or(Value::Null);
                    let is_error = !result
                        .as_object()
                        .map(|o| o.contains_key("success"))
                        .unwrap_or(false);
                    vec![NormalizedEvent::ToolResult {
                        session_id: session_id.to_string(),
                        tool_use_id: call_id,
                        is_error,
                        content: result,
                    }]
                }
                _ => vec![],
            }
        }
        "result" => {
            let subtype = v
                .get("subtype")
                .and_then(|s| s.as_str())
                .unwrap_or("success")
                .to_string();
            vec![NormalizedEvent::Result {
                session_id: session_id.to_string(),
                subtype,
                cost_usd: None,
                usage: v.get("usage").cloned(),
            }]
        }
        _ => vec![],
    }
}

#[async_trait::async_trait]
impl CliProvider for CursorProvider {
    fn id(&self) -> &'static str {
        "cursor"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // gemini / codex と同様、ここでは Ready だけ送って実行は send_user_message で行う。
        let _ = event_sender.send(NormalizedEvent::Ready {
            session_id: opts.session_id.clone(),
        });
        Ok(Box::new(CursorSessionHandle {
            session_id: opts.session_id,
            workspace: opts.workspace,
            model: opts.model,
            system_prompt: opts.system_prompt,
            permission_mode: opts.permission_mode,
            // アプリ再起動をまたぐ再開: thread に保存された CLI session_id から始める
            cli_chat_id: Arc::new(Mutex::new(opts.resume_cli_session_id)),
            event_sender,
            stopped: Arc::new(Mutex::new(false)),
        }))
    }
}

pub struct CursorSessionHandle {
    session_id: String,
    workspace: Option<String>,
    model: String,
    system_prompt: String,
    permission_mode: PermissionMode,
    /// cursor-agent 側の chat id（system.init の session_id）。2ターン目以降 --resume に使う。
    cli_chat_id: Arc<Mutex<Option<String>>>,
    event_sender: UnboundedSender<NormalizedEvent>,
    stopped: Arc<Mutex<bool>>,
}

#[async_trait::async_trait]
impl SessionHandle for CursorSessionHandle {
    async fn send_user_message(&mut self, text: &str) -> Result<(), ProviderError> {
        if *self.stopped.lock().await {
            return Ok(());
        }

        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--trust".into(),
        ];
        // Plan モード: 読み取り・提案のみ（cursor-agent ネイティブの --mode plan に射影）
        if matches!(self.permission_mode, PermissionMode::Plan) {
            args.push("--mode".into());
            args.push("plan".into());
        }
        if !self.model.is_empty() && is_safe_token(&self.model) {
            args.push("--model".into());
            args.push(self.model.clone());
        }
        let resume_id = self.cli_chat_id.lock().await.clone();
        let is_first_turn = resume_id.is_none();
        if let Some(id) = resume_id.as_ref().filter(|s| is_safe_token(s)) {
            args.push("--resume".into());
            args.push(id.clone());
        }

        // system_prompt は初回ターンだけ前置（履歴は CLI 側が --resume で保持する）
        let full_prompt = if is_first_turn && !self.system_prompt.is_empty() {
            format!("# System instructions\n{}\n\n{}", self.system_prompt, text)
        } else {
            text.to_string()
        };

        let mut cmd = build_cursor_command(&args);
        if let Some(ws) = &self.workspace {
            // Windows では wsl.exe が cwd を /mnt/<drive>/... に自動変換する（実測済み）
            cmd.current_dir(ws);
        }
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            ProviderError::SpawnFailed(format!(
                "cursor-agent を起動できませんでした（macOS/Linux はネイティブ、Windows は WSL + cursor-agent が必要）: {}",
                e
            ))
        })?;

        // prompt は stdin で流して close（改行安全・シェルクォート不要）
        if let Some(mut stdin) = child.stdin.take() {
            let bytes = full_prompt.into_bytes();
            tokio::spawn(async move {
                let _ = stdin.write_all(&bytes).await;
                let _ = stdin.shutdown().await;
            });
        }

        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderError::Session("cursor subprocess の stdout が取得できません".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProviderError::Session("cursor subprocess の stderr が取得できません".into())
        })?;

        let session_id = self.session_id.clone();
        let event_sender = self.event_sender.clone();
        let chat_id_store = Arc::clone(&self.cli_chat_id);

        // stdout: NDJSON を1行ずつ NormalizedEvent へ
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                for ev in parse_cursor_line(&session_id, &line) {
                    // chat id は次ターンの --resume 用に保持
                    if let NormalizedEvent::CliSessionId { cli_session_id, .. } = &ev {
                        let mut guard = chat_id_store.lock().await;
                        *guard = Some(cli_session_id.clone());
                    }
                    if event_sender.send(ev).is_err() {
                        return;
                    }
                }
            }
        });

        // stderr: エラーらしき行だけ Error イベントへ（gemini と同方針）
        let session_id_err = self.session_id.clone();
        let event_sender_err = self.event_sender.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let lower = line.to_lowercase();
                if lower.contains("error")
                    || lower.contains("failed")
                    || lower.contains("authentication")
                {
                    let _ = event_sender_err.send(NormalizedEvent::Error {
                        session_id: session_id_err.clone(),
                        message: line,
                    });
                }
            }
        });

        // ゾンビ防止
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
        // -p モードは許可プロンプトを出さない（--trust / --mode plan で制御）
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ProviderError> {
        *self.stopped.lock().await = true;
        Ok(())
    }
}

// ---------- パーサ単体テスト（実測フィクスチャ） ----------
#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn system_init_yields_cli_session_id() {
        let line = r#"{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp/x","session_id":"1c4cf263-29b3-4cfc-b00f-8da35f14a1a2","model":"Auto","permissionMode":"default"}"#;
        let evs = parse_cursor_line("s1", line);
        assert!(matches!(
            &evs[0],
            NormalizedEvent::CliSessionId { cli_session_id, .. }
            if cli_session_id == "1c4cf263-29b3-4cfc-b00f-8da35f14a1a2"
        ));
    }

    #[test]
    fn assistant_text_is_concatenated() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"2"}]},"session_id":"x"}"#;
        let evs = parse_cursor_line("s1", line);
        assert!(matches!(
            &evs[0],
            NormalizedEvent::AssistantText { text, .. } if text == "2"
        ));
    }

    #[test]
    fn thinking_is_skipped() {
        let line = r#"{"type":"thinking","subtype":"delta","text":"…","session_id":"x"}"#;
        assert!(parse_cursor_line("s1", line).is_empty());
    }

    #[test]
    fn tool_call_started_and_completed() {
        let started = r#"{"type":"tool_call","subtype":"started","call_id":"tool_1","tool_call":{"editToolCall":{"args":{"path":"/tmp/hello.txt"}}},"session_id":"x"}"#;
        let evs = parse_cursor_line("s1", started);
        assert!(matches!(
            &evs[0],
            NormalizedEvent::ToolUse { tool_name, tool_use_id, .. }
            if tool_name == "editToolCall" && tool_use_id == "tool_1"
        ));
        let completed = r#"{"type":"tool_call","subtype":"completed","call_id":"tool_1","tool_call":{"editToolCall":{"args":{"path":"/tmp/hello.txt"},"result":{"success":{"linesAdded":1}}}},"session_id":"x"}"#;
        let evs = parse_cursor_line("s1", completed);
        assert!(matches!(
            &evs[0],
            NormalizedEvent::ToolResult { is_error: false, .. }
        ));
    }

    #[test]
    fn result_success() {
        let line = r#"{"type":"result","subtype":"success","duration_ms":8277,"is_error":false,"result":"2","session_id":"x","usage":{"inputTokens":7980}}"#;
        let evs = parse_cursor_line("s1", line);
        assert!(matches!(
            &evs[0],
            NormalizedEvent::Result { subtype, .. } if subtype == "success"
        ));
    }

    #[test]
    fn non_json_line_becomes_error_event() {
        let evs = parse_cursor_line(
            "s1",
            "Error: Authentication required. Please run 'agent login' first",
        );
        assert!(matches!(&evs[0], NormalizedEvent::Error { .. }));
    }

    #[test]
    fn safe_token_validation() {
        assert!(is_safe_token("1c4cf263-29b3-4cfc-b00f-8da35f14a1a2"));
        assert!(is_safe_token("gpt-5.5"));
        assert!(!is_safe_token("a b"));
        assert!(!is_safe_token("x;rm -rf /"));
        assert!(!is_safe_token(""));
    }
}

// ---------- 実機E2E（診断用・CI では #[ignore]） ----------
//
// Windows では WSL + cursor-agent（ログイン済み）が前提。実行:
//   cargo test cursor_e2e -- --ignored --nocapture
#[cfg(test)]
mod cursor_e2e {
    use super::*;
    use crate::providers::types::{AuthMode, SpawnOpts};
    use tokio::sync::mpsc;

    #[test]
    #[ignore = "実機の cursor-agent 導入・ログイン状況に依存する診断用"]
    fn ask_one_question_and_resume() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let (tx, mut rx) = mpsc::unbounded_channel::<NormalizedEvent>();
            let provider = Arc::new(CursorProvider::new());
            let opts = SpawnOpts {
                session_id: "e2e-cursor".to_string(),
                workspace: Some("D:\\tmp".to_string()),
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

            // ---- ターン1 ----
            handle
                .send_user_message("1+1の答えを数字1文字だけ返して")
                .await
                .expect("send failed");
            let (text1, chat_id) = collect_turn(&mut rx).await;
            assert!(text1.contains('2'), "turn1 応答に 2 が無い: {:?}", text1);
            assert!(chat_id.is_some(), "CliSessionId が来ていない");

            // ---- ターン2（--resume で履歴が生きているか） ----
            handle
                .send_user_message("さっきの答えに1を足した数字だけ返して")
                .await
                .expect("send2 failed");
            let (text2, _) = collect_turn(&mut rx).await;
            assert!(text2.contains('3'), "turn2 応答に 3 が無い: {:?}", text2);

            let _ = handle.stop().await;
        });
    }

    async fn collect_turn(
        rx: &mut mpsc::UnboundedReceiver<NormalizedEvent>,
    ) -> (String, Option<String>) {
        let mut text = String::new();
        let mut chat_id = None;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(NormalizedEvent::AssistantText { text: t, .. })) => {
                    print!("{}", t);
                    text.push_str(&t);
                }
                Ok(Some(NormalizedEvent::CliSessionId { cli_session_id, .. })) => {
                    chat_id = Some(cli_session_id);
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
                Err(_) => panic!("timeout"),
            }
        }
        (text, chat_id)
    }
}
