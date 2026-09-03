"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import clsx from "clsx";
import type { Thread } from "@/lib/types";
import { searchConversations, type SearchHit } from "@/lib/search";
import { useTranslation } from "@/lib/i18n";

interface Props {
  open: boolean;
  threads: Thread[];
  onClose: () => void;
  /** ヒットを選んだ（スレッドへ移動し、メッセージがあればそこへスクロール） */
  onPick: (hit: SearchHit, query: string) => void;
}

/**
 * 会話検索（v0.4.0）。全スレッドの題名と本文を部分一致で引き、上位20件を抜粋つきで出す。
 * 索引は持たない（毎回走査・ローカル完結）。Ctrl+Shift+F／コマンドパレット「会話を検索」から。
 */
export function ConversationSearchModal({ open, threads, onClose, onPick }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const hits = useMemo(() => searchConversations(threads, query, 20), [threads, query]);

  useEffect(() => {
    if (active >= hits.length) setActive(Math.max(0, hits.length - 1));
  }, [hits.length, active]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.querySelector<HTMLElement>(`[data-hit-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  const pick = (h: SearchHit | undefined) => {
    if (!h) return;
    onPick(h, query);
  };
  const roleLabel = (r: SearchHit["role"]) =>
    r === "title" ? t("search.roleTitle") : r === "user" ? t("search.roleUser") : t("search.roleAssistant");

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-label={t("search.title")}
    >
      <div className="w-full max-w-xl bg-white rounded-xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--color-border)]">
          <Search size={15} className="text-[var(--color-muted)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(hits.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(hits[active]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
            placeholder={t("search.placeholder")}
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-muted)]"
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)]"
            aria-label={t("search.close")}
          >
            <X size={14} />
          </button>
        </div>
        <div ref={listRef} className="max-h-[55vh] overflow-y-auto unicrew-scroll py-1">
          {query.trim() && hits.length === 0 && (
            <div className="px-4 py-8 text-center text-[12px] text-[var(--color-muted)]">{t("search.empty")}</div>
          )}
          {!query.trim() && (
            <div className="px-4 py-8 text-center text-[12px] text-[var(--color-muted)]">{t("search.hint")}</div>
          )}
          {hits.map((h, idx) => {
            const isActive = idx === active;
            const before = h.snippet.slice(0, h.hitStart);
            const mid = h.snippet.slice(h.hitStart, h.hitStart + h.hitLength);
            const after = h.snippet.slice(h.hitStart + h.hitLength);
            return (
              <button
                key={`${h.threadId}:${h.messageId ?? "title"}:${idx}`}
                data-hit-index={idx}
                type="button"
                onMouseEnter={() => setActive(idx)}
                onClick={() => pick(h)}
                className={clsx(
                  "w-full text-left px-3 py-2 flex flex-col gap-0.5",
                  isActive ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface)]",
                )}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[12.5px] font-medium truncate text-[var(--color-text)]">{h.threadTitle}</span>
                  <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-muted)]">
                    {roleLabel(h.role)}
                  </span>
                </div>
                <div className="text-[11.5px] text-[var(--color-muted)] truncate">
                  {before}
                  <mark className="bg-yellow-100 text-[var(--color-text)] rounded px-0.5">{mid}</mark>
                  {after}
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[10.5px] text-[var(--color-muted)]">
          <span>{t("search.footer")}</span>
          <span>{t("search.count", { count: hits.length })}</span>
        </div>
      </div>
    </div>
  );
}
