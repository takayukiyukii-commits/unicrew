#!/bin/bash
# セッション開始時の環境準備（ローカル・クラウド共通 / SessionStart フックから呼ばれる）
#
# 目的: Claude Code on the web などのクラウドVM（fresh clone・node_modules 無し）で
#       依存インストールと Next.js の型生成を済ませ、CI と同じ検査が通る状態にする。
# 設計: ローカル（node_modules がある通常セッション）では数秒で素通りする。
#       🚨 起動中のUNICREW/devサーバを壊さないため、node_modules があるときは絶対に触らない。
# 検査: このスクリプト後に check.yml と同じ3本が通ること
#       npx tsc --noEmit -p tsconfig.json / npm run lint / npm test
set -u

cd "$(dirname "$0")/.."

# 1) 依存: node_modules が無いときだけ入れる（ローカルの再インストール事故を避ける）
if [ ! -d node_modules ]; then
  echo "[session-setup] node_modules 無し → npm ci --ignore-scripts"
  npm ci --ignore-scripts || { echo "[session-setup] npm ci 失敗"; exit 0; }
else
  echo "[session-setup] node_modules あり → インストール省略（起動中プロセス保護）"
fi

# 2) Next 16 の生成型: .next/types が無いと「ローカルだけ通る」型エラーになる（check.yml と同じ理由）
if [ ! -d .next/types ]; then
  echo "[session-setup] .next/types 無し → npx next typegen"
  npx next typegen || echo "[session-setup] next typegen 失敗（続行）"
fi

echo "[session-setup] 完了"
exit 0
