"use client";

import {
  FileEdit,
  Terminal,
  Search,
  FileText,
  Wrench,
  Check,
  X as XIcon,
  Loader2,
  ListChecks,
} from "lucide-react";
import type { ToolUseBlock } from "@/lib/types";
import { useShowActivity } from "./ActivityContext";
import { useTranslation } from "@/lib/i18n";

interface Props {
  block: ToolUseBlock;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

function iconFor(toolName: string) {
  if (toolName === "Bash") return Terminal;
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") return FileEdit;
  if (toolName === "Read") return FileText;
  if (toolName === "Grep" || toolName === "Glob") return Search;
  return Wrench;
}

function summary(toolName: string, input: Record<string, unknown>): string {
  const i = input ?? {};
  switch (toolName) {
    case "Bash":
      return String(i.command ?? "");
    case "Read":
      return String(i.file_path ?? "");
    case "Edit":
    case "Write":
    case "MultiEdit":
      return String(i.file_path ?? "");
    case "Glob":
      return String(i.pattern ?? "");
    case "Grep":
      return String(i.pattern ?? "");
    default:
      return JSON.stringify(i).slice(0, 120);
  }
}

export function ToolUseBubble({ block }: Props) {
  const { t } = useTranslation();
  const show = useShowActivity();
  if (!show) return null; // 日本語のみモード時はツール詳細を出さない
  // TodoWrite は Claude Code 風のチェックリスト表示にする。
  if (block.toolName === "TodoWrite") {
    return <TodoListBubble block={block} />;
  }
  const Icon = iconFor(block.toolName);
  const status = block.status;
  const StatusIcon =
    status === "completed"
      ? Check
      : status === "errored" || status === "denied"
        ? XIcon
        : Loader2;
  const statusColor =
    status === "completed"
      ? "text-emerald-600"
      : status === "errored" || status === "denied"
        ? "text-red-600"
        : "text-[var(--color-muted)]";
  return (
    <div className="my-1.5 inline-flex items-start gap-2 max-w-full text-[12.5px]">
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg px-2.5 py-1.5 max-w-full overflow-hidden">
        <div className="flex items-center gap-1.5 text-[var(--color-muted)]">
          <Icon size={12} />
          <span className="font-mono font-medium text-[var(--color-text)]">
            {block.toolName}
          </span>
          <StatusIcon
            size={12}
            className={`${statusColor} ${status === "pending" || status === "approved" ? "animate-spin" : ""}`}
          />
          <span className={`text-[11px] ${statusColor}`}>
            {status === "pending" && t("tool.statusPending")}
            {status === "approved" && t("tool.statusApproved")}
            {status === "completed" && t("tool.statusCompleted")}
            {status === "errored" && t("tool.statusErrored")}
            {status === "denied" && t("tool.statusDenied")}
          </span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[12px] text-[var(--color-muted)]">
          {summary(block.toolName, block.input)}
        </div>
      </div>
    </div>
  );
}

function TodoListBubble({ block }: { block: ToolUseBlock }) {
  const { t: tr } = useTranslation();
  const todosRaw = (block.input as { todos?: unknown }).todos;
  const todos: TodoItem[] = Array.isArray(todosRaw)
    ? (todosRaw.filter(
        (t) => t && typeof t === "object" && "content" in (t as object),
      ) as TodoItem[])
    : [];

  // 進捗中のタスクを見出し化（無ければ最後の pending、それも無ければ "タスク整理中"）
  const inProgress = todos.find((t) => t.status === "in_progress");
  const headline =
    inProgress?.activeForm ??
    inProgress?.content ??
    todos.find((t) => t.status === "pending")?.content ??
    tr("tool.todoOrganizing");

  const isStreaming =
    block.status === "pending" || block.status === "approved";

  return (
    <div className="my-2 max-w-full text-[12.5px]">
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-white/40">
          <ListChecks size={13} className="text-[var(--color-accent)]" />
          <span className="font-mono font-medium text-[var(--color-text)] text-[12px]">
            TodoWrite
          </span>
          {todos.length > 0 && (
            <span className="text-[10.5px] text-[var(--color-muted)]">
              {todos.filter((t) => t.status === "completed").length}/
              {todos.length}{tr("tool.todoCompletedSuffix")}
            </span>
          )}
          {isStreaming && (
            <Loader2
              size={11}
              className="text-[var(--color-muted)] animate-spin ml-auto"
            />
          )}
        </div>
        {headline && (
          <div className="px-3 pt-2 pb-1 text-[12.5px] font-medium text-[var(--color-text)] flex items-center gap-1.5">
            {isStreaming && (
              <Loader2
                size={11}
                className="text-[var(--color-accent)] animate-spin shrink-0"
              />
            )}
            <span className="truncate">{headline}</span>
          </div>
        )}
        <ul className="px-3 pb-2 space-y-0.5">
          {todos.map((t, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-[12px] leading-relaxed"
            >
              <TodoMark status={t.status} />
              <span
                className={
                  t.status === "completed"
                    ? "text-[var(--color-muted)] line-through"
                    : t.status === "in_progress"
                      ? "text-[var(--color-text)] font-medium"
                      : "text-[var(--color-text)]/80"
                }
              >
                {t.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TodoMark({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") {
    return (
      <Check size={12} className="shrink-0 mt-[2px] text-emerald-600" aria-hidden="true" />
    );
  }
  if (status === "in_progress") {
    return (
      <span
        className="shrink-0 mt-[3px] inline-block w-2.5 h-2.5 bg-[var(--color-accent)] rounded-sm"
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="shrink-0 mt-[2px] text-[var(--color-muted)] font-mono">
      ◻
    </span>
  );
}
