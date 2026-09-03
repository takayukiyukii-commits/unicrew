# UNICREW 開発エージェント向けルール

このリポジトリは **UNICREW 配布版**（Pure CLI Conductor 方式）。
Phase 2/3 完成版の `repos/unipilot/` から SDK 経路を全廃した派生で、ToS に完全適合した形で配布する。

## 絶対ルール（順守）

1. **Anthropic / OpenAI 系の商用 SDK を import しない**
   - 禁止: `@anthropic-ai/claude-agent-sdk` / `@anthropic-ai/sdk` / `codex-sdk` / 同等の OAuth トークンを内部で扱う SDK
   - これらは公式 CLI の subprocess spawn 経路だけを使う
   - 該当 SDK は package.json / Cargo.toml の依存からも削除する
2. **OAuth トークン（Anthropic / OpenAI / Google 等の商用サービス）を UNICREW 側で読み取り・保管・中継しない**
   - CLI の login 機能だけを呼び出す。トークンは CLI が自前で `~/.claude/credentials` 等に持つ
3. **公式ロゴ画像（Anthropic / OpenAI / Claude / ChatGPT / Google / Gemini 等）を public/ に置かない**
   - テキスト名称・絵文字・カスタム色のみで識別する
4. **「Official Claude app」「Powered by Anthropic」等の提携訴求を書かない**
   - 各社とは無関係の独立アプリと明記する
5. **OSS エージェント（Apache-2.0 / MIT 系）を内蔵する場合は NOTICE 同梱と About 表記を必須**
   - 詳細は「OSS 統合の4層モデル」節参照

## プロバイダ統合の3層モデル（2026-05-10 採用、調査ノート v2 反映）

UNICREW は候補ごとに以下の層を使い分ける。**業界標準 ACP（Agent Client Protocol）対応** のエージェントは L3 で一気に複数対応。

| 層 | 方式 | 通信プロトコル | 適用条件 | 例 |
|---|---|---|---|---|
| **L1** 外部 CLI subprocess | ユーザーが別途 install、UNICREW は spawn のみ | 各社独自 stream-json | 商用 SDK 禁止対象 / OAuth 絡み | Claude / Codex / Gemini / Antigravity (`agy`) |
| **L2** 自動インストール | UNICREW が初回起動時に裏で `winget` / `npm i -g` 等を実行、以後は subprocess 方式 | 各社独自 stream-json | OSS だが ACP 未対応 | Qwen Code / Kimi |
| **L3** **業界標準 ACP プロトコル経由** | 自動 install + `<agent> acp` を spawn、`agent-client-protocol` crate で型付き JSON-RPC over stdio | **Zed 主導の業界標準 ACP** | **ACP 対応エージェント全般** | **Goose / OpenCode / Codex-acp / Kiro** |

> **L4（Rust crate 内蔵）は採用見送り**: 検討の結果、`goose-sdk` は ACP client であって embed SDK ではないことが判明。本物の embed には goose 本体 crate が必要だが V8 同梱・MSRV 1.91.1 強制・ビルド時間爆発でコスト対価値が悪い。詳細は 社内調査ノート（Goose L4 再評価・2026-05-10） 参照。

### L3 採用の必須条件

- 対象エージェントが `<agent> acp` 等の ACP サブコマンドを実装していること
- `agent-client-protocol` crate（Apache-2.0 / Zed主導、crates.io 公開）を Cargo.toml に追加
- crate のメジャーバージョンを Cargo.toml で固定し、自動更新を防ぐ
- About 画面に "Includes agent-client-protocol (Apache-2.0)" 表記
- リポジトリ直下に `THIRD_PARTY_LICENSES/agent-client-protocol/` で NOTICE / LICENSE 同梱

### L3 採用のメリット

1. **業界標準採用** — Zed エディタと同じプロトコル、ベンダーロックイン無し
2. **型付き JSON-RPC** — stdout 文字列パースのバグ温床ゼロ
3. **permission gate がプロトコル組込み** — UNICREW の `permission_mode` と完全一致
4. **複数エージェント1パスで対応** — Goose / OpenCode / Codex-acp / Kiro が同じコードで動く
5. **将来の拡張性** — 新しい ACP 対応 agent が出てきたら provider ファイル1つ追加するだけ

## やっていいこと

- 公式インストーラ（`irm https://claude.ai/install.ps1 | iex` / `curl -fsSL https://claude.ai/install.sh | bash`）を spawn してインストール手助け。Windows で失敗したときのみ `winget install --id Anthropic.ClaudeCode` にフォールバック
- `claude` / `codex` / `agy` CLI を subprocess として動かす（L1）
- 初回起動時に裏で `winget install OpenCode.OpenCode` 等を実行（L2）
- `agent-client-protocol` crate を Cargo.toml に追加し、ACP 対応エージェントと型付き通信（L3）
- CLI の `--output-format stream-json` の出力を parse して UI 表示
- CLI の `--append-system-prompt` フラグでキャラクター人格を渡す
- CLI の `--allowedTools` / `--permission-mode` で許可制御を渡す
- 複数 subprocess を並列実行（並列モード / 議論モード）

## やってはいけないこと（追記）

- ❌ goose 本体 crate を Cargo.toml に直接追加（V8 同梱でバンドル爆発）
- ❌ ベンダー専用 SDK crate（goose-sdk 等）を介する（業界標準 ACP を直接使えるので不要）
- ❌ ACP プロトコル仕様を独自拡張（互換性壊れる）
- ❌ プロバイダが増えても UI に**プロバイダ毎のセクションをそのまま追加しない**（複雑化禁止、下記原則参照）

## UI 複雑化を避ける5原則（プロバイダ拡張時の絶対遵守）

プロバイダ数が 3 → 10+ に増えるため、UI を**カテゴリ抽象化**で守る。

### 原則1: 「カテゴリ」でまとめ、個別に並べない

UI で見せる単位は **モデルカテゴリ**（Claude系 / OpenAI系 / Google系 / OSS-ローカル系）。プロバイダ実体（claude / goose / opencode 等）は内部実装。

```
[Claude系]   公式Claude / Goose+Claude / Antigravity+Claude
[OpenAI系]   公式Codex / Codex-acp / OpenCode+OpenAI
[Google系]   公式Gemini / Antigravity+Gemini
[OSS-ローカル] OpenCode+Ollama / Qwen / Kimi
```

→ 視覚要素は4色のみ（カテゴリ色）、プロバイダ毎の色定義はしない

### 原則2: WelcomeLanding は「無料モード」を1ボタンで上位提示

初回起動時の status 一覧表示は禁止。「無料で始める」を最大ボタンで上位、既存ユーザー向けは小リンク。

### 原則3: SettingsModal は accordion 化

カテゴリ単位で折りたたみ、デフォルト全閉。バッジで「○件 接続中」のみ常時表示。プロバイダ毎の100行セクションをフラットに並べることを禁止。

### 原則4: 議論モードは「プリセット」最優先

N人から3人選ぶUIは作らない。プリセット5〜6種を並べ、カスタム選択は `<details>` の奥に隠す。

### 原則5: 識別はカテゴリ色 + lucide アイコン + テキストで統一

`PROVIDER_BADGES` の絵文字は廃止。lucide-react アイコン + カテゴリ色の組合せで識別（feedback メモ「絵文字ゼロ・lucide統一」準拠）。

### 守るべき不変量

新プロバイダを追加するとき、以下が破られたら**追加を中止して UI 設計を見直す**:

- WelcomeLanding に新しい行が増えていない
- SettingsModal のスクロール量が増えていない（accordion 折り畳みで吸収）
- ChatPane の色種が4色を超えていない
- 議論モードの UI 操作ステップが増えていない

## 設計方針

詳細は [DESIGN.md](./DESIGN.md) 参照。要点:
- VSCode との差別化軸: **AI を動かすことに特化**（コード編集は外部）
- マルチAI対応の provider 抽象を Rust 側に置く（claude.rs / codex.rs / 将来 gemini.rs）
- React 側は NormalizedEvent を購読する設計（プロバイダ依存を漏らさない）

## 既存 unipilot/ との関係

- `repos/unipilot/` はそのまま温存（Phase 2/3 完成版として別物の位置付け）
- `repos/unicrew/` は配布専用、ToS 完全適合版
- 将来 unipilot/ 側の機能追加があれば、ToS 適合できるものだけ unicrew/ に取り込む

## 開発時の制約

- Windows 11 + PowerShell が想定環境（unipilot から継承）
- `tokio::sync::Mutex` 必須（std版はNG、`!Send` 制約）
- `build_silent_command` の PATHEXT 解決ヘルパは継承（npm.cmd / claude.cmd 対応）
- アバター画像は data URL 方式（Tauri asset protocol 不使用）

## やる前に必ず読む

- DESIGN.md — アーキテクチャ全景
- ../unipilot/ — 旧実装（参考用、コピー元）
- Anthropic ToS の最新版（CLI exempt の文言確認）

