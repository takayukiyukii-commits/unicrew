# AI共有ステータス（Claude × Codex）

> このファイルは**ClaudeとCodexの両方が読み書きする正本**。短く・構造化・常に最新。
> 自由記述は禁止。各セクションのフォーマットを守る。
> 詳細議事録は `session_state.md`、決定履歴は `decision_log.md` を参照。

**最終更新**: 2026-06-15 02:10 JST / 更新者: Claude / 状態: DONE（要・実機クリック確認）

> ### Stale判定ルール
> - 24時間以上経過で **STALE 扱い**
> - 完了タスクは `decision_log.md` に流して本ファイルは新作業で上書き

---

## 現在の作業
**UNICREW 初心者向けプレビュー/リンク導線の連続バグを根治（v0.2.31 → v0.2.34）**。インストール済み・起動稼働中（PID更新済・Ver 0.2.34）。リリース（タグpush/公開）は**未実施**＝ローカル検証段階。

### 本セッションで直した4件（症状 → 根本原因 → 修正）
1. **Claudeログインが必ず失敗（v0.2.32 / c6097da）**
   現行 claude CLI は非TTYだと print モード化し対話ログイン不発 → 初回ユーザー全員「ログインに失敗しました」。`claude auth login --claudeai` を portable-pty で実行＋`auth status --json` 判定に刷新。
2. **初心者画面のプレビューが開かない（v0.2.32 / 56703ab・Codex Opus 4.8）**
   `preview` ウィンドウが `capabilities/default.json` の windows 配列に未登録 → preview 窓内で fs/event IPC 全拒否。`"preview"` 追加＋画像用 `fs:allow-read-file` 追加。
3. **リンク更新→再クリックで変わらない（v0.2.33 / 2390978）**
   PreviewWindow が navigate 受信時に reloadKey を進めず、iframe の src/srcDoc 同値で React が再読込しない。navigate で `setReloadKey` 強制リマウント＋送信側 `emit`→`emitTo(previewラベル)`。
4. **本文のプレビュー/画像リンクが全部クリックできない（v0.2.34 / 9c37471）★今回の主訴**
   MessageItem の ReactMarkdown renderers に `a` ハンドラが無く、`[ラベル](先)` が素の `<a>` 化 → Tauri webview でナビゲーション沈黙（plain-text linkify は Ctrl+Click 前提で初心者に届かない）。`lib/preview.ts` に純関数 `classifyMarkdownLink` 追加、`a` レンダラ(MarkdownLink)で通常クリック配線（ローカル画像/HTML→プレビュー窓、localhost→プレビュー窓、外部→既定アプリ）。

## 担当
- **結城さん**: v0.2.34 実機で「確認用プレビューPNG」「6アイコンのリンク」を**通常クリック**して開けるか最終確認。問題なければ正式リリース可否の判断
- **Claude**: 上記4件 修正・ビルド・署名・インストール・起動まで完了。全72テスト pass（preview再読込/リンク分類の回帰テスト含む）。次の指示待ち
- **Codex**: UNIHUB用 電話×3・カメラ×3 アイコン（256x256/RGBA/透過PNG）作成済＝**実ファイルは正常**。本件は UI 配線バグであり Codex 成果物に問題なし。レビュー受領可（特に `classifyMarkdownLink` の file:// / 相対パス解決）

## 本日完成（2026-06-15）
1. ログイン根治（PTY化・auth status --json）
2. プレビュー窓 capability 登録（Codex）
3. プレビュー再読込（reloadKey強制bump・emitTo）
4. 本文リンク配線（classifyMarkdownLink・MarkdownLink）
5. v0.2.32 → CI 3OS success・署名付きDraft（非公開）。v0.2.33/0.2.34 はローカル署名ビルド＋インストール検証
6. メモリ蓄積（project_unicrew_v0232_login_fix / _preview_capability に追記）

## 変更ファイル（本セッション）
- `repos/unicrew/src-tauri/src/lib.rs` — start_claude_login を PTY化、claude_status を auth status --json 化、strip_ansi_simple/find_first_url＋テスト
- `repos/unicrew/src-tauri/capabilities/default.json` — windows に "preview"、fs:allow-read-file 追加
- `repos/unicrew/components/PreviewWindow.tsx` — navigate で reloadKey 強制bump
- `repos/unicrew/lib/preview-window.ts` — emit → emitTo(preview)
- `repos/unicrew/components/MessageItem.tsx` — `a` レンダラ(MarkdownLink)追加
- `repos/unicrew/lib/preview.ts` — 純関数 classifyMarkdownLink 追加
- テスト: `tests/preview-window-reload.test.tsx` / `lib/preview-link.test.ts`（計+14）
- 版: package.json / Cargo.toml / tauri.conf.json → 0.2.34

## 次アクション
- [ ] 結城さん: v0.2.34 実機クリック確認（プレビューPNG・アイコンリンク）
- [ ] OK後: v0.2.34 を正式リリースするか判断（タグpush→3OS CI→署名Draft→公開）
- [ ] D:\Downloads に UNICREW_0.2.32〜0.2.34 のインストーラー配置済
