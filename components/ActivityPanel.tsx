"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Terminal, Check, X as XIcon, Loader2 } from "lucide-react";
import type { Block, Message, ToolUseBlock } from "@/lib/types";

interface Props {
  messages: Message[];
  /** 進行中の draft からも tool 使用を拾うため。 */
  draftBlocks?: Block[];
  /** ChatPane の bottom に貼る用なので max height を抑える。 */
  maxHeightPx?: number;
}

interface Entry {
  id: string;
  ts: number;
  toolName: string;
  status: ToolUseBlock["status"];
  isError?: boolean;
  summary: string;
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  const i = input ?? {};
  switch (toolName) {
    case "Bash":
      return String(i.command ?? "").slice(0, 240);
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return String(i.file_path ?? i.notebook_path ?? "");
    case "Glob":
      return `pattern: ${String(i.pattern ?? "")}`;
    case "Grep": {
      const pat = String(i.pattern ?? "");
      const path = i.path ? ` in ${i.path}` : "";
      return `${pat}${path}`;
    }
    case "WebFetch":
      return String(i.url ?? "");
    case "WebSearch":
      return String(i.query ?? "");
    case "TodoWrite": {
      const todos = Array.isArray(i.todos) ? (i.todos as unknown[]) : [];
      return `${todos.length} 件のタスク`;
    }
    default:
      return JSON.stringify(i).slice(0, 160);
  }
}

function statusGlyph(status: ToolUseBlock["status"]) {
  if (status === "completed") return { ch: Check, color: "text-emerald-400" };
  if (status === "errored" || status === "denied")
    return { ch: XIcon, color: "text-red-400" };
  return { ch: Loader2, color: "text-amber-300", spin: true };
}

/**
 * 直近のツール使用（コード編集・コマンド・検索）をターミナル風に時系列で表示するパネル。
 * ChatPane 下部に貼る想定。collapsible。
 */
export function ActivityPanel({
  messages,
  draftBlocks = [],
  maxHeightPx = 220,
}: Props) {
  const [open, setOpen] = useState(true);

  const entries: Entry[] = useMemo(() => {
    const out: Entry[] = [];
    for (const m of messages) {
      const ts = m.createdAt;
      const blocks = m.blocks ?? [];
      for (const b of blocks) {
        if (b.kind !== "tool_use") continue;
        out.push({
          id: b.toolUseId,
          ts,
          toolName: b.toolName,
          status: b.status,
          isError: b.isError,
          summary: summarize(b.toolName, b.input),
        });
      }
    }
    // 進行中の draft の tool_use ブロックも末尾に
    const draftTs = Date.now();
    for (const b of draftBlocks) {
      if (b.kind !== "tool_use") continue;
      out.push({
        id: b.toolUseId,
        ts: draftTs,
        toolName: b.toolName,
        status: b.status,
        isError: b.isError,
        summary: summarize(b.toolName, b.input),
      });
    }
    return out.slice(-200); // 最大200件まで
  }, [messages, draftBlocks]);

  if (entries.length === 0) return null;

  const completedCount = entries.filter((e) => e.status === "completed").length;
  const runningCount = entries.filter(
    (e) => e.status === "pending" || e.status === "approved",
  ).length;

  return (
    <div className="border-t border-[var(--color-border)] bg-[#0f172a] text-slate-100 font-mono text-[11.5px] leading-tight">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-300 hover:bg-white/5"
      >
        <Terminal size={12} className="text-emerald-400" />
        <span className="font-semibold">ターミナル / アクティビティ</span>
        <span className="text-slate-500">
          {entries.length} 件 ・ ✓ {completedCount}
          {runningCount > 0 && ` ・ ⏳ ${runningCount}`}
        </span>
        <ChevronDown
          size={12}
          className={`ml-auto transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          className="overflow-y-auto px-3 py-1.5"
          style={{ maxHeight: maxHeightPx }}
        >
          <ul className="space-y-0.5">
            {entries.map((e) => {
              const sg = statusGlyph(e.status);
              const Icon = sg.ch;
              return (
                <li
                  key={e.id + "-" + e.ts}
                  className="flex items-start gap-2 whitespace-pre"
                >
                  <span className="text-slate-500 shrink-0 select-none">
                    {formatHHMMSS(e.ts)}
                  </span>
                  <Icon
                    size={11}
                    className={`shrink-0 mt-[2px] ${sg.color} ${sg.spin ? "animate-spin" : ""}`}
                  />
                  <span className="text-amber-300 shrink-0">{e.toolName}</span>
                  <span className="text-slate-300 break-all whitespace-pre-wrap">
                    {e.summary}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatHHMMSS(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
