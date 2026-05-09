# UNICREW スマホ連携用：ポート 1420 を LAN 内のみ許可するファイアウォールルールを追加する。
#
# 使い方:
#   1. このファイルを右クリック → 「PowerShell で実行」（管理者として実行も可）
#   2. または管理者 PowerShell で:
#        powershell -ExecutionPolicy Bypass -File scripts\allow_firewall_1420.ps1
#
# 1度実行すれば永続化されます（OSが覚えています）。再実行しても同名ルールは上書きされるだけで害なし。

$ErrorActionPreference = "Stop"

# 管理者権限チェック。なければ自分自身を管理者で再起動する（UAC ダイアログ）
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal $current
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "管理者権限が必要なので、UAC で昇格して再実行します..."
    Start-Process -FilePath "powershell" `
        -Verb RunAs `
        -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`""
    exit
}

$ruleName = "UNICREW-1420"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "既にルールが存在します。更新します。" -ForegroundColor Yellow
    Remove-NetFirewallRule -DisplayName $ruleName
}

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 1420 `
    -Action Allow `
    -RemoteAddress LocalSubnet `
    -Description "UNICREW スマホ連携：同一 LAN 内のスマホからのみ 1420 ポートへの接続を許可" `
    | Out-Null

Write-Host ""
Write-Host "✓ ファイアウォールルール 'UNICREW-1420' を追加しました（LAN 内のみ）" -ForegroundColor Green
Write-Host ""
Write-Host "次の手順:"
Write-Host "  1. UNICREW を再起動 (cd C:\Users\takay\repos\unicrew && npm run tauri:dev)"
Write-Host "  2. ファイル → 📱 スマホ連携（リモコン） を開いて URL をコピー"
Write-Host "  3. スマホ（同じ Wi-Fi）でその URL を開く"
Write-Host ""
Write-Host "終了するには Enter ..."
Read-Host
