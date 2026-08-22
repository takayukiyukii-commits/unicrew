# UNICREW — Pure CLI Conductor 設計

**最終更新**: 2026-05-08
**起点**: `repos/unipilot/`（Phase 2/3完成版）からのコピー → SDK経路を全廃した配布版

## 1. ポジショニング

VSCode が「コードエディタにAIが乗っている」のに対し、UNICREW は「AIを動かすことに特化したデスクトップ」。コード編集・ファイル管理は外部に任せ、UNICREW は AI セッションの起動・並列・切替・可視化のみに最適化する。

| 軸 | VSCode | UNICREW |
|---|---|---|
| 主役 | コード | AI |
| AIモード | 1セッション拡張 | 並列 / 議論 / 人格別 |
| プロバイダ | Claude拡張 / Copilot等を別個に追加 | Claude / Codex / 将来Gemini を対等に扱う provider 抽象 |
| 出力UI | コードエディタ周辺 | チャットUI＋ツール使用ログ＋思考可視化 |
| 配布 | Microsoft Marketplace | winget / GitHub Releases / 窓の杜 |

## 2. ToS 適合の核心：CLI subprocess only

Anthropic の 2026-04-04 ToS:
> "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — **including the Agent SDK** — is not permitted"

> "For local Claude Code CLI usage on your own computer, nothing changes — it's Anthropic's official product built for **scripted and automated use**, and the Consumer ToS **exempts it from the prohibition on automated access**."

UNICREW は **公式 `claude` / `codex` CLI を subprocess として spawn する以外の経路を持たない**。`@anthropic-ai/claude-agent-sdk` などの SDK を import しないことを設計上の絶対制約とする。

## 3. アーキテクチャ全景

```
┌────────────────────────────────────────────────────────┐
│ Tauri 2.x ウィンドウ                                    │
│  ┌──────────────────────────────────────────────┐     │
│  │ Next.js + React UI（チャット / 並列 / 議論）  │     │
│  └────────────────────┬─────────────────────────┘     │
│                       │ invoke / event                   │
│  ┌────────────────────▼─────────────────────────┐     │
│  │ Rust main: src-tauri/src/                     │     │
│  │  ├ providers/                                 │     │
│  │  │   ├ trait Provider                         │     │
│  │  │   ├ claude.rs       (L1: claude CLI)      │     │
│  │  │   ├ codex.rs        (L1: codex CLI)       │     │
│  │  │   ├ gemini.rs       (L1: gemini CLI)      │     │
│  │  │   ├ antigravity.rs  (L1: agy CLI)         │     │
│  │  │   ├ opencode.rs     (L2: 自動install)     │     │
│  │  │   ├ qwen.rs         (L2: 自動install)     │     │
│  │  │   ├ kimi.rs         (L2: 自動install)     │     │
│  │  │   └ goose_embed.rs  (L4: goose-sdk crate) │     │
│  │  ├ stream_parser.rs                           │     │
│  │  ├ install.rs（winget / brew / npm 経由）    │     │
│  │  └ keychain.rs（OS Keychain：APIキー任意）   │     │
│  └────────┬───────────────────────────┬─────────┘     │
│           │ stdin/stdout              │ direct call    │
│  ┌────────▼─────────────────────┐  ┌─▼──────────────┐ │
│  │ 公式CLI subprocess (L1/L2)    │  │ goose-sdk      │ │
│  │  ├ claude -p ...              │  │ Rust crate内蔵 │ │
│  │  ├ codex exec ...             │  │ (L4)           │ │
│  │  ├ agy ...                    │  │ subprocess無し │ │
│  │  ├ opencode run -f json ...   │  │ 直接 Event 生成│ │
│  │  ├ qwen --output-format ...   │  └────────────────┘ │
│  │  └ kimi ...                   │                     │
│  └───────────────────────────────┘                     │
└────────────────────────────────────────────────────────┘
```

### 4層統合モデル（2026-05-10 採用）

| 層 | 通信方式 | プロバイダ |
|---|---|---|
| L1 外部CLI | subprocess + stream-json | Claude / Codex / Gemini / Antigravity |
| L2 自動install | subprocess + stream-json（初回のみ install 実行） | OpenCode / Qwen Code / Kimi |
| L4 内蔵 | Rust crate 直接 link、subprocess なし | Goose（goose-sdk） |

**L4 の特徴**:
- subprocess 起動コストゼロ → 並列モードで100セッション同時起動可能
- 型付き Rust API → パース失敗・エスケープバグの根絶
- UNICREW 独自の permission gate / kill switch を agent loop の中に直接挟める
- Cargo.toml で `goose-sdk = { git = "https://github.com/block/goose", tag = "v<X>" }` 固定
- ライセンス: Apache-2.0、`THIRD_PARTY_LICENSES/goose/` に NOTICE 同梱必須

**なくなったもの（unipilot から削除）**:
- `sidecar/agent.mjs`（claude-agent-sdk 使用）
- `sidecar/codex-agent.mjs`（codex-sdk 使用）
- `sidecar/` フォルダ自体
- `@anthropic-ai/claude-agent-sdk` / `@anthropic-ai/sdk` / `codex-sdk` 等の依存

**残すもの**:
- React UI コンポーネント全般（イベントスキーマ追従のみ更新）
- ブランド資産（`public/brand/`）
- キャラクター定義 / 人格12種（`lib/personalities.ts`）
- 設定モーダル / 接続ステータスUI
- 音声入力（OpenAI Whisper、独立）
- 思考可視化UI / TodoWrite変換UI（イベントソースを stream-json に切替）

## 4. Provider 抽象（マルチAI対応の核）

```rust
// src-tauri/src/providers/mod.rs
pub trait Provider: Send + Sync {
    /// プロバイダ識別子（"claude" / "codex" / "gemini" 等）
    fn id(&self) -> &'static str;

    /// CLIインストール状態
    async fn check_installed(&self) -> InstallStatus;

    /// CLIインストール（winget等）
    async fn install(&self, on_progress: ProgressFn) -> Result<()>;

    /// ログイン状態（OAuth認証済か）
    async fn check_login(&self) -> LoginStatus;

    /// ログイン開始（CLIのloginコマンドを spawn）
    async fn start_login(&self, on_url: UrlFn) -> Result<()>;

    /// セッション起動（subprocess spawn）
    async fn spawn_session(&self, opts: SpawnOpts) -> Result<SessionHandle>;
}

pub struct SpawnOpts {
    pub session_id: Option<String>,         // 既存セッションresume
    pub system_prompt: Option<String>,      // --append-system-prompt
    pub model: Option<String>,              // --model
    pub workspace: Option<PathBuf>,         // cwd
    pub permission_mode: PermissionMode,    // --permission-mode
    pub allowed_tools: Vec<String>,         // --allowedTools
    pub api_key: Option<String>,            // ANTHROPIC_API_KEY env（任意）
}

pub enum NormalizedEvent {
    SessionStart { session_id: String },
    UserMessage { text: String },
    AssistantText { delta: String },
    ToolUse { name: String, input: serde_json::Value, id: String },
    ToolResult { id: String, output: String, is_error: bool },
    TodoUpdate { items: Vec<TodoItem> },
    UsageUpdate { input_tokens: u64, output_tokens: u64 },
    Result { success: bool, total_cost_usd: f64, duration_ms: u64 },
    Error { message: String },
}
```

各プロバイダの stream-json は微妙に違うので、`stream_parser.rs` で `NormalizedEvent` に正規化してから React に流す。

## 5. Claude 経路の具体

### Single mode
```
claude --print \
  --output-format stream-json --input-format stream-json --verbose \
  --append-system-prompt "${effectiveSystemPrompt}" \
  --permission-mode default \
  --include-partial-messages \
  --session-id ${uuid}
```

- subprocess は会話継続中ずっと alive
- ユーザー入力は stdin に stream-json で書く
- 応答イベントは stdout から行単位 JSON で読む
- `--session-id` で同一セッション
- 終了時は stdin close → CLI が自然終了

### Split mode
- 上記を **2 subprocess 並列**で spawn（Claude + Codex / Claude + Claude も可）
- Rust 側で送信時に両方の stdin に同時書込
- React 側で2カラム表示

### Conference mode
- 各ラウンドで両AIに「直前の相手の出力 ＋ 評価・改善・統合してください」を投げる
- 実装: ラウンド終わるたびに新 subprocess 起動 or 同セッションに stdin で続ける
- `[合意]` 検出 or 上限ラウンド到達で終了
- subprocess 並列 ＋ 順次 spawn のハイブリッド

### キャラクター systemPrompt
- 既存 `buildEffectiveSystemPrompt(characterPrompt, personalityId)` の出力を `--append-system-prompt` に渡すだけ
- SDK の preset+append 形式は CLI が内部で同等の処理をしている（CLI=Anthropic公式なので preset が消えない）

## 5b. ACP プロトコル経路（L3）— 業界標準採用

**訂正**: 当初「L4 Goose 内蔵」を計画したが、調査の結果 `goose-sdk` は ACP client 実装であり、本物の embed は V8 同梱・MSRV 1.91.1 強制でコスト過大と判明。代わりに **業界標準 ACP（Agent Client Protocol、Zed 主導）** を採用し、複数の ACP 対応エージェントを1つの実装で束ねる。詳細経緯: 社内調査ノート（Goose L4 再評価・2026-05-10）

### 共通 ACP transport（providers/acp_transport.rs）

```rust
// src-tauri/src/providers/acp_transport.rs (案)
use agent_client_protocol::{Client, ByteStreams, ActiveSession};
use tokio::process::Command;
use tokio_util::compat::*;

/// ACP プロトコル対応エージェントとの共通通信レイヤー。
/// goose / opencode / codex-acp / kiro が同じパスで動く。
pub struct AcpTransport {
    pub bin: PathBuf,           // 実行バイナリパス（例: "goose", "opencode"）
    pub acp_subcommand: String, // 例: "acp"
}

impl AcpTransport {
    pub async fn spawn_session(&self, opts: SpawnOpts) -> Result<SessionHandle> {
        let mut child = Command::new(&self.bin)
            .arg(&self.acp_subcommand)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());

        let client = Client::builder()
            .transport(transport)
            .on_notification(|n| { /* permission 等を UNICREW UI に転送 */ })
            .build()?;

        client.initialize().await?;
        let session = client
            .build_session_cwd(opts.workspace)?
            .with_system_prompt(opts.system_prompt)
            .with_allowed_tools(opts.allowed_tools)
            .start()
            .await?;

        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(forward_acp_to_normalized(session, tx));
        Ok(SessionHandle { rx, kill_tx: child_kill_tx })
    }
}

fn map_acp_event(ev: agent_client_protocol::SessionMessage) -> NormalizedEvent {
    // ACP の SessionMessage は JSON-RPC で型付き → switch するだけ
    match ev {
        SessionMessage::AssistantText { delta } => NormalizedEvent::AssistantText { delta },
        SessionMessage::ToolUse { name, input, id } => NormalizedEvent::ToolUse { name, input, id },
        SessionMessage::PermissionRequest { ... } => NormalizedEvent::PermissionRequest { ... },
        // ...
    }
}
```

### 各 ACP プロバイダの最小実装

```rust
// providers/goose.rs
pub struct GooseProvider { acp: AcpTransport }
impl Provider for GooseProvider {
    fn id(&self) -> &'static str { "goose" }
    async fn spawn_session(&self, opts: SpawnOpts) -> Result<SessionHandle> {
        self.acp.spawn_session(opts).await
    }
    // install() / check_login() は L2 と同じく winget 等
}

// providers/opencode.rs — ほぼ同じ
// providers/codex_acp.rs — ほぼ同じ
// providers/kiro.rs — ほぼ同じ
```

→ **新しい ACP 対応 agent は数十行で対応完了**

### メリット

| 観点 | 効果 |
|---|---|
| **業界標準採用** | Zed エディタと同じプロトコル、ベンダーロックイン無し |
| **型付き JSON-RPC** | stdout 文字列パースのバグ温床ゼロ |
| **permission gate** | プロトコル組込みで UNICREW の `permission_mode` と完全一致 |
| **複数エージェント1パス** | Goose / OpenCode / Codex-acp / Kiro が同じ実装で動く |
| **拡張性** | 新 ACP agent は provider ファイル1つ追加で対応 |

### 注意点

- `<agent> acp` の subprocess 起動は依然必要（"subprocess ゼロ" は当初の誤認）
- `agent-client-protocol` crate v0.11.x は workspace MSRV が高め → UNICREW MSRV を 1.77 → 1.91.1 に引き上げ
- 商用 ToS のあるエージェント（Claude/Codex/Gemini）は L1 のまま（独自 stream-json 経路継続）

## 5c. UI 複雑化を避ける（プロバイダ拡張時の絶対原則）

10+ プロバイダ追加時、UI が破綻しないための5原則を絶対遵守。詳細は AGENTS.md の「UI 複雑化を避ける5原則」節参照。要点:

1. プロバイダを **モデルカテゴリ**（Claude系 / OpenAI系 / Google系 / OSS-ローカル系）でまとめ、個別表示しない
2. WelcomeLanding は「無料モード」を1ボタンで上位提示、status 一覧は隠す
3. SettingsModal は accordion 化、デフォルト全閉
4. 議論モードは「プリセット」最優先、N人選択 UI は作らない
5. 識別はカテゴリ色 + lucide アイコン + テキスト統一、絵文字禁止

実装影響:
- `lib/providerCategories.ts` 新設 — カテゴリ定義 + プロバイダ ↔ カテゴリ写像
- `components/SettingsModal.tsx` を accordion 化（カテゴリ単位）
- `components/WelcomeLanding.tsx` の status 行を「無料モード1ボタン + 詳細リンク」に再構成
- `components/ConferencePresets.tsx` 新設 — プリセット選択 UI
- `lib/providerVisuals.ts` で `PROVIDER_BADGES` を `CATEGORY_BADGES` (4種) に縮約

## 6. Codex 経路

```
codex exec \
  --output-last-message \
  -c "${configOverride}" \
  "${prompt}"
```

- `codex exec` は単発実行モード
- 会話継続は `codex resume` or stdin pipe
- Codex 側で stream-json 相当の出力フォーマットを context7 で再確認済（`codex mcp-server stdio` 経由なら確実）

将来的に `codex mcp-server` を spawn して MCP プロトコルで通信する案も検討候補。

## 7. インストール / ログインフロー（"ボタンで簡単"）

| ステップ | 実装 | ToS |
|---|---|---|
| Claude CLIインストール | 公式ネイティブインストーラ（Win: `irm https://claude.ai/install.ps1 \| iex` / mac・Linux: `curl -fsSL https://claude.ai/install.sh \| bash`）を spawn。失敗時のみ winget / brew / npm にフォールバック | ✓ Anthropic 公式の配布物をそのまま取得・実行 |
| Codex CLIインストール | 公式インストーラ（Win: `irm https://chatgpt.com/codex/install.ps1 \| iex` / 他: `install.sh`）を spawn。失敗時のみ `npm install -g @openai/codex` | ✓ 同上 |
| 多重起動の防止 | `InstallLock`（AtomicBool）で走行中の再入を拒否。UI 側も done イベントまでボタンを無効化 | — インストーラ同士が一時ファイルを取り合う事故（winget の `%TEMP%\WinGet` 競合）を防ぐ |
| Claude ログイン | `claude login` を spawn、stdout から URL 抽出して Tauri shell.open(url) | ✓ CLI 自身が OAuth を処理、UNICREW は token に触れない |
| Codex ログイン | `codex login` を spawn、同様 | ✓ 同上 |
| 完了検知 | 認証ファイル存在チェック（CLI仕様） | - |

UNICREW が OAuth トークンを読む / 保管する / 中継することは**一切しない**。

## 8. 認証モードの再定義

unipilot 旧設計では「OAuth推奨 / API キー fallback」だったが、UNICREW では:

| モード | 説明 | ToS |
|---|---|---|
| **CLI モード（既定）** | CLIが自前でOAuth管理。Pro/Maxサブスクで動く | ✓ exempt |
| **API キーモード（任意）** | `ANTHROPIC_API_KEY` env を CLI subprocess に渡す。CLI は `--bare` フラグで強制APIキー認証 | ✓ |

**OAuth トークンを SDK で使うモードは廃止**。

## 9. ディレクトリ差分（unipilot → unicrew）

```
unipilot/                            unicrew/
├── sidecar/agent.mjs        ✗      （削除）
├── sidecar/codex-agent.mjs  ✗      （削除）
├── sidecar/                 ✗      （削除）
├── package.json: claude-agent-sdk  ─→ 依存削除
├── src-tauri/src/lib.rs              ←─ providers/ にリファクタ
│                                     +  src-tauri/src/providers/mod.rs
│                                     +  src-tauri/src/providers/claude.rs
│                                     +  src-tauri/src/providers/codex.rs
│                                     +  src-tauri/src/providers/types.rs
│                                     +  src-tauri/src/stream_parser.rs
└── components/                ─→     （ほぼそのまま、event型のみ更新）
```

## 10. 段階移行計画

| Phase | 内容 | 状態 |
|---|---|---|
| P0 | unicrew/ 雛形コピー | ✅ |
| P1 | DESIGN.md / AGENTS.md 整備 | 進行中 |
| P2 | SDK 依存の物理削除（sidecar/, package.json） | 未着手 |
| P3 | Provider trait + stream parser（Rust） | 未着手 |
| P4 | claude.rs / codex.rs 実装 | 未着手 |
| P5 | Tauri commands 書き換え（agent_start / agent_send / agent_stop） | 未着手 |
| P6 | React 側のイベント型更新 | 未着手 |
| P7 | E2E 確認（install→login→single→split→conference） | 未着手 |
| P8 | ブランド更新（README / app名 / package名） | 未着手 |

## 11. 法的・運用ガイダンス

- LP / ストア説明文では「Official Claude app」「Powered by Anthropic」等の**提携を匂わす表現禁止**
- About画面に注意書き必須:
  > UNICREW は Anthropic, PBC および OpenAI, Inc. とは無関係の独立したクライアントアプリです。Claude / Anthropic / ChatGPT / Codex / GPT は各社の商標です。
- 「Pro/Max サブスクリプションを使う」と書かない、「公式CLIのログイン状態をそのまま使う」と書く
- 公式ロゴ画像は埋め込まない（テキスト名称＋色＋絵文字のみ）

## 12. 失敗モード

| ケース | 対応 |
|---|---|
| ユーザーが CLIをインストールしていない | UNICREW のインストールガイドカードへ誘導 |
| ユーザーが未ログイン | ログインボタンで `claude login` を spawn、ブラウザを開く |
| stream-json フォーマット変更 | parser を薄く保ち、CLI 更新時の互換テスト CI |
| CLI subprocess hang | `agent_stop` で `child.start_kill()` 明示 kill（unipilot で実証済） |
| 大量並列でリソース枯渇 | provider ごとの最大同時セッション数制限 |
