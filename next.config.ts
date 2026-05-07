import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 左下に出る Next.js 開発インジケータ（黒丸のNマーク）を完全非表示。
  // UNICREW 本体UIと被るため、devでもoffにする。
  devIndicators: false,
  // Tauri shellでは静的SPA出力に切り替えるため、本番ビルド時は output: "export" を環境変数で有効化
  ...(process.env.UNICREW_TAURI === "1"
    ? { output: "export" as const, images: { unoptimized: true } }
    : {}),
};

export default nextConfig;
