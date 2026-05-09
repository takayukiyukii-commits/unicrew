"use client";

import { useEffect, useState } from "react";
import { Calendar, X, Plus, Play, Trash2, Power } from "lucide-react";
import type { Thread } from "@/lib/types";
import {
  loadRoutines,
  newRoutineId,
  saveRoutines,
  type Routine,
} from "@/lib/routines";

interface Props {
  open: boolean;
  threads: Thread[];
  /** 任意のスレッドに即実行するためのコールバック（テスト用「今すぐ実行」ボタン）。 */
  onRunNow?: (threadId: string, prompt: string) => void;
  onClose: () => void;
}

/**
 * アイデア14: ルーティーン管理モーダル。
 *
 * 毎日HH:MMに指定スレッドへプロンプトを送るルーティーンの登録・有効化・削除UI。
 */
export function RoutinesModal({ open, threads, onRunNow, onClose }: Props) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [draft, setDraft] = useState({
    label: "",
    threadId: threads[0]?.id ?? "",
    prompt: "",
    hour: "09",
    minute: "00",
  });

  useEffect(() => {
    if (open) setRoutines(loadRoutines());
  }, [open]);

  useEffect(() => {
    if (!draft.threadId && threads[0]) {
      setDraft((d) => ({ ...d, threadId: threads[0].id }));
    }
  }, [threads, draft.threadId]);

  const persist = (next: Routine[]) => {
    setRoutines(next);
    saveRoutines(next);
  };

  const add = () => {
    if (!draft.label.trim() || !draft.prompt.trim() || !draft.threadId) return;
    const r: Routine = {
      id: newRoutineId(),
      label: draft.label.trim(),
      threadId: draft.threadId,
      prompt: draft.prompt.trim(),
      schedule: {
        type: "daily",
        hour: parseInt(draft.hour, 10),
        minute: parseInt(draft.minute, 10),
      },
      enabled: true,
      createdAt: Date.now(),
    };
    persist([r, ...routines]);
    setDraft({
      label: "",
      threadId: threads[0]?.id ?? "",
      prompt: "",
      hour: "09",
      minute: "00",
    });
  };

  const toggle = (id: string) => {
    persist(
      routines.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      ),
    );
  };

  const remove = (id: string) => {
    persist(routines.filter((r) => r.id !== id));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="shrink-0 px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <Calendar size={16} className="text-[var(--color-accent)]" />
          <h2 className="font-bold text-[15px] flex-1">
            ルーティーン（毎日定期実行）
          </h2>
          <span className="text-[11px] text-[var(--color-muted)]">
            {routines.filter((r) => r.enabled).length} 有効 / {routines.length} 登録
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label="閉じる"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]/40 text-[11.5px] text-[var(--color-muted)] leading-relaxed">
          UNICREWを起動している間、毎日指定の時刻に該当スレッドへプロンプトを自動送信します。
          PC スリープ中は発火しませんが、起動後の同日中に該当時刻を過ぎていれば1回だけまとめて実行されます。
        </div>

        {/* 新規ルーティーン追加フォーム */}
        <div className="px-4 py-3 border-b border-[var(--color-border)] space-y-1.5">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={draft.label}
              onChange={(e) =>
                setDraft({ ...draft, label: e.target.value })
              }
              placeholder="ラベル（例: 朝の議題ブリーフ）"
              className="flex-1 border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white outline-none focus:border-[var(--color-accent)]"
            />
            <select
              value={draft.threadId}
              onChange={(e) =>
                setDraft({ ...draft, threadId: e.target.value })
              }
              className="border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white"
            >
              {threads.length === 0 && (
                <option value="">（先にスレッドを作成）</option>
              )}
              {threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <select
              value={draft.hour}
              onChange={(e) => setDraft({ ...draft, hour: e.target.value })}
              className="border border-[var(--color-border)] rounded-md px-1 py-1 text-[12px] bg-white"
            >
              {Array.from({ length: 24 }).map((_, i) => (
                <option key={i} value={String(i).padStart(2, "0")}>
                  {String(i).padStart(2, "0")}
                </option>
              ))}
            </select>
            <span className="self-center text-[12px]">:</span>
            <select
              value={draft.minute}
              onChange={(e) =>
                setDraft({ ...draft, minute: e.target.value })
              }
              className="border border-[var(--color-border)] rounded-md px-1 py-1 text-[12px] bg-white"
            >
              {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                <option key={m} value={String(m).padStart(2, "0")}>
                  {String(m).padStart(2, "0")}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            rows={2}
            placeholder="送信するプロンプト（例：今日のXトレンドを5件まとめて）"
            className="w-full resize-none border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={add}
            disabled={
              !draft.label.trim() ||
              !draft.prompt.trim() ||
              !draft.threadId
            }
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-[12px] font-medium disabled:opacity-30"
          >
            <Plus size={11} />
            ルーティーンを追加
          </button>
        </div>

        <div className="flex-1 overflow-y-auto unicrew-scroll px-3 py-2 space-y-1.5">
          {routines.length === 0 ? (
            <div className="text-[12px] text-[var(--color-muted)] py-4 text-center">
              まだルーティーンはありません。上のフォームから追加してください。
            </div>
          ) : (
            routines.map((r) => {
              const t = threads.find((x) => x.id === r.threadId);
              return (
                <div
                  key={r.id}
                  className={`border rounded-md p-2 ${
                    r.enabled
                      ? "border-[var(--color-border)] bg-white"
                      : "border-gray-200 bg-gray-50/60 opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-2 text-[12.5px]">
                    <span className="font-mono text-[var(--color-accent)] tabular-nums">
                      {String(r.schedule.hour).padStart(2, "0")}:
                      {String(r.schedule.minute).padStart(2, "0")}
                    </span>
                    <span className="font-medium truncate flex-1">
                      {r.label}
                    </span>
                    <span className="text-[10.5px] text-[var(--color-muted)] truncate max-w-[120px]">
                      {t?.title ?? "(削除済みスレッド)"}
                    </span>
                    {onRunNow && (
                      <button
                        type="button"
                        onClick={() => onRunNow(r.threadId, r.prompt)}
                        className="p-0.5 rounded hover:bg-emerald-50 text-emerald-600"
                        title="今すぐ実行（テスト）"
                      >
                        <Play size={11} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggle(r.id)}
                      className={`p-0.5 rounded ${
                        r.enabled
                          ? "text-emerald-600 hover:bg-emerald-50"
                          : "text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
                      }`}
                      title={r.enabled ? "一時停止" : "再開"}
                    >
                      <Power size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(r.id)}
                      className="p-0.5 rounded hover:bg-red-50 text-red-500"
                      title="削除"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--color-muted)] line-clamp-2">
                    {r.prompt}
                  </div>
                  {r.schedule.lastFiredDay && (
                    <div className="mt-0.5 text-[10px] text-[var(--color-muted)]">
                      最終発火: {r.schedule.lastFiredDay}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
