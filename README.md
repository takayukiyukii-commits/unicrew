# UNICREW

> AI を動かすことに特化した、マルチ AI デスクトップ。
> サブスクでも、ローカルでも、複数 AI を同時に動かせるランチャー。

**完全無料** で個人利用・商用利用ともに OK。Apache-2.0 ライセンス（[LICENSE](./LICENSE)）。

## 何ができる？

UNICREW は、AI の社員に仕事を頼む **AIオフィス**と、最大6分割の**ターミナル**を備えたデスクトップアプリです。

- **AIオフィス** — 会社を作り、取りまとめ役に指示を出します。社員1人につきAIセッション1本で仕事を進め、報告・質問・確認・納品をまとめます
- **11 プロバイダ対応** — Claude / Codex / Gemini / Goose / OpenCode / Codex-ACP / Kiro / Qwen / Kimi / Grok / Cursor。社員ごとに使うAI・モデル・仕事のやり方を設定できます
- **会社のひな形5種類・社員の見た目12種類** — 名前・部署・役割を編集でき、自分の画像にも差し替えられます
- **ターミナル連動** — 最大6ペインでCLIを操作。作業や許可待ちをオフィスに表示し、「AI に渡す」で選択した文字を取りまとめ役に送れます
- **RUNner連動（表示のみ）** — このPCにあるRUNnerの記録を読み、作業・返事待ち・完了をオフィスに表示します。指示・承認はUNIHUBで行います
- **確認と納品** — 確認カードから「OKを出す」「差し戻す」を選び、納品欄から成果物を開けます
- **相談の受け箱** — 貼り付けた相談に対する返事の下書きを依頼できます。送信は利用者が行います
- **定期実行** — 毎日の指定時刻に、選択中の会社の取りまとめ役へ指示を渡します（アプリ起動中）
- **過去の会話** — 以前の記録を開いて読めます。会話の再開・追記はできません
- **Free モード** — 「ファイル」→「無料で使えるAIを準備する」からOllama + OpenCodeをセットアップできます
- **業界標準 ACP 対応** — 対応エージェントを共通の通信方式で接続します

従来のチャット画面・並列6ペイン・議論モード・サイドチャット・チェックポイント・タスクキュー・差分ビュー・チャット版の相互監査・キャラクター人格・スラッシュコマンドは廃止しました。ターミナルの6分割は引き続き使えます。

## 動かす経路は 3 種類

| 経路 | 必要なもの | 月額 |
|---|---|---|
| **完全無料（Free モード）** | Ollama + OpenCode（アプリ内ボタンで自動セットアップ） | 0 円 |
| **サブスク経路** | Claude Pro / Max / ChatGPT Plus / Pro 等の既存契約 | 既存契約のみ |
| **BYOK 経路** | 各プロバイダの API キー（DASHSCOPE / OPENAI / 等） | 従量課金 |

利用するCLIの認証・契約に合わせて設定し、社員ごとに使うAIを選べます。

## 設計の核：Pure CLI Conductor

UNICREW は公式CLI・OSSエージェントを subprocess として起動します。
商用SDK（`claude-agent-sdk` / `codex-sdk` 等）は import せず、OAuthトークンの読み取り・保管・中継をしない方針です。ログインは各CLIの機能を使います。

各サービスの利用条件は提供元の規約に従います。[Claude Codeの認証・利用条件](https://code.claude.com/docs/en/legal-and-compliance)と[Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)を参照してください。

ACP 対応プロバイダ（Goose / OpenCode / Codex-ACP / Kiro / Kimi / Grok）は業界標準 ACP プロトコル経由で接続します。

詳細は [DESIGN.md](./DESIGN.md) と [AGENTS.md](./AGENTS.md) を参照。

## アーキテクチャ

```text
Tauri + Next.js / React
  ├─ AIオフィス → 進行役 → 社員ごとのCLIセッション
  │                          ├─ JSON出力: Claude / Codex / Qwen / Cursor
  │                          ├─ テキスト出力: Gemini
  │                          └─ ACP: Goose / OpenCode / Codex-ACP / Kiro / Kimi / Grok
  ├─ ターミナル（最大6分割） → CLIを直接操作 → オフィスに状態を表示
  ├─ RUNnerのローカル記録 → オフィスに状態を表示
  └─ 過去の会話 → 既存の保存を読む
```

## 必要環境

- **OS**: Windows 10 1809+ / Windows 11 / macOS 11+ / Linux（3 OS 分のインストーラーを Releases で配布）
  - macOS は **Safari 15.4 以上**が必要です（UNICREW の画面は Mac に入っている Safari の部品で表示されます）。古い場合は「ソフトウェアアップデート」で Safari か macOS を更新してください。足りないときはアプリが起動時に案内を表示します
- **AI を動かすために、以下のいずれか 1 つ以上**:
  - Claude Pro / Max のサブスクリプション
  - ChatGPT Plus / Pro のサブスクリプション
  - 任意のプロバイダの API キー
  - Free モード（Ollama + OpenCode、アプリから自動セットアップ可能）

### 開発（ソースから動かす場合）

- **Node.js 20.9+**
- **Rust（rustup） 1.91.1+**
- **Visual Studio 2022 Build Tools**（Windows・C++ workload 必須）

## 起動

### 配布バイナリ

[Releases](https://github.com/takayukiyukii-commits/unicrew/releases/latest) から、お使いの OS 向けのファイルをダウンロードしてインストール。

| OS | ファイル |
|---|---|
| Windows | `UNICREW_*_x64-setup.exe` / `UNICREW_*_x64_ja-JP.msi` |
| macOS | `UNICREW_*_universal.dmg` |
| Linux | `UNICREW_*_amd64.AppImage` / `*_amd64.deb` / `*.x86_64.rpm` |

**コード署名の状況**

| OS | 署名 | 初回起動時 |
|---|---|---|
| **Windows** | **ZUBOLAND株式会社名義で署名済み**（v0.2.47〜） | 通常は警告が出ません。出た場合は「詳細情報」→「実行」で、発行元が ZUBOLAND株式会社 であることを確認してください |
| **macOS** | 未署名（Apple Developer Program 未加入のため） | 一度開こうとして警告を閉じたあと、「システム設定」→「プライバシーとセキュリティ」→「このまま開く」（macOS 14 以前はアプリを右クリック →「開く」でも可） |
| **Linux** | 未署名 | AppImage は実行権限を付けてから起動してください（`chmod +x`） |

配布物には Tauri Updater 用の署名ファイル（`.sig`）が付いており、自動更新はこの署名を検証してから適用されます。

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

以下は主要なファイルです。

```text
unicrew/
├── app/
│   ├── page.tsx                  # オフィス・ターミナル・過去の会話の切替
│   ├── editor/                   # 別ウィンドウのエディタ
│   └── preview/                  # 成果物プレビュー
├── components/
│   ├── office/                   # オフィス画面・社員・設定・案件ボード
│   ├── PastConversation.tsx      # 過去の会話（閲覧のみ）
│   ├── TerminalPanes.tsx         # 最大6分割ターミナル
│   ├── InteractiveTerminal.tsx
│   ├── Sidebar.tsx
│   ├── SettingsModal.tsx
│   ├── FreeModeWizard.tsx
│   └── RoutinesModal.tsx
├── lib/
│   ├── office/
│   │   ├── engine.ts             # 仕事の進行
│   │   ├── runner.ts             # CLIとの接続
│   │   ├── protocol.ts           # 取りまとめ役の合図
│   │   ├── templates.ts          # 会社のひな形
│   │   ├── looks.ts              # 社員の見た目
│   │   ├── store.ts              # 会社・現在の仕事の保存
│   │   ├── i18n.ts               # オフィスの日本語・英語
│   │   ├── terminal-link.ts      # ターミナルの作業表示
│   │   └── run-link.ts           # RUNnerの記録を読む
│   ├── storage.ts                # 過去の会話の読込・設定
│   ├── routines.ts               # 毎日の定期実行
│   ├── types.ts
│   └── tauri.ts
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs
│   │   ├── thread_store.rs       # 旧会話ファイルの読込など
│   │   └── providers/            # CLI subprocess / ACP
│   └── Cargo.toml
├── THIRD_PARTY_LICENSES/
├── public/office/                # オフィス・社員の絵
├── public/whatsnew/
├── LICENSE
├── NOTICE
├── PRIVACY.md
└── TERMS.md
```

## 使い方フロー

1. 設定で利用するAI CLIの導入・ログインを確認します。Free モードは「ファイル」→「無料で使えるAIを準備する」から開けます
2. AIオフィスで会社名・ひな形・作業フォルダ・使うAIを選び、「この内容で会社を作る」を押します
3. 「あなた（社長）からの指示」に頼みたい仕事を書きます。取りまとめ役が必要に応じて質問し、社員に仕事を渡します
4. 確認カードが届いたら中身を見て「OKを出す」か、理由を書いて「差し戻す」を選びます
5. 納品欄から成果物を開いて確かめます。ターミナルで直接CLIを操作することもできます

## 会社のひな形と社員

人数は取りまとめ役1人を含みます。部署・社員・仕事のやり方は作成後に変更できます。

| ひな形 | 社員 | 部署 |
|---|---:|---:|
| まずは2人で | 2人 | 1 |
| 会社まるごと（5つの部署） | 11人 | 5 |
| 開発チーム | 5人 | 3 |
| 発信チーム | 5人 | 3 |
| Web制作チーム | 5人 | 2 |

社員の見た目は12種類から選択するか、自分の画像に差し替えます。見た目と役割は別々に設定できます。
社員ごとの「仕事のやり方」はAIへの指示として使われます。旧チャットのキャラクター人格プリセットではありません。

## ターミナル・RUNnerとの連動

ターミナルで Claude Code を動かすと、その作業が、取りまとめ役を除いた社員にペイン番号順で映ります（ほかの AI のターミナルは、いまは映りません）。オフィス自身の仕事で作業中・待機中の社員はそちらを優先します。ターミナルの許可にはターミナル側で答えます。

RUNner連動はローカルの作業記録を読む表示機能です。作業中・返事待ちの仕事があると「UNIHUB で開く」入口が出ます。オフィスからRUNnerに指示や承認を送る機能はありません。

定期実行は毎日指定時刻の指示を、選択中の会社に届けます。アプリ起動中に約60秒ごとに確認し、当日まだ実行していなければ指定時刻を過ぎてからでも届けます。会社・作業フォルダ・取りまとめ役の準備ができていない場合は実行済みになりません。

## トラブルシューティング

- **Rust ビルド時の link.exe エラー** → Visual Studio Build Tools (C++ workload) が必要
- **「next dev server is already running」** → `Get-NetTCPConnection -LocalPort 1420` で確認、`Stop-Process -Id <PID> -Force`
- **Claude CLI が見つからない** → 下の「Claude Code が入らない時」を参照
- **認証エラー** → 設定 → 接続状態 → ログイン
- **SmartScreen 警告**（インストール時）→ 詳細情報 → 実行

### Claude Code が入らない時

UNICREW の「インストール」ボタンは、内部で公式のネイティブインストーラを実行しています。うまくいかない場合は同じことを手で実行してください。

1. UNICREW を閉じる（インストーラを二重に走らせないため）
2. PowerShell を開いて `irm https://claude.ai/install.ps1 | iex`
3. PowerShell を開き直して `claude --version` → バージョンが出れば成功
4. UNICREW を起動すると「インストール済」になります

`winget install --id Anthropic.ClaudeCode` で入れようとして

```
remove: The process cannot access the file because it is being used by another process
```

が出た場合は、winget が二重に走って一時ファイルを取り合っています。**その表示が出ても実際にはインストールが完了していることがあるので、まず `claude --version` を確認してください。** 入っていなければ、

```powershell
Remove-Item "$env:TEMP\WinGet" -Recurse -Force -ErrorAction SilentlyContinue
```

で一時ファイルを消してから 2. をやり直してください。

### Gemini CLI が入らない時

Gemini CLI は npm 配布です。**Node.js（npm）が先に必要**です。

1. `node -v` で確認（出なければ https://nodejs.org からインストール）
2. **Node.js を入れた直後は UNICREW を一度終了して起動し直す**（起動中のアプリは新しい PATH を知らないため）
3. `npm install -g @google/gemini-cli`
4. `gemini --version` で確認

### Codex CLI が入らない時

1. UNICREW を閉じる
2. PowerShell で `irm https://chatgpt.com/codex/install.ps1 | iex`（mac/Linux は `curl -fsSL https://chatgpt.com/codex/install.sh | sh`）
3. `codex --version` で確認

Codex は任意です。使う場合は設定で導入・ログインを確認してください。

## 更新

新しい版が出ると、アプリが **GitHub Releases の `latest.json`** を見て通知します（Tauri Updater）。

- 配布物に付いている **minisign 署名（`.sig`）を検証してから**適用します。署名が合わないものは適用されません
- Windows 版は Authenticode 署名済みの実行ファイルに対して更新署名を作っているため、
  **手元で差し替えたビルドでは更新が通りません**（正規の配布物だけが更新される設計です）

## データはどこに保存されるか

会社の設定と仕事の記録は、このPCのアプリ内に保存されます。AIへの指示は利用するCLIを通じて選択したプロバイダへ送られます。

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\jp.unilinks.unicrew\` |
| macOS | `~/Library/Application Support/jp.unilinks.unicrew/` |
| Linux | `~/.local/share/jp.unilinks.unicrew/` |

- **会社の名簿・選択中の会社・会社ごとの「いま」**：WebViewのlocalStorage（`unicrew.offices.v1` / `unicrew.offices.active.v1` / `unicrew.office.run.v1.<会社ID>`）。書きかけの返事とツールの中身は保存しません
- **アプリ設定・定期実行・表示言語**：localStorage（`unicrew.settings.v2` / `unicrew.routines.v1` / `unicrew.locale`）
- **過去の会話**：上記アプリ専用フォルダの `threads/<id>.json` と、旧localStorageの `unicrew.threads.v2` をその場で読みます。起動時の移行・新規保存・書き戻しはしません。確認して削除した会話だけ元の保存先から消します
- **成果物**：会社で選んだ作業フォルダ。会社を削除しても作業フォルダのファイルは削除しません
- **配布アプリから登録するAPIキー**：OSの資格情報ストア（`src-tauri/src/lib.rs` のkeyring経路）
- **CLIの認証・セッション履歴**：各CLIが管理します。オフィスは再開に使うCLIセッションIDを記録します

- AI との会話は、あなたが選んだプロバイダ（Claude / Codex / ローカルの Ollama など）へ直接送られます。UNICREW を経由して当社に届くことはありません
- Free モード（Ollama）で使う場合、会話はあなたのPCから外に出ません
- 当社へ送るのは、**何台で使われているかを知るための匿名の起動情報だけ**です。設定でオフにできます（[PRIVACY.md](./PRIVACY.md)）

## アンインストール

- **Windows**: 「設定 → アプリ」から削除（msi 版は「プログラムの追加と削除」）
- **macOS**: アプリケーションフォルダから削除
- **Linux**: deb 版は `sudo apt remove <パッケージ名>`（`dpkg -l | grep -i unicrew` で確認）／ AppImage はファイルを削除

上のデータフォルダは残ります。設定やセッション履歴も消したい場合は、手で削除してください。
なお UNICREW がインストールした AI CLI（Claude Code・Ollama など）は**別のソフト**なので、
それぞれの手順でアンインストールしてください。

## よくある質問

<details>
<summary><b>本当に無料ですか？ 何かを買う必要はありますか？</b></summary>

UNICREW 自体は完全無料（Apache-2.0）です。
AI を動かす経路として、①Free モード（Ollama + OpenCode・0円）②既存のサブスク ③APIキー のどれかを選びます。
**Free モードだけなら、1円も払わずに使えます。**
</details>

<details>
<summary><b>VSCode や Cursor の代わりになりますか？</b></summary>

なりません。UNICREW は**コードエディタではなく、AI を動かすことに特化した道具**です。
AIオフィスでの仕事の分担と進行、ターミナルでのCLI操作を中心に使います。ファイルの編集には外部エディタも使えます。
</details>

<details>
<summary><b>会社のコードを触らせても大丈夫ですか？</b></summary>

会話の送り先は、あなたが選んだプロバイダです。UNICREW は中身を預かりません。
外に出したくない場合は Free モード（ローカルの Ollama）を選んでください。
</details>

<details>
<summary><b>黒い画面（ターミナル）は必要ですか？</b></summary>

AIオフィスへの指示は通常の入力欄から送れます。CLIの導入・ログインは設定から行い、CLIを直接操作したい場合はターミナルを使えます。
</details>

<details>
<summary><b>前の会話の続きを書けますか？</b></summary>

過去の会話は読むだけです。「AIオフィスを開く」から新たに指示してください。過去の会話が自動でオフィスの指示に引き継がれることはありません。
</details>

<details>
<summary><b>RUNnerの承認もオフィスでできますか？</b></summary>

できません。オフィスはRUNnerの状態を表示するだけです。「UNIHUB で開く」からRUNnerの画面で指示・承認を行ってください。
</details>

<details>
<summary><b>不具合を見つけた・要望がある</b></summary>

[Issues](https://github.com/takayukiyukii-commits/unicrew/issues) へお願いします。
</details>

## ライセンス・法的事項

- 本アプリは **Apache License 2.0** に基づき提供されます（[LICENSE](./LICENSE)、[NOTICE](./NOTICE)）。
- 個人利用・商用利用ともに無料。改変・再配布も Apache-2.0 の範囲で自由です。
- 利用規約: [TERMS.md](./TERMS.md)
- プライバシーポリシー: [PRIVACY.md](./PRIVACY.md)（会話内容・APIキー・個人情報は一切収集しません。何台で使われているかを知るための匿名の起動情報のみ送信し、設定でオフにできます）

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

## 姉妹製品（ZUBOLAND の無料デスクトップアプリ）

| | 何をするもの | 行き先 |
|---|---|---|
| **KUZIRA** | マーケター特化のセカンドブラウザ。魚拓・タグ検知・競合ウォッチ | [製品ページ](https://zuboland.jp/products/kuzira) |
| **UNICREW** | （このリポジトリ）AIオフィスとターミナルで仕事を進めるワークスペース | [製品ページ](https://zuboland.jp/products/unicrew) |
| **HONJIN** | 事業の今と動きを手元で見る作業台 | [Releases](https://github.com/zuboland/honjin/releases/latest) |

3つとも登録不要・無料で使えます。

## UNIシリーズ

AIから動かせるマーケティングの道具。UNICREW の「機能の追加 → UNI製品MCP一括接続」から
まとめて登録すると、UNICREW 上の AI にこれらの操作を任せられます。

[UNIHUB](https://hub.uni-core.jp) ／ [UNIPOST](https://post.uni-core.jp) ／ [UNISTEP](https://step.uni-core.jp) ／ [UNIREACH](https://reach.uni-core.jp) ／ [UNICORE](https://unilinks.uni-core.jp) ／ [UNIDESK](https://desk.uni-core.jp)

---

ZUBOLAND / uniLinks
