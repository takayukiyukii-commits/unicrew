# UNICREW — AIコーディング用デスクトップアプリ（完全無料・Apache-2.0）

- 配布: GitHub Releases（タグpush→release.ymlで3OS CI・Ed25519署名付き自動更新）
- 構成: Tauri v2 / Next.js / Rust（src-tauri）
- 位置づけ: 完全無料・Apache-2.0 のデスクトップアプリ（課金・アカウント登録なしで全機能が使える）

## この製品特有の地雷・決定事項（事故実績ベース）
- Cargo.lockは必ずコミット（gitignore禁止。CIがフレッシュ解決して上流非互換を掴む）
- 署名鍵（Ed25519）はリポジトリ外のローカル鍵保管場所で管理する。**紛失すると配布済みユーザーの自動更新が永久に停止する**ためバックアップ必須
- 新しいウィンドウを追加したら capabilities/default.json の windows 配列に必ず登録（漏れると該当ウィンドウ内のfs/event全拒否）
- claude CLIのログインは非TTYでprintモード化→portable-ptyで実行（v0.2.32で根治済み）
- IMEカーソルは実カーソル信頼（VS Code方式）。スクレイピング補正はclaude UI刷新で壊れる
- リリース手順: 版数3ファイル更新→タグpush→CI 3OS success確認→Draft/Publish はメンテナが判断
- 🚨 出荷前ゲート: タグを打つ前に `python "D:/company/CDO（技術責任者）/スクリプト/readme_facts_check.py" unicrew` を回し、**ERROR 0** を確認する（公開READMEの署名の記述・対応OS・プロバイダ数が実物と合っているか。2026-08-28に「未署名」「9プロバイダ」の古い記述が前日更新のREADMEに残っていた）
- 🚨 `npm run build:tauri` は前処理で実行中の unicrew.exe を強制終了する（stopDevServers）。アプリを使用中にビルドしないこと（実際に作業中のアプリを落とした事故あり）

## 全社共通（要遵守）
- デプロイとコミットはワンセット（未コミット残し禁止）。git add は個別ファイル指定
- APIキー・秘密は直書き禁止（環境変数参照）。.env* はコミットしない
- 出力は日本語

## クラウドエージェント（Claude Code on the web）
- 環境準備は `.claude/settings.json` の SessionStart フック → `scripts/session-setup.sh`（fresh clone でだけフルインストール。node_modules があるときは触らない＝起動中プロセス保護）
- 合格基準は check.yml と同一の3本：`npx tsc --noEmit -p tsconfig.json` / `npm run lint` / `npm test`
- 🚨 クラウドに出すのは **Next 側のロジックとテストまで**。Tauri の Rust ビルド・署名・公証・実機確認はクラウド不可（CI とローカル）
- 運用ルール: `docs/cloud-agent.md`

<!-- HONJIN:vault-rule -->
@HONJIN.md
<!-- /HONJIN:vault-rule -->
