"use client";

import { useEffect, useState } from "react";
import { Calendar, X, Plus, Play, Trash2, Power } from "lucide-react";
import {
  loadRoutines,
  newRoutineId,
  saveRoutines,
  markFired,
  initialLastFiredDay,
  type Routine,
} from "@/lib/routines";
import { useTranslation } from "@/lib/i18n";

interface Props {
  open: boolean;
  /** 取りまとめ役が指示を受け取れたら true。 */
  onRunNow?: (prompt: string) => boolean;
  onClose: () => void;
}

/**
 * アイデア14: ルーティーン管理モーダル。
 *
 * 毎日HH:MMに AIオフィスの取りまとめ役へ指示を送るルーティーンの登録・有効化・削除UI。
 */
export function RoutinesModal({ open, onRunNow, onClose }: Props) {
  const { t: tr } = useTranslation();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [draft, setDraft] = useState({
    label: "",
    prompt: "",
    hour: "09",
    minute: "00",
  });

  useEffect(() => {
    if (open) setRoutines(loadRoutines());
  }, [open]);

  const persist = (next: Routine[]) => {
    setRoutines(next);
    saveRoutines(next);
  };

  const add = () => {
    if (!draft.label.trim() || !draft.prompt.trim()) return;
    const hh = parseInt(draft.hour, 10);
    const mm = parseInt(draft.minute, 10);
    const r: Routine = {
      id: newRoutineId(),
      label: draft.label.trim(),
      prompt: draft.prompt.trim(),
      schedule: {
        type: "daily",
        hour: hh,
        minute: mm,
        // 監査R3: 当日の指定時刻を過ぎていれば発火済み扱いにし、作成直後の
        // 即時発火（過去時刻回収）を防ぐ
        lastFiredDay: initialLastFiredDay(hh, mm),
      },
      enabled: true,
      createdAt: Date.now(),
    };
    persist([r, ...loadRoutines()]);
    setDraft({
      label: "",
      prompt: "",
      hour: "09",
      minute: "00",
    });
  };

  const toggle = (id: string) => {
    persist(
      loadRoutines().map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      ),
    );
  };

  const remove = (id: string) => {
    persist(loadRoutines().filter((r) => r.id !== id));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="shrink-0 px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <Calendar size={16} className="text-[var(--color-accent)]" />
          <h2 className="font-bold text-[15px] flex-1">
            {tr("routines.title")}
          </h2>
          <span className="text-[11px] text-[var(--color-muted)]">
            {tr("routines.count", { enabled: routines.filter((r) => r.enabled).length, total: routines.length })}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label={tr("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]/40 text-[11.5px] text-[var(--color-muted)] leading-relaxed">
          {tr("routines.intro")}
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
              placeholder={tr("routines.labelPlaceholder")}
              className="flex-1 border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white outline-none focus:border-[var(--color-accent)]"
            />
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
            placeholder={tr("routines.promptPlaceholder")}
            className="w-full resize-none border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={add}
            disabled={
              !draft.label.trim() ||
              !draft.prompt.trim()
            }
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-[12px] font-medium disabled:opacity-30"
          >
            <Plus size={11} />
            {tr("routines.addCta")}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto unicrew-scroll px-3 py-2 space-y-1.5">
          {routines.length === 0 ? (
            <div className="text-[12px] text-[var(--color-muted)] py-4 text-center">
              {tr("routines.empty")}
            </div>
          ) : (
            routines.map((r) => {
              return (
                <div
                  key={r.id}
                  className={`border rounded-md p-2 ${
                    r.enabled
                      ? "border-[var(--color-border)] bg-white"
                      : "border-gray-200 bg-gray-50/60 opacity-60"
                  }`}
                >
                  <div className="flex items-start gap-2 text-[12.5px]">
                    <span className="font-mono text-[var(--color-accent)] tabular-nums shrink-0">
                      {String(r.schedule.hour).padStart(2, "0")}:
                      {String(r.schedule.minute).padStart(2, "0")}
                    </span>
                    {/* 【2026-08-28 修正】truncate でラベルと送り先が切れていた。
                        折り返して全文見せる。 */}
                    <span className="flex-1 min-w-0">
                      <span className="font-medium break-words">{r.label}</span>
                      <span className="ml-2 text-[10.5px] text-[var(--color-muted)] break-words">
                        {tr("routines.destination")}
                      </span>
                    </span>
                    {onRunNow && (
                      <button
                        type="button"
                        onClick={() => {
                          const accepted = onRunNow(r.prompt);
                          // 監査R3: 手動実行したら発火済みにして、同日の定期実行との
                          // 二重送信を防ぐ
                          if (accepted) persist(markFired(loadRoutines(), r.id, new Date()));
                          onClose();
                        }}
                        className="p-0.5 rounded hover:bg-emerald-50 text-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={tr("routines.runNow")}
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
                      title={r.enabled ? tr("routines.pause") : tr("routines.resume")}
                    >
                      <Power size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(r.id)}
                      className="p-0.5 rounded hover:bg-red-50 text-red-500"
                      title={tr("routines.delete")}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--color-muted)] whitespace-pre-wrap break-words">
                    {r.prompt}
                  </div>
                  {r.schedule.lastFiredDay && (
                    <div className="mt-0.5 text-[10px] text-[var(--color-muted)]">
                      {tr("routines.lastFired", { day: r.schedule.lastFiredDay })}
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
