# UNICREW — Pure CLI Conductor 設計

## 1. 目的と画面

UNICREW は、AIオフィスで仕事を分担し、ターミナルでCLIを操作するデスクトップアプリ。
Tauri v2のウィンドウにNext.js / Reactの画面を表示する。

`app/page.tsx` が次の画面を切り替える。

| 画面 | 実装 | 用途 |
|---|---|---|
| AIオフィス | `components/office/OfficeView.tsx` | 会社の作成・社員設定・指示・確認・納品 |
| ターミナル | `components/TerminalPanes.tsx` | 最大6ペインでCLIを操作 |
| 過去の会話 | `components/PastConversation.tsx` | 保存済み会話を読む。再開・追記なし |

旧チャットの並列6ペイン・議論モード・サイドチャット・チェックポイント・タスクキュー・差分ビュー・相互監査・キャラクター人格・スラッシュコマンドは廃止。ターミナルの6分割は別機能として残る。

## 2. アーキテクチャ

```text
app/page.tsx
  ├─ OfficeView → OfficeRunner → agent_start / agent_send / agent_stop
  │                  │                         │
  │                  ├─ engine.step            ▼
  │                  └─ protocol.ts     Rust CliProvider → CLI subprocess
  │                                             │
  │                  ← agent events ← NormalizedEvent
  ├─ TerminalPanes → InteractiveTerminal → PTY
  │       └─ terminal-link → オフィスの表示用状態
  ├─ RUNnerのローカル記録 → run-link → オフィスの表示用状態
  ├─ 定期実行 / ターミナルの「AI に渡す」 → boss-bus → 取りまとめ役
  └─ PastConversation ← storage.ts ← 旧会話ファイル / 旧localStorage
```

### Pure CLI Conductorの制約

- 商用AI SDKをimportしない。公式CLI・OSSエージェントをsubprocessとして起動する
- 商用サービスのOAuthトークンを読み取り・保管・中継しない。ログインはCLIの機能を呼ぶ
- APIキーモードはCLIにキーを渡す。OAuthをSDKで扱うモードは設けない
- 公式ロゴ画像を同梱しない。識別はカテゴリ色・lucideアイコン・テキストを使う
- 「Official Claude app」「Powered by Anthropic」など提携を示唆する表現は禁止。Aboutには各社と無関係の独立アプリである旨を表示する
- 利用案内は「公式CLIのログイン状態を使う」と記述する
- OSSライセンス・NOTICEを同梱し、Aboutで表示する

利用条件は提供元の規約による。[Claude Codeの認証・利用条件](https://code.claude.com/docs/en/legal-and-compliance)と[Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)を参照。CLIを起動するという実装方式だけで、規約への完全適合を断定しない。

## 3. 会社・社員・仕事の進行

`lib/office/types.ts` の `Office` が会社名・作業フォルダ・部署・社員を持つ。
`Staff` は名前・役割・部署・取りまとめ役かどうか・プロバイダ・モデル・仕事のやり方・見た目を持つ。

`lib/office/templates.ts` のひな形は5種類。人数は取りまとめ役を含む。

| ひな形 | 社員 | 部署 |
|---|---:|---:|
| まずは2人で | 2 | 1 |
| 会社まるごと（5つの部署） | 11 | 5 |
| 開発チーム | 5 | 3 |
| 発信チーム | 5 | 3 |
| Web制作チーム | 5 | 2 |

`lib/office/looks.ts` の見た目は12種類。社員の役割とは独立して選べる。画像の差し替えはdata URLで表示する。絵の構成は [docs/office-art.md](docs/office-art.md) を参照。

### 状態と副作用を分ける

`engine.step(run, office, input, locale)` は新しい `OfficeRun` と `OfficeEffect[]` を返す。
言語の既定は日本語。画面・Tauri・localStorageは読み書きしない。
社員の吹き出し・通知・記録・attentionの文は `lib/office/i18n.ts` で日本語と英語を出し分ける。
AIの返答・利用者の入力・保存済みの記録は翻訳し直さない。

`OfficeRunner` がeffectsを実行する。社員1人に1セッションを割り当て、IDは `office.<会社ID>.<社員ID>`。
同じ社員への起動と送信は順番に処理する。起動時に取りまとめ役・社員それぞれのシステムプロンプトを渡し、保存済みCLIセッションIDがあれば再開に使う。
ブラウザのみでは `demo.ts` の見本を使い、本物のAIを呼ばない。

### 取りまとめ役の合図

`lib/office/protocol.ts` が返答から合図を読み取る。表示が英語でも合図とAI向けシステムプロンプト・伝言は日本語のまま。

| 合図 | 動き |
|---|---|
| `[[依頼:名前]] … [[/依頼]]` | 担当社員に送る。複数人へ依頼できる |
| `[[質問]] … [[/質問]]` | 社長の返事を待つ（「最後まで自動で進める」が入のときは、1つの仕事で8回まで「おすすめの案で進めて」と自動で返す） |
| `[[確認:題名]] … [[/確認]]` | 確認カードを出す。`ファイル: 場所` で成果物を指定（「最後まで自動で進める」が入のときは、1つの仕事で8回まで待たずに OK として進め、題・内容・ファイルを記録に残す） |
| `[[返事]] … [[/返事]]` | 相談の受け箱に返事の下書きを置く |
| `[[完了]]` | 仕事を完了にする |

社員の報告がそろったら取りまとめ役へまとめて渡す。社員の途中失敗も報告として返す。
確認の「OKを出す」「差し戻す」は取りまとめ役への伝言になる。CLIの道具実行許可は別のpermission応答で扱う。
会社ごとの「最後まで自動で進める」（`Office.autoMode`・既定は切）が入のときは、道具の許可を聞かずに通し、通した操作を `OfficeRun.autoLog` に残す（200件まで。1件は道具に渡す中身2000字まで、切り替えた瞬間に通した物は札の文そのまま4000字まで。切ったときは切った字数を書く。アプリは操作の中身で止めない）。
許可・確認の通知にはボタンを付ける（Windows だけ。`src-tauri/src/attention.rs` の `notify_with_actions`）。通知に入りきらない長い操作には「許可する」を出さず、開いて全部読んでもらう。
許可の札に出す文は `lib/office/ask-text.ts` が作る（道具に渡す項目を全部出す・見えない文字や大量の空行は印に置き換える・4000字で切ったら切ったと書く）。
納品は `lib/turn-artifacts.ts` で道具の実行結果から集め、完了時には設定に応じてプレビューを開く。

## 4. CLIプロバイダ

`src-tauri/src/providers/mod.rs` の `CliProvider` / `SessionHandle` がプロバイダ差異を吸収する。
`build_provider` と `lib/types.ts` の `Provider` は11種類。

| 通信経路 | プロバイダ |
|---|---|
| CLIのJSON出力 | Claude / Codex / Qwen / Cursor |
| CLIのテキスト出力 | Gemini |
| ACP（JSON-RPC over stdio） | Goose / OpenCode / Codex-ACP / Kiro / Kimi / Grok |

イベント型は `src-tauri/src/providers/types.rs` の `NormalizedEvent`。フロントは `lib/tauri.ts` を経由して購読し、オフィスの進行役へ渡す。
CLI引数の具体は各provider実装を正本にする。Codexの新規・再開では利用できる引数が異なるため、変更時は `scripts/verify_codex_route.py` で検証する。

### 統合の運用ルール

- L1: 外部CLIのsubprocess起動。L2: 導入補助の後、subprocess起動。L3: ACP対応CLIのsubprocessと標準ACPで通信する
- L3は対象CLIがACPを実装していることが前提。プロトコルを独自拡張しない
- ACP crateのバージョン範囲を固定し、無断で更新しない。現在のCargo.tomlは `agent-client-protocol = "0.11"`
- `THIRD_PARTY_LICENSES/agent-client-protocol/` にLICENSE / NOTICEを同梱し、Aboutに `Includes agent-client-protocol (Apache-2.0)` を表示する
- Goose本体crateの内蔵（L4）とベンダー専用SDK経由は採用しない
- プロバイダを増やすときはカテゴリでまとめ、設定は折り畳みで扱う。画面の色・操作ステップ・スクロール量を増やさない。詳細な制約は `AGENTS.md` に従う
- CLIの検出・インストール・ログインは既存のRust実装を使う。WindowsのPATHEXT解決と静かなプロセス起動を維持し、インストーラの多重起動を防ぐ
- Rustの非同期共有状態は `tokio::sync::Mutex` を使う

## 5. ターミナル・RUNner・定期実行

### ターミナル

`TerminalPanes.tsx` の上限は6ペイン。
`terminal-link.ts` が開始・道具使用・許可待ち・停止の知らせを運び、`OfficeView.tsx` が表示用の状態へ重ねる。
取りまとめ役を除く社員の先頭からペイン番号順で割り当て、オフィスの仕事で作業中・待機中の社員は優先する。会社の仕事の進行状態へは書き込まない。
「AI に渡す」は `app/page.tsx` → `boss-bus.ts` で取りまとめ役へ指示を送る。会社などの準備不足なら再送用の文を保持する。

### RUNner

`run-link.ts` の `RunWatcher` はローカルの実行記録を読み、作業中・返事待ち・完了を知らせる。
`OfficeView.tsx` が約5秒ごとに確認し、取りまとめ役以外の社員の後方から表示を割り当てる。
RUNnerへ指示・承認を書き込まない。動いている仕事の入口は `https://hub.uni-core.jp/app/run` を開く。

### 定期実行

`lib/routines.ts` は毎日の時刻指定に対応。`app/page.tsx` が起動中に約60秒ごとに確認する。
同日未実行なら予定時刻を過ぎても対象になる。取りまとめ役が受け取った場合だけ、その日を実行済みにする。
送り先は選択中の会社で、旧会話には追記しない。

## 6. 保存と過去の会話

| データ | 保存・読込 |
|---|---|
| 会社一覧 | localStorage `unicrew.offices.v1` |
| 選択中の会社 | localStorage `unicrew.offices.active.v1` |
| 会社の「いま」 | localStorage `unicrew.office.run.v1.<会社ID>` |
| アプリ設定 / 定期実行 / 言語 | localStorage `unicrew.settings.v2` / `unicrew.routines.v1` / `unicrew.locale` |
| 過去の会話 | アプリ専用フォルダ `threads/<id>.json` と旧localStorage `unicrew.threads.v2` |
| 成果物 | 会社で選んだ作業フォルダ |

`lib/office/store.ts` は書きかけの返事とツールの中身を保存しない。ただし、許可の札の説明（`permissions[].text`）と自動で通した操作の記録（`autoLog`）には、道具に渡す中身（コマンドなど）が入る。
記録は200件・通知60件・納品100件・相談30件に制限する。開き直すと実行中だった仕事を停止状態に戻し、続きの指示を待つ。

`lib/storage.ts` は過去の会話をその場で読む。起動時の移行・新規会話の保存・書き戻しは行わない。
ファイルと旧localStorageに同じIDで異なる記録があれば両方表示する。確認後の削除は対象の保存元だけに適用し、旧worktreeやチェックポイントは削除しない。
`PastConversation.tsx` は本文・日時・添付名を表示し、入力欄や再開操作を持たない。

## 7. 検証

ロジックはVitest、型はTypeScript、書き方はESLintで検証する。
実機の操作手順は [E2E_TEST.md](E2E_TEST.md)。ブラウザの見本だけでCLI接続・成果物の実在を確認した扱いにはしない。
公開前は `python scripts/verify_public_repo.py` で配布境界を検査する。
