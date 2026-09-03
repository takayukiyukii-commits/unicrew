"use client";

import { History, X, FolderOpen } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { getCharacter } from "@/lib/characters";
import type { RestoreTarget } from "@/lib/checkpoint";

interface Props {
  open: boolean;
  /** 何ターン目の発言か（1始まり） */
  turn: number;
  /** その発言の冒頭 */
  excerpt: string;
  targets: RestoreTarget[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * チェックポイント／巻き戻し（v0.4.0）の確認モーダル。
 * ネイティブダイアログは使わない（他プロセスのキー入力で幽霊クリックが起きる・このPCは並行自動化前提）。
 * 戻すのはファイルだけ。会話は消さない。HEAD・index・ブランチも動かさない。
 */
export function RestoreCheckpointModal({ open, turn, excerpt, targets, busy, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  if (!open) return null;
  const nameOf = (x: RestoreTarget) =>
    x.slot ? (getCharacter(x.slot.characterId)?.name ?? x.key) : t("restore.workspace");
  return (
    <div
      className="fixed inset-0 z-[58] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-label={t("restore.title")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col">
        <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History size={16} className="text-[var(--color-accent)]" />
            <div className="text-[14px] font-semibold">{t("restore.title")}</div>
          </div>
          <button
            onClick={onCancel}
            disabled={busy}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] disabled:opacity-50"
            title={t("restore.cancel")}
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)]">
            <div className="text-[11px] text-[var(--color-muted)]">{t("restore.turn", { turn })}</div>
            <div className="text-[12.5px] truncate" title={excerpt}>
              {excerpt || "…"}
            </div>
          </div>
          <ul className="space-y-1">
            {targets.map((x) => (
              <li key={x.key} className="flex items-center gap-2 text-[12px]">
                <FolderOpen size={13} className="shrink-0 text-[var(--color-muted)]" />
                <span className="shrink-0 font-medium">{nameOf(x)}</span>
                <code className="min-w-0 truncate font-mono text-[11px] text-[var(--color-muted)]" title={x.cwd}>
                  {x.cwd}
                </code>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
            {t("restore.bodyA")}
            <strong className="text-[var(--color-text)]"> {t("restore.bodyB")} </strong>
            {t("restore.bodyC")}
          </p>
          {/* 2026-09-04 監査: 「記録に無いファイルは消える」ことを押す前に伝える（完了後の件数表示だけでは遅い） */}
          <p className="text-[12px] text-amber-600 dark:text-amber-500 leading-relaxed">
            {t("restore.bodyD")}
          </p>
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col gap-2">
          <button
            onClick={onConfirm}
            disabled={busy || targets.length === 0}
            className="w-full flex items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] text-white py-2 text-[13px] font-medium hover:opacity-90 disabled:opacity-50"
          >
            <History size={14} />
            {busy ? t("restore.working") : t("restore.confirm")}
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="w-full text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)] py-1 disabled:opacity-50"
          >
            {t("restore.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
