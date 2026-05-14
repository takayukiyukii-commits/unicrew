"use client";

import { Shield, FileEdit, Terminal, Search, FileText, AlertTriangle } from "lucide-react";
import type { PendingPermission } from "@/lib/types";
import { useTranslation, t as translate } from "@/lib/i18n";

interface Props {
  pending: PendingPermission | null;
  onDecide: (decision: "allow" | "allow_once" | "deny") => void;
}

function iconFor(toolName: string) {
  if (toolName === "Bash") return Terminal;
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") return FileEdit;
  if (toolName === "Read") return FileText;
  if (toolName === "Grep" || toolName === "Glob") return Search;
  return Shield;
}

function summary(toolName: string, input: Record<string, unknown>): string {
  const i = input ?? {};
  switch (toolName) {
    case "Bash":
      return String(i.command ?? "");
    case "Read":
      return translate("permission.summaryRead", { path: String(i.file_path ?? "") });
    case "Edit":
      return translate("permission.summaryEdit", { path: String(i.file_path ?? "") });
    case "Write":
      return translate("permission.summaryWrite", { path: String(i.file_path ?? "") });
    case "MultiEdit":
      return translate("permission.summaryMultiEdit", { path: String(i.file_path ?? "") });
    case "Glob":
      return translate("permission.summaryGlob", { pattern: String(i.pattern ?? "") });
    case "Grep":
      return translate("permission.summaryGrep", { pattern: String(i.pattern ?? "") });
    default:
      return JSON.stringify(i).slice(0, 200);
  }
}

const RISK_LEVEL: Record<string, "low" | "mid" | "high"> = {
  Read: "low",
  Glob: "low",
  Grep: "low",
  Edit: "mid",
  Write: "mid",
  MultiEdit: "mid",
  Bash: "high",
};

export function PermissionPromptModal({ pending, onDecide }: Props) {
  const { t } = useTranslation();
  if (!pending) return null;
  const Icon = iconFor(pending.toolName);
  const risk = RISK_LEVEL[pending.toolName] ?? "mid";
  const riskColor =
    risk === "high"
      ? "text-red-600 bg-red-50 border-red-200"
      : risk === "mid"
        ? "text-amber-700 bg-amber-50 border-amber-200"
        : "text-emerald-700 bg-emerald-50 border-emerald-200";
  const riskLabel =
    risk === "high"
      ? t("permission.riskHigh")
      : risk === "mid"
        ? t("permission.riskMid")
        : t("permission.riskLow");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">
        <div className="px-5 pt-5 pb-3 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[var(--color-accent-soft)] flex items-center justify-center">
            <Icon size={18} className="text-[var(--color-accent)]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-[15px]">{t("permission.title")}</h2>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${riskColor}`}
              >
                {riskLabel}
              </span>
            </div>
            <p className="text-[12px] text-[var(--color-muted)]">
              {t("permission.subtitleA")}
              <span className="font-mono">{pending.toolName}</span>
              {t("permission.subtitleB")}
            </p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="text-[12px] font-semibold text-[var(--color-muted)] uppercase tracking-wide">
            {t("permission.actionLabel")}
          </div>
          <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md p-3 text-[12.5px] whitespace-pre-wrap break-words max-h-60 overflow-auto font-mono">
            {summary(pending.toolName, pending.input)}
          </pre>

          {risk === "high" && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-[12px] text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div>
                {t("permission.highRiskWarning")}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          <button
            onClick={() => onDecide("deny")}
            className="px-4 py-2 text-sm rounded-md hover:bg-white transition"
          >
            {t("permission.deny")}
          </button>
          <button
            onClick={() => onDecide("allow_once")}
            className="px-4 py-2 text-sm rounded-md border border-[var(--color-border)] hover:bg-white transition"
          >
            {t("permission.allowOnce")}
          </button>
          <button
            onClick={() => onDecide("allow")}
            className="px-4 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition"
          >
            {t("permission.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
