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
- リリース手順: 版数は package.json を正本に**7か所**（package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json / src-tauri/Cargo.lock / package-lock.json / lib/whatsnew.ts の fallback / next.config.ts は package.json を読む実装のまま）＋ `public/whatsnew/<version>.md` を用意（ロック2本は `cargo check` と `npm install --ignore-scripts --no-audit --no-fund` で同期する。`npm version` は使わない＝勝手にタグを切る）→ **`python scripts/verify_version_sync.py` が ERROR 0**（`--selftest` で毒味可・check.yml でも走る）→タグpush→CI 3OS success確認→Draft/Publish はメンテナが判断
- 🚨 版数の告知は「更新したか」ではなく「機械が止めるか」で守る。2026-09-03 実測＝`lib/whatsnew.ts` が 0.3.2 のまま 0.3.7 まで5版出荷され、利用者に What's New が一度も出ていなかった（人が守る「版数3ファイル更新」は守られなかった）
- 🚨 出荷前ゲート: タグを打つ前に、公開READMEの記述が実物と合っているかを機械照合する（署名の記述・対応OS・プロバイダ数）。**ERROR 0 を確認してからタグを打つ**。2026-08-28に「未署名」「9プロバイダ」の古い記述が、前日に更新したREADMEに残っていた（実際は Windows 署名済み・11プロバイダ）
- 🚨 他社CLIの引数を触ったら `python scripts/verify_codex_route.py` を通す（6項目・全組み合わせを実際に起動する）。**自社コードを1文字も変えていなくても、相手がフラグを整理した瞬間に壊れる**。2026-09-01 実測＝`codex exec --ask-for-approval` が消えており、**Planモード×Codexは新規・再開の両方で exit code 2 の起動即死**だった（UIからは「応答が来ない」としか見えない）。`codex exec` と `codex exec resume` で使えるフラグが違う（`-C` `-s/--sandbox` は resume に無い／`-c` `-i/--image` は両方にある）
- 🚨 AI へ渡す本文に **CLI 固有の道具名（`Read` 等）を書かない**。UNICREW は11プロバイダを載せていて `Read` を持つのは Claude Code だけ。※「だから他経路では必ず失敗する」は**誤り**（2026-09-01 実測で否定＝codex 0.150.1 は誤った道具名を無視して正答した）。書かない理由は「壊れるから」ではなく「モデルの気の利きに寄りかからないため」
- 🚨 `npm run build:tauri` は前処理で実行中の unicrew.exe を強制終了する（stopDevServers）。アプリを使用中にビルドしないこと（実際に作業中のアプリを落とした事故あり）
- 🚨 過去の会話は `lib/storage.ts` がアプリ専用フォルダの `threads/<id>.json` と旧localStorageをその場で読む。起動時のファイル移行・新規保存・書き戻しはしない。削除は利用者が確認した会話だけ。AIオフィスの会社と「いま」は `lib/office/store.ts` がlocalStorageへ保存する。**開発版と配布版は同じidentifierで保存先を共有するため、保存・削除の検証には使い捨て環境を使う**

## 現行の画面と仕事の進行

- `app/page.tsx` はAIオフィス・最大6分割ターミナル・過去の会話（閲覧のみ）を切り替える
- `lib/office/engine.ts` は状態と出来事、呼び出し側が渡す表示言語から次の状態とeffectsを返す。画面・localStorageには触れない
- `lib/office/runner.ts` は社員1人につきCLIセッション1本を管理。`protocol.ts` の日本語の合図とAI向け指示は表示言語に合わせて変更しない
- `terminal-link.ts` はターミナルの状態を表示用に運ぶ。`run-link.ts` はRUNnerの記録を読むだけで、指示・承認はUNIHUBで行う
- 定期実行の指示は `boss-bus.ts` を通して選択中の会社の取りまとめ役へ届ける
- 旧チャットの並列・議論・サイドチャット・チェックポイント・タスクキュー・差分・相互監査・キャラクター人格・スラッシュコマンドは廃止。旧画面の手順を復活させない

## 共通ルール（要遵守）
- デプロイとコミットはワンセット（未コミット残し禁止）。git add は個別ファイル指定
- APIキー・秘密は直書き禁止（環境変数参照）。.env* はコミットしない
- 出力は日本語

## クラウドエージェント（Claude Code on the web）
- 環境準備は `.claude/settings.json` の SessionStart フック → `scripts/session-setup.sh`（fresh clone でだけフルインストール。node_modules があるときは触らない＝起動中プロセス保護）
- 合格基準は check.yml と同一の3本：`npx tsc --noEmit -p tsconfig.json` / `npm run lint` / `npm test`
- 🚨 クラウドに出すのは **Next 側のロジックとテストまで**。Tauri の Rust ビルド・署名・公証・実機確認はクラウド不可（CI とローカル）
- 運用ルール: `docs/cloud-agent.md`

