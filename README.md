# UNICREW

> AIを動かすことに特化した、マルチAIデスクトップ。
> Claude / Codex / 将来のGemini を、ターミナルなしで束ねる。

## 何をする？

UNICREW は **AI を動かすことだけに特化** したデスクトップアプリです。
コードエディタはVSCodeに任せて、AI セッションの起動・並列・切替・可視化を担当します。

- Claude Pro/Max / ChatGPT Plus・Pro のサブスクリプションで動く（追加課金なし）
- Claude × Codex を **並列モード** で同時実行、**議論モード** で互いに評価し合わせる
- キャラクター人格12種で role/口調を切替
- ツール使用ログをチャットに自然に挿入する Activity Panel

## 設計の核：Pure CLI Conductor

UNICREW は Anthropic / OpenAI の **公式 CLI を subprocess として spawn する以外の経路を持ちません**。
SDK（`claude-agent-sdk` / `codex-sdk`）は import しません。

これは Anthropic ToS（2026-04-04 施行）の条文:

> "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted."

> "For local Claude Code CLI usage on your own computer, nothing changes — it's Anthropic's official product built for scripted and automated use, and the Consumer ToS exempts it from the prohibition on automated access."

に完全準拠するための設計判断です。VSCode の統合ターミナルから `claude` を呼ぶのと同じ法的立ち位置で動作します。

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
│  │  ├ claude.rs（claude CLI subprocess）          │     │
│  │  ├ codex.rs（codex CLI subprocess）            │     │
│  │  └ stream_parser.rs                            │     │
│  └────────────────────┬─────────────────────────┘     │
│                       │ stdin / stdout                   │
│  ┌────────────────────▼─────────────────────────┐     │
│  │ 公式 CLI subprocess                            │     │
│  │  claude -p --output-format stream-json …      │     │
│  │  codex exec --json …                          │     │
│  └───────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────┘
```

## 必要環境

- **Node.js 18+**
- **Rust（rustup） 1.77+**
- **Visual Studio 2022 Build Tools**（Windows・C++ workload 必須）
- **Claude Code CLI**：`winget install --id Anthropic.ClaudeCode` または UNICREW 内のインストールボタン
- **Codex CLI**（任意）：`npm install -g @openai/codex` または UNICREW 内のインストールボタン

## 起動

```powershell
# 初回のみ
npm install

# 開発起動
npm run tauri:dev
```

初回ビルドは Rust のコンパイルで5-10分かかります。

## 配布ビルド

```powershell
npm run tauri:build
```

成果物：
- Windows: `src-tauri/target/release/bundle/msi/UNICREW_*.msi`
- macOS: `src-tauri/target/release/bundle/dmg/UNICREW_*.dmg`

コード署名は ZUBOLAND法人登記後に EV証明書 / Apple Developer ID で実装予定。

## ディレクトリ構成

```
unicrew/
├── app/                       # Next.js (renderer)
│   ├── layout.tsx
│   ├── page.tsx               # メインシェル
│   └── globals.css
├── components/
│   ├── Sidebar.tsx            # スレッド一覧
│   ├── ChatPane.tsx           # チャット本体
│   ├── MessageItem.tsx
│   ├── ToolUseBubble.tsx      # ツール実行表示
│   ├── ActivityPanel.tsx      # 折り畳みアクティビティログ
│   ├── RightPane.tsx          # キャラ＋モデル
│   ├── SettingsModal.tsx
│   ├── WelcomeLanding.tsx
│   └── ...
├── lib/
│   ├── types.ts
│   ├── characters.ts          # プリセット8体
│   ├── personalities.ts       # 人格12種
│   ├── storage.ts             # localStorage / Tauri Store
│   └── tauri.ts               # invoke / event 橋渡し
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs             # Tauri commands
│   │   └── providers/         # CLI subprocess 抽象（Pure CLI Conductor）
│   │       ├── mod.rs
│   │       ├── types.rs
│   │       ├── stream_parser.rs
│   │       ├── claude.rs
│   │       └── codex.rs
│   ├── capabilities/default.json
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
└── public/brand/              # UNICREW 独自ブランド資産
```

## 使い方フロー

1. **設定** → CLI のインストール状態を確認
2. （初回）Claude Code が未インストールならインストールボタン → ログインボタン
3. **最初の会話を始める** → キャラクター（オプション）→ ワークスペース（自動）
4. メッセージ送信 → CLI が tool 使うときは `--permission-mode acceptEdits` で自動承認

## キャラクター（プリセット8体）

| ID | 名前 | 役割 | デフォルトモデル |
|---|---|---|---|
| tmpl-auto | おまかせ | 自動切替 | sonnet |
| tmpl-ceo | CEO | 統括役 | opus |
| preset-cdo | CDO | 技術責任者 | opus |
| preset-cmo | CMO | マーケ | sonnet |
| preset-cso | CSO | 営業 | sonnet |
| preset-cpo | CPO | プロダクト | opus |
| preset-cfo | CFO | 財務 | sonnet |
| preset-secretary | 秘書 | アシスタント | haiku |

## トラブルシューティング

- **Rust ビルド時の link.exe エラー** → Visual Studio Build Tools (C++ workload) が必要
- **「next dev server is already running」** → `Get-NetTCPConnection -LocalPort 1420` で確認、`Stop-Process -Id <PID> -Force`
- **Claude CLI が見つからない** → `winget install --id Anthropic.ClaudeCode --accept-source-agreements --accept-package-agreements` または UNICREW 内のインストールボタン
- **認証エラー** → 設定 → 接続状態 → ログイン

## 法的注意事項

- **UNICREW は Anthropic, PBC および OpenAI, Inc. とは無関係の独立したクライアントアプリです。**
- Claude / Anthropic は Anthropic, PBC の商標です。
- ChatGPT / Codex / GPT は OpenAI, Inc. の商標です。
- UNICREW は公式 CLI を subprocess として呼び出すランチャーであり、Anthropic / OpenAI の OAuth トークンを直接読み書きしません。
- ロゴ画像は UNICREW 独自のもののみ使用。Anthropic / OpenAI のロゴ画像は使用していません。
