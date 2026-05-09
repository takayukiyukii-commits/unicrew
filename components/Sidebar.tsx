"use client";

import {
  Plus,
  Trash2,
  Settings,
  FolderOpen,
  Loader2,
  Columns2,
  Puzzle,
  Search,
  X,
} from "lucide-react";
import { useState, useMemo } from "react";
import type { Thread } from "@/lib/types";
import { getCharacter } from "@/lib/characters";
import { CharacterAvatar } from "./CharacterAvatar";
import clsx from "clsx";

export type MainView = "chat" | "addons";

interface Props {
  threads: Thread[];
  activeThreadId: string | null;
  /** 並列ペイン（右側）に開かれているスレッド ID。null なら単一ペイン。 */
  splitThreadId?: string | null;
  /** 現在ストリーミング中のスレッド ID 集合（裏で動いてるスレッドにスピナーを出す）。 */
  streamingThreadIds?: ReadonlySet<string>;
  /** 通常クリック = 主ペインに開く。Ctrl/Cmd+クリック = 並列ペインに開く。 */
  onSelect: (id: string, modifiers?: { intoSplit?: boolean }) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  /** 現在中央に表示している view。"addons" の場合はサイドバーのプラグインボタンをアクティブ化。 */
  mainView?: MainView;
  /** プラグイン/スキル/MCP のページに切替 */
  onOpenAddons?: () => void;
}

export function Sidebar({
  threads,
  activeThreadId,
  splitThreadId = null,
  streamingThreadIds,
  onSelect,
  onCreate,
  onDelete,
  onOpenSettings,
  mainView = "chat",
  onOpenAddons,
}: Props) {
  /** アイデア11: 全スレッド横断検索（最小実装：In-Memoryでタイトル＋メッセージ全文grep） */
  const [searchQuery, setSearchQuery] = useState("");
  const sorted = useMemo(() => {
    const all = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter((t) => {
      if (t.title.toLowerCase().includes(q)) return true;
      return t.messages.some((m) => m.content.toLowerCase().includes(q));
    });
  }, [threads, searchQuery]);
  return (
    <aside className="w-64 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-tight">UNICREW</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-medium">
            β
          </span>
        </div>
      </div>

      <button
        onClick={onCreate}
        className="mx-3 mt-3 flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] text-white py-2 text-sm font-medium hover:opacity-90 transition"
      >
        <Plus size={16} />
        新しい会話
      </button>

      {/* アイデア11: 全スレッド横断検索バー */}
      <div className="mx-3 mt-2 relative">
        <Search
          size={11}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-muted)] pointer-events-none"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="全スレッド検索…"
          className="w-full pl-7 pr-7 py-1.5 text-[12px] border border-[var(--color-border)] rounded-md bg-white outline-none focus:border-[var(--color-accent)]"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)]"
            aria-label="検索クリア"
          >
            <X size={11} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-0.5 unicrew-scroll">
        {sorted.length === 0 && (
          <div className="px-3 py-6 text-xs text-[var(--color-muted)] text-center">
            {searchQuery
              ? "該当するスレッドはありません。"
              : "会話はまだありません。\n「新しい会話」から始めましょう。"}
          </div>
        )}
        {sorted.map((t) => {
          const character = getCharacter(t.characterId);
          const isActive = t.id === activeThreadId;
          const isInSplit = t.id === splitThreadId;
          const isStreaming = streamingThreadIds?.has(t.id) ?? false;
          const wsName = t.workspace?.split(/[/\\]/).pop() ?? null;
          return (
            <div
              key={t.id}
              className={clsx(
                "group flex items-start gap-2 px-2 py-2 rounded-md cursor-pointer text-sm border",
                isActive
                  ? "bg-white border-[var(--color-border)] shadow-sm"
                  : isInSplit
                    ? "bg-white/80 border-[var(--color-accent)]/40"
                    : "border-transparent hover:bg-white/60",
              )}
              onClick={(e) =>
                onSelect(t.id, { intoSplit: e.ctrlKey || e.metaKey })
              }
              title={
                isInSplit
                  ? "並列ペインに表示中（Ctrl/⌘+クリックで主ペインへ）"
                  : "クリックで主ペイン、Ctrl/⌘+クリックで並列ペインに開く"
              }
            >
              <CharacterAvatar character={character} size={26} className="mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="truncate text-[13px] font-medium text-[var(--color-text)]">
                    {t.title}
                  </span>
                  {isStreaming && (
                    <Loader2
                      size={11}
                      className="shrink-0 text-[var(--color-accent)] animate-spin"
                      aria-label="応答中"
                    />
                  )}
                  {isInSplit && (
                    <Columns2
                      size={11}
                      className="shrink-0 text-[var(--color-accent)]"
                      aria-label="並列ペインに表示中"
                    />
                  )}
                </div>
                <div className="truncate text-[11px] text-[var(--color-muted)]">
                  {character?.name ?? "—"}
                </div>
                {wsName && (
                  <div className="flex items-center gap-1 text-[10.5px] text-[var(--color-muted)] mt-0.5">
                    <FolderOpen size={10} />
                    <span className="truncate font-mono" title={t.workspace ?? undefined}>
                      {wsName}
                    </span>
                  </div>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(t.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-red-500 transition"
                title="このスレッドを削除（取り消し不可）"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--color-border)] p-2 space-y-0.5">
        {onOpenAddons && (
          <button
            onClick={onOpenAddons}
            className={clsx(
              "w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition",
              mainView === "addons"
                ? "bg-white text-[var(--color-accent)] font-medium shadow-sm border border-[var(--color-border)]"
                : "text-[var(--color-muted)] hover:bg-white hover:text-[var(--color-text)]",
            )}
            title="Claude / Codex のプラグイン・スキル・MCP を一覧"
          >
            <Puzzle size={15} />
            機能の追加
          </button>
        )}
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-[var(--color-muted)] hover:bg-white hover:text-[var(--color-text)] transition"
        >
          <Settings size={15} />
          設定
        </button>
      </div>
    </aside>
  );
}
