#!/usr/bin/env node
/**
 * Tauri ビルド用の前処理ラッパー。
 *
 * Next.js の `output: "export"` モードでは API Route（特に POST/PUT/DELETE）が
 * 静的化できずビルドが落ちる。一方、UNICREW では LAN モード用に
 * /api/mobile/* を持っている（dev モードのみ動かす想定）。
 *
 * このスクリプトは:
 *   1. app/api を _api_tauri_backup に一時 rename
 *   2. `cross-env UNICREW_TAURI=1 next build` を実行
 *   3. 成否に関わらず必ず元に戻す
 *
 * これで dev サーバの LAN モードは動かしつつ、Tauri 配布版ビルド（クラウドモード専用）
 * を成功させられる。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const apiDir = path.join(repoRoot, "app", "api");
const apiBackup = path.join(repoRoot, "app", "_api_tauri_backup");
// distDir は標準の `.next`（変更すると out/ 出力先がずれて Tauri が frontendDist を見つけられなくなる）
const nextCache = path.join(repoRoot, ".next");
// next.js static export 出力先（Tauri config の frontendDist が指す）
const outDir = path.join(repoRoot, "out");

/**
 * dev サーバ（unicrew.exe + node listening 1420）を停止する。
 * .next ディレクトリのファイルロックを外すために必要。
 */
function stopDevServers() {
  // unicrew.exe（Tauri ウィンドウ）を停止
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-Process unicrew -ErrorAction SilentlyContinue | Stop-Process -Force",
    ],
    { stdio: "ignore", shell: false },
  );
  // 1420 を握ってる node プロセスを停止
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }",
    ],
    { stdio: "ignore", shell: false },
  );
  console.log("[build_tauri] stopped dev servers (unicrew.exe + 1420)");
}

function moveAside() {
  if (fs.existsSync(apiDir)) {
    if (fs.existsSync(apiBackup)) {
      fs.rmSync(apiBackup, { recursive: true, force: true });
    }
    fs.renameSync(apiDir, apiBackup);
    console.log("[build_tauri] moved app/api → app/_api_tauri_backup");
  }
  // 過去の .next（type cache が API Route 参照を含む）と out/ を消す
  for (const dir of [nextCache, outDir]) {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[build_tauri] cleared ${path.basename(dir)}/`);
      } catch (e) {
        console.warn(
          `[build_tauri] ${path.basename(dir)}/ cleanup failed:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }
}

function restore() {
  if (fs.existsSync(apiBackup)) {
    if (fs.existsSync(apiDir)) {
      fs.rmSync(apiDir, { recursive: true, force: true });
    }
    fs.renameSync(apiBackup, apiDir);
    console.log("[build_tauri] restored app/api");
  }
}

let exitCode = 0;
try {
  stopDevServers();
  moveAside();
  const result = spawnSync(
    "npx",
    ["cross-env", "UNICREW_TAURI=1", "next", "build"],
    {
      stdio: "inherit",
      shell: true,
      cwd: repoRoot,
    },
  );
  exitCode = result.status ?? 1;
} catch (e) {
  console.error("[build_tauri] error:", e);
  exitCode = 1;
} finally {
  restore();
}

process.exit(exitCode);
