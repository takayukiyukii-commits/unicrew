import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UNICREW - あなた専属のAIチームを、5分で。",
  description:
    "Claude / Codex / スキル / MCP をターミナルなしで使える AI デスクトップアプリ。複数 AI を並べて議論させたり、キャラクター別に役割分担できる。完全無料。",
  applicationName: "UNICREW",
  authors: [{ name: "uniLinks / ZUBOLAND" }],
  openGraph: {
    title: "UNICREW - あなた専属のAIチームを、5分で。",
    description:
      "Claude / Codex / スキル / MCP をターミナルなしで使える AI デスクトップアプリ。完全無料。",
    siteName: "UNICREW",
    type: "website",
    locale: "ja_JP",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}
