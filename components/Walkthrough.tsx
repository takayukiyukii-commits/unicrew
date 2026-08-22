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
  listenCodexInstallProgress,
  listenInstallProgress,
  startClaudeLogin,
  startCodexLogin,
} from "@/lib/tauri";
import { InstallFailedFallback } from "@/components/InstallFailedFallback";
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

/** インストール完了イベントが来なかった場合にボタンを解放するまでの上限。 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

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
  // インストーラの出力（最終行）と失敗フラグ。
  // 🚨 2026-08-22 追加。従来この画面は claude_install:* / codex_install:* を購読して
  // おらず（購読していたのは SettingsModal だけ）、押しても進捗も失敗理由も出ないため
  // 「何も起きない」に見えていた。
  const [claudeLine, setClaudeLine] = useState("");
  const [codexLine, setCodexLine] = useState("");
  const [claudeFailed, setClaudeFailed] = useState(false);
  const [codexFailed, setCodexFailed] = useState(false);
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

  // インストール進捗の購読。
  // ここで done を受けて初めて busy を解除する（＝完了まで押せない）。
  // busy を先に解除していたのが、連打 → winget/install.ps1 の同時実行 →
  // 「The process cannot access the file because it is being used by another process」
  // の入口だった。
  //
  // 🚨 購読は open ではなくマウント全体に張る（この画面は open を出し入れするだけで
  // 常時マウントされている）。open で外すと「インストール中に画面を閉じた」ときに
  // done を取りこぼし、busy が installing のまま居座る。
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const keep = (u: () => void) => {
      if (disposed) u();
      else unlistens.push(u);
    };
    void listenInstallProgress({
      onLine: (line) => setClaudeLine(line),
      onDone: (success) => {
        setClaudeBusy((b) => (b === "installing" ? "none" : b));
        setClaudeFailed(!success);
      },
    }).then(keep);
    void listenCodexInstallProgress({
      onLine: (line) => setCodexLine(line),
      onDone: (success) => {
        setCodexBusy((b) => (b === "installing" ? "none" : b));
        setCodexFailed(!success);
      },
    }).then(keep);
    return () => {
      disposed = true;
      unlistens.forEach((u) => u());
    };
  }, []);

  // 保険1: done を取りこぼしても、ポーリングが installed を見つけたら解除する。
  useEffect(() => {
    if (claudeBusy === "installing" && claude.installed) {
      setClaudeBusy("none");
      setClaudeFailed(false);
    }
  }, [claudeBusy, claude.installed]);
  useEffect(() => {
    if (codexBusy === "installing" && codex.installed) {
      setCodexBusy("none");
      setCodexFailed(false);
    }
  }, [codexBusy, codex.installed]);

  // 保険2: それでも何も返ってこない場合の最終解除（15分）。
  // ボタンが永久に押せないまま詰むのを防ぐ。
  useEffect(() => {
    if (claudeBusy !== "installing") return;
    const id = setTimeout(() => {
      setClaudeBusy("none");
      setClaudeFailed(true);
    }, INSTALL_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [claudeBusy]);
  useEffect(() => {
    if (codexBusy !== "installing") return;
    const id = setTimeout(() => {
      setCodexBusy("none");
      setCodexFailed(true);
    }, INSTALL_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [codexBusy]);

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
              installLine={claudeLine}
              installFailed={claudeFailed}
              product="claude"
              productLabel="Claude Code"
              helpUrl="https://github.com/takayukiyukii-commits/unicrew#claude-code-が入らない時"
              onInstall={async () => {
                // 完了は claude_install:done で受ける。ここで解除しない。
                setClaudeFailed(false);
                setClaudeLine("");
                setClaudeBusy("installing");
                try {
                  await installClaudeCode();
                } catch (e) {
                  setClaudeBusy("none");
                  setClaudeFailed(true);
                  setClaudeLine(e instanceof Error ? e.message : String(e));
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
              installLine={codexLine}
              installFailed={codexFailed}
              product="codex"
              productLabel="Codex CLI"
              helpUrl="https://github.com/takayukiyukii-commits/unicrew#codex-cli-が入らない時"
              onInstall={async () => {
                setCodexFailed(false);
                setCodexLine("");
                setCodexBusy("installing");
                try {
                  await installCodex();
                } catch (e) {
                  setCodexBusy("none");
                  setCodexFailed(true);
                  setCodexLine(e instanceof Error ? e.message : String(e));
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
  installLine,
  installFailed,
  product,
  productLabel,
  helpUrl,
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
  installLine: string;
  installFailed: boolean;
  product: "claude" | "codex";
  productLabel: string;
  helpUrl: string;
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

      {/* インストール進捗（押しっぱなしに見えないよう、必ず何か出す） */}
      {busy === "installing" && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 space-y-1">
          <div className="flex items-center gap-2 text-[11.5px] text-[var(--color-text)]">
            <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
            {t("walkthrough.installRunning")}
          </div>
          <div className="font-mono text-[10.5px] text-[var(--color-muted)] break-all line-clamp-2 leading-relaxed">
            {installLine || "…"}
          </div>
        </div>
      )}

      {/* 失敗時の救済（手動コマンド・コピー・サポート連絡） */}
      {installFailed && busy === "none" && !installed && (
        <InstallFailedFallback
          product={product}
          productLabel={productLabel}
          lastLine={installLine}
          helpUrl={helpUrl}
        />
      )}

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
