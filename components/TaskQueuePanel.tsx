"use client";

import { useEffect, useState } from "react";
import {
  ListChecks,
  Play,
  X,
  CheckCircle2,
  AlertCircle,
  SkipForward,
  Loader2,
  Plus,
  Trash2,
  RotateCcw,
} from "lucide-react";
import clsx from "clsx";
import type { QueuedTask, TaskStatus } from "@/lib/types";
import {
  TASK_STATUS_LABEL,
  loadTaskQueue,
  makeQueuedTask,
  nextPendingTask,
  removeTask,
  saveTaskQueue,
  splitToTasks,
  updateTaskStatus,
  clearFinishedTasks,
} from "@/lib/task-queue";

interface Props {
  /** 現在のスレッドID（タスクを紐づけるため） */
  threadId: string | null;
  /** ストリーム中なら true。タスクの自動進行はこの値が false になったタイミングで動く。 */
  isStreaming: boolean;
  /** 1件のタスクを送信実行する。完了は isStreaming=false になることで検知。 */
  onRunTask: (prompt: string) => void;
  /**
   * 直近の assistant メッセージ。エラーメッセージを検知して failed に振るために使う。
   * "**起動エラー**" / "**エラー**" などで始まると失敗扱い。
   */
  lastAssistantText?: string | null;
  /** パネルを閉じる */
  onClose: () => void;
}

const ERROR_PREFIXES = ["**エラー**", "**起動エラー**"];

function looksLikeError(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return ERROR_PREFIXES.some((p) => trimmed.startsWith(p));
}

export function TaskQueuePanel({
  threadId,
  isStreaming,
  onRunTask,
  lastAssistantText,
  onClose,
}: Props) {
  const [tasks, setTasks] = useState<QueuedTask[]>([]);
  const [bulkInput, setBulkInput] = useState("");
  const [autoRun, setAutoRun] = useState(true);
  /** "all" | "active"（待機+実行中）| "failed" の表示フィルタ */
  const [filter, setFilter] = useState<"all" | "active" | "failed">("all");
  /** 失敗時のエラー全文を展開表示する taskId のセット */
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(
    () => new Set(),
  );

  // 初回load
  useEffect(() => {
    setTasks(loadTaskQueue());
  }, []);

  // tasks 変更時に保存
  useEffect(() => {
    saveTaskQueue(tasks);
  }, [tasks]);

  // 自動進行：isStreaming が false に落ちたら、次の pending を実行する
  useEffect(() => {
    if (!autoRun) return;
    if (!threadId) return;
    if (isStreaming) return;
    // 既に running のものは isStreaming=false になった時点で完了したとみなす。
    // ただし直近の assistant メッセージがエラー文言で始まっていれば failed に振る。
    setTasks((prev) => {
      const running = prev.find(
        (t) => t.status === "running" && t.threadId === threadId,
      );
      if (!running) return prev;
      if (looksLikeError(lastAssistantText)) {
        return updateTaskStatus(prev, running.id, "failed", {
          error: lastAssistantText?.slice(0, 200),
        });
      }
      return updateTaskStatus(prev, running.id, "completed");
    });
    // 次の pending を発射（少し遅延を置いてfinalizeDraftの伝搬を待つ）
    const timer = setTimeout(() => {
      setTasks((prev) => {
        const next = nextPendingTask(prev, threadId);
        if (!next) return prev;
        onRunTask(next.prompt);
        return updateTaskStatus(prev, next.id, "running");
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [isStreaming, autoRun, threadId, onRunTask, lastAssistantText]);

  const addBulk = () => {
    if (!threadId) return;
    const lines = splitToTasks(bulkInput);
    if (lines.length === 0) return;
    const newTasks = lines.map((p) => makeQueuedTask(threadId, p));
    setTasks((prev) => [...prev, ...newTasks]);
    setBulkInput("");
  };

  const runNow = (id: string) => {
    if (!threadId) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    onRunTask(task.prompt);
    setTasks((prev) => updateTaskStatus(prev, id, "running"));
  };

  const skip = (id: string) => {
    setTasks((prev) => updateTaskStatus(prev, id, "skipped"));
  };

  const remove = (id: string) => {
    setTasks((prev) => removeTask(prev, id));
    setExpandedErrors((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  };

  /** 失敗したタスクを pending に戻す（自動進行に再投入される）。 */
  const retry = (id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              status: "pending" as const,
              error: undefined,
              startedAt: undefined,
              finishedAt: undefined,
            }
          : t,
      ),
    );
  };

  const toggleErrorExpanded = (id: string) => {
    setExpandedErrors((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const clearFinished = () => {
    setTasks((prev) => clearFinishedTasks(prev));
  };

  const threadTasks = threadId
    ? tasks.filter((t) => t.threadId === threadId)
    : tasks;
  const pendingCount = threadTasks.filter((t) => t.status === "pending").length;
  const runningCount = threadTasks.filter((t) => t.status === "running").length;
  const failedCount = threadTasks.filter((t) => t.status === "failed").length;
  const visibleTasks = threadTasks.filter((t) => {
    if (filter === "failed") return t.status === "failed";
    if (filter === "active")
      return t.status === "pending" || t.status === "running";
    return true;
  });

  return (
    <div className="border-t border-[var(--color-border)] bg-white">
      <div className="px-3 py-1.5 flex items-center gap-2 text-[11.5px] border-b border-[var(--color-border)] bg-[var(--color-surface)]/40">
        <ListChecks size={12} className="text-[var(--color-muted)] shrink-0" />
        <span className="font-semibold">タスクキュー</span>
        <span className="text-[var(--color-muted)]">
          待機 {pendingCount} / 実行中 {runningCount}
          {failedCount > 0 && (
            <>
              {" / "}
              <span className="text-red-600 font-semibold">
                失敗 {failedCount}
              </span>
            </>
          )}
        </span>

        {/* 表示フィルタ */}
        <div className="flex items-center gap-0.5 ml-1">
          <FilterBtn
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label="全部"
          />
          <FilterBtn
            active={filter === "active"}
            onClick={() => setFilter("active")}
            label="アクティブ"
          />
          <FilterBtn
            active={filter === "failed"}
            onClick={() => setFilter("failed")}
            label="失敗"
            danger
          />
        </div>

        <label className="ml-auto flex items-center gap-1 text-[10.5px] text-[var(--color-muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={autoRun}
            onChange={(e) => setAutoRun(e.target.checked)}
            className="h-3 w-3"
          />
          自動進行
        </label>
        <button
          type="button"
          onClick={clearFinished}
          className="text-[10.5px] text-[var(--color-muted)] hover:text-red-500 inline-flex items-center gap-0.5"
          title="完了済みタスクを消す（失敗ログは残る）"
        >
          <Trash2 size={11} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 rounded hover:bg-red-50 text-[var(--color-muted)] hover:text-red-500"
          title="閉じる"
          aria-label="閉じる"
        >
          <X size={12} />
        </button>
      </div>

      <div className="px-3 py-2 max-h-[220px] overflow-y-auto unicrew-scroll">
        {visibleTasks.length === 0 ? (
          <div className="text-[11.5px] text-[var(--color-muted)] py-2 text-center">
            {filter === "failed"
              ? "失敗したタスクはありません。"
              : threadTasks.length === 0
              ? "タスクは空です。下の入力欄に複数行で書くと、1行＝1タスクとして並びます。"
              : "条件に合うタスクはありません。"}
          </div>
        ) : (
          <ul className="space-y-1">
            {visibleTasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onRun={() => runNow(t.id)}
                onSkip={() => skip(t.id)}
                onRemove={() => remove(t.id)}
                onRetry={() => retry(t.id)}
                onToggleError={() => toggleErrorExpanded(t.id)}
                errorExpanded={expandedErrors.has(t.id)}
                disableRun={isStreaming}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="px-3 py-2 border-t border-[var(--color-border)] flex items-end gap-1.5">
        <textarea
          value={bulkInput}
          onChange={(e) => setBulkInput(e.target.value)}
          rows={2}
          placeholder="タスクを追加（1行＝1件）。例：
- README.mdを読んでまとめて
- テストを実行して結果を要約
- ChatPaneのN-way対応を確認"
          className="flex-1 resize-none bg-white border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="button"
          onClick={addBulk}
          disabled={!threadId || !bulkInput.trim()}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-[11.5px] font-medium disabled:opacity-30"
          title="まとめて追加"
        >
          <Plus size={11} />
          追加
        </button>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onRun,
  onSkip,
  onRemove,
  onRetry,
  onToggleError,
  errorExpanded,
  disableRun,
}: {
  task: QueuedTask;
  onRun: () => void;
  onSkip: () => void;
  onRemove: () => void;
  onRetry: () => void;
  onToggleError: () => void;
  errorExpanded: boolean;
  disableRun: boolean;
}) {
  const status: TaskStatus = task.status;
  const hasError = status === "failed" && !!task.error;
  return (
    <li
      className={clsx(
        "rounded group",
        status === "failed" && "bg-red-50/40 border border-red-200",
      )}
    >
      <div className="flex items-center gap-1.5 text-[12px] px-1.5 py-1 hover:bg-[var(--color-surface)]/40">
        <StatusIcon status={status} />
        <button
          type="button"
          onClick={hasError ? onToggleError : undefined}
          className={clsx(
            "flex-1 min-w-0 truncate text-left",
            status === "completed" && "line-through text-[var(--color-muted)]",
            status === "skipped" && "line-through text-[var(--color-muted)]",
            status === "failed" && "text-red-700",
            hasError && "cursor-pointer hover:underline",
          )}
          title={hasError ? "クリックでエラー全文を表示" : task.prompt}
        >
          {task.label ?? task.prompt}
        </button>
        <span className="shrink-0 text-[10px] text-[var(--color-muted)] tabular-nums">
          {TASK_STATUS_LABEL[status]}
        </span>
        <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
          {status === "pending" && (
            <button
              type="button"
              onClick={onRun}
              disabled={disableRun}
              title="今すぐ実行"
              className="p-0.5 rounded hover:bg-emerald-50 text-emerald-600 disabled:opacity-30"
            >
              <Play size={11} />
            </button>
          )}
          {status === "pending" && (
            <button
              type="button"
              onClick={onSkip}
              title="スキップ"
              className="p-0.5 rounded hover:bg-amber-50 text-amber-600"
            >
              <SkipForward size={11} />
            </button>
          )}
          {status === "failed" && (
            <button
              type="button"
              onClick={onRetry}
              title="再実行（pendingに戻す）"
              className="p-0.5 rounded hover:bg-emerald-50 text-emerald-600"
            >
              <RotateCcw size={11} />
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            title="削除"
            className="p-0.5 rounded hover:bg-red-50 text-red-500"
          >
            <X size={11} />
          </button>
        </span>
      </div>
      {hasError && errorExpanded && (
        <div className="px-2 pb-1.5 -mt-0.5">
          <pre className="bg-red-100/60 text-red-900 text-[10.5px] p-1.5 rounded font-mono whitespace-pre-wrap break-all">
            {task.error}
          </pre>
        </div>
      )}
    </li>
  );
}

function FilterBtn({
  active,
  onClick,
  label,
  danger = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "px-1.5 py-0.5 rounded text-[10.5px] transition border",
        active
          ? danger
            ? "bg-red-100 text-red-700 border-red-200"
            : "bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-[var(--color-accent)]"
          : "bg-transparent text-[var(--color-muted)] border-transparent hover:bg-[var(--color-surface)]",
      )}
    >
      {label}
    </button>
  );
}

function StatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case "running":
      return <Loader2 size={11} className="animate-spin text-[var(--color-accent)] shrink-0" />;
    case "completed":
      return <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />;
    case "failed":
      return <AlertCircle size={11} className="text-red-500 shrink-0" />;
    case "skipped":
      return <SkipForward size={11} className="text-amber-500 shrink-0" />;
    default:
      return (
        <span className="h-[10px] w-[10px] rounded-full border border-[var(--color-border)] shrink-0" />
      );
  }
}
