# UNICREW E2E 動作確認手順

実装完了後、結城さん側で対話的にテストする手順。

## 0. 前提

- `claude` CLI / `codex` CLI がインストール済（`claude --version` / `codex --version` で確認）
- Claude Pro/Max にログイン済（`claude` を起動して `/login` 通過済）

## 1. 開発起動

```powershell
cd C:\Users\takay\repos\unicrew
npm run tauri:dev
```

初回は Rust 依存のコンパイルで5-10分。2回目以降は数十秒。

## 2. 確認チェックリスト

### Single mode（既定）
- [ ] WelcomeLanding が表示される
- [ ] 「最初の会話を始める」をクリック → スレッド作成
- [ ] チャット入力で「こんにちは」送信
- [ ] Claude が応答（assistant_text イベント受信）
- [ ] 思考時間 / トークン数のメトリクス表示
- [ ] ファイル編集を依頼 → tool_use バブル表示 → tool_result 表示

### キャラクター切替
- [ ] RightPane でキャラを切替
- [ ] systemPrompt が `--append-system-prompt` で渡って人格が変わる

### Split mode
- [ ] ChatPane ヘッダーの `Columns2` ボタンで分割
- [ ] 左 Claude、右 Codex（または逆）で同じメッセージを並列送信
- [ ] 両方から並列で応答が流れる

### Conference mode
- [ ] 議論モードに切替
- [ ] 1メッセージ送信で 2 AI が交互に評価し合う
- [ ] `[合意]` で終了 or 上限ラウンドで停止

### 停止
- [ ] `Esc` で停止 → subprocess が即座に kill
- [ ] `Ctrl+Shift+C` で全スレッド一斉停止

### インストール / ログインフロー
- [ ] Claude CLI 未インストール状態でアプリ起動 → 設定の Claude セクションで「インストール」ボタン → winget が裏で走る → 完了通知
- [ ] 未ログイン → 「ログイン」ボタン → ブラウザが開く → CLI が trust dialog を出さない（`-p` モード）

### ToS適合確認
- [ ] About セクションに「Anthropic / OpenAI とは無関係」表示
- [ ] サブスクリプションモード時、`process.env` に `ANTHROPIC_API_KEY` が **設定されていない** ことを確認（Tauri devtools の Network パネルで claude CLI の env を見る）
- [ ] Sidebar / 設定画面に Anthropic / OpenAI の公式ロゴ画像が**1つも無い**こと

## 3. 失敗パターン

| 症状 | 対処 |
|---|---|
| `claude CLI を起動できませんでした` | `claude --version` で PATH 確認、未インストールなら winget |
| stream-json パースエラー | Claude CLI のバージョンを 2.x 系に更新（`claude --version`） |
| 応答が来ない（CLI が hang） | `Esc` で停止、`Activity Panel` の stderr を確認 |
| Codex `session not found` | `codex login` 済か確認、`codex exec` を直接ターミナルで叩いてみる |

## 4. 配布前の最終確認

```powershell
npm run tauri:build
```

成果物: `src-tauri/target/release/bundle/msi/UNICREW_*.msi`

MSI を別マシン（Claude/Codex 未インストール）にインストール → UNICREW 内のインストールボタンで CLI 自動セットアップ → ログイン → 会話までを確認。
