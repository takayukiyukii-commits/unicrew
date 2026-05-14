"use client";

/**
 * 初回起動時の言語選択モーダル。
 *
 * - localStorage に `unicrew.locale` が未設定なら表示
 * - 「日本語 / English」2択
 * - 選択後は setLocale() で永続化＋全コンポーネントへ通知
 * - Walkthrough より前に表示する（page.tsx で順番制御）
 */

import { useEffect, useState } from "react";
import { Globe, Check } from "lucide-react";
import clsx from "clsx";
import { getLocale, setLocale, type Locale, t } from "@/lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function LanguagePickerModal({ open, onClose }: Props) {
  const [picked, setPicked] = useState<Locale>(() => getLocale());

  // open になった瞬間に <html lang> を一時的に updated picked に合わせる
  useEffect(() => {
    if (!open) return;
    try { document.documentElement.lang = picked; } catch { /* noop */ }
  }, [open, picked]);

  if (!open) return null;

  const confirm = () => {
    setLocale(picked);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Language picker"
    >
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-6 py-5 border-b border-[var(--color-border)] flex items-center gap-2">
          <Globe size={20} className="text-[var(--color-accent)]" aria-hidden />
          <div>
            <div className="text-[15px] font-bold tracking-tight">
              {/* 両言語併記してどちらの話者にも伝わるように */}
              Choose your language / 言語を選択
            </div>
            <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
              {t("languagePicker.subtitle", picked)}
            </div>
          </div>
        </div>

        <div className="px-6 py-5 space-y-2">
          <LangButton
            label="日本語"
            sub="Japanese"
            selected={picked === "ja"}
            onClick={() => setPicked("ja")}
          />
          <LangButton
            label="English"
            sub="英語"
            selected={picked === "en"}
            onClick={() => setPicked("en")}
          />
        </div>

        <div className="px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex justify-end">
          <button
            type="button"
            onClick={confirm}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-semibold hover:opacity-90"
          >
            {t("languagePicker.continue", picked)}
          </button>
        </div>
      </div>
    </div>
  );
}

function LangButton({
  label,
  sub,
  selected,
  onClick,
}: {
  label: string;
  sub: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-left transition",
        selected
          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
          : "border-[var(--color-border)] bg-white hover:bg-[var(--color-surface)]",
      )}
    >
      <div>
        <div className="text-[14px] font-semibold text-[var(--color-text)]">{label}</div>
        <div className="text-[11.5px] text-[var(--color-muted)]">{sub}</div>
      </div>
      {selected && <Check size={16} className="text-[var(--color-accent)]" />}
    </button>
  );
}
