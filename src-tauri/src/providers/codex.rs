//! Codex CLI driver。
//!
//! Codex CLI（OpenAI公式）は Claude と違って `codex exec` が単発実行モデル。
//! 永続 stdin パイプを開いておく方式ではなく、メッセージごとに `codex exec resume`
//! を呼び直すパターンにする。
//!
//! ToS 遵守メモ:
//!  - `codex-sdk` Node SDK は import しない
//!  - ChatGPT Plus/Pro の OAuth は CLI 側で完結（UNICREW は触らない）
//!  - サブスク or API キーの切替は CLI が認識する標準 env / 認証ファイルに任せる

use crate::providers::types::{AuthMode, NormalizedEvent, PermissionMode, ProviderError, SpawnOpts};
use crate::providers::{CliProvider, SessionHandle};
use serde_json::Value;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

pub struct CodexProvider;

impl CodexProvider {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl CliProvider for CodexProvider {
    fn id(&self) -> &'static str {
        "codex"
    }

    async fn spawn_session(
        self: Arc<Self>,
        opts: SpawnOpts,
        event_sender: UnboundedSender<NormalizedEvent>,
    ) -> Result<Box<dyn SessionHandle>, ProviderError> {
        // Codex は send 時に都度 subprocess を立てるので、ここでは Ready だけ送って
        // ハンドルを返す。実セッション ID は最初の send 後に CLI から取得して保持。
        let _ = event_sender.send(NormalizedEvent::Ready {
            session_id: opts.session_id.clone(),
        });
        // 既存セッションを再開（任意）。
        // 値があれば最初の send から `codex exec resume <sid>` 経路に乗り、
        // 前回の会話履歴を CLI が読み込む。session が消えていた場合は CLI 側が
        // エラーを吐くので、UI 側でハンドリングする。
        let initial_cli_session = opts.resume_cli_session_id.clone();
        Ok(Box::new(CodexSessionHandle {
            session_id: opts.session_id,
            workspace: opts.workspace,
            model: opts.model,
            auth_mode: opts.auth_mode,
            api_key: opts.api_key,
            system_prompt: opts.system_prompt,
            permission_mode: opts.permission_mode,
            cli_session_id: Arc::new(Mutex::new(initial_cli_session)),
            event_sender,
            stopped: Arc::new(Mutex::new(false)),
        }))
    }
}

pub struct CodexSessionHandle {
    /// UNICREW 内部 ID（React 側で使う）
    session_id: String,
    workspace: Option<String>,
    model: String,
    auth_mode: AuthMode,
    api_key: Option<String>,
    system_prompt: String,
    permission_mode: PermissionMode,
    /// Codex CLI 側のセッションID（最初の exec で取得）
    cli_session_id: Arc<Mutex<Option<String>>>,
    event_sender: UnboundedSender<NormalizedEvent>,
    stopped: Arc<Mutex<bool>>,
}

#[async_trait::async_trait]
impl SessionHandle for CodexSessionHandle {
    async fn send_user_message(&mut self, text: &str) -> Result<(), ProviderError> {
        if *self.stopped.lock().await {
            return Ok(());
        }

        let cli_session = self.cli_session_id.lock().await.clone();
        let mut cmd = crate::build_silent_command("codex");

        if let Some(sid) = cli_session.as_ref() {
            cmd.arg("exec").arg("resume").arg(sid);
        } else {
            cmd.arg("exec");
        }

        // 共通フラグ。
        cmd.args(["--json", "--skip-git-repo-check"]);

        // パーミッションモード（Shift+Tab トグル）。
        // - AcceptEdits: 既存挙動。codex exec は非対話なので承認 UI を出せず、UNICREW 側で
        //   Workspace Trust 済の前提で `--dangerously-bypass-approvals-and-sandbox` を付けて
        //   承認待ち（item.started のまま固まる）を回避する。
        // - Plan: 読み取り・分析専用。`--sandbox read-only --ask-for-approval never` で
        //   書込・実行は静かに拒否。ファイルツリー走査と要約だけ通す。
        match self.permission_mode {
            PermissionMode::AcceptEdits => {
                cmd.arg("--dangerously-bypass-approvals-and-sandbox");
            }
            PermissionMode::Plan => {
                cmd.args([
                    "--sandbox",
                    "read-only",
                    "--ask-for-approval",
                    "never",
                ]);
            }
        }

        // UNICREW の `ModelId` 型は claude-* しか持っておらず、Codex キャラの defaultModel にも
        // `claude-sonnet-4-6` が入ってしまっている。これを `codex exec -m claude-sonnet-4-6`
        // にそのまま渡すと OpenAI 側が即 400 invalid_request_error を返し、subprocess が
        // 一瞬で終了する（UI からは「接続が切れた」ように見える）。
        // claude- 始まりは明らかに誤渡し。空文字も含めて落とす → codex CLI の既定モデル
        // （`~/.codex/config.toml`）を使わせる。OpenAI モデルが明示指定されてる時だけ尊重。
        if !self.model.is_empty() && !self.model.starts_with("claude-") {
            cmd.arg("-m").arg(&self.model);
        }

        // `-C` は `codex exec` 専用フラグで、`codex exec resume` には存在しない。
        // resume に渡すと clap が「unexpected argument '-C'」で即 exit code 2 で死ぬ
        // → 議論モードの2ラリー目以降で Codex の応答が消える原因だった。
        // resume 時は元セッションの cwd を引き継ぐので -C 不要。新規 exec の時だけ渡す。
        if cli_session.is_none() {
            if let Some(ws) = &self.workspace {
                cmd.arg("-C").arg(ws);
            }
        }

        // システムプロンプトは Codex の config 経由（-c instructions=...）。
        // ただし長文の場合 TOML エスケープに弱いので、最初のメッセージ前置きとして合成する。
        let prompt = if cli_session.is_none() && !self.system_prompt.is_empty() {
            format!("{}\n\n---\n\n{}", self.system_prompt, text)
        } else {
            text.to_string()
        };
        // Windows の codex.cmd へ argv で渡すと、Rust 1.77+ が CVE-2024-24576 対策で
        // 改行入りの引数を弾く（"batch file arguments are invalid"）。
        // システムプロンプトが必ず複数行なので、`-` を引数に置いて stdin から流す方式に変更。
        // codex exec は引数末尾が `-` のとき stdin を読む。
        cmd.arg("-");

        // 認証モード制御
        match self.auth_mode {
            AuthMode::Subscription => {
                cmd.env_remove("OPENAI_API_KEY");
            }
            AuthMode::ApiKey => {
                if let Some(k) = self.api_key.as_ref() {
                    cmd.env("OPENAI_API_KEY", k);
                }
            }
        }

        // stdin にプロンプトを書き込んで close する。argv 経由を回避するための方策。
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            ProviderError::SpawnFailed(format!(
                "codex CLI を起動できませんでした（インストール / PATH を確認してください）: {}",
                e
            ))
        })?;

        // stdin にプロンプトを流す → close（drop で EOF が立つ）
        if let Some(mut stdin) = child.stdin.take() {
            let bytes = prompt.into_bytes();
            tokio::spawn(async move {
                let _ = stdin.write_all(&bytes).await;
                let _ = stdin.shutdown().await;
            });
        }

        let stdout = child.stdout.take().ok_or_else(|| {
            ProviderError::Session("codex subprocess の stdout が取得できません".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ProviderError::Session("codex subprocess の stderr が取得できません".into())
        })?;

        let session_id_for_stdout = self.session_id.clone();
        let event_sender_stdout = self.event_sender.clone();
        let cli_session_for_stdout = Arc::clone(&self.cli_session_id);

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let parsed: Result<Value, _> = serde_json::from_str(&line);
                let v = match parsed {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // Codex CLI の JSONL イベント正規化
                let events = normalize_codex_event(&session_id_for_stdout, &v);

                // 初回 session_id を捕捉。捕捉できたらフロントへ CliSessionId イベントを送って
                // thread.codexSessionId として永続化させる（再起動後の `exec resume` 用）。
                if let Some(sid) = extract_session_id(&v) {
                    let mut guard = cli_session_for_stdout.lock().await;
                    if guard.is_none() {
                        *guard = Some(sid.clone());
                        let _ = event_sender_stdout.send(NormalizedEvent::CliSessionId {
                            session_id: session_id_for_stdout.clone(),
                            cli_session_id: sid,
                        });
                    }
                }

                for ev in events {
                    if event_sender_stdout.send(ev).is_err() {
                        return;
                    }
                }
            }
        });

        let session_id_for_stderr = self.session_id.clone();
        let event_sender_stderr = self.event_sender.clone();
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

        // child は send 関数のスコープを抜けると drop される。
        // Codex は exec 単位で完結するので、終了を待つ必要はないが、
        // ゾンビ防止のためバックグラウンドで wait する。
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
        // Codex は --full-auto モードなので permission prompt を出さない
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ProviderError> {
        *self.stopped.lock().await = true;
        // 個別 child は send ごとに background wait してるので明示 kill 不要
        Ok(())
    }
}

/// Codex JSONL イベントを NormalizedEvent に変換。
///
/// Codex CLI には2種類のイベント形がある（バージョンで違う）:
///
/// **旧形（〜 codex-cli 0.x 初期）**:
///   - `{"id":"...","msg":{"type":"agent_message","message":"..."}}`
///   - `{"id":"...","msg":{"type":"task_started", "session_id": "uuid"}}`
///   - `{"id":"...","msg":{"type":"task_complete","last_agent_message":"..."}}`
///   - `{"id":"...","msg":{"type":"error", "message":"..."}}`
///
/// **新形（codex-cli 0.117〜）**:
///   - `{"type":"thread.started","thread_id":"uuid"}`
///   - `{"type":"turn.started"}`
///   - `{"type":"item.completed","item":{...}}` (assistant message / tool use / tool result)
///   - `{"type":"turn.completed","usage":{...}}`
///   - `{"type":"turn.failed","error":{"message":"..."}}`
///   - `{"type":"error","message":"..."}`
///
/// 両方を吸収する。
fn normalize_codex_event(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    // 新形は `type` がトップレベル。旧形は `msg.type` にある。
    if v.get("msg").is_some() {
        normalize_legacy(session_id, v)
    } else if v.get("type").is_some() {
        normalize_new(session_id, v)
    } else {
        vec![]
    }
}

/// 旧形（msg ラッパー）パーサ。
fn normalize_legacy(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    let Some(msg) = v.get("msg") else {
        return vec![];
    };
    let msg_type = msg.get("type").and_then(|x| x.as_str()).unwrap_or("");

    match msg_type {
        "agent_message" | "agent_message_delta" => {
            if let Some(text) = msg
                .get("message")
                .or_else(|| msg.get("delta"))
                .and_then(|x| x.as_str())
            {
                vec![NormalizedEvent::AssistantText {
                    session_id: session_id.to_string(),
                    text: text.to_string(),
                }]
            } else {
                vec![]
            }
        }
        "exec_command_begin" | "command_started" | "tool_use" => {
            let tool_use_id = msg
                .get("call_id")
                .or_else(|| msg.get("id"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let tool_name = msg
                .get("tool")
                .or_else(|| msg.get("command"))
                .and_then(|x| x.as_str())
                .unwrap_or("Bash")
                .to_string();
            let tool_input = msg.clone();
            vec![NormalizedEvent::ToolUse {
                session_id: session_id.to_string(),
                tool_use_id,
                tool_name,
                tool_input,
            }]
        }
        "exec_command_end" | "command_executed" | "tool_result" => {
            let tool_use_id = msg
                .get("call_id")
                .or_else(|| msg.get("id"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = msg
                .get("exit_code")
                .and_then(|x| x.as_i64())
                .map(|c| c != 0)
                .unwrap_or(false);
            let content = msg
                .get("stdout")
                .or_else(|| msg.get("output"))
                .cloned()
                .unwrap_or(Value::Null);
            vec![NormalizedEvent::ToolResult {
                session_id: session_id.to_string(),
                tool_use_id,
                is_error,
                content,
            }]
        }
        "task_complete" => {
            let cost = msg.get("cost_usd").and_then(|x| x.as_f64());
            let usage = msg.get("usage").cloned();
            vec![NormalizedEvent::Result {
                session_id: session_id.to_string(),
                subtype: "success".to_string(),
                cost_usd: cost,
                usage,
            }]
        }
        "error" => {
            let message = msg
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            vec![NormalizedEvent::Error {
                session_id: session_id.to_string(),
                message,
            }]
        }
        _ => vec![],
    }
}

/// 新形（top-level `type`）パーサ — codex-cli 0.117+ で観測されるフォーマット。
fn normalize_new(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    let event_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");

    match event_type {
        // thread.started / turn.started はライフサイクル系。Ready は spawn 時に既送なので無視。
        "thread.started" | "turn.started" => vec![],
        // item.started: コマンド実行が「始まった」シグナル。
        // 完了を待たず ToolUse を即発火しないと、UI 側で「Codex 何やってるか分からない時間」が出る。
        // command_execution 系のときだけ ToolUse を発火（assistant_message は started では未確定なので無視）。
        "item.started" => normalize_new_item_started(session_id, v),
        // item.completed / item.added: assistant message / tool use / tool result が item として届く。
        "item.completed" | "item.added" => normalize_new_item(session_id, v),
        "agent_message" | "agent_message_delta" => {
            // 新形でも一部のCLI流派が直接 agent_message を出すケースがある
            if let Some(text) = v
                .get("message")
                .or_else(|| v.get("delta"))
                .and_then(|x| x.as_str())
            {
                vec![NormalizedEvent::AssistantText {
                    session_id: session_id.to_string(),
                    text: text.to_string(),
                }]
            } else {
                vec![]
            }
        }
        "turn.completed" => {
            let usage = v.get("usage").cloned();
            vec![NormalizedEvent::Result {
                session_id: session_id.to_string(),
                subtype: "success".to_string(),
                cost_usd: None,
                usage,
            }]
        }
        "turn.failed" => {
            let message = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            vec![NormalizedEvent::Error {
                session_id: session_id.to_string(),
                message,
            }]
        }
        "error" => {
            let message = v
                .get("message")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            vec![NormalizedEvent::Error {
                session_id: session_id.to_string(),
                message,
            }]
        }
        _ => vec![],
    }
}

/// 新形 `item.started` の中身を分岐する。
///
/// command_execution 系は「始まった」段階で ToolUse を発火し、UI に進行中バブルを描かせる。
/// assistant_message などのテキスト系は started 時点では未確定（中身が空 or 部分）なので無視し、
/// completed フェーズの normalize_new_item で確定値を一括発火する。
fn normalize_new_item_started(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    let Some(item) = v.get("item") else {
        return vec![];
    };
    let item_type = item.get("type").and_then(|x| x.as_str()).unwrap_or("");

    if !matches!(item_type, "command_execution" | "tool_call" | "exec_command") {
        return vec![];
    }

    let tool_use_id = item
        .get("id")
        .or_else(|| item.get("call_id"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let tool_name = item
        .get("name")
        .or_else(|| item.get("tool"))
        .and_then(|x| x.as_str())
        .unwrap_or("Bash")
        .to_string();
    let tool_input = item.clone();

    vec![NormalizedEvent::ToolUse {
        session_id: session_id.to_string(),
        tool_use_id,
        tool_name,
        tool_input,
    }]
}

/// 新形 `item.completed` / `item.added` の中身を分岐する。
///
/// command_execution 系は ToolUse を**スキップ**して ToolResult だけ発火する
/// （ToolUse は normalize_new_item_started 側で先に発火済みの想定）。
/// 出力フィールドが無い場合は何も出さない（古い CLI 派が item.added だけで完結する流派には
/// `item.added` でも一旦 ToolUse を出していた頃の名残だが、ActivityPanel 廃止後は
/// チャット側で進行中バブル表示が要らないので、started → completed の二段運用に統一する）。
fn normalize_new_item(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    let Some(item) = v.get("item") else {
        return vec![];
    };
    let item_type = item.get("type").and_then(|x| x.as_str()).unwrap_or("");

    match item_type {
        // assistant が出力したテキスト
        "agent_message" | "assistant_message" | "message" => {
            let text = item
                .get("text")
                .or_else(|| item.get("message"))
                .or_else(|| item.get("content"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                vec![]
            } else {
                vec![NormalizedEvent::AssistantText {
                    session_id: session_id.to_string(),
                    text,
                }]
            }
        }
        // ツール呼び出し（コマンド実行）— ToolUse は started 側で既出。ここでは ToolResult のみ。
        "command_execution" | "tool_call" | "exec_command" => {
            let output_opt = item.get("output").or_else(|| item.get("stdout"));
            let Some(output) = output_opt else {
                return vec![];
            };
            let tool_use_id = item
                .get("id")
                .or_else(|| item.get("call_id"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = item
                .get("exit_code")
                .and_then(|x| x.as_i64())
                .map(|c| c != 0)
                .unwrap_or(false);
            vec![NormalizedEvent::ToolResult {
                session_id: session_id.to_string(),
                tool_use_id,
                is_error,
                content: output.clone(),
            }]
        }
        _ => vec![],
    }
}

fn extract_session_id(v: &Value) -> Option<String> {
    // 旧形: msg.session_id
    if let Some(s) = v.get("msg").and_then(|m| m.get("session_id")).and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    // 新形: thread.started イベントの thread_id を session_id 相当として扱う
    // （codex CLI は exec resume <thread_id> で再開するので等価）
    if let Some(s) = v.get("thread_id").and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    if let Some(s) = v.get("session_id").and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    None
}
