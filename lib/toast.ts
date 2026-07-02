"use client";

/**
 * 依存ゼロの軽量トースト（設計書③: 失敗の無言握り潰しをやめて可視化する）。
 *
 * page.tsx の状態管理に依存せず、MessageItem（チャット）や InteractiveTerminal
 * （xterm のリンク activate コールバック）のような「React ツリーの外側からも
 * 呼びたい」場所で使えるよう、DOM 直挿しで実装する。白基調（UNI 共通テーマ）。
 */
export function showToast(message: string, kind: "info" | "error" = "info"): void {
  if (typeof document === "undefined") return;
  const rootId = "unicrew-toast-root";
  let root = document.getElementById(rootId);
  if (!root) {
    root = document.createElement("div");
    root.id = rootId;
    root.style.position = "fixed";
    root.style.left = "50%";
    root.style.bottom = "24px";
    root.style.transform = "translateX(-50%)";
    root.style.zIndex = "9999";
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.alignItems = "center";
    root.style.gap = "8px";
    root.style.pointerEvents = "none";
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.textContent = message;
  el.style.padding = "8px 14px";
  el.style.borderRadius = "8px";
  el.style.fontSize = "12.5px";
  el.style.lineHeight = "1.5";
  el.style.background = kind === "error" ? "#fef2f2" : "#fafaf9";
  el.style.border = kind === "error" ? "1px solid #fca5a5" : "1px solid #d6d3d1";
  el.style.color = kind === "error" ? "#991b1b" : "#292524";
  el.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)";
  el.style.opacity = "0";
  el.style.transition = "opacity 160ms ease";
  el.style.maxWidth = "70vw";
  el.style.overflow = "hidden";
  el.style.textOverflow = "ellipsis";
  el.style.whiteSpace = "nowrap";
  root.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => {
      el.remove();
      const r = document.getElementById(rootId);
      if (r && r.childElementCount === 0) r.remove();
    }, 220);
  }, 3500);
}
