//! Claude CLI driver。
//!
//! `claude` CLI（Anthropic公式）を `--input-format stream-json --output-format stream-json --verbose`
//! のヘッドレスモードで spawn し、永続セッションとして使う。
//!
//! ToS 遵守メモ:
//!  - SDK は import しない
//!  - OAuth トークンは UNICREW 側で読み書きしない（CLI が `~/.claude/credentials` 等で自前管理）
//!  - サブスクモード時は `ANTHROPIC_API_KEY` を env から外して CLI のサブスク認証経路に乗せる

use crate::providers::images::InputImage;
use crate::providers::types::{AuthMode, NormalizedEvent, PermissionMode, ProviderError, SpawnOpts};
use crate::providers::{stream_parser, CliProvider, SessionHandle};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

/// can_use_tool の request_id → (返信に載せる updatedInput, permission_suggestions)。
/// stdout 読み取りタスクが書き、承認ボタンが押されたときにセッション側が読む。
type PendingPermissions = Arc<Mutex<HashMap<String, (serde_json::Value, serde_json::Value)>>>;

/// `--permission-prompt-tool stdio` を安全に渡せる claude CLI の下限。
///
/// この値を知らない CLI は `Error: MCP tool stdio (passed via --permission-prompt-tool) not found`
/// を出して**終了コード1で即死する**（2026-09-01 実測）。つまり付け方を誤ると
/// Claude セッションが1本も起動しなくなるので、実機で通ることを確認できた版だけに絞る。
/// 実測で通ったのは 2.1.246 / 2.1.251 / 2.1.252。下限を下げるときは必ず実機で確かめること。
const MIN_VERSION_FOR_STDIO_PERMISSION_PROMPT: (u32, u32, u32) = (2, 1, 246);

/// `claude --version` の先頭トークンから (major, minor, patch) を取り出す。
/// 例: "2.1.252 (Claude Code)" → (2, 1, 252)
fn parse_cli_semver(text: &str) -> Option<(u32, u32, u32)> {
    let token = text.trim().split_whitespace().next()?;
    let mut parts = token.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch: String = parts
        .next()?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    Some((major, minor, patch.parse().ok()?))
}

/// `claude --version` をプロセス内で1回だけ実行して結果を使い回す。
/// 取れない・読めないときは None を返し、呼び出し側は新しい引数を付けない側（＝従来動作）に倒す。
async fn claude_cli_version() -> Option<(u32, u32, u32)> {
    static CACHE: tokio::sync::OnceCell<Option<(u32, u32, u32)>> =
        tokio::sync::OnceCell::const_new();
    *CACHE
        .get_or_init(|| async {
            let out = crate::build_silent_command("claude")
                .arg("--version")
                .output()
                .await
                .ok()?;
            parse_cli_semver(&String::from_utf8_lossy(&out.stdout))
        })
        .await
}

/// 承認ダイアログの決定を、CLI が受け取れる control_response の中身に変換する。
///
/// 実測で CLI が受け入れた形（2026-09-01）:
///   allow      → {"behavior":"allow","updatedInput":{...},"updatedPermissions":[...]}
///   allow_once → {"behavior":"allow","updatedInput":{...}}
///   deny       → {"behavior":"deny","message":"..."}
///
/// `updatedPermissions` を返すのは「許可」のときだけ。これを返すと CLI が自分の設定に
/// 覚えて次回から聞かなくなる（実測で2回目は聞いてこなくなった）。UNICREW は設定ファイルを書かない。
fn build_permission_decision(
    decision: &str,
    input: serde_json::Value,
    suggestions: serde_json::Value,
) -> serde_json::Value {
    if decision == "deny" {
        return serde_json::json!({
            "behavior": "deny",
            "message": "ユーザーが許可しませんでした",
        });
    }
    let mut body = serde_json::Map::new();
    body.insert("behavior".into(), serde_json::Value::String("allow".into()));
    // 入力を控えられていないとき（再起動を挟んだ等）は updatedInput を付けない。
    // 空オブジェクトを送るとツールの引数を潰してしまうため。
    if !input.is_null() {
        body.insert("updatedInput".into(), input);
    }
    if decision == "allow" {
        if let Some(arr) = suggestions.as_array() {
            if !arr.is_empty() {
                body.insert(
                    "updatedPermissions".into(),
                    serde_json::Value::Array(arr.clone()),
                );
            }
        }
    }
    serde_json::Value::Object(body)
}

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
            // session_id だけだと「停止→同スレッドへ即再送」で旧セッションの
            // Drop が新セッションの同名ファイルを削除し、新 claude が
            // --append-system-prompt-file を読めず終了コード1で即死する。
            // spawn ごとに一意な連番を付けて衝突を根絶する。
            use std::sync::atomic::{AtomicU64, Ordering};
            static SYSPROMPT_SEQ: AtomicU64 = AtomicU64::new(0);
            let nonce = SYSPROMPT_SEQ.fetch_add(1, Ordering::Relaxed);
            path.push(format!(
                "unicrew-claude-sysprompt-{}-{}.txt",
                opts.session_id, nonce
            ));
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

        // ウェブ検索・ウェブ取得を自動許可する。
        //
        // acceptEdits が自動で許可するのは「ファイル編集」まで。WebSearch / WebFetch は
        // その対象外なので CLI が承認を求めてくるが、Claude 経路には承認フローが無く
        // （send_permission_response は no-op）誰も答えられない。結果、CLI は
        //   "Claude requested permissions to use WebSearch, but you haven't granted it yet."
        // を返して黙って諦め、ユーザーには「許可ダイアログが出ないので検索できない」
        // としか見えなくなる（2026-09-01 に実機で再現・修正を実測）。
        //
        // WebSearch / WebFetch はどちらも読み取り専用なので Plan モードでも許可してよい。
        // Bash / Edit / Write / Read / Grep は acceptEdits で通ることを実測済みなので触らない。
        //
        // 注1: --allowedTools は「自動承認する道具の一覧」であって、道具立てを絞る指定ではない
        //      （絞るのは --tools / --disallowedTools）。既存で使えていた道具は減らない。
        // 注2: `--allowedTools=A,B` と `=` 連結した 1 引数で渡すこと。CLI 側の定義が
        //      可変長引数 <tools...> なので `--allowedTools A` と分けると後続の引数まで飲み込む。
        cmd.arg("--allowedTools=WebSearch,WebFetch");

        // 承認フローを stdio に引き出す。
        //
        // これを渡すと CLI は「許可が要る道具」を勝手に諦めず、stdout に
        // control_request(can_use_tool) を出して stdin の返事を待つようになる。
        // 受け口は stream_parser と send_permission_response、UI は既存の
        // PermissionPromptModal（ACP 系プロバイダ用に作ってあったもの）をそのまま使う。
        //
        // これが無いと、acceptEdits が面倒を見ない道具（MCP ツールなど）は
        // 「Claude requested permissions ... but you haven't granted it yet.」で黙って落ち、
        // ユーザーには「出るはずの許可ダイアログが出ない」としか見えない。
        //
        // 🚨 値 "stdio" を知らない古い CLI は起動即死（終了コード1）する。
        //    そのため実機で確認が取れている版だけに限定する。取れなければ付けない＝従来動作。
        if let Some(v) = claude_cli_version().await {
            if v >= MIN_VERSION_FOR_STDIO_PERMISSION_PROMPT {
                cmd.arg("--permission-prompt-tool").arg("stdio");
            }
        }

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
        let pending_permissions: PendingPermissions = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_stdout = pending_permissions.clone();
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
                        // 承認要求だけは、返信に要る生の値（updatedInput 用の入力と
                        // permission_suggestions）を先に控える。NormalizedEvent には載せない
                        // ＝ React 側の型（PendingPermission）を変えずに済ませるため。
                        if line.contains("control_request") {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                                if let Some(ask) = stream_parser::extract_permission_request(&v) {
                                    if let Ok(mut map) = pending_for_stdout.lock() {
                                        map.insert(ask.request_id, (ask.input, ask.suggestions));
                                    }
                                }
                            }
                        }
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
            pending_permissions,
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
    /// 返事待ちの承認要求。stdout タスクが入れ、承認ボタンで取り出す。
    pending_permissions: PendingPermissions,
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
        self.send_user_message_with_images(text, &[]).await
    }

    /// 添付画像を **本物の画像として** CLI に渡す。
    ///
    /// claude CLI は `--input-format stream-json` の user メッセージで
    /// content 配列 + image ブロック（base64）を受け取れる（2026-09-01 実測。
    /// 画像のピクセルにしか無い単語を読ませて正答させた）。
    /// これにより「ワークスペース外のファイルを読む許可」の問題ごと消える。
    ///
    /// 画像が1枚も無いときは従来どおり `content` を **文字列** のまま送る。
    /// 形を変えないほうが安全（既存の全経路がこの形で通っている）。
    async fn send_user_message_with_images(
        &mut self,
        text: &str,
        images: &[InputImage],
    ) -> Result<(), ProviderError> {
        // 組み立ては images::build_user_payload に一本化してある。
        // ユニットテストも実機検証（examples/print_user_payload.rs）も
        // **この同じ関数**を通るので、「テストは通るが実物は違う」が起きない。
        let (payload, skipped) =
            crate::providers::images::build_user_payload(text, images);
        if skipped > 0 {
            eprintln!(
                "[unicrew/claude] 添付画像 {} 件はインライン化を見送りました（形式・サイズ・枚数のいずれか）。本文のパス経由で従来どおり処理されます",
                skipped
            );
        }

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
                    "Claude が起動直後に終了しました（終了コード {code}）。停止直後の再送と競合したか、未ログインの可能性があります。少し待ってから再送し、改善しなければ設定 → アカウントで Claude Code のログインを確認してください。"
                )));
            }
            return Err(ProviderError::Io(e));
        }
        Ok(())
    }

    async fn send_permission_response(
        &mut self,
        request_id: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        // `--permission-prompt-tool stdio` を付けて起動した場合、CLI は
        // control_request(can_use_tool) を出したあと **stdin の返事が来るまで止まる**。
        // ここで返さないとセッションが固まるので、必ず1回返す。
        //
        // 返す形（2026-09-01 実測）:
        //   {"type":"control_response","response":{"subtype":"success","request_id":"...",
        //     "response":{"behavior":"allow","updatedInput":{...}}}}
        let saved = self
            .pending_permissions
            .lock()
            .ok()
            .and_then(|mut map| map.remove(request_id));

        let (input, suggestions) = saved.unwrap_or((
            serde_json::Value::Null,
            serde_json::Value::Null,
        ));
        let body = build_permission_decision(decision, input, suggestions);

        let payload = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": body,
            }
        });
        let mut line = serde_json::to_string(&payload)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
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


#[cfg(test)]
mod claude_permission_tests {
    use super::*;

    #[test]
    fn semver_is_read_from_version_output() {
        assert_eq!(parse_cli_semver("2.1.252 (Claude Code)"), Some((2, 1, 252)));
        assert_eq!(parse_cli_semver("2.1.246 (Claude Code)"), Some((2, 1, 246)));
        assert_eq!(parse_cli_semver("  2.1.251
"), Some((2, 1, 251)));
        // プレリリース表記でも数字部分まで読めれば良い
        assert_eq!(parse_cli_semver("3.0.1-beta.2 (x)"), Some((3, 0, 1)));
    }

    #[test]
    fn unreadable_version_is_none_so_we_fall_back_to_old_behaviour() {
        // 読めなければ None → 呼び出し側は --permission-prompt-tool を付けない＝従来動作。
        assert_eq!(parse_cli_semver(""), None);
        assert_eq!(parse_cli_semver("unknown"), None);
        assert_eq!(parse_cli_semver("2.1"), None);
    }

    #[test]
    fn version_gate_matches_what_was_verified_on_real_binaries() {
        // 実機で通ったのは 2.1.246 / 2.1.251 / 2.1.252。
        // 未確認の古い版には付けない（付けると終了コード1で即死するため）。
        for v in [(2, 1, 246), (2, 1, 251), (2, 1, 252), (2, 2, 0), (3, 0, 0)] {
            assert!(v >= MIN_VERSION_FOR_STDIO_PERMISSION_PROMPT, "{:?}", v);
        }
        for v in [(2, 1, 245), (2, 0, 999), (1, 9, 9)] {
            assert!(v < MIN_VERSION_FOR_STDIO_PERMISSION_PROMPT, "{:?}", v);
        }
    }

    #[test]
    fn allow_echoes_input_and_persists_via_suggestions() {
        let input = serde_json::json!({"query": "ZUBOLAND"});
        let suggestions = serde_json::json!([{"type": "addRules", "behavior": "allow"}]);
        let body = build_permission_decision("allow", input.clone(), suggestions.clone());
        assert_eq!(body["behavior"], "allow");
        assert_eq!(body["updatedInput"], input);
        assert_eq!(body["updatedPermissions"], suggestions);
    }

    #[test]
    fn allow_once_does_not_persist() {
        let body = build_permission_decision(
            "allow_once",
            serde_json::json!({"a": 1}),
            serde_json::json!([{"type": "addRules"}]),
        );
        assert_eq!(body["behavior"], "allow");
        assert!(body.get("updatedPermissions").is_none());
    }

    #[test]
    fn deny_carries_a_reason_and_never_allows() {
        let body = build_permission_decision(
            "deny",
            serde_json::json!({"a": 1}),
            serde_json::json!([{"type": "addRules"}]),
        );
        assert_eq!(body["behavior"], "deny");
        assert!(body.get("updatedInput").is_none());
        assert!(body["message"].as_str().is_some());
    }

    #[test]
    fn missing_input_is_omitted_not_blanked() {
        // 控えが無いときに updatedInput:{} を送るとツールの引数を潰してしまう。
        let body = build_permission_decision(
            "allow",
            serde_json::Value::Null,
            serde_json::Value::Null,
        );
        assert_eq!(body["behavior"], "allow");
        assert!(body.get("updatedInput").is_none());
        assert!(body.get("updatedPermissions").is_none());
    }
}
