import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "UNICREW Remote",
  description:
    "AIを動かすマルチAIデスクトップ「UNICREW」のスマホ用リモコン。QRコードで PC とペアリングして外出先からも操作できる。",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-180.png", type: "image/png", sizes: "180x180" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [
      { url: "/icon-180.png", sizes: "180x180" },
    ],
    shortcut: ["/favicon.ico"],
  },
  appleWebApp: {
    capable: true,
    title: "UNICREW",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#0ea5e9",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function MobileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
