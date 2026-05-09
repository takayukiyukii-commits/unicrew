# UNICREW 開発エージェント向けルール

このリポジトリは **UNICREW 配布版**（Pure CLI Conductor 方式）。
Phase 2/3 完成版の `repos/unipilot/` から SDK 経路を全廃した派生で、ToS に完全適合した形で配布する。

## 絶対ルール（順守）

1. **`@anthropic-ai/claude-agent-sdk` / `@anthropic-ai/sdk` / `codex-sdk` を import しない**
   - 公式 CLI を subprocess として spawn する以外の経路を作らない
   - SDK 系のパッケージは package.json / Cargo.toml の依存からも削除する
2. **OAuth トークンを UNICREW 側で読み取り・保管・中継しない**
   - CLI の login 機能だけを呼び出す。トークンは CLI が自前で `~/.claude/credentials` 等に持つ
3. **公式ロゴ画像（Anthropic / OpenAI / Claude / ChatGPT）を public/ に置かない**
   - テキスト名称・絵文字・カスタム色のみで識別する
4. **「Official Claude app」「Powered by Anthropic」等の提携訴求を書かない**
   - Anthropic / OpenAI とは無関係の独立アプリと明記する

## やっていいこと

- `winget install --id Anthropic.ClaudeCode` を spawn してインストール手助け
- `claude` / `codex` CLI を spawn して subprocess として動かす
- CLI の `--output-format stream-json` の出力を parse して UI 表示
- CLI の `--append-system-prompt` フラグでキャラクター人格を渡す
- CLI の `--allowedTools` / `--permission-mode` で許可制御を渡す
- 複数 subprocess を並列実行（並列モード / 議論モード）

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
