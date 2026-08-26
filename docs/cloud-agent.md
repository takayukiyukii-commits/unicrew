# クラウドエージェント運用（Claude Code on the web）— UNICREW

> 2026-08-27 制定。unichat に続く2本目。参考: https://code.claude.com/docs/en/cloud-environments
> 会社方針: クラウドに出すのは「本番キーの要らない改修」だけ。8割クラウド化は目標にしない（効果は測っていない）。

## 仕組み（このリポジトリ側の準備＝コミット済み）

- クラウドVM = Ubuntu 24.04 / Node 20・21・22 プリインストール / fresh clone
- `.claude/settings.json` の **SessionStart フック**が `scripts/session-setup.sh` を実行
  - node_modules 無し（＝クラウド）→ `npm ci --ignore-scripts` + `npx next typegen`
  - node_modules あり（＝ローカル）→ 素通り。**起動中の UNICREW / dev サーバを壊さないため、既存の node_modules には触らない**
- 合格基準は CI（`.github/workflows/check.yml`）と同一の3本
  ```bash
  npx tsc --noEmit -p tsconfig.json   # 必須
  npm run lint --silent               # 必須
  npm test --silent                   # 必須（vitest）
  ```

## 🚨 UNICREW 固有の境界線（unichat と違う点）

UNICREW は **Tauri デスクトップアプリ**。クラウドVM（Ubuntu）では本体の出荷物を作れません。

| クラウドに出してよい | 出さない（ローカル / CI） |
|---|---|
| `app/` `components/` `lib/` のロジック修正 | `src-tauri/` の Rust ビルド（`npm run tauri:build`） |
| vitest のテスト追加・修正 | Windows 署名（Azure Trusted Signing・CI の release.yml） |
| 型エラー修正・リファクタ・依存更新 | macOS 公証・Linux AppImage/deb ビルド（CI） |
| 同型バグの横展開 grep 修正 | 実機での起動確認・CLI（claude/codex）の subprocess 動作確認 |
| ドキュメント整備 | 更新導線・インストーラの実機検証 |

つまり **「Next 側のロジックとテストまで」がクラウドの守備範囲**。ビルドと署名と実機は今までどおり CI とローカルで行う。

## 初回だけ必要な操作

1. https://claude.ai/code で GitHub 連携（または `/web-setup`）
2. リポジトリ選択に `unicrew` を選ぶ
3. 環境は **Default（Trusted ネットワーク）のままで良い**
4. 🚨 環境変数欄・Setup script 欄に **APIキーを入れない**（秘密ストア未提供＝環境利用者全員に見える）

## 使い方（ローカルから投げる）

```bash
# 計画をローカルで作る（コードを編集しない）
claude --permission-mode plan
# 計画をコミットしてからクラウドで実行
claude --cloud "docs/xxx-plan.md の計画を実行して。終わったら tsc / lint / test の3本を通してPRを作る"
```

## 掟

- PR には検査結果（tsc / lint / test）を貼る。**動作を証明せずに完了にしない**
- クラウドの成果は必ず **ブランチ + PR** で受ける（main は公開リポの既定ブランチ・リリースタグの土台）
- **UNICREW は public リポジトリ**。社内の固有名詞・未公開情報・キーをコミットしない
- `.env*` はコミットしない・クラウドに運ばない（keyfinder/envload の原則どおり、値は運ばない）
