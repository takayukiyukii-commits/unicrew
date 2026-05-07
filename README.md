# UNICREW

> Claudeを誰でも、5分で。
> ローカルファイルを開いて、会話しながら開発・編集ができるClaudeデスクトップアプリ。

## アーキテクチャ

```
┌────────────────────────────────────────────────────┐
│  Tauri 2 ウィンドウ                                │
│  ┌────────────────────────────────────────────┐    │
│  │  Next.js 16 + React 19（renderer / SPA）   │    │
│  │  - 3ペインUI（スレッド／チャット／キャラ） │    │
│  └─────────────┬──────────────────────────────┘    │
│                │ invoke / event                     │
│  ┌─────────────▼──────────────────────────────┐    │
│  │  Rust main プロセス                        │    │
│  │  - OS Keychain（APIキー保管）              │    │
│  │  - Claude Code 検出 / ログイン起動         │    │
│  │  - Node sidecar の spawn と stdin/stdout   │    │
│  └─────────────┬──────────────────────────────┘    │
│                │ stdio JSON-lines                   │
│  ┌─────────────▼──────────────────────────────┐    │
│  │  Node sidecar (sidecar/agent.mjs)          │    │
│  │  - @anthropic-ai/claude-agent-sdk          │    │
│  │  - Claude Code 相当のtool use loop         │    │
│  │  - canUseTool で UI 経由の許可UX           │    │
│  └────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────┘
```

## 認証モード

| モード | 概要 | 想定ユーザー |
|---|---|---|
| **Claude Pro/Max でログイン**（推奨） | Claude Code CLI の OAuth で claude.ai にログイン → 既存サブスクリプションで動作 | 一般ユーザー（追加課金なし） |
| **API キーで使う** | Anthropic API キーを OS Keychain に保管 → 従量課金 | 組織アカウント・チーム |

サブスクリプションモードでは Sidecar に `ANTHROPIC_API_KEY` を渡さないため、SDK は Claude Code CLI の OAuth トークンを自動で使います。

## 必要環境

- **Node.js 18+**
- **Rust（rustup） 1.77+**
- **Visual Studio 2022 Build Tools**（Windows・C++ workload 必須）
- **Claude Code (CLI)**：サブスクリプションモード用。`winget install Anthropic.ClaudeCode` または `npm install -g @anthropic-ai/claude-code`

## 起動

```powershell
# 初回のみ
npm install
cd sidecar; npm install; cd ..

# デスクトップアプリ起動
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

コード署名（EV証明書 / Apple Developer ID）は別途設定。

## ディレクトリ構成

```
unipilot/
├── app/                      # Next.js (renderer)
│   ├── layout.tsx
│   ├── page.tsx              # メインシェル
│   └── globals.css
├── components/
│   ├── Sidebar.tsx           # スレッド一覧
│   ├── ChatPane.tsx          # チャット本体
│   ├── MessageItem.tsx       # メッセージ1件
│   ├── ToolUseBubble.tsx     # ツール実行表示
│   ├── PermissionPromptModal.tsx  # 許可確認
│   ├── RightPane.tsx         # キャラ＋モデル
│   ├── SettingsModal.tsx     # 認証設定
│   ├── CharacterPickerModal.tsx
│   └── WorkspaceTree.tsx     # ファイルツリー（Phase 2）
├── lib/
│   ├── types.ts              # Block/Thread/Character/AuthMode
│   ├── characters.ts         # プリセット6体
│   ├── storage.ts            # localStorage CRUD（→ Tauri Store移行予定）
│   └── tauri.ts              # Tauri invoke / event 橋渡し
├── sidecar/
│   ├── agent.mjs             # Claude Agent SDK loop
│   └── package.json          # SDK依存
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs            # Tauri commands & sidecar管理
│   ├── capabilities/default.json
│   ├── icons/                # 暫定アイコン (scripts/generate_icons.py)
│   ├── Cargo.toml
│   └── tauri.conf.json
└── scripts/generate_icons.py
```

## 使い方フロー

1. **設定** → 認証方法を選ぶ（推奨：Claude Pro/Max）
2. （初回）Claude Code が未インストールならインストールボタン → ログインボタン
3. **新しい会話** → キャラクター選択 → ワークスペースフォルダ選択
4. メッセージ送信 → エージェントがツールを使うとき**許可ダイアログ**が出る
5. 許可 → ファイル編集／コマンド実行が走り、結果が表示される

## キャラクター（プリセット6体）

| ID | 名前 | 役割 | デフォルトモデル |
|---|---|---|---|
| preset-cdo | CDO 桐生 | 技術責任者 | Opus 4.7 |
| preset-cmo | CMO 早瀬 | マーケ責任者 | Sonnet 4.6 |
| preset-cso | CSO 影山 | 営業責任者 | Sonnet 4.6 |
| preset-cpo | CPO 御影 | プロダクト責任者 | Opus 4.7 |
| preset-cfo | CFO 水原 | 財務責任者 | Sonnet 4.6 |
| preset-secretary | 秘書 ミナ | アシスタント | Haiku 4.5 |

カスタムキャラクター作成は次フェーズ。

## ロードマップ

| 時期 | マイルストーン |
|---|---|
| 2026-05-15 | MVP α（マルチスレッド + Agent SDK + キャラ6体 + 許可UX） |
| 2026-05-31 | カスタムキャラ作成 + アバター生成 + Setup Wizard |
| 2026-06-15 | MCP/スキル 1クリック追加UI |
| 2026-06-30 | Closed β（uniLinks受講生100名） |
| 2026-07-31 | 一般公開（Free + Pro） |

## トラブルシューティング

- **Rust ビルド時の link.exe エラー** → Visual Studio Build Tools (C++ workload) が必要
- **「next dev server is already running」** → `Get-NetTCPConnection -LocalPort 1420` で確認、`Stop-Process -Id <PID> -Force`
- **Sidecar が落ちる** → Node.js が PATH に通っているか確認。Tauri は `node` コマンドで spawn する
- **認証エラー** → 設定 → Claude Code 接続状態 → ログイン

## 注意事項

- このリポジトリは OneDrive 外（`C:/Users/takay/repos/unipilot`）
- APIキーは OS Keychain（Windows: Credential Manager）に保管
- スキル・MCP・Skills は Claude Agent SDK の `settingSources: ["user", "project"]` で読み込まれる
- UNIシリーズ統一：白基調ライトテーマ
