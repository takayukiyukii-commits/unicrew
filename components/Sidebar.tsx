"use client";

import { Archive, Building2, ChevronDown, ChevronRight, FolderTree, Puzzle, Settings, SquareTerminal, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Thread } from "@/lib/types";
import { useTranslation } from "@/lib/i18n";
import clsx from "clsx";

export type MainView = "office" | "past" | "addons" | "terminal";
interface Props {
  threads: Thread[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onOpenOffice: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  mainView: MainView;
  onOpenAddons: () => void;
  onOpenTerminal: () => void;
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  collapsed: boolean;
  onExpand: () => void;
}

export function Sidebar({ threads, activeThreadId, onSelect, onOpenOffice, onDelete, onOpenSettings, mainView, onOpenAddons, onOpenTerminal, explorerOpen, onToggleExplorer, collapsed, onExpand }: Props) {
  const { t } = useTranslation();
  const [showPast, setShowPast] = useState(false);
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const buttonClass = (active: boolean) => clsx("w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition", collapsed && "justify-center px-1", active ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-text)] hover:bg-white");
  return (
    <aside className={clsx("shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col", collapsed ? "w-12" : "w-64")}>
      {collapsed ? <button type="button" onClick={onExpand} className="py-3 font-bold border-b border-[var(--color-border)]" aria-label={t("sidebar.expandShort")} title={t("sidebar.expand")}>U</button>
        : <div className="px-4 py-3 font-bold text-lg border-b border-[var(--color-border)]">UNICREW</div>}
      <div className={clsx("space-y-2 py-3", collapsed ? "px-1" : "px-3")}>
        <button type="button" className={buttonClass(mainView === "office")} onClick={onOpenOffice} title={t("sidebar.office")} aria-label={t("sidebar.office")}><Building2 size={16} />{!collapsed && t("sidebar.office")}</button>
        <button type="button" className={buttonClass(mainView === "terminal")} onClick={onOpenTerminal} title={t("sidebar.terminal")} aria-label={t("sidebar.terminal")}><SquareTerminal size={16} />{!collapsed && t("sidebar.terminal")}</button>
      </div>
      {threads.length > 0 && <button type="button" onClick={() => { if (collapsed) onExpand(); setShowPast((value) => collapsed || !value); }} aria-expanded={showPast && !collapsed}
        aria-label={t("sidebar.pastConversations")} title={t("sidebar.pastConversationsHint")} className="mx-3 flex items-center gap-1 text-xs text-[var(--color-muted)]">
        {collapsed ? <Archive size={16} /> : <>{showPast ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{t("sidebar.pastConversations")}（{threads.length}）</>}
      </button>}
      <div className="flex-1 min-h-0 overflow-y-auto unicrew-scroll px-2 py-3 space-y-1">
        {!collapsed && showPast && sorted.map((thread) => (
          <div key={thread.id} className={clsx("flex items-center rounded-md border", mainView === "past" && thread.id === activeThreadId ? "bg-white border-[var(--color-border)]" : "border-transparent hover:bg-white/60")}>
            <button type="button" onClick={() => onSelect(thread.id)} className="flex-1 min-w-0 text-left px-2 py-2 text-sm break-words">{thread.title || t("sidebar.pastConversations")}</button>
            <button type="button" onClick={() => onDelete(thread.id)} className="p-2 text-red-500 rounded hover:bg-red-50" title={t("sidebar.deleteThread")} aria-label={t("sidebar.deleteThread")}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--color-border)] p-2 space-y-1">
        <button type="button" className={buttonClass(explorerOpen)} onClick={onToggleExplorer} title={t("sidebar.explorer")} aria-label={t("sidebar.explorer")}><FolderTree size={15} />{!collapsed && t("sidebar.explorer")}</button>
        <button type="button" className={buttonClass(mainView === "addons")} onClick={onOpenAddons} title={t("sidebar.addons")} aria-label={t("sidebar.addons")}><Puzzle size={15} />{!collapsed && t("sidebar.addons")}</button>
        <button type="button" className={buttonClass(false)} onClick={onOpenSettings} title={t("sidebar.settings")} aria-label={t("sidebar.settings")}><Settings size={15} />{!collapsed && t("sidebar.settings")}</button>
      </div>
    </aside>
  );
}
