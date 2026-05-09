//! Gemini CLI driver。
//!
//! Google 公式 `gemini`（@google/gemini-cli）を subprocess として呼ぶ。
//!
//! 実装方針:
//!  - claude/codex のような stream-json は gemini-cli が未提供のため、
//!    `gemini -p "<prompt>"` の単発実行モードでstdoutを全部AssistantTextとして流す
//!  - ストリーミング表示は line-buffered 単位（gemini-cliが標準出力をflushする粒度）
//!  - 永続セッションは gemini-cli の checkpoint 機能を使わず、
//!    ハンドル内に "ユーザー発言/応答" の履歴を保持して毎ターン丸ごと渡し直す
//!    （gemini-cli 側がstatelessなため）
//!
//! ToS / 認証:
//!  - サブスクモード: gemini-cli が `~/.config/google/...` 等の認証を握る前提で env 干渉しない
//!  - APIキー: `GEMINI_API_KEY` を env で渡す
//!
//! 注意:
//!  - tool 実行のJSON通知は流さない（geminiの単発exec モードに通知配管がない）。
//!    そのため UNICREW の Activity Panel 上で gemini のツール実行は
//!    「テキスト応答内のコードブロック」として見える。

use crate::providers::types::{AuthMode, NormalizedEvent, ProviderError, SpawnOpts};
use crate::providers::{CliProvider, SessionHandle};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

pub struct GeminiProvider;

impl GeminiProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for GeminiProvider {
    fn id(&self) -> &'static str {
        "gemini"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // Codex 同様、ここでは Ready だけ送って実行は send_user_message で行う。
        let _ = event_sender.send(NormalizedEvent::Ready {
            session_id: opts.session_id.clone(),
        });
        Ok(Box::new(GeminiSessionHandle {
            session_id: opts.session_id,
            workspace: opts.workspace,
            model: opts.model,
            auth_mode: opts.auth_mode,
            api_key: opts.api_key,
            system_prompt: opts.system_prompt,
            history: Arc::new(Mutex::new(Vec::new())),
            event_sender,
            stopped: Arc::new(Mutex::new(false)),
        }))
    }
}

pub struct GeminiSessionHandle {
    session_id: String,
    workspace: Option<String>,
    model: String,
    auth_mode: AuthMode,
    api_key: Option<String>,
    system_prompt: String,
    /// (user, assistant) ペアの履歴。毎ターン丸ごと再送する。
    history: Arc<Mutex<Vec<(String, String)>>>,
    event_sender: UnboundedSender<NormalizedEvent>,
    stopped: Arc<Mutex<bool>>,
}

impl GeminiSessionHandle {
    /// gemini-cli に渡す最終プロンプトを構築する。
    /// system_prompt + 過去履歴 + 今回のユーザー発言をプレーンテキストで合成。
    async fn build_full_prompt(&self, user_text: &str) -> String {
        let history = self.history.lock().await;
        let mut out = String::new();
        if !self.system_prompt.is_empty() {
            out.push_str("# システム指示\n");
            out.push_str(&self.system_prompt);
            out.push_str("\n\n");
        }
        for (i, (user, assistant)) in history.iter().enumerate() {
            out.push_str(&format!("## ターン{} ユーザー\n{}\n\n", i + 1, user));
            out.push_str(&format!("## ターン{} あなたの回答\n{}\n\n", i + 1, assistant));
        }
        out.push_str("## 今回のユーザーからの依頼\n");
        out.push_str(user_text);
        out
    }
}

#[async_trait::async_trait]
impl SessionHandle for GeminiSessionHandle {
    async fn send_user_message(&mut self, text: &str) -> Result<(), ProviderError> {
        if *self.stopped.lock().await {
            return Ok(());
        }

        let full_prompt = self.build_full_prompt(text).await;
        let mut cmd = crate::build_silent_command("gemini");
        // -p で非対話モード。履歴は UNICREW 側が握って都度渡し直す。
        cmd.arg("-p").arg(&full_prompt);
        if !self.model.is_empty() {
            cmd.arg("-m").arg(&self.model);
        }
        if let Some(ws) = &self.workspace {
            cmd.current_dir(ws);
        }

        // 認証モード制御
        match self.auth_mode {
            AuthMode::Subscription => {
                // gemini-cli は ~/.gemini や OAuth で認証するのでAPIキーenvを抜く
                cmd.env_remove("GEMINI_API_KEY");
                cmd.env_remove("GOOGLE_API_KEY");
            }
            AuthMode::ApiKey => {
                if let Some(k) = self.api_key.as_ref() {
                    cmd.env("GEMINI_API_KEY", k);
                }
            }
        }

        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            ProviderError::SpawnFailed(format!(
                "gemini CLI を起動できませんでした（インストール / PATH を確認してください）: {}",
                e
            ))
        })?;

        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderError::Session("gemini subprocess の stdout が取得できません".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProviderError::Session("gemini subprocess の stderr が取得できません".into())
        })?;

        let session_id = self.session_id.clone();
        let event_sender = self.event_sender.clone();
        let history = Arc::clone(&self.history);
        let user_text_owned = text.to_string();

        // stdout 読み取り：行ごとに AssistantText として流し、累積も記録
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            let mut accumulated = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.is_empty() {
                    accumulated.push_str(&line);
                    accumulated.push('\n');
                }
                let chunk = if line.is_empty() {
                    "\n".to_string()
                } else {
                    format!("{}\n", line)
                };
                if event_sender
                    .send(NormalizedEvent::AssistantText {
                        session_id: session_id.clone(),
                        text: chunk,
                    })
                    .is_err()
                {
                    return;
                }
            }
            // 履歴に保存（次ターンで丸ごと再送するため）
            {
                let mut h = history.lock().await;
                h.push((user_text_owned, accumulated.trim().to_string()));
            }
            // 完了通知
            let _ = event_sender.send(NormalizedEvent::Result {
                session_id: session_id.clone(),
                subtype: "success".to_string(),
                cost_usd: None,
                usage: None,
            });
        });

        // stderr：エラーらしき行だけ Error イベントへ
        let session_id_for_stderr = self.session_id.clone();
        let event_sender_stderr = self.event_sender.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let lower = line.to_lowercase();
                if lower.contains("error")
                    || lower.contains("failed")
                    || lower.contains("api key")
                {
                    let _ = event_sender_stderr.send(NormalizedEvent::Error {
                        session_id: session_id_for_stderr.clone(),
                        message: line,
                    });
                }
            }
        });

        // ゾンビ防止のためバックグラウンドで wait
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
        // gemini -p モードはツール許可UIを出さない（許可フローなし）
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ProviderError> {
        *self.stopped.lock().await = true;
        Ok(())
    }
}
