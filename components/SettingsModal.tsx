"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  Eye,
  EyeOff,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  Key,
  Download,
  LogIn,
} from "lucide-react";
import type { AppSettings, AuthMode } from "@/lib/types";
import { isUsagePingEnabled, setUsagePingEnabled } from "@/lib/telemetry";
import {
  applyAppearance,
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE,
  type AppearanceSettings,
} from "@/lib/appearance";
import {
  acpCliStatus,
  claudeStatus,
  cliVersions,
  codexStatus,
  geminiStatus,
  getApiKey,
  getOpenAiApiKey,
  installAcpCli,
  installClaudeCode,
  installCodex,
  installGemini,
  listenAcpInstallProgress,
  listenCliUpdate,
  listenCodexInstallProgress,
  listenCodexLoginProgress,
  listenGeminiInstallProgress,
  listenInstallProgress,
  listenLoginProgress,
  setApiKey,
  setOpenAiApiKey,
  startClaudeLogin,
  startCodexLogin,
  updateCli,
  type AcpCliAutoInstallProvider,
  type AcpCliProvider,
  type AcpCliStatus,
  type ClaudeStatus,
  type CliVersions,
  type CodexStatus,
  type GeminiStatus,
} from "@/lib/tauri";
import { InstallFailedFallback } from "@/components/InstallFailedFallback";
import clsx from "clsx";
import { CharactersSection } from "./CharactersSection";
import { RemoteAccessSection } from "./RemoteAccessSection";
import { UserAvatar } from "./UserAvatar";
import {
  pickAndSaveAvatar,
  deleteAvatar,
  saveAvatarFromFile,
  checkUnicrewUpdate,
  downloadAndInstallUnicrewUpdate,
  type UnicrewUpdateInfo,
} from "@/lib/tauri";
import { CategoryDot } from "@/lib/providerVisuals";
import {
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  type ProviderCategory,
} from "@/lib/providerCategories";
import { useTranslation, type Locale } from "@/lib/i18n";

interface Props {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (s: AppSettings) => void;
  onCharactersChanged?: () => void;
  /**
   * 「無料で試す」など特定セットアップに誘導する deep-link。
   * 指定されたカテゴリの CategoryAccordion を自動展開する。
   * 同じ値を渡しても展開を作り直したい場合は呼び出し側で counter を上げる
   * `forceOpenAccordionKey` を別に渡す（変化検出用）。
   */
  forceOpenCategory?: ProviderCategory | null;
  forceOpenAccordionKey?: number;
}

type InstallStage = "idle" | "running" | "done" | "failed";

/** 完了イベントが来ないままボタンが押せなくなるのを防ぐ上限（Walkthrough と同じ値） */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
type LoginStage =
  | "idle"
  | "starting"
  | "waiting_browser"
  | "polling"
  | "done"
  | "failed";

export function SettingsModal({
  open,
  settings,
  onClose,
  onSave,
  onCharactersChanged,
  forceOpenCategory,
  forceOpenAccordionKey,
}: Props) {
  const { locale, t: tr, setLocale: applyLocale } = useTranslation();
  const [authMode, setAuthMode] = useState<AuthMode>(settings.authMode);
  const [showActivity, setShowActivity] = useState<boolean>(
    settings.showActivity ?? true,
  );
  const [advancedMode, setAdvancedMode] = useState<boolean>(
    settings.advancedMode ?? false,
  );
  const [beginnerMode, setBeginnerMode] = useState<boolean>(
    settings.beginnerMode ?? true,
  );
  const [appearance, setAppearance] = useState<AppearanceSettings>(
    settings.appearance ?? DEFAULT_APPEARANCE,
  );
  // 匿名の起動情報を送るか。localStorage はSSR時に読めないので、
  // 既定（オン）で描いてからマウント後に実際の値へ合わせる
  const [usagePing, setUsagePing] = useState<boolean>(true);
  useEffect(() => {
    setUsagePing(isUsagePingEnabled());
  }, []);
  const [apiKey, setApiKeyLocal] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [openaiKey, setOpenaiKeyLocal] = useState("");
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [cxStatus, setCxStatus] = useState<CodexStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [versions, setVersions] = useState<CliVersions | null>(null);
  const [updatingCli, setUpdatingCli] = useState<"claude" | "codex" | null>(null);
  const [updateLine, setUpdateLine] = useState("");
  const [installStage, setInstallStage] = useState<InstallStage>("idle");
  const [installLine, setInstallLine] = useState("");
  const [loginStage, setLoginStage] = useState<LoginStage>("idle");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [cxInstallStage, setCxInstallStage] = useState<InstallStage>("idle");
  const [cxInstallLine, setCxInstallLine] = useState("");
  const [cxLoginStage, setCxLoginStage] = useState<LoginStage>("idle");
  const [cxLoginUrl, setCxLoginUrl] = useState<string | null>(null);
  const [gmStatus, setGmStatus] = useState<GeminiStatus | null>(null);
  const [gmInstallStage, setGmInstallStage] = useState<InstallStage>("idle");
  const [gmInstallLine, setGmInstallLine] = useState("");
  // ACP / ローカル LLM 系（Goose / OpenCode / Ollama / codex-acp / kiro / qwen）の status + install 進捗。
  // - 自動インストール対応の 4 種（opencode/ollama/codex-acp/qwen）は stage/line も使う
  // - 手動インストール限定の 2 種（goose/kiro）は status のみ参照
  type AcpCliState = {
    status: AcpCliStatus | null;
    stage: InstallStage;
    line: string;
  };
  const initialAcpState: Record<AcpCliProvider, AcpCliState> = {
    goose: { status: null, stage: "idle", line: "" },
    opencode: { status: null, stage: "idle", line: "" },
    ollama: { status: null, stage: "idle", line: "" },
    "codex-acp": { status: null, stage: "idle", line: "" },
    kiro: { status: null, stage: "idle", line: "" },
    qwen: { status: null, stage: "idle", line: "" },
    kimi: { status: null, stage: "idle", line: "" },
    grok: { status: null, stage: "idle", line: "" },
    cursor: { status: null, stage: "idle", line: "" },
  };
  const [acpStates, setAcpStates] =
    useState<Record<AcpCliProvider, AcpCliState>>(initialAcpState);
  const updateAcpState = useCallback(
    (provider: AcpCliProvider, patch: Partial<AcpCliState>) => {
      setAcpStates((prev) => ({
        ...prev,
        [provider]: { ...prev[provider], ...patch },
      }));
    },
    [],
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cxPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      // status / version を全部並列取得。version は npm view を叩くので少し遅いが、待ってから表示。
      //
      // 🚨 allSettled で取る。Promise.all だと 1 つでも reject した時点で
      // どの set*Status にも到達せず、**インストールは成功したのに画面は
      // 「未インストール」のまま**という食い違いが起きる（npm view は
      // オフラインで普通に失敗する）。取れたものだけ反映する。
      const results = await Promise.allSettled([
        claudeStatus(),
        codexStatus(),
        geminiStatus(),
        cliVersions(),
        acpCliStatus("goose"),
        acpCliStatus("opencode"),
        acpCliStatus("ollama"),
        acpCliStatus("codex-acp"),
        acpCliStatus("kiro"),
        acpCliStatus("qwen"),
        acpCliStatus("kimi"),
        acpCliStatus("grok"),
        acpCliStatus("cursor"),
      ]);
      const val = <T,>(i: number): T | null =>
        results[i].status === "fulfilled"
          ? ((results[i] as PromiseFulfilledResult<T>).value as T)
          : null;
      const c = val<Awaited<ReturnType<typeof claudeStatus>>>(0);
      const x = val<Awaited<ReturnType<typeof codexStatus>>>(1);
      const g = val<Awaited<ReturnType<typeof geminiStatus>>>(2);
      const v = val<Awaited<ReturnType<typeof cliVersions>>>(3);
      if (c) setStatus(c);
      if (x) setCxStatus(x);
      if (g) setGmStatus(g);
      if (v) setVersions(v);
      const acpAt = (i: number) =>
        val<Awaited<ReturnType<typeof acpCliStatus>>>(i);
      setAcpStates((prev) => ({
        goose: { ...prev.goose, status: acpAt(4) ?? prev.goose.status },
        opencode: { ...prev.opencode, status: acpAt(5) ?? prev.opencode.status },
        ollama: { ...prev.ollama, status: acpAt(6) ?? prev.ollama.status },
        "codex-acp": {
          ...prev["codex-acp"],
          status: acpAt(7) ?? prev["codex-acp"].status,
        },
        kiro: { ...prev.kiro, status: acpAt(8) ?? prev.kiro.status },
        qwen: { ...prev.qwen, status: acpAt(9) ?? prev.qwen.status },
        kimi: { ...prev.kimi, status: acpAt(10) ?? prev.kimi.status },
        grok: { ...prev.grok, status: acpAt(11) ?? prev.grok.status },
        cursor: { ...prev.cursor, status: acpAt(12) ?? prev.cursor.status },
      }));
    } finally {
      setRefreshing(false);
    }
  }, []);

  // 🚨 「インストール中…」で永久に固まらないための保険。
  // done イベントを取りこぼすと、このモーダルは常駐マウントなので閉じて開き直しても
  // running のまま残り、再試行ボタンも手動コマンドも出ない（＝ユーザーが詰む）。
  // ① 実際に入っていたら done 扱い ② 15分でタイムアウトして failed（再試行できる状態）
  useEffect(() => {
    if (installStage === "running" && status?.installed) setInstallStage("done");
  }, [installStage, status?.installed]);
  useEffect(() => {
    if (cxInstallStage === "running" && cxStatus?.installed) setCxInstallStage("done");
  }, [cxInstallStage, cxStatus?.installed]);
  useEffect(() => {
    if (gmInstallStage === "running" && gmStatus?.installed) setGmInstallStage("done");
  }, [gmInstallStage, gmStatus?.installed]);

  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const arm = (
      stage: InstallStage,
      setStage: (s: InstallStage) => void,
      setLine: (l: string) => void,
    ) => {
      if (stage !== "running") return;
      timers.push(
        setTimeout(() => {
          setLine(tr("settings.installTimeout"));
          setStage("failed");
        }, INSTALL_TIMEOUT_MS),
      );
    };
    arm(installStage, setInstallStage, setInstallLine);
    arm(cxInstallStage, setCxInstallStage, setCxInstallLine);
    arm(gmInstallStage, setGmInstallStage, setGmInstallLine);
    return () => timers.forEach(clearTimeout);
  }, [installStage, cxInstallStage, gmInstallStage, tr]);

  // CLI 更新進捗 listen
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenCliUpdate((line) => setUpdateLine(line)).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleUpdateCli = useCallback(
    async (provider: "claude" | "codex") => {
      setUpdatingCli(provider);
      setUpdateLine("");
      try {
        await updateCli(provider);
        // 完了後にバージョン再取得
        await refreshStatus();
      } catch (e) {
        setUpdateLine(`${tr("settings.error")}${e}`);
      } finally {
        setUpdatingCli(null);
      }
    },
    [refreshStatus, tr],
  );

  // モーダルを開くたびに「保存済みの settings」から編集用 state を再同期する。
  // 本コンポーネントはアプリ起動時に常駐マウントされるため、useState 初期値は
  // 「localStorage 読込前のデフォルト settings」を掴んでいる。ここで beginnerMode /
  // advancedMode / appearance を同期しないと、保存ボタンで古い値（beginnerMode:true 等）を
  // 上書きしてしまい、ターミナル等の上級者UIがサイドバーから消える
  // （ユーザー報告 2026-07-16 の真因）。
  useEffect(() => {
    if (open) {
      setAuthMode(settings.authMode);
      setShowActivity(settings.showActivity ?? true);
      setAdvancedMode(settings.advancedMode ?? false);
      setBeginnerMode(settings.beginnerMode ?? true);
      setAppearance(settings.appearance ?? DEFAULT_APPEARANCE);
      getApiKey().then((k) => setApiKeyLocal(k ?? ""));
      getOpenAiApiKey()
        .then((k) => setOpenaiKeyLocal(k ?? ""))
        .catch(() => {});
      refreshStatus();
    }
  }, [open, settings, refreshStatus]);

  // Subscribe to install progress
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenInstallProgress({
      onLine: (line) => setInstallLine(line),
      onDone: (success) => {
        setInstallStage(success ? "done" : "failed");
        // Refresh status to reflect new install
        setTimeout(refreshStatus, 500);
      },
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [refreshStatus]);

  // Subscribe to Codex install/login progress
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    listenCodexInstallProgress({
      onLine: (line) => setCxInstallLine(line),
      onDone: (success) => {
        setCxInstallStage(success ? "done" : "failed");
        setTimeout(refreshStatus, 500);
      },
    }).then((u) => unlisteners.push(u));
    listenCodexLoginProgress({
      onBrowserOpened: (url) => {
        setCxLoginUrl(url);
        setCxLoginStage("waiting_browser");
        if (cxPollRef.current) clearInterval(cxPollRef.current);
        cxPollRef.current = setInterval(async () => {
          const s = await codexStatus();
          setCxStatus(s);
          if (s.logged_in) {
            setCxLoginStage("done");
            if (cxPollRef.current) {
              clearInterval(cxPollRef.current);
              cxPollRef.current = null;
            }
          }
        }, 2000);
      },
      onDone: (success) => {
        if (cxPollRef.current) {
          clearInterval(cxPollRef.current);
          cxPollRef.current = null;
        }
        if (success) {
          setCxLoginStage("done");
          refreshStatus();
        } else if (cxLoginStage !== "done") {
          setCxLoginStage("failed");
        }
      },
    }).then((u) => unlisteners.push(u));
    return () => {
      unlisteners.forEach((u) => u());
      if (cxPollRef.current) clearInterval(cxPollRef.current);
    };
  }, [refreshStatus, cxLoginStage]);

  // Gemini インストール進捗を listen（gemini はブラウザ login 経路を CLI が自前で処理するので、
  // UNICREW としてはインストール進捗だけ拾えれば十分）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenGeminiInstallProgress({
      onLine: (line) => setGmInstallLine(line),
      onDone: (success) => {
        setGmInstallStage(success ? "done" : "failed");
        setTimeout(refreshStatus, 500);
      },
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [refreshStatus]);

  // ACP CLI（goose/opencode/ollama）の install 進捗。
  // 同じ acp_install:line / acp_install:done を共有するため、payload の provider で振り分ける。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenAcpInstallProgress({
      onLine: (ev) => updateAcpState(ev.provider, { line: ev.line }),
      onDone: (ev) => {
        updateAcpState(ev.provider, { stage: ev.success ? "done" : "failed" });
        setTimeout(refreshStatus, 500);
      },
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [refreshStatus, updateAcpState]);

  // Subscribe to login progress
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenLoginProgress({
      onBrowserOpened: (url) => {
        setLoginUrl(url);
        setLoginStage("waiting_browser");
        // Start polling claudeStatus to detect completion
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          const s = await claudeStatus();
          setStatus(s);
          if (s.logged_in) {
            setLoginStage("done");
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }
        }, 2000);
      },
      onDone: (success) => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        if (success) {
          setLoginStage("done");
          refreshStatus();
        } else if (loginStage !== "done") {
          setLoginStage("failed");
        }
      },
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshStatus, loginStage]);

  if (!open) return null;

  const save = async () => {
    if (authMode === "apikey") {
      await setApiKey(apiKey.trim());
    }
    await setOpenAiApiKey(openaiKey.trim());
    onSave({
      ...settings,
      authMode,
      // 初心者モード=クリーン表示 / 解除=ターミナル風のツール実行詳細を表示
      // （showActivity の独立トグルは無く beginnerMode が唯一のスイッチ）
      showActivity: !beginnerMode,
      advancedMode,
      beginnerMode,
      appearance,
    });
    onClose();
  };

  // 🚨 invoke が reject したときに stage を戻す。捕まえないと「インストール中…」の
  // まま永久に固まり、ボタンも出ない（Rust 側が Err を返す経路が実在する）。
  const startInstall = async () => {
    setInstallStage("running");
    setInstallLine("");
    try {
      await installClaudeCode();
    } catch (e) {
      setInstallLine(e instanceof Error ? e.message : String(e));
      setInstallStage("failed");
    }
  };

  const startLogin = async () => {
    setLoginStage("starting");
    setLoginUrl(null);
    await startClaudeLogin();
  };

  const startCxInstall = async () => {
    setCxInstallStage("running");
    setCxInstallLine("");
    try {
      await installCodex();
    } catch (e) {
      setCxInstallLine(e instanceof Error ? e.message : String(e));
      setCxInstallStage("failed");
    }
  };

  const startCxLogin = async () => {
    setCxLoginStage("starting");
    setCxLoginUrl(null);
    await startCodexLogin();
  };

  const startGmInstall = async () => {
    setGmInstallStage("running");
    setGmInstallLine("");
    try {
      await installGemini();
    } catch (e) {
      // 例: Node/npm が入っていない PC では npm の spawn 自体が失敗して Err が返る
      setGmInstallLine(e instanceof Error ? e.message : String(e));
      setGmInstallStage("failed");
    }
  };

  const startAcpInstall = async (provider: AcpCliAutoInstallProvider) => {
    updateAcpState(provider, { stage: "running", line: "" });
    try {
      await installAcpCli(provider);
    } catch (e) {
      updateAcpState(provider, {
        stage: "failed",
        line: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <h2 className="font-bold text-[15px]">{tr("settings.title")}</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--color-surface)] rounded transition"
            aria-label={tr("common.close")}
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto">
          <section>
            <h3 className="font-semibold text-sm mb-2">外観（背景・アクセント色）</h3>
            <p className="text-[12px] text-[var(--color-muted)] mb-3 leading-relaxed">
              プリセットから選ぶか、背景色・アクセント色を自由に変えられます。
            </p>
            <div className="grid grid-cols-2 gap-2">
              {APPEARANCE_PRESETS.map((pr) => (
                <button
                  key={pr.id}
                  type="button"
                  onClick={() => {
                    const next = { ...appearance, preset: pr.id };
                    setAppearance(next);
                    applyAppearance(next);
                  }}
                  className={clsx(
                    "border rounded-xl p-2.5 text-left transition flex items-center gap-2",
                    (appearance.preset ?? "default") === pr.id
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                      : "border-[var(--color-border)] hover:bg-[var(--color-surface)]",
                  )}
                >
                  <span
                    className="h-5 w-5 rounded-full border border-[var(--color-border)] shrink-0"
                    style={{ background: pr.vars.bg }}
                    aria-hidden
                  />
                  <span className="text-[12px] font-medium">{pr.label}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <label className="text-[12px] flex items-center justify-between gap-2 border border-[var(--color-border)] rounded-lg px-3 py-2">
                <span>背景色</span>
                <input
                  type="color"
                  value={appearance.bg || "#ffffff"}
                  onChange={(e) => {
                    const next = { ...appearance, bg: e.target.value };
                    setAppearance(next);
                    applyAppearance(next);
                  }}
                  className="h-6 w-10 cursor-pointer bg-transparent"
                />
              </label>
              <label className="text-[12px] flex items-center justify-between gap-2 border border-[var(--color-border)] rounded-lg px-3 py-2">
                <span>アクセント色</span>
                <input
                  type="color"
                  value={appearance.accent || "#3b82f6"}
                  onChange={(e) => {
                    const next = { ...appearance, accent: e.target.value };
                    setAppearance(next);
                    applyAppearance(next);
                  }}
                  className="h-6 w-10 cursor-pointer bg-transparent"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => {
                setAppearance(DEFAULT_APPEARANCE);
                applyAppearance(DEFAULT_APPEARANCE);
              }}
              className="mt-2 text-[11px] text-[var(--color-muted)] underline hover:text-[var(--color-text)]"
            >
              既定に戻す
            </button>
          </section>

          <section>
            <h3 className="font-semibold text-sm mb-2">{tr("settings.language")}</h3>
            <p className="text-[12px] text-[var(--color-muted)] mb-3 leading-relaxed">
              {tr("settings.languageHint")}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(["ja", "en"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => applyLocale(l as Locale)}
                  className={clsx(
                    "border rounded-xl p-3 text-left transition",
                    locale === l
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                      : "border-[var(--color-border)] hover:bg-[var(--color-surface)]",
                  )}
                >
                  <div className="font-semibold text-[13px]">
                    {l === "ja" ? tr("settings.languageJa") : tr("settings.languageEn")}
                  </div>
                  <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                    {l === "ja" ? tr("settings.languageSubJa") : tr("settings.languageSubEn")}
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="font-semibold text-sm mb-2">{tr("settings.auth.heading")}</h3>
            <p className="text-[12px] text-[var(--color-muted)] mb-3 leading-relaxed">
              {tr("settings.auth.intro")}
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setAuthMode("subscription")}
                className={clsx(
                  "border rounded-xl p-3 text-left transition",
                  authMode === "subscription"
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-border)] hover:bg-[var(--color-surface)]",
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles size={15} className="text-[var(--color-accent)]" />
                  <span className="font-semibold text-[13px]">
                    {tr("settings.auth.subscriptionTitle")}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white font-medium">
                    {tr("settings.auth.recommendedBadge")}
                  </span>
                </div>
                <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                  {tr("settings.auth.subscriptionDesc")}
                </p>
              </button>

              <button
                onClick={() => setAuthMode("apikey")}
                className={clsx(
                  "border rounded-xl p-3 text-left transition",
                  authMode === "apikey"
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-border)] hover:bg-[var(--color-surface)]",
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Key size={15} className="text-[var(--color-text)]" />
                  <span className="font-semibold text-[13px]">
                    {tr("settings.auth.apikeyTitle")}
                  </span>
                </div>
                <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                  {tr("settings.auth.apikeyDesc")}
                </p>
              </button>
            </div>
          </section>

          {/* ── 接続済みエージェント（カテゴリ accordion） ── */}
          <div className="text-[11px] font-semibold text-[var(--color-muted)] uppercase tracking-wide pt-2">
            {tr("settings.connectedAgents")}
          </div>

          {authMode === "subscription" && (
            <CategoryAccordion
              category="claude_family"
              connectedCount={status?.installed && status?.logged_in ? 1 : 0}
              totalCount={1}
              defaultOpen={!status?.installed || !status?.logged_in}
            >
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold text-[12.5px]">{tr("settings.claude.title")}</h4>
                <button
                  onClick={refreshStatus}
                  disabled={refreshing}
                  className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
                >
                  {tr("settings.recheck")}
                </button>
              </div>

              {!status ? (
                <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
                  <Loader2 size={14} className="animate-spin" />
                  {tr("common.checking")}
                </div>
              ) : (
                <>
                  <StatusRow
                    label={tr("settings.statusLabelClaudeCode")}
                    ok={status.installed}
                    detail={status.version ?? tr("settings.notInstalled")}
                  />
                  <StatusRow
                    label={tr("settings.statusLabelLogin")}
                    ok={status.logged_in}
                    detail={
                      status.logged_in
                        ? tr("settings.loggedInStatus")
                        : status.installed
                          ? tr("settings.notLoggedIn")
                          : tr("settings.claudeInstallRequired")
                    }
                  />
                  {versions?.claude.update_available && (
                    <CliUpdateBanner
                      info={versions.claude}
                      busy={updatingCli === "claude"}
                      line={updatingCli === "claude" ? updateLine : ""}
                      onUpdate={() => handleUpdateCli("claude")}
                    />
                  )}

                  {/* インストール進捗 */}
                  {!status.installed && (installStage === "idle" || installStage === "failed") && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
                        {tr("settings.claude.installIntro")}
                      </p>
                      <button
                        onClick={startInstall}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                      >
                        <Download size={13} />
                        {tr("settings.claude.installCta")}
                      </button>
                    </div>
                  )}

                  {installStage === "running" && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <div className="flex items-center gap-2 text-[12px] text-[var(--color-text)] mb-1.5">
                        <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                        <span>{tr("settings.claude.installing")}</span>
                      </div>
                      <div className="bg-white border border-[var(--color-border)] rounded p-2 font-mono text-[10.5px] text-[var(--color-muted)] truncate max-w-full">
                        {installLine || "..."}
                      </div>
                    </div>
                  )}

                  {installStage === "done" && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <div className="flex items-center gap-2 text-[12px] text-emerald-600">
                        <CheckCircle2 size={14} />
                        {tr("settings.claude.installDone")}
                      </div>
                    </div>
                  )}

                  {installStage === "failed" && (
                    <InstallFailedFallback
                      product="claude"
                      productLabel="Claude Code"
                      lastLine={installLine}
                      helpUrl="https://github.com/takayukiyukii-commits/unicrew#claude-code-が入らない時"
                    />
                  )}

                  {/* ログイン進捗 */}
                  {status.installed && !status.logged_in && loginStage === "idle" && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
                        {tr("settings.claude.loginIntro")}
                      </p>
                      <button
                        onClick={startLogin}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                      >
                        <LogIn size={13} />
                        {tr("settings.claude.loginCta")}
                      </button>
                    </div>
                  )}

                  {(loginStage === "starting" ||
                    loginStage === "waiting_browser" ||
                    loginStage === "polling") && (
                    <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
                      <div className="flex items-center gap-2 text-[12px] text-[var(--color-text)]">
                        <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                        {loginStage === "starting" && tr("settings.claude.preparing")}
                        {loginStage === "waiting_browser" &&
                          tr("settings.claude.waitBrowser")}
                        {loginStage === "polling" && tr("settings.claude.confirmingLogin")}
                      </div>
                      {loginUrl && (
                        <div className="text-[11px] text-[var(--color-muted)] break-all">
                          {tr("settings.claude.openUrlHint")}
                          <br />
                          <a
                            href={loginUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--color-accent)] hover:underline font-mono"
                          >
                            {loginUrl}
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {loginStage === "done" && status.logged_in && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <div className="flex items-center gap-2 text-[12px] text-emerald-600">
                        <CheckCircle2 size={14} />
                        {tr("settings.claude.loginDone")}
                      </div>
                    </div>
                  )}

                  {loginStage === "failed" && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <div className="flex items-center gap-2 text-[12px] text-red-600">
                        <AlertCircle size={14} />
                        {tr("settings.claude.loginFailed")}
                      </div>
                    </div>
                  )}

                  {status.installed && status.logged_in && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <p className="text-[11.5px] text-emerald-600 leading-relaxed flex items-center gap-1.5">
                        <CheckCircle2 size={13} />
                        {tr("settings.claude.ready")}
                      </p>
                    </div>
                  )}
                </>
              )}
            </CategoryAccordion>
          )}

          {/* Codex（OpenAI 系カテゴリ） */}
          <CategoryAccordion
            category="openai_family"
            connectedCount={cxStatus?.installed && cxStatus?.logged_in ? 1 : 0}
            totalCount={1}
            defaultOpen={false}
          >
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-[12.5px]">{tr("settings.codex.title")}</h4>
              <button
                onClick={refreshStatus}
                disabled={refreshing}
                className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
              >
                {tr("settings.recheck")}
              </button>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed mb-2">
              {tr("settings.codex.intro")}
            </p>

            {cxStatus && (
              <>
                <StatusRow
                  label={tr("settings.statusLabelCodexCli")}
                  ok={cxStatus.installed}
                  detail={cxStatus.version ?? tr("settings.notInstalled")}
                />
                <StatusRow
                  label={tr("settings.statusLabelLogin")}
                  ok={cxStatus.logged_in}
                  detail={
                    cxStatus.logged_in
                      ? tr("settings.loggedInStatus")
                      : cxStatus.installed
                        ? tr("settings.notLoggedIn")
                        : tr("settings.codexInstallRequired")
                  }
                />
                {versions?.codex.update_available && (
                  <CliUpdateBanner
                    info={versions.codex}
                    busy={updatingCli === "codex"}
                    line={updatingCli === "codex" ? updateLine : ""}
                    onUpdate={() => handleUpdateCli("codex")}
                  />
                )}

                {/* Install */}
                {!cxStatus.installed && (cxInstallStage === "idle" || cxInstallStage === "failed") && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
                      {tr("settings.codex.installIntro")}
                    </p>
                    <button
                      onClick={startCxInstall}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                    >
                      <Download size={13} />
                      {tr("settings.codex.installCta")}
                    </button>
                  </div>
                )}
                {cxInstallStage === "running" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-[var(--color-text)] mb-1.5">
                      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                      <span>{tr("settings.codex.installing")}</span>
                    </div>
                    <div className="bg-white border border-[var(--color-border)] rounded p-2 font-mono text-[10.5px] text-[var(--color-muted)] truncate max-w-full">
                      {cxInstallLine || "..."}
                    </div>
                  </div>
                )}
                {cxInstallStage === "done" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-emerald-600">
                      <CheckCircle2 size={14} />
                      {tr("settings.codex.installDone")}
                    </div>
                  </div>
                )}
                {cxInstallStage === "failed" && (
                  <InstallFailedFallback
                    product="codex"
                    productLabel="Codex CLI"
                    lastLine={cxInstallLine}
                    helpUrl="https://github.com/takayukiyukii-commits/unicrew#codex-cli-が入らない時"
                  />
                )}

                {/* Login */}
                {cxStatus.installed &&
                  !cxStatus.logged_in &&
                  cxLoginStage === "idle" && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
                        {tr("settings.codex.loginIntro")}
                      </p>
                      <button
                        onClick={startCxLogin}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                      >
                        <LogIn size={13} />
                        {tr("settings.codex.loginCta")}
                      </button>
                    </div>
                  )}
                {(cxLoginStage === "starting" ||
                  cxLoginStage === "waiting_browser" ||
                  cxLoginStage === "polling") && (
                  <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
                    <div className="flex items-center gap-2 text-[12px] text-[var(--color-text)]">
                      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                      {cxLoginStage === "starting" && tr("settings.codex.preparing")}
                      {cxLoginStage === "waiting_browser" &&
                        tr("settings.codex.waitBrowser")}
                      {cxLoginStage === "polling" && tr("settings.codex.confirmingLogin")}
                    </div>
                    {cxLoginUrl && (
                      <div className="text-[11px] text-[var(--color-muted)] break-all">
                        {tr("settings.codex.openUrlHint")}
                        <br />
                        <a
                          href={cxLoginUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--color-accent)] hover:underline font-mono"
                        >
                          {cxLoginUrl}
                        </a>
                      </div>
                    )}
                  </div>
                )}
                {cxLoginStage === "done" && cxStatus.logged_in && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-emerald-600">
                      <CheckCircle2 size={14} />
                      {tr("settings.codex.loginDone")}
                    </div>
                  </div>
                )}
                {cxLoginStage === "failed" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-red-600">
                      <AlertCircle size={14} />
                      {tr("settings.codex.loginFailed")}
                    </div>
                  </div>
                )}
              </>
            )}
          </CategoryAccordion>

          {/* Gemini（Google 系カテゴリ） */}
          <CategoryAccordion
            category="google_family"
            connectedCount={
              gmStatus?.installed && (gmStatus?.logged_in || gmStatus?.has_api_key_env) ? 1 : 0
            }
            totalCount={1}
            defaultOpen={false}
          >
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-[12.5px]">{tr("settings.gemini.title")}</h4>
              <button
                onClick={refreshStatus}
                disabled={refreshing}
                className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
              >
                {tr("settings.recheck")}
              </button>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed mb-2">
              {tr("settings.gemini.intro1")}<span className="font-mono">@google/gemini-cli</span>{tr("settings.gemini.intro2")}<span className="font-mono">GEMINI_API_KEY</span>{tr("settings.gemini.intro3")}
            </p>

            {gmStatus && (
              <>
                <StatusRow
                  label={tr("settings.statusLabelGeminiCli")}
                  ok={gmStatus.installed}
                  detail={gmStatus.version ?? tr("settings.notInstalled")}
                />
                <StatusRow
                  label={tr("settings.statusLabelAuth")}
                  ok={gmStatus.logged_in || gmStatus.has_api_key_env}
                  detail={
                    gmStatus.logged_in
                      ? tr("settings.gemini.oauthLoggedIn")
                      : gmStatus.has_api_key_env
                        ? tr("settings.gemini.envKeyDetected")
                        : gmStatus.installed
                          ? tr("settings.gemini.notAuthenticated")
                          : tr("settings.geminiInstallRequired")
                  }
                />

                {/* Install */}
                {!gmStatus.installed && (gmInstallStage === "idle" || gmInstallStage === "failed") && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
                      {tr("settings.gemini.installIntro")}
                    </p>
                    <button
                      onClick={startGmInstall}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                    >
                      <Download size={13} />
                      {tr("settings.gemini.installCta")}
                    </button>
                  </div>
                )}
                {gmInstallStage === "running" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)] mb-1">
                      <Loader2 size={13} className="animate-spin" />
                      {tr("settings.gemini.installing")}
                    </div>
                    <div className="text-[10.5px] text-[var(--color-muted)] font-mono truncate">
                      {gmInstallLine}
                    </div>
                  </div>
                )}
                {gmInstallStage === "done" && (
                  <div className="pt-2 border-t border-[var(--color-border)] text-[12px] text-emerald-600 flex items-center gap-1.5">
                    <CheckCircle2 size={13} />
                    {tr("settings.gemini.installDone")}
                  </div>
                )}
                {gmInstallStage === "failed" && (
                  <InstallFailedFallback
                    product="gemini"
                    productLabel="Gemini CLI"
                    lastLine={gmInstallLine}
                    helpUrl="https://github.com/takayukiyukii-commits/unicrew#gemini-cli-が入らない時"
                  />
                )}
                {gmStatus.installed && !gmStatus.logged_in && !gmStatus.has_api_key_env && (
                  <div className="pt-2 border-t border-[var(--color-border)] text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                    {tr("settings.gemini.authMethodsHint")}
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">
                      <li>
                        <span className="font-mono">gemini</span>{tr("settings.gemini.authMethod1Post")}
                      </li>
                      <li>
                        {tr("settings.gemini.authMethod2Pre")}<span className="font-mono">GEMINI_API_KEY</span>{tr("settings.gemini.authMethod2Post")}
                      </li>
                    </ul>
                  </div>
                )}
              </>
            )}
            {!gmStatus && (
              <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
                <Loader2 size={14} className="animate-spin" />
                {tr("common.checking")}
              </div>
            )}
          </CategoryAccordion>

          {/* ローカル / OSS 系（Sprint 2 で OpenCode + Goose + Ollama を自動インストール対応）。
              codex-acp / kiro は手動インストールのみ対応（npm パッケージや AWS Builder ID 前提のため）。 */}
          {(() => {
            type AcpRow = {
              provider: AcpCliProvider;
              label: string;
              description: string;
              installHelpUrl: string;
              /** "auto" = installAcpCli 実行可。"manual" = 手動インストール案内のみ。 */
              kind: "auto" | "manual";
            };
            const acpRows: AcpRow[] = [
              {
                provider: "goose",
                label: "Goose",
                description: tr("settings.acp.goose.desc"),
                installHelpUrl:
                  "https://github.com/block/goose/releases/latest",
                kind: "manual",
              },
              {
                provider: "opencode",
                label: "OpenCode",
                description: tr("settings.acp.opencode.desc"),
                installHelpUrl: "https://opencode.ai/docs/install/",
                kind: "auto",
              },
              {
                provider: "ollama",
                label: "Ollama",
                description: tr("settings.acp.ollama.desc"),
                installHelpUrl: "https://ollama.com/download",
                kind: "auto",
              },
              {
                provider: "codex-acp",
                label: "Codex-ACP",
                description: tr("settings.acp.codexAcp.desc"),
                installHelpUrl:
                  "https://github.com/zed-industries/codex-acp",
                kind: "auto",
              },
              {
                provider: "kiro",
                label: "Kiro CLI",
                description: tr("settings.acp.kiro.desc"),
                installHelpUrl: "https://kiro.dev/",
                kind: "manual",
              },
              {
                provider: "qwen",
                label: "Qwen Code",
                description: tr("settings.acp.qwen.desc"),
                installHelpUrl: "https://github.com/QwenLM/qwen-code",
                kind: "auto",
              },
              {
                provider: "kimi",
                label: "Kimi Code CLI",
                description: tr("settings.acp.kimi.desc"),
                installHelpUrl: "https://github.com/moonshotai/kimi-cli",
                kind: "manual",
              },
              {
                provider: "grok",
                label: "Grok CLI",
                description: tr("settings.acp.grok.desc"),
                installHelpUrl: "https://docs.x.ai/build/cli/reference",
                kind: "auto",
              },
              {
                provider: "cursor",
                label: "Cursor Agent",
                description: tr("settings.acp.cursor.desc"),
                installHelpUrl: "https://cursor.com/docs/cli/overview",
                kind: "manual",
              },
            ];
            const connected = acpRows.filter(
              (r) => acpStates[r.provider].status?.installed,
            ).length;
            return (
              <CategoryAccordion
                category="open_local"
                connectedCount={connected}
                totalCount={acpRows.length}
                defaultOpen={false}
                forceOpenSignal={
                  forceOpenCategory === "open_local"
                    ? forceOpenAccordionKey
                    : undefined
                }
              >
                <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed mb-3">
                  {tr("settings.acp.intro")}
                  <strong>Ollama → OpenCode → UNICREW</strong>
                  {tr("settings.acp.introMid")}
                </p>
                <div className="space-y-2">
                  {acpRows.map((r) => {
                    const s = acpStates[r.provider];
                    const installed = !!s.status?.installed;
                    const version = s.status?.version ?? null;
                    const running = s.stage === "running";
                    return (
                      <div
                        key={r.provider}
                        className="border border-[var(--color-border)] rounded-xl p-3 bg-white"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <CategoryDot category="open_local" size={8} />
                          <span className="font-semibold text-[12.5px]">
                            {r.label}
                          </span>
                          {installed ? (
                            <span className="inline-flex items-center gap-1 text-[10.5px] text-emerald-600">
                              <CheckCircle2 size={12} />
                              {version ?? tr("settings.acp.installedShort")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--color-muted)]">
                              <AlertCircle size={12} />
                              {tr("settings.acp.notInstalledShort")}
                            </span>
                          )}
                          {r.kind === "manual" && (
                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-[var(--color-muted)]">
                              {tr("settings.acp.manualOnly")}
                            </span>
                          )}
                          <a
                            href={r.installHelpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-[var(--color-accent)] hover:underline"
                          >
                            {r.kind === "manual" ? tr("settings.acp.installSteps") : tr("settings.acp.manualSteps")}
                            <ExternalLink size={10} />
                          </a>
                        </div>
                        <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed mb-2">
                          {r.description}
                        </p>
                        {r.kind === "auto" && (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                void startAcpInstall(
                                  r.provider as AcpCliAutoInstallProvider,
                                )
                              }
                              disabled={running}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[11.5px] font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-wait"
                            >
                              {running ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Download size={12} />
                              )}
                              {installed
                                ? running
                                  ? tr("settings.acp.updating")
                                  : tr("settings.acp.reinstall")
                                : running
                                  ? tr("settings.acp.installingShort")
                                  : tr("settings.acp.autoInstall")}
                            </button>
                            {s.stage === "done" && (
                              <span className="text-[10.5px] text-emerald-600 inline-flex items-center gap-1">
                                <CheckCircle2 size={12} />
                                {tr("settings.acp.done")}
                              </span>
                            )}
                            {s.stage === "failed" && (
                              <span className="text-[10.5px] text-rose-600 inline-flex items-center gap-1">
                                <AlertCircle size={12} />
                                {tr("settings.acp.failed")}
                              </span>
                            )}
                          </div>
                        )}
                        {r.kind === "auto" &&
                          s.line &&
                          (running || s.stage === "failed") && (
                            <pre className="mt-2 text-[10.5px] text-[var(--color-muted)] bg-[var(--color-surface)] rounded p-2 max-h-20 overflow-auto whitespace-pre-wrap break-all">
                              {s.line}
                            </pre>
                          )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10.5px] text-[var(--color-muted)] italic mt-3">
                  {tr("settings.acp.footnote")}
                </p>
              </CategoryAccordion>
            );
          })()}

          {authMode === "apikey" && (
            <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
              <h4 className="font-semibold text-[13px]">{tr("settings.apikey.heading")}</h4>
              <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
                {tr("settings.apikey.intro")}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKeyLocal(e.target.value)}
                    placeholder="sk-ant-api03-..."
                    className="w-full border border-[var(--color-border)] rounded-md px-3 py-2 text-sm pr-9 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline"
              >
                {tr("settings.apikey.cta")}
                <ExternalLink size={11} />
              </a>
            </section>
          )}

          <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
            <h4 className="font-semibold text-[13px]">{tr("settings.openaiKey.heading")}</h4>
            <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
              {tr("settings.openaiKey.intro")}
            </p>
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <input
                  type={showOpenaiKey ? "text" : "password"}
                  value={openaiKey}
                  onChange={(e) => setOpenaiKeyLocal(e.target.value)}
                  placeholder="sk-..."
                  className="w-full border border-[var(--color-border)] rounded-md px-3 py-2 text-sm pr-9 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowOpenaiKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                >
                  {showOpenaiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline"
            >
              {tr("settings.openaiKey.cta")}
              <ExternalLink size={11} />
            </a>
          </section>

          <UserProfileSection
            displayName={settings.userDisplayName ?? ""}
            avatarPath={settings.userAvatarPath ?? null}
            emoji={settings.userEmoji ?? ""}
            accentColor={settings.userAccentColor ?? "#111827"}
            onChange={(patch) => onSave({ ...settings, ...patch })}
          />

          <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
            <h4 className="font-semibold text-[13px]">{tr("settings.display.heading")}</h4>
            <label className="flex items-start gap-2 text-[12.5px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={beginnerMode}
                onChange={(e) => setBeginnerMode(e.target.checked)}
                className="w-4 h-4 mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium">
                  {tr("settings.display.beginnerTitle")}
                </span>
                <span className="block text-[var(--color-muted)] text-[11.5px] mt-0.5 leading-relaxed">
                  {tr("settings.display.beginnerBody1")}<strong>{tr("settings.display.beginnerBodyStrong")}</strong>{tr("settings.display.beginnerBody2")}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-[12.5px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.autoCheckAddonUpdates ?? true}
                onChange={(e) =>
                  onSave({
                    ...settings,
                    autoCheckAddonUpdates: e.target.checked,
                  })
                }
                className="w-4 h-4 mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium">
                  {tr("settings.display.autoCheckTitle")}
                </span>
                <span className="block text-[var(--color-muted)] text-[11.5px] mt-0.5 leading-relaxed">
                  {tr("settings.display.autoCheckBody1")}<strong>{tr("settings.display.autoCheckBody1Strong")}</strong>{tr("settings.display.autoCheckBody2")}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-[12.5px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.autoApplyAddonUpdates ?? false}
                disabled={!(settings.autoCheckAddonUpdates ?? true)}
                onChange={(e) =>
                  onSave({
                    ...settings,
                    autoApplyAddonUpdates: e.target.checked,
                  })
                }
                className="w-4 h-4 mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium">
                  {tr("settings.display.autoApplyTitle")}
                </span>
                <span className="block text-[var(--color-muted)] text-[11.5px] mt-0.5 leading-relaxed">
                  {tr("settings.display.autoApplyBody1")}<strong>{tr("settings.display.autoApplyBody1Strong")}</strong>{tr("settings.display.autoApplyBody2")}
                </span>
              </span>
            </label>

          </section>

          <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
            <h4 className="font-semibold text-[13px]">プライバシー</h4>
            <label className="flex items-start gap-2 text-[12.5px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={usagePing}
                onChange={(e) => {
                  setUsagePingEnabled(e.target.checked);
                  setUsagePing(e.target.checked);
                }}
                className="w-4 h-4 mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium">匿名の起動情報を送る</span>
                <span className="block text-[var(--color-muted)] text-[11.5px] mt-0.5 leading-relaxed">
                  起動したときに<strong>ランダムなID・アプリのバージョン・OSの種類</strong>の3つだけを送ります。
                  何台に使われているかを知るためだけのもので、会話の内容・キャラクター設定・APIキー・
                  ファイルの場所は<strong>一切送りません</strong>。オフにすると本当に送信しません。
                </span>
              </span>
            </label>
          </section>

          <UnicrewSelfUpdateSection currentVersion="0.2.1" />

          <RemoteAccessSection />

          <div className="border-t border-[var(--color-border)] pt-5">
            <CharactersSection onCharactersChanged={onCharactersChanged} />
          </div>

          <section className="border-t border-[var(--color-border)] pt-4 text-[12px] text-[var(--color-muted)] leading-relaxed">
            <div className="font-semibold text-[var(--color-text)] mb-1">
              {tr("settings.about.heading")}
            </div>
            <p className="leading-relaxed mb-2">
              {tr("settings.about.body1Pre")}<strong>{tr("settings.about.body1Strong")}</strong>{tr("settings.about.body1Post")}
            </p>
            <div className="font-semibold text-[var(--color-text)] mb-1 mt-2">
              {tr("settings.about.inDevHeading")}
            </div>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>{tr("settings.about.inDev1")}</li>
              <li>{tr("settings.about.inDev2")}</li>
              <li>{tr("settings.about.inDev3")}</li>
            </ul>

            <div className="font-semibold text-[var(--color-text)] mb-1 mt-4">
              {tr("settings.about.legalHeading")}
            </div>
            <p className="leading-relaxed text-[11px]">
              {tr("settings.about.legalBody1Pre")}<strong>Anthropic, PBC</strong>{tr("settings.about.legalBody1Mid")}<strong>OpenAI, Inc.</strong>{tr("settings.about.legalBody1Post")}
            </p>
            <ul className="list-disc pl-4 space-y-0.5 mt-1 text-[11px]">
              <li>{tr("settings.about.trademark1")}</li>
              <li>{tr("settings.about.trademark2")}</li>
              <li>{tr("settings.about.trademark3")}</li>
            </ul>

            <div className="font-semibold text-[var(--color-text)] mb-1 mt-4">
              {tr("settings.about.ossHeading")}
            </div>
            <ul className="list-disc pl-4 space-y-0.5 text-[11px]">
              <li>
                <strong>agent-client-protocol</strong>{tr("settings.about.ossBody1")}<span className="font-mono">THIRD_PARTY_LICENSES/agent-client-protocol/NOTICE.md</span>{tr("settings.about.ossBody2")}
              </li>
            </ul>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md hover:bg-white transition"
          >
            {tr("settings.footer.cancel")}
          </button>
          <button
            onClick={save}
            className="px-4 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition"
          >
            {tr("settings.footer.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * カテゴリ単位の accordion ラッパー。
 * プロバイダ拡張時に SettingsModal がフラットにスクロール地獄化することを防ぐ。
 *
 * 設計指針（AGENTS.md「UI 複雑化を避ける5原則」原則1+3）:
 * - 視覚要素は4色のみ（カテゴリ色）
 * - デフォルト全閉、未接続/エラー時のみデフォルト開
 * - バッジで「N/M 接続」を常時表示
 */
function CategoryAccordion({
  category,
  connectedCount,
  totalCount,
  defaultOpen = false,
  forceOpenSignal,
  children,
}: {
  category: ProviderCategory;
  connectedCount: number;
  totalCount: number;
  defaultOpen?: boolean;
  /**
   * 外部から「開いてほしい」シグナル（変化検出用キー）。
   * undefined → 何もしない。値が変わったタイミングで open=true を強制。
   */
  forceOpenSignal?: number;
  children: React.ReactNode;
}) {
  const { t: tr } = useTranslation();
  const allConnected = totalCount > 0 && connectedCount === totalCount;
  const partial = connectedCount > 0 && connectedCount < totalCount;
  const empty = totalCount === 0;

  // defaultOpen は status 読み込み完了で flip するケースがある（claude_family 等）。
  // 元の挙動を維持するため `<details open={defaultOpen}>` の reactive を残す。
  // それを上書きする外部シグナル（forceOpenSignal）が変わったら "ロック" を立て、
  // ユーザーが手動で閉じるまで open=true を維持する。
  const [forceOpenLatched, setForceOpenLatched] = useState(false);
  useEffect(() => {
    if (forceOpenSignal !== undefined) setForceOpenLatched(true);
  }, [forceOpenSignal]);
  const effectiveOpen = forceOpenLatched || defaultOpen;

  return (
    <details
      open={effectiveOpen}
      onToggle={(e) => {
        // ユーザーが閉じたら latch を解除し、defaultOpen 主導に戻す。
        if (!(e.currentTarget as HTMLDetailsElement).open) {
          setForceOpenLatched(false);
        }
      }}
      className="group border border-[var(--color-border)] rounded-xl bg-[var(--color-surface)] overflow-hidden"
    >
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-2 hover:bg-white/40 transition">
        <CategoryDot category={category} size={10} />
        <span className="font-semibold text-[13px] text-[var(--color-text)]">
          {CATEGORY_LABELS[category]}
        </span>
        <span
          className={clsx(
            "ml-auto text-[11px] px-2 py-0.5 rounded-full font-medium",
            empty
              ? "bg-gray-100 text-[var(--color-muted)]"
              : allConnected
                ? "bg-emerald-100 text-emerald-700"
                : partial
                  ? "bg-amber-100 text-amber-700"
                  : "bg-gray-100 text-[var(--color-muted)]",
          )}
        >
          {empty
            ? tr("settings.categoryEmpty")
            : allConnected
              ? tr("settings.categoryAllConnected")
              : tr("settings.categoryPartial", { connected: connectedCount, total: totalCount })}
        </span>
        <span className="text-[var(--color-muted)] group-open:rotate-180 transition-transform">
          ▾
        </span>
      </summary>
      <div className="px-4 pb-4 pt-1 space-y-2 border-t border-[var(--color-border)] bg-white">
        <p className="text-[10.5px] text-[var(--color-muted)] mb-1 italic leading-relaxed">
          {CATEGORY_DESCRIPTIONS[category]}
        </p>
        {children}
      </div>
    </details>
  );
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between text-[12.5px]">
      <div className="flex items-center gap-2">
        {ok ? (
          <CheckCircle2 size={14} className="text-emerald-500" />
        ) : (
          <AlertCircle size={14} className="text-amber-500" />
        )}
        <span>{label}</span>
      </div>
      <span className="text-[var(--color-muted)] font-mono text-[11.5px] truncate max-w-[60%]">
        {detail}
      </span>
    </div>
  );
}

/**
 * CLI が古い時に出す警告バナー。ワンクリックで `npm install -g <pkg>@latest` を実行する。
 */
function CliUpdateBanner({
  info,
  busy,
  line,
  onUpdate,
}: {
  info: { name: string; package: string; current: string | null; latest: string | null };
  busy: boolean;
  line: string;
  onUpdate: () => void;
}) {
  const { t: tr } = useTranslation();
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-md px-3 py-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] text-amber-800">
          <AlertCircle size={13} />
          <span className="font-medium">{tr("settings.cliUpdate.title", { name: info.name })}</span>
          <span className="font-mono text-[11px] text-amber-700">
            {info.current ?? "—"} → {info.latest ?? "—"}
          </span>
        </div>
        <button
          type="button"
          onClick={onUpdate}
          disabled={busy}
          className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md bg-amber-600 text-white font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              {tr("settings.cliUpdate.updating")}
            </>
          ) : (
            <>
              <Download size={11} />
              {tr("settings.cliUpdate.updateNow")}
            </>
          )}
        </button>
      </div>
      {busy && line && (
        <div className="text-[10.5px] text-amber-700 font-mono truncate">
          {line}
        </div>
      )}
    </div>
  );
}

/**
 * 「あなた」プロフィール編集セクション。
 *
 * - 表示名 / アバター画像 / 1文字（絵文字 or 漢字）/ 背景色 を編集できる
 * - アバター画像があれば 1文字 / 背景色は無視される（CharacterAvatar と同じ優先度）
 * - onChange はフィールド更新ごとに親へ patch を投げ、settings に即マージ保存される
 */
const USER_ACCENT_PRESETS = [
  "#111827", // 黒（既定）
  "#1e40af", // 紺
  "#0f766e", // ティール
  "#16a34a", // 緑
  "#ca8a04", // 黄
  "#ea580c", // 橙
  "#db2777", // ピンク
  "#7c3aed", // 紫
];

function UserProfileSection({
  displayName,
  avatarPath,
  emoji,
  accentColor,
  onChange,
}: {
  displayName: string;
  avatarPath: string | null;
  emoji: string;
  accentColor: string;
  onChange: (patch: Partial<AppSettings>) => void;
}) {
  const { t: tr } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [dragHot, setDragHot] = useState(false);
  const handlePickAvatar = async () => {
    setBusy(true);
    try {
      const saved = await pickAndSaveAvatar();
      if (saved) {
        if (avatarPath) {
          await deleteAvatar(avatarPath).catch(() => {});
        }
        onChange({ userAvatarPath: saved });
      }
    } finally {
      setBusy(false);
    }
  };
  const handleClearAvatar = async () => {
    if (avatarPath) {
      await deleteAvatar(avatarPath).catch(() => {});
    }
    onChange({ userAvatarPath: null });
  };
  const handleDropFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      // png/jpg/webp/gif/svg 以外は弾く（Rust 側でも弾くが UI 側のフィードバックを早く返す）
      alert(tr("settings.profile.imageInvalid"));
      return;
    }
    setBusy(true);
    try {
      const saved = await saveAvatarFromFile(file);
      if (saved) {
        if (avatarPath) {
          await deleteAvatar(avatarPath).catch(() => {});
        }
        onChange({ userAvatarPath: saved });
      }
    } catch (e) {
      alert(
        tr("settings.profile.imageSaveFailed") +
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
      <h4 className="font-semibold text-[13px]">{tr("settings.profile.heading")}</h4>
      <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
        {tr("settings.profile.intro")}
      </p>
      <div className="flex items-center gap-4">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!dragHot) setDragHot(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragHot(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragHot(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleDropFile(file);
          }}
          className={`relative rounded-full transition ${
            dragHot
              ? "ring-2 ring-[var(--color-accent)] ring-offset-2"
              : ""
          }`}
          title={tr("settings.profile.dragHint")}
        >
          <UserAvatar
            avatarPath={avatarPath}
            emoji={emoji}
            accentColor={accentColor}
            fallbackText={displayName.trim().charAt(0) || tr("settings.userNameInitial")}
            size={64}
          />
          {dragHot && (
            <div className="absolute inset-0 rounded-full bg-[var(--color-accent)]/20 flex items-center justify-center text-[10px] text-[var(--color-accent)] font-semibold pointer-events-none">
              {tr("settings.dropLabel")}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <label className="block">
            <span className="block text-[11px] text-[var(--color-muted)] mb-0.5">
              {tr("settings.profile.displayName")}
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => onChange({ userDisplayName: e.target.value })}
              placeholder={tr("settings.profile.namePlaceholder")}
              className="w-full border border-[var(--color-border)] rounded-md px-2 py-1 text-[13px] bg-white outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handlePickAvatar}
              disabled={busy}
              className="px-2.5 py-1 text-[11.5px] rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface)] disabled:opacity-50"
            >
              {tr("settings.profile.pickImage")}
            </button>
            {avatarPath && (
              <button
                type="button"
                onClick={handleClearAvatar}
                className="px-2.5 py-1 text-[11.5px] rounded-md border border-[var(--color-border)] hover:bg-red-50 text-red-600"
              >
                {tr("settings.profile.clearImage")}
              </button>
            )}
            <span className="text-[10.5px] text-[var(--color-muted)]">
              {tr("settings.profile.dropHint")}
            </span>
          </div>
        </div>
      </div>
      {!avatarPath && (
        <div className="grid grid-cols-2 gap-3 pt-1">
          <label className="block">
            <span className="block text-[11px] text-[var(--color-muted)] mb-0.5">
              {tr("settings.profile.glyphLabel")}
            </span>
            <input
              type="text"
              value={emoji}
              onChange={(e) =>
                onChange({ userEmoji: e.target.value.slice(0, 4) })
              }
              maxLength={4}
              placeholder={tr("settings.profile.glyphPlaceholder")}
              className="w-full border border-[var(--color-border)] rounded-md px-2 py-1 text-[13px] bg-white outline-none focus:border-[var(--color-accent)] text-center"
            />
          </label>
          <div>
            <span className="block text-[11px] text-[var(--color-muted)] mb-0.5">
              {tr("settings.profile.bgColor")}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {USER_ACCENT_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onChange({ userAccentColor: c })}
                  className={`w-6 h-6 rounded-full border-2 transition ${
                    accentColor === c
                      ? "border-[var(--color-text)]"
                      : "border-white hover:scale-110"
                  }`}
                  style={{ background: c }}
                  aria-label={tr("settings.profile.bgColorLabel", { color: c })}
                  title={c}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * UNICREW 本体の自動アップデート UI。
 *
 * 流れ:
 *   1) 「最新版を確認」押下 → GitHub Releases の latest.json を fetch（plugin-updater が裏でやる）
 *   2) 新版があれば情報＋「ダウンロードして適用」ボタン
 *   3) 押下 → .exe/.msi をダウンロード → 署名検証 → 既存版置換 → 自動再起動
 *
 * 署名鍵：リポジトリ外の鍵保管フォルダで管理（Ed25519 / minisign 互換）。
 * 公開鍵は tauri.conf.json の plugins.updater.pubkey に直書きされており、
 * バイナリにビルドインされる。鍵が一致しないアップデートは弾かれる。
 */
function UnicrewSelfUpdateSection({
  currentVersion,
}: {
  currentVersion: string;
}) {
  const { t: tr } = useTranslation();
  const [info, setInfo] = useState<UnicrewUpdateInfo | null>(null);
  // 表示用の実バージョン（tauri.conf.json の version）。ハードコードでなく実値を出す。
  const [realVersion, setRealVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (alive) setRealVersion(v);
      } catch {
        /* 非 Tauri 等は currentVersion prop へフォールバック */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const onCheck = async () => {
    setChecking(true);
    setErrorMsg(null);
    try {
      const r = await checkUnicrewUpdate();
      setInfo(r);
      if (r && !r.available) {
        setProgress(tr("settings.selfUpdate.upToDate"));
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const onInstall = async () => {
    if (!info || !info.available) return;
    setInstalling(true);
    setErrorMsg(null);
    setProgress(tr("settings.selfUpdate.downloadStart"));
    try {
      // DownloadEvent の型は { event: "Started"|"Progress"|"Finished", data?: any }
      await downloadAndInstallUnicrewUpdate(info.__token, (ev) => {
        const e = ev as { event?: string; data?: { chunkLength?: number; contentLength?: number } };
        if (e?.event === "Started") {
          const size = e.data?.contentLength
            ? Math.round(e.data.contentLength / 1024 / 1024) + "MB"
            : tr("settings.selfUpdate.sizeUnknown");
          setProgress(tr("settings.selfUpdate.downloadStartedSize", { size }));
        } else if (e?.event === "Progress") {
          setProgress(tr("settings.selfUpdate.downloading"));
        } else if (e?.event === "Finished") {
          setProgress(tr("settings.selfUpdate.downloadDone"));
        }
      });
      // ここまで来たら relaunch されているので普通は到達しない
      setProgress(tr("settings.selfUpdate.applied"));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
      <h4 className="font-semibold text-[13px] flex items-center gap-1.5">
        {tr("settings.selfUpdate.heading")}
        <span className="text-[10.5px] font-mono text-[var(--color-muted)]">
          v{realVersion ?? currentVersion}
        </span>
      </h4>
      <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
        {tr("settings.selfUpdate.intro")}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || installing}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface)] disabled:opacity-50"
        >
          {checking ? (
            <>
              <Loader2 size={11} className="animate-spin" />
              {tr("settings.selfUpdate.checking")}
            </>
          ) : (
            tr("settings.selfUpdate.checkLatest")
          )}
        </button>
        {info?.available && (
          <button
            type="button"
            onClick={onInstall}
            disabled={installing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] rounded-md bg-amber-600 text-white font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {installing ? (
              <>
                <Loader2 size={11} className="animate-spin" />
                {tr("settings.selfUpdate.installing")}
              </>
            ) : (
              <>{tr("settings.selfUpdate.installCta", { version: info.version })}</>
            )}
          </button>
        )}
      </div>
      {info?.available && info.body && (
        <details className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
          <summary className="cursor-pointer text-[var(--color-text)] font-medium">
            {tr("settings.selfUpdate.showChangelog", { version: info.version })}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap text-[11px] bg-[var(--color-surface)] rounded-md p-2 max-h-64 overflow-auto">
            {info.body}
          </pre>
        </details>
      )}
      {progress && (
        <div className="text-[11.5px] text-[var(--color-muted)] font-mono">
          {progress}
        </div>
      )}
      {errorMsg && (
        <div className="text-[11.5px] text-red-600 leading-relaxed">
          {tr("settings.selfUpdate.error")}{errorMsg}
        </div>
      )}
    </section>
  );
}
