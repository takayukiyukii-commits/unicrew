import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 版数の単一ソース＝package.json。lib/whatsnew.ts の UNICREW_VERSION がこれを読む
// （scripts/verify_version_sync.py が Cargo.toml / tauri.conf.json / whatsnew と一致を検査する）
const pkgVersion: string = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")).version;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 左下に出る Next.js 開発インジケータ（黒丸のNマーク）を完全非表示。
  // UNICREW 本体UIと被るため、devでもoffにする。
  devIndicators: false,
  env: { NEXT_PUBLIC_UNICREW_VERSION: pkgVersion },
  // Tauri shellでは静的SPA出力に切り替えるため、本番ビルド時は output: "export" を環境変数で有効化。
  // distDir は変更しない（変更すると out/ 出力先がずれて Tauri が見つけられなくなる）。
  // dev サーバが起動中だと .next のロックでビルド失敗するため、build_tauri.js が事前に dev を止める。
  ...(process.env.UNICREW_TAURI === "1"
    ? {
        output: "export" as const,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
