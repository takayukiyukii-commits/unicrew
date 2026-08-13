"use client";

import { useState } from "react";
import { CheckCircle2, X, Send, Mail } from "lucide-react";
import {
  RATING_OPTIONS,
  type FeedbackRating,
  type FeedbackPayload,
  recordFeedback,
  markFeedbackDismissed,
} from "@/lib/feedback";
import { useTranslation } from "@/lib/i18n";

interface Props {
  /** UNICREW のバージョン（mailto に含めるため） */
  appVersion: string;
  /** 累計ユーザーメッセージ数（mailto に含めるため） */
  userMessageCount: number;
  /** 送信完了 or 閉じる時に呼ばれる。親で表示状態を更新する。 */
  onClose: () => void;
}

export function FeedbackCard({
  appVersion,
  userMessageCount,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [improvement, setImprovement] = useState("");
  const [featureRequest, setFeatureRequest] = useState("");
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submit = () => {
    if (!rating) return;
    const payload: FeedbackPayload = {
      rating,
      improvement: improvement.trim(),
      feature_request: featureRequest.trim(),
      email: email.trim() || undefined,
      app_version: appVersion,
      user_message_count: userMessageCount,
      submitted_at: new Date().toISOString(),
    };
    const { mailtoUrl } = recordFeedback(payload);

    // メーラーを開いてメンテナ宛に送信。
    // window.location.href だと SPA 遷移と誤認される環境があるため open を優先。
    if (typeof window !== "undefined") {
      window.open(mailtoUrl, "_self");
    }

    setSubmitted(true);
    // 1.5秒後に自動クローズ
    setTimeout(() => onClose(), 1500);
  };

  const dismiss = () => {
    markFeedbackDismissed();
    onClose();
  };

  if (submitted) {
    return (
      <div className="my-4 mx-auto max-w-2xl rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 flex items-center gap-3">
        <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
        <div className="text-[13px] text-emerald-900 leading-relaxed">
          {t("feedback.thanks")}
        </div>
      </div>
    );
  }

  return (
    <div className="my-4 mx-auto max-w-2xl rounded-xl border border-[var(--color-border)] bg-white shadow-sm overflow-hidden">
      <div className="flex items-start justify-between px-5 pt-4 pb-2">
        <div>
          <div className="text-[13.5px] font-semibold text-[var(--color-text)]">
            {t("feedback.title")}
          </div>
          <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
            {t("feedback.subtitle")}
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="text-[var(--color-muted)] hover:text-[var(--color-text)] -mt-1 -mr-1 p-1"
          title={t("feedback.laterTitle")}
          aria-label={t("feedback.closeAria")}
        >
          <X size={15} />
        </button>
      </div>

      <div className="px-5 pb-4 space-y-3">
        {/* 評価 */}
        <div>
          <div className="text-[11.5px] text-[var(--color-muted)] mb-1.5">
            {t("feedback.ratingLabel")}
          </div>
          <div className="flex gap-1.5">
            {RATING_OPTIONS.map((opt, idx) => {
              const active = rating === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setRating(opt.id)}
                  className={[
                    "flex-1 flex flex-col items-center gap-0.5 py-2 rounded-lg border transition",
                    active
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft,#eef3ff)]"
                      : "border-[var(--color-border)] hover:bg-[var(--color-surface)]",
                  ].join(" ")}
                  aria-pressed={active}
                >
                  <span className="text-[14px] leading-none font-bold tabular-nums">
                    {idx + 1}
                  </span>
                  <span className="text-[10px] text-[var(--color-muted)]">
                    {opt.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 改善要望 */}
        <div>
          <label className="block text-[11.5px] text-[var(--color-muted)] mb-1">
            {t("feedback.improvementLabel")}
          </label>
          <textarea
            value={improvement}
            onChange={(e) => setImprovement(e.target.value)}
            placeholder={t("feedback.improvementPlaceholder")}
            rows={2}
            className="w-full text-[12.5px] border border-[var(--color-border)] rounded-md px-2.5 py-1.5 resize-none focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {/* 新機能要望 */}
        <div>
          <label className="block text-[11.5px] text-[var(--color-muted)] mb-1">
            {t("feedback.featureLabel")}
          </label>
          <textarea
            value={featureRequest}
            onChange={(e) => setFeatureRequest(e.target.value)}
            placeholder={t("feedback.featurePlaceholder")}
            rows={2}
            className="w-full text-[12.5px] border border-[var(--color-border)] rounded-md px-2.5 py-1.5 resize-none focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {/* 連絡先（任意） */}
        <div>
          <label className="block text-[11.5px] text-[var(--color-muted)] mb-1">
            {t("feedback.contactLabel")}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            className="w-full text-[12.5px] border border-[var(--color-border)] rounded-md px-2.5 py-1.5 focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        {/* 送信 */}
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={dismiss}
            className="text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)] underline-offset-2 hover:underline"
          >
            {t("feedback.later")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!rating}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-[12px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
          >
            <Send size={12} />
            {t("feedback.submit")}
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--color-muted)] pt-1 border-t border-[var(--color-border)]">
          <Mail size={11} />
          <span>{t("feedback.mailerHint")}</span>
        </div>
      </div>
    </div>
  );
}
