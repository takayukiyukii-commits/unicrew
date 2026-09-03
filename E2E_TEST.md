# UNICREW E2E 動作確認手順

実装完了後、メンテナが対話的にテストする手順。

## 0. 前提

- `claude` CLI / `codex` CLI がインストール済（`claude --version` / `codex --version` で確認）
- Claude Pro/Max にログイン済（`claude` を起動して `/login` 通過済）

## 1. 開発起動

```powershell
cd <リポジトリのパス>
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

### 添付画像（🚨 2回壊れている箇所）
- [ ] スクリーンショットを Ctrl+V でチャット欄に貼る → サムネイルが出る
- [ ] **画像にしか書いていない文字を AI に読ませる**（例: 適当な英数字を書いた画像を貼って「この画像の文字は？」）
- [ ] AI が正しく答える。**「許可していただければ」「読み取れませんでした」と言ったら不合格**
- [ ] このとき許可ダイアログが出ないこと（画像はメッセージに添えて渡すので、ファイルを開く必要が無い）
- [ ] 画像2枚を同時に貼っても両方読める
- [ ] PDF などの書類添付は従来どおりパスで渡り、AI がファイルを開いて読む

> 🚨 サムネイルが出ることは「AI に見えている」の証拠にならない。
> 画面の見た目と AI が受け取るものは別物で、そのズレで106日間壊れていた。
> **必ず画像の中にしか無い文字を読ませて確かめる。**
> 機械で測るなら `python scripts/verify_image_attachment.py`（`--legacy` で毒味）。

### Codex 経路（🚨 引数1つで起動即死する場所）
- [ ] Codex キャラで「こんにちは」→ 応答が返る
- [ ] **Shift+Tab で Plan モードに切替 → 応答が返る**（旧実装は exit 2 で無言だった）
- [ ] Plan モードでファイル作成を頼む → **作られない**
- [ ] Plan モードのまま2回目を送る（resume 経路）→ 応答が返る
- [ ] Codex キャラに画像を貼る → 画像の中の文字を読める

> 🚨 UNICREW は11個の他社CLIに乗っている。**自社コードを1文字も変えていなくても、
> 相手がフラグを整理した瞬間に壊れる。** 実際 `--ask-for-approval` が消えて
> Plan×Codex は新規・再開の両方で起動即死していた（誰も気づかないまま）。
> 機械で測るなら `python scripts/verify_codex_route.py`（6項目）。

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

### worktree 隔離（v0.4.0・並列/議論モードで AI ごとに作業場を分ける）
- [ ] git 管理下のフォルダを workspace にして「定番3社議論」を開始 → 右ペインの参加者の下に「作業場：AIごとに隔離中（3）」と各AIのブランチ名 `unicrew/<thread8>/<slot>` が出る
- [ ] 各AIに「`hello_<自分の名前>.txt` を作って」と頼む → 親フォルダの `git status` が空のまま（AppData/worktrees 配下にだけファイルができる）
- [ ] 1人分「取り込む」→ 親に変更がステージされ、まだコミットされていない（`git status` で確認）
- [ ] 2人目を同じファイルに違う内容で書かせてから「取り込む」→ 「衝突があるため取り込みを中止」と出て、親の作業ツリーが取り込み前の状態に戻っている（`git status` が空）
- [ ] 「パッチ」→ AppData/patches に `.patch` ができ、トーストにパスが出る
- [ ] スレッドを削除 → `git worktree list` から該当が消え、ブランチは残っている
- [ ] git 管理外のフォルダで並列を始める → 「同じフォルダで実行します」のトーストが**1回だけ**出て、右ペインに「git init する」ボタンが出る → 押すと初期コミットができ、次の送信から隔離される
- [ ] 単独スレッド・plan モード・審判（moderator）では worktree が作られない（右ペインに隔離行が出ない／`git worktree list` が増えない）

> 🚨 git の手順自体は `D:\company\tmp\wt_probe.sh` 相当で毒味済み（2026-09-03）。ここで見るのは「アプリがその手順を正しい順番で呼んでいるか」。

### 変更の差分ビュー（v0.4.0・AI が何を変えたかを一覧と左右比較で見る）
- [ ] git 管理下のフォルダを workspace にして単独スレッドで「`hello.txt` を作って `README.md` の1行目を変えて」と頼む → 応答後、右ペインの「変更 (2)」に `+ hello.txt` と `± README.md` が ±行数つきで並ぶ
- [ ] 行をクリック → エディタウィンドウに「差分: README.md」タブが開き、左が基準・右が今のファイル・**編集できない**（保存ボタンが無効・Ctrl+S が効かない）
- [ ] もう1ターン「`hello.txt` に1行足して」→「このターン」では `hello.txt` だけ、「コミット後すべて」では2件出る（ターン基準が効いている）
- [ ] 送信前後で利用者の `git status` / `git diff --cached` / `git rev-parse HEAD` が変わらない（一時 index しか使っていない）
- [ ] 並列（3社議論）で worktree 隔離中 → 「変更」にプルダウンが出て、参加者を切り替えると各 worktree の変更だけが出る（親フォルダは「変更はありません」）
- [ ] 画像などバイナリを変えさせる → 一覧に「バイナリ」と出て、クリックすると「バイナリファイルのため差分を表示できません」
- [ ] git 管理外のフォルダでは「変更」ブロック自体が出ない（隔離ブロックの「git init する」だけが出る）

> 🚨 git の手順自体は `D:\company\tmp\uc_changes_probe.sh` で毒味済み（2026-09-03：M/D/R/A の検出・ターン基準で絞れる・利用者の index/HEAD 不変・worktree でも同手順）。ここで見るのは「アプリが正しい cwd と基準で呼んでいるか」。

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
