"use client";
import { useEffect, useState } from "react";

/** 窓が隠れたら描画ループも止める。動きを減らす設定は変更時にも反映する。 */
export function useOfficeMotion(active: boolean) {
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const visibility = () => setVisible(document.visibilityState === "visible");
    const preference = () => setReduced(media.matches);
    visibility();
    preference();
    document.addEventListener("visibilitychange", visibility);
    media.addEventListener("change", preference);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", preference);
    };
  }, []);
  return { running: active && visible, reduced };
}
