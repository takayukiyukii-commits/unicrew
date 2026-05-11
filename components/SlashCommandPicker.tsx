"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Slash } from "lucide-react";
import clsx from "clsx";
import type { Provider } from "@/lib/types";
import {
  SLASH_COMMANDS,
  SLASH_COMMAND_CATEGORIES,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "@/lib/slash-commands";

interface Props {
  /** いまアクティブなプロバイダ群。並列モード時は ["claude","codex"] を渡す。 */
  activeProviders: Provider[];
  /** 選択時のハンドラ。textarea に挿入してフォーカスを戻す呼び出し側を想定。 */
  onPick: (cmd: SlashCommandDef) => void;
  disabled?: boolean;
}

// プロバイダ色は lib/providerCategories の CATEGORY_COLORS に集約済み（4 色）。
// ローカルテーブルを再定義しない。新プロバイダ追加で毎回 ここを直さないため。
import { colorOf } from "@/lib/providerCategories";
import { PROVIDER_LABELS as PROVIDER_LABELS_CENTRAL } from "@/lib/types";

function providerBadge(p: Provider): { label: string; color: string } {
  return { label: PROVIDER_LABELS_CENTRAL[p], color: colorOf(p) };
}

const CATEGORY_ORDER: SlashCommandCategory[] = [
  "basic",
  "dev",
  "config",
  "info",
];

export function SlashCommandPicker({
  activeProviders,
  onPick,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // アクティブ provider に該当するコマンド + 検索フィルタ + カテゴリ別グルーピング
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => {
      const providerOk =
        activeProviders.length === 0 ||
        c.providers.some((p) => activeProviders.includes(p));
      if (!providerOk) return false;
      if (!q) return true;
      return (
        c.command.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      );
    });
    const grouped: Record<SlashCommandCategory, SlashCommandDef[]> = {
      basic: [],
      dev: [],
      config: [],
      info: [],
    };
    for (const c of matches) grouped[c.category].push(c);
    const flat: SlashCommandDef[] = [];
    for (const cat of CATEGORY_ORDER) flat.push(...grouped[cat]);
    return { grouped, flat };
  }, [query, activeProviders]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
    else {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
  }, [query, open]);

  // 矢印キーで候補移動 / Enterで決定
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered.flat[activeIndex];
      if (cmd) {
        onPick(cmd);
        setOpen(false);
      }
    }
  };

  // ハイライト中の項目をスクロール内に保つ
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-cmd-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title="スラッシュコマンドを挿入"
        className={clsx(
          "h-9 px-2 inline-flex items-center gap-1 rounded-lg border text-[11.5px] transition",
          "border-[var(--color-border)] text-[var(--color-muted)] bg-white",
          !disabled &&
            "hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
          open && "bg-[var(--color-surface)] text-[var(--color-text)]",
          disabled && "opacity-40 cursor-not-allowed",
        )}
      >
        <Slash size={13} />
        <ChevronDown size={11} className="opacity-60" />
      </button>

      {open && (
        <div
          className="absolute right-0 bottom-[calc(100%+6px)] w-[360px] max-h-[420px] flex flex-col rounded-lg border border-[var(--color-border)] bg-white shadow-xl z-50"
          role="listbox"
        >
          <div className="shrink-0 px-3 py-2 border-b border-[var(--color-border)]">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="コマンドを検索…（例：レビュー / クリア）"
              className="w-full text-[12.5px] outline-none placeholder:text-[var(--color-muted)]"
            />
          </div>

          <div ref={listRef} className="overflow-y-auto unicrew-scroll py-1">
            {filtered.flat.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-[var(--color-muted)]">
                一致するコマンドはありません
              </div>
            ) : (
              CATEGORY_ORDER.map((cat) => {
                const list = filtered.grouped[cat];
                if (list.length === 0) return null;
                return (
                  <div key={cat} className="mb-1">
                    <div className="px-3 pt-2 pb-0.5 text-[10.5px] uppercase tracking-wide text-[var(--color-muted)] font-semibold">
                      {SLASH_COMMAND_CATEGORIES[cat]}
                    </div>
                    {list.map((cmd) => {
                      const flatIndex = filtered.flat.indexOf(cmd);
                      const isActive = flatIndex === activeIndex;
                      return (
                        <button
                          key={cmd.command + cmd.label}
                          type="button"
                          data-cmd-index={flatIndex}
                          onMouseEnter={() => setActiveIndex(flatIndex)}
                          onClick={() => {
                            onPick(cmd);
                            setOpen(false);
                          }}
                          className={clsx(
                            "w-full px-3 py-1.5 flex items-start gap-2 text-left transition",
                            isActive
                              ? "bg-[var(--color-accent-soft)]"
                              : "hover:bg-[var(--color-surface)]",
                          )}
                          role="option"
                          aria-selected={isActive}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[13px] font-medium text-[var(--color-text)] truncate">
                                {cmd.label}
                              </span>
                              <span className="font-mono text-[10.5px] text-[var(--color-muted)] shrink-0">
                                {cmd.command.trim()}
                              </span>
                              <span className="ml-auto flex items-center gap-1 shrink-0">
                                {cmd.providers.map((p) => (
                                  <span
                                    key={p}
                                    className="text-[9.5px] px-1 py-0.5 rounded font-medium border"
                                    style={{
                                      color: providerBadge(p).color,
                                      borderColor: providerBadge(p).color,
                                    }}
                                  >
                                    {providerBadge(p).label}
                                  </span>
                                ))}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-[var(--color-muted)] leading-snug">
                              {cmd.description}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          <div className="shrink-0 px-3 py-1.5 border-t border-[var(--color-border)] text-[10.5px] text-[var(--color-muted)] flex items-center gap-2">
            <span>↑↓ で選択</span>
            <span>Enter で挿入</span>
            <span>Esc で閉じる</span>
          </div>
        </div>
      )}
    </div>
  );
}
