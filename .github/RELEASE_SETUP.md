# Release ワークフロー セットアップ

`tag v*` を push すると、Windows / macOS (universal) / Linux の3プラットフォーム向けに自動ビルドして GitHub Release のドラフトを作る、というフロー。

## 必要な GitHub Secrets

Repository → Settings → Secrets and variables → Actions → New repository secret から登録:

| シークレット名 | 内容 | 取得方法 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | minisign 秘密鍵の **本文**（base64含む全文） | `Get-Content -Raw D:\secrets\tauri-signing\unicrew.key` の出力をそのまま貼り付け |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 上記鍵のパスフレーズ | `D:\secrets\tauri-signing\README.md` の「パスワード」行を参照 |

> ⚠️ 秘密鍵を紛失すると、配布済ユーザーの自動アップデートが永久に止まります。
> F: 外付けバックアップ（タスクスケジューラ Backup_Secrets_Daily 03:15）が走っていることを確認。

## リリースする手順

1. ローカルでバージョン更新:
   ```
   - package.json: "version"
   - src-tauri/Cargo.toml: version
   - src-tauri/tauri.conf.json: "version"
   - lib/whatsnew.ts: UNICREW_VERSION
   - public/whatsnew/<version>.md 新規作成（リリースノート）
   ```

2. コミット & タグ:
   ```bash
   git add -A
   git commit -m "vX.Y.Z: <要約>"
   git tag vX.Y.Z -m "UNICREW vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```

3. GitHub Actions が走り出すのを待つ。3プラットフォーム並列で 10〜20 分。

4. Release のドラフトが出来上がるので、Web UI でリリースノートを最終確認 → 「Publish release」。

5. `latest.json` が更新され、既存ユーザーの自動アップデートが翌起動で走る。

## macOS の注意

- 現状 **Apple Developer ID で署名していない** ため、初回起動時に「開発元が未確認」警告が出ます。
  - 暫定: Finder で右クリック → 開く → 「開く」を再度クリックでバイパス可
  - 恒久: Apple Developer Program 加入 (年 $99) + 証明書設定 + notarytool が必要
- universal binary なので Apple Silicon / Intel どちらでも動く

## Linux の注意

- AppImage / .deb / .rpm が同時に出る
- 動作確認は Ubuntu 22.04 のみ。他ディストロは順次

## 単発の手動リリース（Actions を待たない場合）

Windows ローカルでは:
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw D:\secrets\tauri-signing\unicrew.key)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<パスワード>"
npm run build:tauri
npm run tauri:build
```

成果物: `src-tauri/target/release/bundle/{msi,nsis}/UNICREW_x.y.z_*.{msi,exe}` + `.sig`
