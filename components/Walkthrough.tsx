"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  ExternalLink,
  ArrowRight,
  X,
  Sparkles,
  Bot,
  Cpu,
} from "lucide-react";
import clsx from "clsx";
import {
  claudeStatus,
  codexStatus,
  installClaudeCode,
  installCodex,
  isTauri,
  startClaudeLogin,
  startCodexLogin,
} from "@/lib/tauri";
import { markWalkthroughDone } from "@/lib/walkthrough";
import { useTranslation } from "@/lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Step 3 の "最初のキャラを選ぶ" 用。Picker を開かせるだけ。 */
  onPickFirstCharacter: () => void;
}

type StepId = 1 | 2 | 3;

interface StatusSnapshot {
  installed: boolean;
  logged_in: boolean;
  loading: boolean;
}

const FRESH: StatusSnapshot = { installed: false, logged_in: false, loading: true };

/**
 * Welcome 後の 3 ステップ初期セットアップ。
 *
 * Step 1: Claude CLI のインストール / ログイン
 * Step 2: Codex CLI（任意。スキップ可）
 * Step 3: 最初のキャラクター選択
 *
 * Claude/Codex 状態は 1.5 秒間隔でポーリングして自動進行する。
 */
export function Walkthrough({ open, onClose, onPickFirstCharacter }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<StepId>(1);
  const [claude, setClaude] = useState<StatusSnapshot>(FRESH);
  const [codex, setCodex] = useState<StatusSnapshot>(FRESH);
  const [claudeBusy, setClaudeBusy] = useState<"none" | "installing" | "loggingIn">("none");
  const [codexBusy, setCodexBusy] = useState<"none" | "installing" | "loggingIn">("none");
  const [skippedCodex, setSkippedCodex] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ステータスポーリング（open 中、かつ Step 3 到達前のみ）。
  // Step 3 はキャラクター選択画面でステータスを参照しないため、ポーリングを止めて
  // CLI への余計な負荷と画面リレンダーを抑える。
  useEffect(() => {
    if (!open) return;
    if (step === 3) return;
    let cancelled = false;
    const tick = async () => {
      if (!isTauri()) {
        if (!cancelled) {
          setClaude({ installed: false, logged_in: false, loading: false });
          setCodex({ installed: false, logged_in: false, loading: false });
        }
        return;
      }
      try {
        const [c, x] = await Promise.all([claudeStatus(), codexStatus()]);
        if (cancelled) return;
        setClaude({ installed: c.installed, logged_in: c.logged_in, loading: false });
        setCodex({ installed: x.installed, logged_in: x.logged_in, loading: false });
      } catch {
        /* noop */
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, step]);

  // 自動進行: Claude OK で Step2 へ
  useEffect(() => {
    if (!open) return;
    if (step === 1 && claude.installed && claude.logged_in) {
      setStep(2);
    }
  }, [open, step, claude.installed, claude.logged_in]);

  // Step2 自動進行: Codex 完了 or skip → Step3
  useEffect(() => {
    if (!open) return;
    if (step === 2 && (codex.logged_in || skippedCodex)) {
      setStep(3);
    }
  }, [open, step, codex.logged_in, skippedCodex]);

  if (!open) return null;

  const finish = () => {
    markWalkthroughDone();
    onClose();
  };

  const claudeReady = claude.installed && claude.logged_in;
  const codexReady = codex.installed && codex.logged_in;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-label={t("walkthrough.dialogLabel")}
    >
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col max-h-[90vh]">
        {/* ヘッダー */}
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--color-accent)]" />
            <div>
              <div className="text-[15px] font-bold tracking-tight">
                {t("walkthrough.title")}
              </div>
              <div className="text-[11.5px] text-[var(--color-muted)]">
                {t("walkthrough.subtitle")}
              </div>
            </div>
          </div>
          <button
            onClick={finish}
            className="p-1.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)]"
            title={t("walkthrough.closeHint")}
          >
            <X size={16} />
          </button>
        </div>

        {/* ステッパー */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <StepBadge n={1} active={step === 1} done={claudeReady} label={t("walkthrough.step1Label")} />
          <Connector />
          <StepBadge
            n={2}
            active={step === 2}
            done={codexReady || skippedCodex}
            label={t("walkthrough.step2Label")}
          />
          <Connector />
          <StepBadge n={3} active={step === 3} done={false} label={t("walkthrough.step3Label")} />
        </div>

        {/* ステップ本体 */}
        <div className="px-6 py-5 flex-1 min-h-0 overflow-y-auto unicrew-scroll">
          {step === 1 && (
            <ProviderStep
              icon={<Bot size={18} className="text-orange-600" />}
              title={t("walkthrough.step1Title")}
              description={t("walkthrough.step1Body")}
              status={claude}
              busy={claudeBusy}
              onInstall={async () => {
                setClaudeBusy("installing");
                try {
                  await installClaudeCode();
                } finally {
                  setClaudeBusy("none");
                }
              }}
              onLogin={async () => {
                setClaudeBusy("loggingIn");
                try {
                  await startClaudeLogin();
                } finally {
                  setClaudeBusy("none");
                }
              }}
            />
          )}
          {step === 2 && (
            <ProviderStep
              icon={<Cpu size={18} className="text-emerald-600" />}
              title={t("walkthrough.step2Title")}
              description={t("walkthrough.step2Body")}
              status={codex}
              busy={codexBusy}
              onInstall={async () => {
                setCodexBusy("installing");
                try {
                  await installCodex();
                } finally {
                  setCodexBusy("none");
                }
              }}
              onLogin={async () => {
                setCodexBusy("loggingIn");
                try {
                  await startCodexLogin();
                } finally {
                  setCodexBusy("none");
                }
              }}
              skipLabel={t("walkthrough.step2Skip")}
              onSkip={() => setSkippedCodex(true)}
            />
          )}
          {step === 3 && (
            <div className="space-y-4">
              <h3 className="text-[15px] font-semibold flex items-center gap-2">
                <Sparkles size={15} className="text-[var(--color-accent)]" />
                {t("walkthrough.step3Title")}
              </h3>
              <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed">
                {t("walkthrough.step3Body")}
              </p>
              <button
                onClick={() => {
                  markWalkthroughDone();
                  onClose();
                  onPickFirstCharacter();
                }}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] text-white py-2.5 text-[13px] font-medium hover:opacity-90 transition"
              >
                {t("walkthrough.openPicker")}
                <ArrowRight size={14} />
              </button>
              <button
                onClick={finish}
                className="w-full text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)] py-1"
              >
                {t("walkthrough.skipPicker")}
              </button>
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="px-6 py-3 border-t border-[var(--color-border)] flex items-center justify-between text-[11.5px] text-[var(--color-muted)] bg-[var(--color-surface)]">
          <span>{t("walkthrough.footer")}</span>
          {step < 3 && (
            <button
              onClick={() => setStep((s) => (Math.min(3, s + 1) as StepId))}
              className="text-[var(--color-accent)] hover:underline"
            >
              {t("walkthrough.skipNext")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepBadge({
  n,
  active,
  done,
  label,
}: {
  n: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={clsx(
          "w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold",
          done
            ? "bg-emerald-500 text-white"
            : active
              ? "bg-[var(--color-accent)] text-white"
              : "bg-white border border-[var(--color-border)] text-[var(--color-muted)]",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <span
        className={clsx(
          "text-[11.5px]",
          active
            ? "text-[var(--color-text)] font-medium"
            : "text-[var(--color-muted)]",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function Connector() {
  return <div className="flex-1 h-px bg-[var(--color-border)]" />;
}

function ProviderStep({
  icon,
  title,
  description,
  status,
  busy,
  onInstall,
  onLogin,
  skipLabel,
  onSkip,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: StatusSnapshot;
  busy: "none" | "installing" | "loggingIn";
  onInstall: () => void;
  onLogin: () => void;
  skipLabel?: string;
  onSkip?: () => void;
}) {
  const { t } = useTranslation();
  const installed = status.installed;
  const loggedIn = status.logged_in;
  return (
    <div className="space-y-4">
      <h3 className="text-[15px] font-semibold flex items-center gap-2">
        {icon}
        {title}
      </h3>
      <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed">
        {description}
      </p>

      <div className="space-y-2">
        <CheckRow
          label={t("walkthrough.cliInstalled")}
          done={installed}
          loading={status.loading}
          actionLabel={
            busy === "installing"
              ? t("walkthrough.cliInstalling")
              : installed
                ? t("walkthrough.cliInstalledLabel")
                : t("walkthrough.cliInstall")
          }
          actionDisabled={installed || busy !== "none"}
          actionBusy={busy === "installing"}
          onAction={onInstall}
        />
        <CheckRow
          label={t("walkthrough.loggedIn")}
          done={loggedIn}
          loading={status.loading}
          actionLabel={
            busy === "loggingIn"
              ? t("walkthrough.loggingIn")
              : loggedIn
                ? t("walkthrough.loggedIn")
                : t("walkthrough.login")
          }
          actionDisabled={!installed || loggedIn || busy !== "none"}
          actionBusy={busy === "loggingIn"}
          onAction={onLogin}
          icon={!loggedIn && installed ? <ExternalLink size={11} /> : undefined}
        />
      </div>

      {onSkip && skipLabel && (
        <button
          onClick={onSkip}
          className="text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)] underline underline-offset-2"
        >
          {skipLabel}
        </button>
      )}
    </div>
  );
}

function CheckRow({
  label,
  done,
  loading,
  actionLabel,
  actionDisabled,
  actionBusy,
  onAction,
  icon,
}: {
  label: string;
  done: boolean;
  loading: boolean;
  actionLabel: string;
  actionDisabled?: boolean;
  actionBusy?: boolean;
  onAction: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-white">
      <div className="flex items-center gap-2 min-w-0">
        <div
          className={clsx(
            "w-5 h-5 rounded-full flex items-center justify-center shrink-0",
            done ? "bg-emerald-500" : "bg-[var(--color-surface)] border border-[var(--color-border)]",
          )}
        >
          {done ? (
            <Check size={11} className="text-white" />
          ) : loading ? (
            <Loader2 size={11} className="animate-spin text-[var(--color-muted)]" />
          ) : null}
        </div>
        <span className="text-[12.5px] truncate">{label}</span>
      </div>
      <button
        onClick={onAction}
        disabled={actionDisabled}
        className={clsx(
          "shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] border transition",
          done
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 cursor-default"
            : actionDisabled
              ? "border-[var(--color-border)] text-[var(--color-muted)] cursor-not-allowed bg-[var(--color-surface)]"
              : "border-[var(--color-accent)] bg-[var(--color-accent)] text-white hover:opacity-90",
        )}
      >
        {actionBusy ? <Loader2 size={11} className="animate-spin" /> : icon}
        {actionLabel}
      </button>
    </div>
  );
}
