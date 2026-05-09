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
│  │  │   ├ claude.rs（claude CLI subprocess）     │     │
│  │  │   ├ codex.rs（codex CLI subprocess）       │     │
│  │  │   └ (future) gemini.rs / copilot.rs        │     │
│  │  ├ stream_parser.rs                           │     │
│  │  ├ install.rs（winget / brew 経由）           │     │
│  │  └ keychain.rs（OS Keychain：APIキー任意）   │     │
│  └────────────────────┬─────────────────────────┘     │
│                       │ stdin / stdout                   │
│  ┌────────────────────▼─────────────────────────┐     │
│  │ 公式CLI subprocess（Anthropic / OpenAI 配布）│     │
│  │  ├ claude -p --output-format stream-json …   │     │
│  │  └ codex exec ...                             │     │
│  └───────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────┘
```

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
| Claude CLIインストール | `winget install --id Anthropic.ClaudeCode --accept-source-agreements --accept-package-agreements` を spawn | ✓ Anthropic公式パッケージを Microsoft 公式パッケージマネージャ経由で取得・実行 |
| Codex CLIインストール | `winget install OpenAI.Codex` 等 | ✓ 同上 |
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
