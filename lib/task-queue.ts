"use client";

import { nanoid } from "nanoid";
import type { QueuedTask, TaskStatus } from "./types";

const STORAGE_KEY = "unicrew.task_queue.v1";

export function loadTaskQueue(): QueuedTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedTask[];
  } catch {
    return [];
  }
}

export function saveTaskQueue(tasks: QueuedTask[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

export function newTaskId(): string {
  return "task-" + nanoid(8);
}

/**
 * 文字列を改行区切りで複数タスクに分割する。
 * 空行は無視。先頭の "- " "* " "1. " 等のリスト記号は剥がす。
 */
export function splitToTasks(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, ""))
    .filter((line) => line.length > 0);
}

export function makeQueuedTask(
  threadId: string,
  prompt: string,
  label?: string,
): QueuedTask {
  return {
    id: newTaskId(),
    threadId,
    prompt,
    label: label ?? deriveLabel(prompt),
    status: "pending",
    createdAt: Date.now(),
  };
}

function deriveLabel(prompt: string): string {
  const single = prompt.replace(/\s+/g, " ").trim();
  return single.length <= 40 ? single : single.slice(0, 40) + "…";
}

/** 次に実行すべきタスクを返す（同じthread内で1件ずつ）。 */
export function nextPendingTask(
  tasks: QueuedTask[],
  threadId?: string,
): QueuedTask | undefined {
  return tasks.find(
    (t) => t.status === "pending" && (!threadId || t.threadId === threadId),
  );
}

export function updateTaskStatus(
  tasks: QueuedTask[],
  id: string,
  status: TaskStatus,
  patch?: Partial<QueuedTask>,
): QueuedTask[] {
  return tasks.map((t) =>
    t.id === id
      ? {
          ...t,
          status,
          ...patch,
          ...(status === "running" ? { startedAt: Date.now() } : {}),
          ...(status === "completed" || status === "failed" || status === "skipped"
            ? { finishedAt: Date.now() }
            : {}),
        }
      : t,
  );
}

export function removeTask(tasks: QueuedTask[], id: string): QueuedTask[] {
  return tasks.filter((t) => t.id !== id);
}

export function clearFinishedTasks(tasks: QueuedTask[]): QueuedTask[] {
  return tasks.filter(
    (t) => t.status !== "completed" && t.status !== "skipped",
  );
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "待機中",
  running: "実行中",
  completed: "完了",
  failed: "エラー",
  skipped: "スキップ",
};
