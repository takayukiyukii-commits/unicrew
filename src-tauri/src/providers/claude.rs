//! Claude CLI driver。
//!
//! `claude` CLI（Anthropic公式）を `--input-format stream-json --output-format stream-json --verbose`
//! のヘッドレスモードで spawn し、永続セッションとして使う。
//!
//! ToS 遵守メモ:
//!  - SDK は import しない
//!  - OAuth トークンは UNICREW 側で読み書きしない（CLI が `~/.claude/credentials` 等で自前管理）
//!  - サブスクモード時は `ANTHROPIC_API_KEY` を env から外して CLI のサブスク認証経路に乗せる

use crate::providers::types::{AuthMode, NormalizedEvent, PermissionMode, ProviderError, SpawnOpts};
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

        // 既存セッションを再開（任意）。
        // CLI 側の session_id を渡せば、Claude が前回の会話履歴をロードして継続する。
        // セッションが消えていた場合は CLI が起動時にエラーで落ちるが、
        // 上位のフォールバック（新規セッションで再起動）はフロント側で判断する。
        if let Some(sid) = &opts.resume_cli_session_id {
            cmd.arg("--resume").arg(sid);
        }

        // システムプロンプト（人格＋キャラ合成済の文字列）。
        //
        // Windows で `claude` が `.cmd` シムに resolve される環境（npm install 経由など）だと、
        // Rust 1.77+ の CVE-2024-24576 対策で、改行入りの引数が "batch file arguments are invalid"
        // で弾かれる。multi-line system_prompt はメモリ注入機能で更に確実に複数行になるため、
        // 安全側に倒して `--append-system-prompt-file <path>` で渡す。
        // これは `claude --help` には出ない隠しオプションだが、`--bare` の説明で言及されてる。
        let mut sysprompt_temp_path: Option<std::path::PathBuf> = None;
        if !opts.system_prompt.is_empty() {
            let mut path = std::env::temp_dir();
            // セッションIDは UNICREW 内のものを使う（衝突しない）
            path.push(format!("unicrew-claude-sysprompt-{}.txt", opts.session_id));
            match std::fs::write(&path, &opts.system_prompt) {
                Ok(()) => {
                    cmd.arg("--append-system-prompt-file").arg(&path);
                    sysprompt_temp_path = Some(path);
                }
                Err(e) => {
                    eprintln!(
                        "[unicrew/claude] system_prompt の一時ファイル書き出しに失敗、argv 渡しにフォールバック: {}",
                        e
                    );
                    cmd.arg("--append-system-prompt").arg(&opts.system_prompt);
                }
            }
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

        // パーミッション：Shift+Tab でフロントが切り替えた値をそのまま CLI に渡す。
        // - AcceptEdits（既定）: 編集・実行を自動許可（UNICREW UI に承認フロー無いため）
        // - Plan: 読み取り・分析のみ。Claude 側で edit/bash がブロックされる
        let permission_mode_arg = match opts.permission_mode {
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Plan => "plan",
        };
        cmd.arg("--permission-mode").arg(permission_mode_arg);

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
            sysprompt_temp_path,
        }))
    }
}

pub struct ClaudeSessionHandle {
    session_id: String,
    stdin: ChildStdin,
    child: Child,
    _stdout_handle: JoinHandle<()>,
    /// `--append-system-prompt-file` 用に書き出した一時ファイル。Drop で削除する。
    sysprompt_temp_path: Option<std::path::PathBuf>,
}

impl Drop for ClaudeSessionHandle {
    fn drop(&mut self) {
        if let Some(p) = self.sysprompt_temp_path.take() {
            let _ = std::fs::remove_file(p);
        }
    }
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
        // 書き込み失敗の多くは claude が起動直後に終了しているケース
        // （未ログイン/未認証/CLI未インストール等）。生のパイプエラー
        // （Windows: os error 232「パイプを閉じています」）は分かりにくいので、
        // 子プロセスの終了状態を見て実用的な案内へ置き換える。
        let w = self.stdin.write_all(line.as_bytes()).await;
        let f = if w.is_ok() {
            self.stdin.flush().await
        } else {
            Ok(())
        };
        if let Err(e) = w.and(f) {
            if let Ok(Some(status)) = self.child.try_wait() {
                let code = status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "不明".into());
                return Err(ProviderError::Session(format!(
                    "Claude が起動直後に終了しました（終了コード {code}）。未ログイン／未認証の可能性が高いです。設定 → アカウントから Claude Code にログインし直してください。"
                )));
            }
            return Err(ProviderError::Io(e));
        }
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
