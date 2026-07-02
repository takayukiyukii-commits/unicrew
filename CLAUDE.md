# UNICREW — AIコーディング用デスクトップアプリ（完全無料・Apache-2.0・集客フロント）

- 配布: GitHub Releases（タグpush→release.ymlで3OS CI・Ed25519署名付き自動更新）
- 構成: Tauri v2 / Next.js / Rust（src-tauri）
- 位置づけ: 販売シリーズ外の無料製品。主力7製品の集客フロント

## この製品特有の地雷・決定事項（事故実績ベース）
- Cargo.lockは必ずコミット（gitignore禁止。CIがフレッシュ解決して上流非互換を掴む）
- 署名鍵: D:/secrets/tauri-signing/unicrew.key。紛失すると配布済みユーザーの自動更新が永久停止
- 新しいウィンドウを追加したら capabilities/default.json の windows 配列に必ず登録（漏れると該当ウィンドウ内のfs/event全拒否）
- claude CLIのログインは非TTYでprintモード化→portable-ptyで実行（v0.2.32で根治済み）
- IMEカーソルは実カーソル信頼（VS Code方式）。スクレイピング補正はclaude UI刷新で壊れる
- リリース手順: 版数3ファイル更新→タグpush→CI 3OS success確認→Draft/Publish判断は結城さん
- 2026-07-02時点で未push2コミットあり（push判断は結城さん）

## 全社共通（要遵守）
- DB変更は手動SQL運用：SQLファイルの絶対パスを1行ずつ提示し、結城さんがSupabase SQL Editorで実行
- デプロイとコミットはワンセット（未コミット残し禁止）。git add は個別ファイル指定
- APIキー・秘密は直書き禁止（環境変数参照）。.env* はコミットしない
- 出力は日本語。会社ルール正本は D:/company/CLAUDE.md
