# UNICREW

> AI を動かすことに特化した、マルチ AI デスクトップ。
> サブスクでも、ローカルでも、複数 AI を同時に動かせるランチャー。

**完全無料** で個人利用・商用利用ともに OK。Apache-2.0 ライセンス（[LICENSE](./LICENSE)）。

## 何ができる？

UNICREW は **AI を動かすことだけに特化**したデスクトップアプリです。
コードエディタは VSCode に任せて、AI セッションの起動・並列・切替・可視化を担当します。

- **11 プロバイダ対応** — Claude / Codex / Gemini / Goose / OpenCode / Codex-ACP / Kiro / Qwen / Kimi / Grok / Cursor を同じ UI で
- **議論モード** — 複数の AI に役割を持たせて議論・相互レビュー（9 プリセット）
- **並列モード** — 2 社以上を同時実行、レスポンスを横並びで比較
- **Free モード** — 「1 分で始める」ボタン 1 つで Ollama + OpenCode を自動セットアップ。API キー不要・サブスク不要
- **業界標準 ACP 対応** — Zed Industries 主導の Agent Client Protocol を採用、新エージェントの追加が容易
- **キャラクター人格 13 種** — role / 口調を切替

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

- **OS**: Windows 10 1809+ / Windows 11 / macOS / Linux（3 OS 分のインストーラーを Releases で配布）
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
| **macOS** | 未署名（Apple Developer Program 未加入のため） | Gatekeeper → アプリを右クリック →「開く」 |
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
│   ├── characters.ts          # プリセット 13 体
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
5. プリセットから議論を始める：9 種のキャストから 1 クリックで選択

## キャラクター（プリセット 13 体）

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

Codex は任意です。使わない場合は初期セットアップでスキップして構いません。

## 更新

新しい版が出ると、アプリが **GitHub Releases の `latest.json`** を見て通知します（Tauri Updater）。

- 配布物に付いている **minisign 署名（`.sig`）を検証してから**適用します。署名が合わないものは適用されません
- Windows 版は Authenticode 署名済みの実行ファイルに対して更新署名を作っているため、
  **手元で差し替えたビルドでは更新が通りません**（正規の配布物だけが更新される設計です）

## データはどこに保存されるか

**すべてあなたのPCの中だけです。** 会話内容・APIキー・個人情報は外部に送信しません。

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\jp.unilinks.unicrew\` |
| macOS | `~/Library/Application Support/jp.unilinks.unicrew/` |
| Linux | `~/.local/share/jp.unilinks.unicrew/` |

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
編集は VSCode などに任せて、AI セッションの起動・並列・切替・可視化を UNICREW が担当します。
</details>

<details>
<summary><b>会社のコードを触らせても大丈夫ですか？</b></summary>

会話の送り先は、あなたが選んだプロバイダです。UNICREW は中身を預かりません。
外に出したくない場合は Free モード（ローカルの Ollama）を選んでください。
</details>

<details>
<summary><b>黒い画面（ターミナル）は必要ですか？</b></summary>

不要です。AI CLI の導入もアプリ内のボタンから行えます。
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
| **UNICREW** | （このリポジトリ）複数のAIと議論しながら作業を進めるAIチーム型ワークスペース | [製品ページ](https://zuboland.jp/products/unicrew) |
| **HONJIN** | 事業の今と動きを手元で見る作業台 | [Releases](https://github.com/zuboland/honjin/releases/latest) |

3つとも登録不要・無料で使えます。

## UNIシリーズ

AIから動かせるマーケティングの道具。UNICREW の「機能の追加 → UNI製品MCP一括接続」から
まとめて登録すると、UNICREW 上の AI にこれらの操作を任せられます。

[UNIHUB](https://hub.uni-core.jp) ／ [UNIPOST](https://post.uni-core.jp) ／ [UNISTEP](https://step.uni-core.jp) ／ [UNIREACH](https://reach.uni-core.jp) ／ [UNICORE](https://unilinks.uni-core.jp) ／ [UNIDESK](https://desk.uni-core.jp)

---

ZUBOLAND / uniLinks
