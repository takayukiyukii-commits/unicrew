"use client";

import { useEffect } from "react";
import { OLD_WEBKIT_ATTR } from "@/lib/old-webkit-guard";

// 画面のプログラム（React）が動き出したことを、見張り（lib/old-webkit-guard.ts）に知らせる。
// これが立たないまま時間が過ぎたら「この Mac では動いていない」と判断して案内を出す。
export function BootMarker() {
  useEffect(() => {
    (window as unknown as { __UNICREW_BOOTED__?: boolean }).__UNICREW_BOOTED__ = true;
    // 「時間切れ」で出した案内だけ消す（遅い Mac で後から動き出した場合）。CSS 非対応の案内は残す
    const root = document.documentElement;
    if (typeof (window as unknown as { CSSLayerBlockRule?: unknown }).CSSLayerBlockRule === "undefined") {
      // ルートの作り直し（hydration の回復・global-error からの復帰）で <html> の属性は消され、
      // 見張りの <script> は再実行されない。CSS 非対応の印はここでも付け直す（2026-10-13 監査の指摘）
      root.setAttribute(OLD_WEBKIT_ATTR, "css");
    } else if (root.getAttribute(OLD_WEBKIT_ATTR) === "timeout") {
      root.removeAttribute(OLD_WEBKIT_ATTR);
    }
  }, []);
  return null;
}
