# UNICREW

> AI を動かすことに特化した、マルチ AI デスクトップ。
> サブスクでも、ローカルでも、複数 AI を同時に動かせるランチャー。

**完全無料** で個人利用・商用利用ともに OK。Apache-2.0 ライセンス（[LICENSE](./LICENSE)）。

## 何ができる？

UNICREW は **AI を動かすことだけに特化**したデスクトップアプリです。
コードエディタは VSCode に任せて、AI セッションの起動・並列・切替・可視化を担当します。

- **9 プロバイダ対応** — Claude / Codex / Gemini / Goose / OpenCode / Codex-ACP / Kiro / Qwen / Kimi を同じ UI で
- **議論モード** — 複数の AI に役割を持たせて議論・相互レビュー（7 プリセット）
- **並列モード** — 2 社以上を同時実行、レスポンスを横並びで比較
- **Free モード** — 「1 分で始める」ボタン 1 つで Ollama + OpenCode を自動セットアップ。API キー不要・サブスク不要
- **業界標準 ACP 対応** — Zed Industries 主導の Agent Client Protocol を採用、新エージェントの追加が容易
- **キャラクター人格 12 種** — role / 口調を切替

## 動かす経路は 3 種類

| 経路 | 必要なもの | 月額 |
|---|---|---|
| **完全無料（Free モード）** | Ollama + OpenCode（アプリ内ボタンで自動セットアップ） | 0 円 |
| **サブスク経路** | Claude Pro / Max / ChatGPT Plus / Pro 等の既存契約 | 既存契約のみ |
| **BYOK 経路** | 各プロバイダの API キー（DASHSCOPE / OPENAI / 等） | 従量課金 |

ユーザーは好きな経路を組み合わせて使えます。Claude Pro でメイン会話 + Free モードで並列議論、といった使い方も自然です。

## 設計の核：Pure CLI Conductor

UNICREW は Anthropic / OpenAI / Google / Alibaba / Moonshot AI 等の **公式 CLI を subprocess として spawn する以外の経路を持ちません**。
商用 SDK（`claude-agent-sdk` / `codex-sdk` 等）は import しません。

これは Anthropic ToS（2026-04-04 施行）の条文:

> "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted."

> "For local Claude Code CLI usage on your own computer, nothing changes — it's Anthropic's official product built for scripted and automated use, and the Consumer ToS exempts it from the prohibition on automated access."

に完全準拠するための設計判断です。VSCode の統合ターミナルから `claude` を呼ぶのと同じ法的立ち位置で動作します。

ACP 対応プロバイダ（Goose / OpenCode / Codex-ACP / Kiro / Kimi）は Apache-2.0 / MIT の OSS で、業界標準 ACP プロトコル経由で接続します。

詳細は [DESIGN.md](./DESIGN.md) と [AGENTS.md](./AGENTS.md) を参照。

## アーキテクチャ

```
┌────────────────────────────────────────────────────────┐
│ Tauri 2.x ウィンドウ                                    │
│  ┌──────────────────────────────────────────────┐     │
│  │ Next.js + React UI（チャット / 並列 / 議論）  │     │
│  └────────────────────┬─────────────────────────┘     │
│                       │ invoke / event                   │
│  ┌────────────────────▼─────────────────────────┐     │
│  │ Rust providers/                                │     │
│  │  ├ trait CliProvider                           │     │
│  │  ├ stream-json 経路: claude / codex / gemini   │     │
│  │  │                    qwen                     │     │
│  │  ├ ACP 経路 (acp_transport):                   │     │
│  │  │   goose / opencode / codex_acp /            │     │
│  │  │   kiro / kimi                               │     │
│  │  └ stream_parser.rs                            │     │
│  └────────────────────┬─────────────────────────┘     │
│                       │ stdin / stdout / JSON-RPC        │
│  ┌────────────────────▼─────────────────────────┐     │
│  │ 公式 CLI / OSS エージェント subprocess         │     │
│  │  claude -p --output-format stream-json …      │     │
│  │  codex exec --json …                          │     │
│  │  goose acp / opencode acp / kimi acp …        │     │
│  └───────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────┘
```

## 必要環境

- **OS**: Windows 10 1809+ / Windows 11（macOS / Linux 版は今後対応）
- **AI を動かすために、以下のいずれか 1 つ以上**:
  - Claude Pro / Max のサブスクリプション
  - ChatGPT Plus / Pro のサブスクリプション
  - 任意のプロバイダの API キー
  - Free モード（Ollama + OpenCode、アプリから自動セットアップ可能）

### 開発（ソースから動かす場合）

- **Node.js 18+**
- **Rust（rustup） 1.91.1+**
- **Visual Studio 2022 Build Tools**（Windows・C++ workload 必須）

## 起動

### 配布バイナリ

[Releases](https://github.com/takayukiyukii-commits/unicrew/releases) から最新の `.msi` または `.exe` をダウンロードしてインストール。

⚠️ 未署名のため初回起動時に SmartScreen 警告が出ます。「詳細情報」→「実行」で起動できます。

### 開発起動

```powershell
# 初回のみ
npm install

# 開発起動
npm run tauri:dev
```

初回ビルドは Rust のコンパイルで 5–10 分かかります。

## 配布ビルド

```powershell
npm run tauri:build
```

成果物：
- Windows: `src-tauri/target/release/bundle/msi/UNICREW_*.msi`
- macOS: `src-tauri/target/release/bundle/dmg/UNICREW_*.dmg`

## ディレクトリ構成

```
unicrew/
├── app/                       # Next.js (renderer)
│   ├── page.tsx               # メインシェル
│   ├── editor/                # 別ウィンドウのタブ式エディタ
│   └── globals.css
├── components/
│   ├── Sidebar.tsx
│   ├── ChatPane.tsx
│   ├── SettingsModal.tsx
│   ├── WelcomeLanding.tsx
│   ├── ConferencePresets.tsx  # 議論モードプリセット
│   ├── FreeModeWizard.tsx     # Ollama+OpenCode 自動セットアップ
│   ├── CommandPalette.tsx
│   ├── Walkthrough.tsx
│   ├── WhatsNewModal.tsx
│   └── ...
├── lib/
│   ├── types.ts
│   ├── characters.ts          # プリセット 12 体
│   ├── providerCategories.ts  # UI 抽象化基盤
│   ├── providerVisuals.tsx
│   └── tauri.ts
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs             # Tauri commands
│   │   └── providers/         # CLI subprocess 抽象
│   │       ├── claude.rs / codex.rs / gemini.rs / qwen.rs    (stream-json)
│   │       ├── goose.rs / opencode.rs / codex_acp.rs /        (ACP)
│   │       │   kiro.rs / kimi.rs
│   │       ├── acp_transport.rs
│   │       └── stream_parser.rs
│   └── Cargo.toml
├── THIRD_PARTY_LICENSES/      # OSS NOTICE
├── public/whatsnew/           # What's New ページ
├── LICENSE                    # Apache-2.0
├── NOTICE
├── PRIVACY.md
└── TERMS.md
```

## 使い方フロー

1. アプリ起動 → 「1 分で始める」で **Free モード**を試す（API キー不要）
2. または「Claude / Codex / Gemini のサブスクをお持ちの方」から既存契約で接続
3. **最初の会話を始める** → キャラクター（オプション）→ ワークスペース選択
4. 会話中に「並列モード」「議論モード」へ自然に拡張
5. プリセットから議論を始める：7 種のキャストから 1 クリックで選択

## キャラクター（プリセット 12 体）

| ID | 名前 | 役割 | プロバイダ |
|---|---|---|---|
| tmpl-claude-normal | Claude（normal） | 素の Claude | claude |
| tmpl-codex-normal | Codex（normal） | 素の Codex | codex |
| tmpl-opencode-normal | OpenCode（normal） | 無料・ローカル | opencode |
| tmpl-qwen-normal | Qwen（normal） | コスト・OSS 派 | qwen |
| tmpl-kimi-normal | Kimi（normal） | 長文・自律 | kimi |
| tmpl-auto | おまかせ | 自動切替 | claude |
| tmpl-ceo | CEO | 統括役 | claude |
| tmpl-cdo | CDO | 技術責任者 | claude |
| tmpl-cmo | CMO | マーケ | claude |
| tmpl-cso | CSO | 営業 | claude |
| tmpl-cpo | CPO | プロダクト | claude |
| tmpl-cfo | CFO | 財務 | claude |
| tmpl-secretary | 秘書 | アシスタント | claude |

## トラブルシューティング

- **Rust ビルド時の link.exe エラー** → Visual Studio Build Tools (C++ workload) が必要
- **「next dev server is already running」** → `Get-NetTCPConnection -LocalPort 1420` で確認、`Stop-Process -Id <PID> -Force`
- **Claude CLI が見つからない** → `winget install --id Anthropic.ClaudeCode --accept-source-agreements --accept-package-agreements` または UNICREW 内のインストールボタン
- **認証エラー** → 設定 → 接続状態 → ログイン
- **SmartScreen 警告**（インストール時）→ 詳細情報 → 実行

## ライセンス・法的事項

- 本アプリは **Apache License 2.0** に基づき提供されます（[LICENSE](./LICENSE)、[NOTICE](./NOTICE)）。
- 個人利用・商用利用ともに無料。改変・再配布も Apache-2.0 の範囲で自由です。
- 利用規約: [TERMS.md](./TERMS.md)
- プライバシーポリシー: [PRIVACY.md](./PRIVACY.md)（本アプリはユーザー情報を一切収集しません）

### 商標について

UNICREW は **Anthropic, PBC / OpenAI, Inc. / Google LLC / Alibaba / Moonshot AI / Block, Inc. / sst / Zed Industries / AWS Inc. とは無関係の独立したクライアントアプリ**です。

- Claude / Anthropic は Anthropic, PBC の商標です。
- ChatGPT / Codex / GPT は OpenAI, Inc. の商標です。
- Gemini は Google LLC の商標です。
- Qwen は Alibaba Group の商標です。
- Kimi / Moonshot は Moonshot AI の商標です。
- Goose は Block, Inc. の OSS プロジェクトです。
- OpenCode は sst の OSS プロジェクトです。
- Codex-ACP は Zed Industries, Inc. の OSS プロジェクトです。
- Kiro は AWS / kirodotdev の製品です。
- ACP（Agent Client Protocol）は Zed Industries, Inc. 主導のオープンプロトコルです。

UNICREW は各社のロゴ画像を使用していません（独自ロゴのみ使用）。

---

ZUBOLAND / uniLinks
