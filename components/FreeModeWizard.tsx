"use client";

/**
 * FreeModeWizard — 「1分で始める」完全自動セットアップウィザード。
 *
 * 目的:
 *   API キー / サブスク無しで UNICREW を体験できる状態まで、ボタン1回で進む。
 *
 * 4ステップ:
 *   1. Ollama 本体のインストール（winget Ollama.Ollama、macOS/Linux は手動誘導）
 *   2. qwen2.5-coder:7b モデルの pull（数百MB〜数GB、所要は回線次第）
 *   3. OpenCode CLI のインストール（npm install -g opencode-ai）
 *   4. 完了通知 → 親が OpenCode 単独スレッドを spawn
 *
 * 設計指針（AGENTS.md「UI 複雑化を避ける5原則」原則1: モーダルは1つ・1責務）:
 *   - 進捗ログは折りたたみ <details> に押し込む（縦長化防止）
 *   - 4ステップは縦1列のチェックリスト風に表示
 *   - 「中断」ボタンは常に右上に出す（実際の subprocess kill はベストエフォート）
 *
 * Tauri 非対応環境（ブラウザ dev）では「Tauri 起動時のみ」表示で fallback。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  X,
  ChevronDown,
  Download,
  Terminal,
  Cpu,
  Rocket,
} from "lucide-react";
import {
  acpCliStatus,
  installAcpCli,
  isTauri,
  listenAcpInstallProgress,
  listenOllamaPullProgress,
  ollamaPull,
} from "@/lib/tauri";
import { useTranslation, t as translate } from "@/lib/i18n";

/** Wizard が叩く各ステップの状態。 */
type StepStatus = "pending" | "running" | "skipped" | "ok" | "error";

interface StepState {
  status: StepStatus;
  /** 失敗時のメッセージ（ユーザー向け日本語）。 */
  error?: string;
  /** 進捗テキスト。subprocess の最新行を都度上書き。 */
  progress?: string;
}

const STEPS = [
  {
    key: "ollama",
    icon: Cpu,
    titleKey: "freeMode.step.ollama.title",
    descriptionKey: "freeMode.step.ollama.desc",
  },
  {
    key: "model",
    icon: Download,
    titleKey: "freeMode.step.model.title",
    descriptionKey: "freeMode.step.model.desc",
  },
  {
    key: "opencode",
    icon: Terminal,
    titleKey: "freeMode.step.opencode.title",
    descriptionKey: "freeMode.step.opencode.desc",
  },
  {
    key: "spawn",
    icon: Rocket,
    titleKey: "freeMode.step.spawn.title",
    descriptionKey: "freeMode.step.spawn.desc",
  },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

const DEFAULT_MODEL = "qwen2.5-coder:7b";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 4ステップ全成功時に呼ばれる。親側で OpenCode 単独スレッドを spawn する想定。 */
  onCompleted: () => void;
}

/**
 * 4ステップを自動で順に走らせるモーダル。
 * 親が `open=true` にしてマウントしたら自動で実行開始。
 * 途中で閉じるとステップ状態は破棄され、次回開いた時に再実行する。
 */
export function FreeModeWizard({ open, onClose, onCompleted }: Props) {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<Record<StepKey, StepState>>({
    ollama: { status: "pending" },
    model: { status: "pending" },
    opencode: { status: "pending" },
    spawn: { status: "pending" },
  });
  /** 詳細ログ表示の開閉。 */
  const [showLog, setShowLog] = useState(false);
  /** 詳細ログ本体。subprocess の stdout/stderr を蓄積する。 */
  const [log, setLog] = useState<string[]>([]);
  /** 実行ガード。同一マウント中に再エントリしないため。 */
  const ranRef = useRef(false);

  const appendLog = useCallback((line: string) => {
    // 末尾だけ保持してメモリ膨張を防ぐ。
    setLog((prev) => {
      const next = [...prev, line];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  const updateStep = useCallback(
    (key: StepKey, patch: Partial<StepState>) => {
      setSteps((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    },
    [],
  );

  /**
   * acp_install のイベントを Promise でラップ。
   * 指定 provider の done が来るまで待つ。
   */
  const runAcpInstall = useCallback(
    async (provider: "ollama" | "opencode"): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        let unlisten: (() => void) | null = null;
        listenAcpInstallProgress({
          onLine: (ev) => {
            if (ev.provider !== provider) return;
            appendLog(`[${provider}] ${ev.line}`);
            updateStep(provider === "ollama" ? "ollama" : "opencode", {
              progress: ev.line,
            });
          },
          onDone: (ev) => {
            if (ev.provider !== provider) return;
            unlisten?.();
            if (ev.success) resolve();
            else reject(new Error(translate("freeMode.installFailed", { provider })));
          },
        })
          .then((u) => {
            unlisten = u;
            installAcpCli(provider).catch((e) => {
              unlisten?.();
              reject(e instanceof Error ? e : new Error(String(e)));
            });
          })
          .catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
      });
    },
    [appendLog, updateStep],
  );

  /**
   * ollama_pull のイベントを Promise でラップ。
   */
  const runOllamaPull = useCallback(
    async (model: string): Promise<void> => {
      return new Promise<void>((resolve, reject) => {
        let unlisten: (() => void) | null = null;
        listenOllamaPullProgress({
          onLine: (ev) => {
            if (ev.model !== model) return;
            appendLog(`[ollama pull] ${ev.line}`);
            updateStep("model", { progress: ev.line });
          },
          onDone: (ev) => {
            if (ev.model !== model) return;
            unlisten?.();
            if (ev.success) resolve();
            else reject(new Error(translate("freeMode.pullFailed", { model })));
          },
        })
          .then((u) => {
            unlisten = u;
            ollamaPull(model).catch((e) => {
              unlisten?.();
              reject(e instanceof Error ? e : new Error(String(e)));
            });
          })
          .catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
      });
    },
    [appendLog, updateStep],
  );

  const runAll = useCallback(async () => {
    if (!isTauri()) {
      updateStep("ollama", {
        status: "error",
        error: translate("freeMode.requireTauri"),
      });
      return;
    }
    // Step 1: Ollama
    updateStep("ollama", { status: "running" });
    try {
      const st = await acpCliStatus("ollama");
      if (st.installed) {
        updateStep("ollama", { status: "skipped", progress: st.version ?? undefined });
        appendLog(translate("freeMode.alreadyInstalled", { provider: "ollama", version: st.version ?? translate("freeMode.versionUnknown") }));
      } else {
        await runAcpInstall("ollama");
        updateStep("ollama", { status: "ok" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateStep("ollama", { status: "error", error: msg });
      appendLog(translate("freeMode.errorLog", { key: "ollama", error: msg }));
      return;
    }

    // Step 2: model pull
    updateStep("model", { status: "running" });
    try {
      await runOllamaPull(DEFAULT_MODEL);
      updateStep("model", { status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateStep("model", { status: "error", error: msg });
      appendLog(translate("freeMode.errorLog", { key: "model", error: msg }));
      return;
    }

    // Step 3: OpenCode
    updateStep("opencode", { status: "running" });
    try {
      const st = await acpCliStatus("opencode");
      if (st.installed) {
        updateStep("opencode", { status: "skipped", progress: st.version ?? undefined });
        appendLog(translate("freeMode.alreadyInstalled", { provider: "opencode", version: st.version ?? translate("freeMode.versionUnknown") }));
      } else {
        await runAcpInstall("opencode");
        updateStep("opencode", { status: "ok" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateStep("opencode", { status: "error", error: msg });
      appendLog(translate("freeMode.errorLog", { key: "opencode", error: msg }));
      return;
    }

    // Step 4: spawn は親に委譲。
    updateStep("spawn", { status: "running" });
    try {
      onCompleted();
      updateStep("spawn", { status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      updateStep("spawn", { status: "error", error: msg });
    }
  }, [appendLog, onCompleted, runAcpInstall, runOllamaPull, updateStep]);

  // open=true でマウントされたら自動実行。閉じてもう一度開いたら state リセット。
  useEffect(() => {
    if (!open) {
      ranRef.current = false;
      setSteps({
        ollama: { status: "pending" },
        model: { status: "pending" },
        opencode: { status: "pending" },
        spawn: { status: "pending" },
      });
      setLog([]);
      setShowLog(false);
      return;
    }
    if (ranRef.current) return;
    ranRef.current = true;
    void runAll();
  }, [open, runAll]);

  if (!open) return null;

  const allDone =
    steps.ollama.status !== "running" &&
    steps.ollama.status !== "pending" &&
    steps.model.status !== "running" &&
    steps.model.status !== "pending" &&
    steps.opencode.status !== "running" &&
    steps.opencode.status !== "pending" &&
    steps.spawn.status !== "running" &&
    steps.spawn.status !== "pending";

  const hasError = Object.values(steps).some((s) => s.status === "error");

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <header className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[var(--color-accent)] text-white flex items-center justify-center shrink-0">
            <Sparkles size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-bold text-[var(--color-text)]">
              {t("freeMode.title")}
            </h2>
            <p className="text-[11.5px] text-[var(--color-muted)] mt-0.5">
              {t("freeMode.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-8 h-8 rounded-lg hover:bg-[var(--color-surface)] flex items-center justify-center text-[var(--color-muted)]"
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          <ol className="space-y-2.5">
            {STEPS.map((s, idx) => {
              const state = steps[s.key];
              return (
                <StepRow
                  key={s.key}
                  index={idx + 1}
                  icon={<s.icon size={16} />}
                  title={t(s.titleKey)}
                  description={t(s.descriptionKey)}
                  state={state}
                />
              );
            })}
          </ol>

          <details
            open={showLog}
            onToggle={(e) => setShowLog((e.target as HTMLDetailsElement).open)}
            className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
          >
            <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 text-[11.5px] text-[var(--color-muted)]">
              <ChevronDown size={12} />
              {t("freeMode.logDetails", { lines: log.length })}
            </summary>
            <pre className="px-3 pb-3 pt-1 text-[10.5px] leading-relaxed text-[var(--color-muted)] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
              {log.length === 0 ? t("freeMode.logEmpty") : log.join("\n")}
            </pre>
          </details>
        </div>

        <footer className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex items-center gap-2">
          {hasError && (
            <p className="text-[11.5px] text-rose-600 flex-1">
              {t("freeMode.hasError")}
            </p>
          )}
          {!hasError && !allDone && (
            <p className="text-[11.5px] text-[var(--color-muted)] flex-1">
              {t("freeMode.running")}
            </p>
          )}
          {!hasError && allDone && (
            <p className="text-[11.5px] text-emerald-600 flex-1 font-semibold">
              {t("freeMode.allDone")}
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[12px] font-semibold hover:opacity-90 disabled:opacity-50"
            disabled={!allDone && !hasError}
          >
            {allDone && !hasError ? t("freeMode.closeCta") : t("freeMode.abortCta")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function StepRow({
  index,
  icon,
  title,
  description,
  state,
}: {
  index: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  state: StepState;
}) {
  const { t } = useTranslation();
  const statusIcon = (() => {
    switch (state.status) {
      case "pending":
        return (
          <span className="w-5 h-5 rounded-full bg-gray-100 text-[var(--color-muted)] text-[10px] flex items-center justify-center">
            {index}
          </span>
        );
      case "running":
        return <Loader2 size={16} className="text-[var(--color-accent)] animate-spin" />;
      case "ok":
        return <CheckCircle2 size={16} className="text-emerald-500" />;
      case "skipped":
        return <CheckCircle2 size={16} className="text-sky-500" />;
      case "error":
        return <AlertCircle size={16} className="text-rose-500" />;
    }
  })();

  return (
    <li className="flex items-start gap-3 p-3 rounded-xl border border-[var(--color-border)] bg-white">
      <div className="shrink-0 mt-0.5">{statusIcon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-muted)] shrink-0">{icon}</span>
          <span className="font-semibold text-[12.5px] text-[var(--color-text)]">
            {title}
          </span>
          {state.status === "skipped" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">
              {t("freeMode.badgeSkipped")}
            </span>
          )}
          {state.status === "ok" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
              {t("freeMode.badgeOk")}
            </span>
          )}
          {state.status === "running" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
              {t("freeMode.badgeRunning")}
            </span>
          )}
          {state.status === "error" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">
              {t("freeMode.badgeError")}
            </span>
          )}
        </div>
        <p className="text-[11.5px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
          {description}
        </p>
        {state.progress && (
          <p className="text-[10.5px] text-[var(--color-muted)] mt-1 font-mono truncate">
            {state.progress}
          </p>
        )}
        {state.error && (
          <p className="text-[10.5px] text-rose-600 mt-1 leading-relaxed">
            {state.error}
          </p>
        )}
      </div>
    </li>
  );
}
