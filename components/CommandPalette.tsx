"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import clsx from "clsx";
import { fuzzyFilter, type FuzzyMatch } from "@/lib/fuzzy";
import { commandSearchText, type Command } from "@/lib/commands";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 表示時点で評価される（毎回 fresh） */
  commands: Command[];
}

function HighlightedLabel({
  text,
  positions,
  offset = 0,
}: {
  text: string;
  positions: number[];
  offset?: number;
}) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions.map((p) => p - offset));
  return (
    <>
      {Array.from(text).map((ch, i) => (
        <span
          key={i}
          className={clsx(
            set.has(i) && "text-[var(--color-accent)] font-semibold",
          )}
        >
          {ch}
        </span>
      ))}
    </>
  );
}

export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 開閉時のリセットと autofocus
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // モーダルアニメーション後に focus
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const enabled = commands.filter((c) => c.enabled !== false);
    if (!query.trim()) {
      return enabled.map((cmd) => ({
        item: cmd,
        match: { score: 0, positions: [] } as FuzzyMatch,
      }));
    }
    return fuzzyFilter(enabled, query, commandSearchText);
  }, [commands, query]);

  // active を範囲内に
  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);

  // active 行を可視範囲にスクロール
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-cmd-index="${active}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [active, open]);

  if (!open) return null;

  const runActive = () => {
    const target = filtered[active];
    if (!target) return;
    onClose();
    // Promise を捨てる（エラーは各 run 側で処理する想定）
    Promise.resolve(target.item.run()).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[command]", target.item.id, e);
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-label="コマンドパレット"
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
                setActive((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runActive();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="コマンド・キャラ・ワークスペース・スレッドを検索…"
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--color-muted)]"
          />
          <kbd className="hidden md:inline-block text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-muted)]">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          className="max-h-[55vh] overflow-y-auto unicrew-scroll py-1"
        >
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-[12px] text-[var(--color-muted)]">
              該当するコマンドがありません
            </div>
          )}
          {filtered.map(({ item, match }, idx) => {
            const Icon = item.icon;
            const isActive = idx === active;
            return (
              <button
                key={item.id}
                data-cmd-index={idx}
                onMouseEnter={() => setActive(idx)}
                onClick={() => {
                  setActive(idx);
                  runActive();
                }}
                className={clsx(
                  "w-full text-left px-3 py-2 flex items-center gap-2.5",
                  isActive ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface)]",
                )}
              >
                {Icon ? (
                  <Icon
                    size={15}
                    className={clsx(
                      "shrink-0",
                      isActive
                        ? "text-[var(--color-accent)]"
                        : "text-[var(--color-muted)]",
                    )}
                  />
                ) : (
                  <ChevronRight size={15} className="shrink-0 text-[var(--color-muted)]" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-[var(--color-text)] truncate">
                    <HighlightedLabel
                      text={item.label}
                      positions={match.positions}
                    />
                  </div>
                  {item.description && (
                    <div className="text-[11px] text-[var(--color-muted)] truncate">
                      {item.description}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-muted)]">
                    {item.category}
                  </span>
                  {item.shortcut && (
                    <kbd className="hidden md:inline-block text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-muted)]">
                      {item.shortcut}
                    </kbd>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--color-border)] bg-[var(--color-surface)] text-[10.5px] text-[var(--color-muted)]">
          <div className="flex items-center gap-2">
            <span>↑↓ で選択</span>
            <span>Enter で実行</span>
          </div>
          <div>{filtered.length} 件</div>
        </div>
      </div>
    </div>
  );
}
