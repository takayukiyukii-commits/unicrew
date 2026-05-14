"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, X } from "lucide-react";
import { fetchWhatsNew, markWhatsNewSeen, UNICREW_VERSION } from "@/lib/whatsnew";
import { useTranslation } from "@/lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function WhatsNewModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetchWhatsNew()
      .then((md) => {
        if (cancelled) return;
        setContent(md);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const close = () => {
    markWhatsNewSeen();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label={t("whatsNew.dialogLabel")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--color-accent)]" />
            <div>
              <div className="text-[15px] font-bold tracking-tight">
                {t("whatsNew.title", { version: UNICREW_VERSION })}
              </div>
              <div className="text-[11.5px] text-[var(--color-muted)]">
                {t("whatsNew.subtitle")}
              </div>
            </div>
          </div>
          <button
            onClick={close}
            className="p-1.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)]"
            title={t("whatsNew.closeHint")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto unicrew-scroll px-6 py-4">
          {loading && (
            <div className="text-[12px] text-[var(--color-muted)] py-6 text-center">
              {t("whatsNew.loading")}
            </div>
          )}
          {!loading && !content && (
            <div className="text-[12px] text-[var(--color-muted)] py-6 text-center">
              {t("whatsNew.notFound")}
            </div>
          )}
          {!loading && content && (
            <div className="prose prose-sm max-w-none unicrew-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-[var(--color-border)] flex items-center justify-end gap-2 bg-[var(--color-surface)]">
          <button
            onClick={close}
            className="px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white text-[12.5px] font-medium hover:opacity-90"
          >
            {t("whatsNew.closeCta")}
          </button>
        </div>
      </div>
    </div>
  );
}
