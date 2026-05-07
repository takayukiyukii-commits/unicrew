"use client";

import { useEffect, useRef } from "react";
import { GripVertical } from "lucide-react";

interface Props {
  /** 左ペインの幅％（0-100）。値の変更は onChange で親に通知。 */
  widthPct: number;
  onChange: (pct: number) => void;
  /** 親のクライアント幅 px を測るための ref。リサイザの相対座標計算に使う。 */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 最小・最大％（境界）。デフォルト 20% / 80%。 */
  min?: number;
  max?: number;
}

/**
 * 並列ペイン間のドラッグ可能な区切り線。
 * 親要素は `position: relative` の必要なし。コンテナの幅で％計算する。
 */
export function PaneResizer({
  widthPct,
  onChange,
  containerRef,
  min = 20,
  max = 80,
}: Props) {
  const draggingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(min, Math.min(max, pct));
      onChangeRef.current(clamped);
    };
    const handleUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    return () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
  }, [containerRef, min, max]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(widthPct)}
      onMouseDown={(e) => {
        e.preventDefault();
        draggingRef.current = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onDoubleClick={() => onChangeRef.current(50)}
      title="ドラッグでサイズ変更 / ダブルクリックで均等"
      className="group relative w-1 shrink-0 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)]/40 transition"
    >
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      <div className="absolute top-1/2 -translate-y-1/2 -left-2 w-5 h-7 rounded bg-[var(--color-border)] group-hover:bg-[var(--color-accent)] flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition pointer-events-none">
        <GripVertical size={11} />
      </div>
    </div>
  );
}
