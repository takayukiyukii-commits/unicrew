"use client";

import { useEffect } from "react";

/**
 * 最終防壁。RootLayout 自体（または error.tsx）が落ちた時だけ発火する。
 * layout を置換するため globals.css / Tailwind が効かない前提でインライン style のみ使用。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[UNICREW] fatal layout error:", error);
  }, [error]);

  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fafafa",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          color: "#1a1a1a",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            アプリの初期化でエラーが発生しました
          </div>
          <div
            style={{
              fontSize: 13,
              color: "#6b7280",
              lineHeight: 1.6,
              marginBottom: 20,
            }}
          >
            会話データは保存されています。下のボタンで復帰してください。
            <br />
            A fatal error occurred. Your data is safe.
          </div>
          <div
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            <button
              onClick={() => reset()}
              style={{
                padding: "10px 16px",
                borderRadius: 6,
                border: "none",
                background: "#2563eb",
                color: "#fff",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              やり直す / Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "10px 16px",
                borderRadius: 6,
                border: "1px solid #e5e7eb",
                background: "#fff",
                color: "#1a1a1a",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              アプリを再読み込み / Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
