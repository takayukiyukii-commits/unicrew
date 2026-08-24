# winget（Windows Package Manager）への掲載

- **目的**：ブラウザのダウンロードを経由しない入口を1本持つ
- **対象**：次のセッションのCDO
- **想定効果**：`winget install ZUBOLAND.UNICREW` の経路では SmartScreen の警告が出ない

## なぜ winget なら警告が出ないのか（一次情報）

Microsoft Store を見送った理由（ブラウザ専用ポリシー＝Chromium 2メジャー以内）は、
**winget には存在しない**。winget のポリシーに browser / Chromium の語は1つも無い。
実際に Brave が GitHub Releases を InstallerUrl にして掲載されている。

警告が出ない理由は winget-cli のソースに書いてある（推測ではない）。

`src/AppInstallerCLICore/Workflows/DownloadFlow.cpp`

```cpp
// An initial MotW is always set to URLZONE_INTERNET at the time the file is downloaded.
// This function may change that to URLZONE_TRUSTED if appropriate
if (WI_IsFlagSet(context.GetFlags(), Execution::ContextFlag::InstallerTrusted))
{
    // We know the installer already went through multiple scans and we can trust it.
    Utility::ApplyMotwIfApplicable(installerPath, URLZONE_TRUSTED);
}
```

`src/AppInstallerRepositoryCore/SourceList.cpp` — 既定のコミュニティソースは

```cpp
details.TrustLevel = SourceTrustLevel::Trusted | SourceTrustLevel::StoreOrigin;
```

つまり **公式リポジトリ経由でハッシュが一致した場合に限り、Mark of the Web が
「インターネット」ではなく「信頼済みサイト」で付く**。だから SmartScreen の
「認識されないアプリ」が出ない。

🚨 これはドキュメント上の保証ではなく実装。Microsoft が変えたら変わる。
🚨 **Smart App Control は別物。** MotW に関係なく全実行ファイルの署名を見るので、
   同梱DLLの署名（`package.json` の `win.signExts`）は winget 経路でも必要。

## 出荷のたびにやること

1. 新しい安定版（zuboland-hp の `api/unicrew/dl.js` の `STABLE_TAG`）を決める
2. `packaging/winget/<version>/` を前の版からコピーし、以下を書き換える
   - `PackageVersion`（4ファイルすべて）
   - `InstallerUrl`
   - `InstallerSha256`（**公開済みアセットをHTTPSで落として計算する**。ローカルのビルド成果物ではない）
   - `ReleaseDate`（GitHub release の `published_at`）
3. `winget validate --manifest packaging/winget/<version>` が通ることを確認
4. `microsoft/winget-pkgs` のフォークに
   `manifests/z/ZUBOLAND/UNICREW/<version>/` として置き、PRを出す
   - タイトルは `Update: ZUBOLAND.UNICREW to <version>`
   - **`winget install --manifest` を実行していないなら、チェックを付けない**

## 検証の実態（2026-08-24 に確定した）

- **CLA は署名済み**（PR #423057 で `agree company="ZUBOLAND株式会社"`）。以後のPRでは不要
- 🚨 **Windows Sandbox は使えない。この開発機は Windows 11 Home で、Home は公式のサポート
  エディション一覧（Pro / Enterprise / Education）に入っていない。** 管理者権限の問題ではない
- そのかわり **winget-pkgs の検証パイプラインが無人インストールを実行する**。
  失敗すれば `Validation-Unattended-Failed` などのラベルが付く。
  KUZIRA の PR #423057 は `Azure-Pipeline-Passed` / `Validation-Completed` が付いた
  ＝Microsoft側の環境でインストールが通ったことが実証された
- したがって `winget install --manifest` のローカルテストは**こちらでは踏めない**。
  **チェックを付けず、その理由をPR本文に書く**のが正しい出し方

## 出したあとの見方

- 動きがあるとメールが来るが、**対応が要るのは `Needs-Author-Feedback` が付いたときだけ**
- `msftbot/requiresApproval/moderator` のコメントは「機械の検査は終わった。
  人間のボランティアの承認待ち」という状態通知であって、却下でも指摘でもない

## 変わらないこと

winget に載せても **サイトからの .exe 直ダウンロードの警告は消えない**。
消えるのは評判が貯まったときだけ。winget は「警告の出ない別の入口」であって
警告の解除ではない。

---

## UNICREW固有のメモ（KUZIRAとの違い）

- **Tauri なので「同梱DLLの署名漏れ」問題が構造的に無い。** ブラウザエンジンを同梱せず
  OSのWebView2を使うため、署名対象はアプリ本体exe / NSIS / MSI の3つだけ。
  Electron（KUZIRA）は Chromium のDLLを同梱するので `win.signExts` が要る。ここが違う
- **ライセンスが Apache-2.0**（KUZIRAは Proprietary）。manifest の `License` も違う
- インストーラは **Tauri v2 の NSIS**（`installMode: currentUser` → `Scope: user`）
- `ProductCode` は **`UNICREW`**（製品名そのもの）。根拠＝`tauri-v2.11.1` の `installer.nsi` の
  `UNINSTKEY` 定義が `...CurrentVersion\Uninstall\${PRODUCTNAME}` になっている。
  🚨 GUIDではない。KUZIRA（electron-builder）はGUIDなので、同じつもりで書かない
- **silent（`/S`）ではアプリが起動しない**（同テンプレートの `.onInstSuccess` は
  `/R` が渡されたときだけ起動する）。winget は `/R` を渡さないので問題ない
- MSI も配布しているが、winget に載せるのは **NSIS の方**（LPが配っているのと同じ実体）。
  MSI は `ja-JP` ロケール固定のビルドなので採用しない
