//! Qwen Code CLI driver。
//!
//! `qwen` CLI（Alibaba/QwenLM、Apache-2.0、Claude Code fork）を
//! `--input-format stream-json --output-format stream-json --verbose`
//! のヘッドレスモードで spawn し、永続セッションとして使う。
//!
//! Claude Code とフラグ互換なため claude.rs とほぼ同形だが、以下が異なる:
//!  - bin 名: `qwen`
//!  - auth env: `DASHSCOPE_API_KEY`（Alibaba Cloud Model Studio）。
//!    OpenRouter 等のサードパーティは `--api-key` / `--openai-base-url` 等で指定するが
//!    UNICREW では BYOK 経路を DashScope 1本に絞る（販売動線は uniLinks LP）。
//!  - permission-mode フラグは未確認 → 渡さない（CLI デフォルトの挙動に任せる）
//!  - サブスクログイン経路は無い（OSS Apache-2.0、BYOK のみ）

use crate::providers::types::{AuthMode, NormalizedEvent, PermissionMode, ProviderError, SpawnOpts};
use crate::providers::{stream_parser, CliProvider, SessionHandle};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

pub struct QwenProvider;

impl QwenProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for QwenProvider {
    fn id(&self) -> &'static str {
        "qwen"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        let mut cmd = crate::build_silent_command("qwen");

        // ヘッドレス stream-json モード。Qwen Code は Claude Code fork なので同じ event shape。
        // `--include-partial-messages` は付けない（claude.rs と同じ理由で二重表示防止）。
        cmd.args([
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
        ]);

        // 既存セッション再開（任意）。Qwen も `--resume <session-id>` をサポート。
        if let Some(sid) = &opts.resume_cli_session_id {
            cmd.arg("--resume").arg(sid);
        }

        // システムプロンプト。Windows の .cmd シム経由で改行入り argv が弾かれる問題は
        // Claude と同じく一時ファイル → `--append-system-prompt-file` 経路で回避。
        let mut sysprompt_temp_path: Option<std::path::PathBuf> = None;
        if !opts.system_prompt.is_empty() {
            let mut path = std::env::temp_dir();
            path.push(format!("unicrew-qwen-sysprompt-{}.txt", opts.session_id));
            match std::fs::write(&path, &opts.system_prompt) {
                Ok(()) => {
                    cmd.arg("--append-system-prompt-file").arg(&path);
                    sysprompt_temp_path = Some(path);
                }
                Err(e) => {
                    eprintln!(
                        "[unicrew/qwen] system_prompt の一時ファイル書き出しに失敗、argv 渡しにフォールバック: {}",
                        e
                    );
                    cmd.arg("--append-system-prompt").arg(&opts.system_prompt);
                }
            }
        }

        // モデル指定。デフォルトは qwen3-coder-plus（DashScope 提供）。
        // opts.model は UI 側で UNICREW 共通の ModelId 文字列が来るが、Qwen 系の値が
        // 指定されている時のみ渡す。未指定や Claude/Codex モデル名が入っている時は CLI に渡さない
        // （CLI のデフォルトに任せる）。
        if !opts.model.is_empty() && opts.model.starts_with("qwen") {
            cmd.arg("--model").arg(&opts.model);
        }

        // ワークスペース
        if let Some(ws) = &opts.workspace {
            cmd.current_dir(ws);
        }

        // 認証モード。Qwen は OSS BYOK 一択（サブスクログイン無し）。
        // サブスクモードで来た場合は API キーを env から外すだけで CLI 起動は試みる
        // （ユーザー側に DASHSCOPE_API_KEY が export 済の可能性に賭ける）。
        match opts.auth_mode {
            AuthMode::Subscription => {
                cmd.env_remove("DASHSCOPE_API_KEY");
            }
            AuthMode::ApiKey => {
                if let Some(k) = opts.api_key.as_ref() {
                    cmd.env("DASHSCOPE_API_KEY", k);
                }
            }
        }

        // permission-mode は Qwen Code の対応状況が公式 docs から未確認のため渡さない。
        // 動作確認後に Plan / AcceptEdits 等の互換マッピングが取れたら追加する。
        let _ = match opts.permission_mode {
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Plan => "plan",
        };

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            ProviderError::SpawnFailed(format!(
                "qwen CLI を起動できませんでした（インストール / PATH を確認してください）: {}",
                e
            ))
        })?;

        let stdin = child.stdin.take().ok_or_else(|| {
            ProviderError::Session("qwen subprocess の stdin が取得できません".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderError::Session("qwen subprocess の stdout が取得できません".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProviderError::Session("qwen subprocess の stderr が取得できません".into())
        })?;

        let session_id = opts.session_id.clone();
        let session_id_for_stdout = session_id.clone();
        let event_sender_stdout = event_sender.clone();
        let stdout_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            let _ = event_sender_stdout.send(NormalizedEvent::Ready {
                session_id: session_id_for_stdout.clone(),
            });
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        // Qwen の stream-json は Claude Code fork で event types 同一なので
                        // 同じ stream_parser をそのまま流用。
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

        let session_id_for_stderr = session_id.clone();
        let event_sender_stderr = event_sender.clone();
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

        Ok(Box::new(QwenSessionHandle {
            session_id,
            stdin,
            child,
            _stdout_handle: stdout_handle,
            sysprompt_temp_path,
        }))
    }
}

pub struct QwenSessionHandle {
    session_id: String,
    stdin: ChildStdin,
    child: Child,
    _stdout_handle: JoinHandle<()>,
    sysprompt_temp_path: Option<std::path::PathBuf>,
}

impl Drop for QwenSessionHandle {
    fn drop(&mut self) {
        if let Some(p) = self.sysprompt_temp_path.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

#[async_trait::async_trait]
impl SessionHandle for QwenSessionHandle {
    async fn send_user_message(&mut self, text: &str) -> Result<(), ProviderError> {
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
