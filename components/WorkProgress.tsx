"use client";

/**
 * AI の作業の進み具合（2026-10-07 追加）。
 *
 * 初心者モードでは道具の吹き出しを隠しているため、考え中は「…」しか出ず、
 * 何をしているのか分からなかった。ここで「いま◯◯しています」「✓ ◯◯しました」
 * 「段取り 2/5」を日本語で随時出す。言い換えは lib/progress-text.ts。
 */
import { Check, Loader2, X } from "lucide-react";
import type { Block } from "@/lib/types";
import { summarizeProgress } from "@/lib/progress-text";

export function WorkProgress({
  blocks,
  idleLabel,
  compact = false,
}: {
  blocks: Block[];
  /** 道具を使っていない間の言葉（「考えています」「返事を書いています」） */
  idleLabel: string;
  compact?: boolean;
}) {
  const s = summarizeProgress(blocks, compact ? 3 : 6);
  return (
    <div
      className="my-1.5 rounded-lg border border-[var(--color-border)] bg-white/70 px-3 py-2 text-[12.5px]"
      aria-live="polite"
      data-testid="work-progress"
    >
      {s.plan && (
        <div className="mb-1.5">
          <div className="flex items-center justify-between text-[11.5px] text-[var(--color-muted)]">
            <span>
              段取り {s.plan.done}/{s.plan.total} 完了
            </span>
            {s.plan.now && <span className="truncate ml-2">いま：{s.plan.now}</span>}
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-all"
              style={{ width: `${Math.round((s.plan.done / Math.max(1, s.plan.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}
      {s.steps.map((st, i) => (
        <div key={i} className="flex items-center gap-1.5 text-[var(--color-muted)]">
          {st.state === "done" ? (
            <Check size={12} className="shrink-0 text-emerald-600" />
          ) : (
            <X size={12} className="shrink-0 text-red-500" />
          )}
          <span className="truncate">{st.text}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5 font-medium text-[var(--color-text)]">
        <Loader2 size={12} className="shrink-0 animate-spin text-[var(--color-accent)]" />
        <span className="truncate">{s.current ?? idleLabel}…</span>
      </div>
    </div>
  );
}

/** 下の状況バー用の1行（いまの作業、無ければ段取りの今、無ければ idle）。 */
export function progressLine(blocks: Block[], idleLabel: string): string {
  const s = summarizeProgress(blocks, 1);
  const head = s.current ?? s.plan?.now ?? idleLabel;
  return s.plan ? `${head}（段取り ${s.plan.done}/${s.plan.total}）` : head;
}
