# AI共有ステータス（Claude × Codex）

> このファイルは**ClaudeとCodexの両方が読み書きする正本**。短く・構造化・常に最新。
> 自由記述は禁止。各セクションのフォーマットを守る。
> 詳細議事録は `session_state.md`、決定履歴は `decision_log.md` を参照。

**最終更新**: 2026-05-10 19:50 JST / 更新者: Claude / 状態: DONE

> ### Stale判定ルール
> - 24時間以上経過で **STALE 扱い**
> - 完了タスクは `decision_log.md` に流して本ファイルは新作業で上書き

---

## 現在の作業
**UNICREW v0.1.0 release ビルド完成（PID稼働中）**。本日午後の並列ペイン10項目アップグレードに加え、夕方〜夜にかけてオンボーディング摩擦低減＆操作機能 5項目を追加実装し、`UNICREW_0.1.0_x64-setup.exe`（23.7MB）/ `UNICREW_0.1.0_x64_ja-JP.msi`（25.5MB）まで bundle 完了。未コミット継続。

### 本セッション追加（19:00〜19:50）
1. **Shift+Tab パーミッションモードトグル** — Claude Code流。`Thread.permissionMode: "acceptEdits" | "plan"` 新設、入力欄上にバッジ表示。Claude `--permission-mode` / Codex `--sandbox read-only --ask-for-approval never` に射影。切替時は両 provider session を kill して次回送信時に新モードで再 spawn。
2. **「このまま開始」を Claude/Codex 両対応に拡張** — CharacterPickerModal 既存ボタンを単独モード時 `🟠 Claude単独 / 🟢 Codex単独` の2ボタンに分割、並列モード時は `🟠×🟢 両方並列で開始` の1ボタンに集約。重複3カードは撤去（最初の試行で WelcomeLanding と modal の両方に増設してしまったため整理）。
3. **UniMcpModal Claude+Codex 両対応** — ヘッダに `claude / codex / both` セレクタ追加（localStorage `unicrew.uni_mcp_target.v1` 永続）。`addCodexMcp` / `removeCodexMcp` 既存 Tauri コマンド利用、Rust 変更なし。
4. **長会話バナー** — `LONG_CHAT_THRESHOLD = 30` メッセージ超過で sky-50 バナー表示。「新しいスレッドを開く」→ `handleCreateInstant`、X で per-thread dismiss。primary/split/3+ 全配置で動作。
5. **Codex プラグイン1クリックインストール** — codex CLI が `/plugin install` 相当未提供のため未実装維持。「Phase D」謎メッセージを `~/.codex/config.toml` 直編集案内＋「MCPは1クリック対応」明示に書換。

## 担当
- **結城さん**: UNICREW release 実機検証（Shift+Tab / このまま開始 2ボタン分割 / UniMcp target セレクタ / 長会話バナー）。コミット粒度の指示
- **Claude**: 本日のUI/UX 15項目（午後10 + 夕方5）完了。release ビルド成果物まで生成済。次の指示待ち
- **Codex**: レビュー受領可（特に Shift+Tab の Rust 側 `PermissionMode` enum と `--permission-mode plan` 射影、Codex の `--sandbox read-only` プラン挙動）

## 本日完成（2026-05-10）
1. **AM**: Codex 議論モード2大バグ修正（モデル名サニタイズ・resume 時 `-C` 削除）+ ActivityPanel 削除
2. **昼**: キャラ命名統一（Codex/Claude（normal））、絵文字ゼロ化、Codex item.started 拾い、配布 Phase 1 確認
3. **午後**: 並列ペイン10項目 + ペイン名に AI 表記
4. **夜**: 知見ナレッジ化（`ナレッジ/UNICREW/20260510_UI改修まとめ.md`）+ F:バックアップ
5. **夜2（19:00〜）**: Shift+Tab / このまま開始 整理 / UniMcp 両対応 / 長会話バナー / Codex プラグイン文言改善 + release ビルド完走（37.6MB exe / 23.7MB nsis / 25.5MB msi）

## 変更ファイル（本セッション追加分・19:00〜）
- `repos/unicrew/lib/types.ts` — `PermissionMode` 型 + `Thread.permissionMode?` + `PERMISSION_MODE_LABELS`
- `repos/unicrew/lib/tauri.ts` — `AgentStartParams.permissionMode` 追加
- `repos/unicrew/src-tauri/src/providers/types.rs` — `PermissionMode` enum + `SpawnOpts.permission_mode`
- `repos/unicrew/src-tauri/src/providers/claude.rs` — `--permission-mode {acceptEdits|plan}` に直射
- `repos/unicrew/src-tauri/src/providers/codex.rs` — plan 時 `--sandbox read-only --ask-for-approval never`
- `repos/unicrew/src-tauri/src/lib.rs` — `AgentStartRequest.permission_mode` 配線
- `repos/unicrew/app/page.tsx` — `togglePermissionMode` ＋ Shift+Tab グローバルリスナー、4箇所の `<ChatPane>` に props 注入
- `repos/unicrew/components/ChatPane.tsx` — `PermissionModeBadge` ＋ 長会話バナー（30 メッセージ閾値、per-thread dismiss）
- `repos/unicrew/components/CharacterPickerModal.tsx` — 既存「このまま開始」ボタンを Claude/Codex 2ボタンに拡張
- `repos/unicrew/components/UniMcpModal.tsx` — `target: claude/codex/both` セレクタ + `addForTarget`/`removeForTarget`
- `repos/unicrew/components/AddonsSection.tsx` — Codex プラグインインストール文言を実態案内に修正

## 設定（適用済）
- 検証：`tsc -p . --noEmit` 0、`cargo check` clean、`npm run tauri:build` exit 0
- release exe: `C:\Users\takay\repos\unicrew\src-tauri\target\release\unicrew.exe`（37.6MB、19:45:08 build）
- bundle: `target/release/bundle/{msi,nsis}/UNICREW_0.1.0_*`
- Desktop ショートカット2系統:
  - `D:\Desktop\UNICREW.lnk` → `scripts/launch_unicrew.bat`（dev hot-reload 用、`npm run tauri:dev`）
  - `D:\Desktop\UNICREW (release).lnk` → `target/release/unicrew.exe`（配布版相当の実機検証用、本セッションで新規追加）
- 未コミット継続。隣セッション分（CommandPalette/Editor/Trust/Walkthrough/WhatsNew/Observability）と本セッション分が混在、ハンク分割は危険なので統合1コミット推奨

## コミット案（push は明示指示まで保留）
```
feat(unicrew): 並列ペインUX改修 + AI×人格直交化 + 会話継承 + Shift+Tab + 「このまま開始」両AI対応 + UniMcp両対応 + 長会話バナー + release v0.1.0

== 並列ペイン ==
- splitIds 配列化で最大6ペイン対応、3+ で grid 3col×2row
- focusedThread でペイン編集対象指定（リング表示）

== AI × 人格 ==
- Picker に AI タブ、CEO×Codex 等の組合せ起動
- AI 切替時 systemPrompt に直近5往復履歴注入
- 他ペイン参照モード（peek）を送信ごと差し込み

== Shift+Tab パーミッションモード ==
- Thread.permissionMode "acceptEdits" | "plan" を新設
- Claude --permission-mode、Codex --sandbox read-only --ask-for-approval never に射影
- 切替時は両 provider subprocess を kill し次回送信で新モード spawn

== 「このまま開始」両AI対応 ==
- CharacterPickerModal 単独モード時に Claude/Codex 2ボタン分割
- 並列モード時は両方並列1ボタン

== UniMcpModal 両対応 ==
- claude / codex / both セレクタを追加（localStorage 永続）
- addForTarget / removeForTarget で必要側だけ操作

== 長会話バナー ==
- LONG_CHAT_THRESHOLD = 30 で「新スレッド推奨」バナー表示
- per-thread dismiss、handleCreateInstant に直結

== Codex driver ==
- item.started 拾い、started/completed 二段運用
- claude-* model サニタイズ、resume 時 -C 除外
- PermissionMode 経由でフラグ切替

== UX ==
- ワークスペース一本化（Explorer 単一ソース）
- 絵文字ゼロ + 色玉のみ復活、lucide ラインアート統一
- Codex プラグイン文言を実態案内に修正

== 進行中の追加機能（隣セッション分） ==
- CommandPalette / Editor / Trust / Walkthrough / WhatsNew / Observability
```

## 失敗・詰まったこと（今日中に解消）
- ① 並列ペイン3+ 表示のバグ：state が単一値（splitId）だったため上書き → 配列化で解消
- ② RightPane の操作対象が常に主ペイン → focusedThread で独立化
- ③ AI 切替で Codex が「初対面」状態 → fresh spawn 時に systemPrompt 履歴注入
- ④ Picker の DoorOpen が「画面に何も出ない」バグ → ボタン削除で混乱解消
- ⑤ **「このまま開始」を最初 WelcomeLanding と Modal の2箇所に冗長実装してしまった** → ユーザーから整理指示 → モーダル既存ボタンの拡張1箇所に統一（学び：既存 UI コンポーネントの確認を先にやる）
- ⑥ デスクトップショートカットが debug 版を指していて release ビルド反映が見えなかった → release 専用ショートカット `UNICREW (release).lnk` を別途作成して併存

## 次の一手
1. **結城さん**: UNICREW release 実機検証
   - Shift+Tab で permissionMode が切り替わるか / プランモードで edit 拒否されるか
   - 「+」新規スレッド時の「このまま開始」が Claude単独 / Codex単独 / 両方並列の3パターン全部使えるか
   - UniMcp の claude/codex/both セレクタが期待通り両側に登録されるか
   - 30 メッセージ超過時に長会話バナーが出るか
2. **結城さん**: コミット粒度指示（統合1コミット推奨）+ push 判断
3. **CDO**: 結城さんOK後、UNICREW 配布計画 Phase 2-4（GitHub Releases + tauri-action + SmartScreen警告ガイド + Tauri Updater）。`UNICREW_0.1.0_x64-setup.exe` がそのまま L2（GitHub Releases）に上げる候補
4. **CDO**: 残課題A（portproxy 自動更新停止 LastResult=3221225786 / 04/29から継続）の調査優先度判断
5. **CFO**: コード署名コスト見積 + Stripe Connect 手数料試算（既存）
6. **CMO**: UNICREW LP 作成（既存）

## 注意すべき認証情報・制約
- ローカル `repos/unicrew/` フォルダ名は据置（パス参照ドキュメント書換負担を避けるため）
- GitHub 上は `unicrew` リポ名で公開
- UNICREW 本体は完全無料配布、Stripe / 価格プラン UI は本体に実装しない
- OTel エンドポイント（Honeycomb / Grafana Cloud / 自前 OTLP）は結城さん要判断
- **Bridge への日本語 PUT は必ず `python scripts/bridge_put.py` 経由**
- UNIHUB の フォルダ名 `unichat/` と DB プレフィックス `unichat_*` は互換性維持で残置
- **Codex CLI 制約**: `codex exec` には `-C/--cd` あり、`codex exec resume` にはない。`-m/--model` は両方にあるが UNICREW の `ModelId` 型は claude-* だけなのでランタイムで落とす
- **Codex item event**: `item.started` で ToolUse、`item.completed` で ToolResult のみ
- **絵文字ゼロ方針**：UNICREW は UI/コピー/データから絵文字を排除。例外は provider 識別の色玉 🟠/🟢/🔵 のみ
- **PermissionMode 射影**: Plan モードで Codex は `--sandbox read-only --ask-for-approval never`（書込・実行を静かに拒否）。Claude は `--permission-mode plan`
- **Codex プラグイン install 制約**: codex CLI に `/plugin install` 相当が無いため UI から1クリック不可。`~/.codex/config.toml` 直編集が必要
- **PowerShell 5.1 で日本語コメント／パスを含む .ps1 は UTF-8 BOM 付き必須**
- **PSプロファイル編集は `C:\Users\takay\.config\powershell\profile.ps1`**

## 未確定の仮説
- UNICREW `ModelId` 型を Codex/Gemini まで拡張するか、`Character` 側でプロバイダ別モデルを持たせるか
- 並列モードでテンプレ provider 切替時の重複ユーザーキャラ累積（同 persona × 同 provider のクローンを集約するか）
- 残課題A（portproxy）の iPhone 遠隔操作への影響有無
- KFM を将来的に解除するタイミング（OneDrive 完全死亡時 or PCリプレイス時）
- Codex CLI が将来 `/plugin install` 相当を提供したら、UNICREW 側の `install_codex_plugin` Tauri コマンドを足して1クリック化する余地
