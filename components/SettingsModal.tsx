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
  Copy,
  Check,
  Mail,
  HelpCircle,
} from "lucide-react";
import type { AppSettings, AuthMode } from "@/lib/types";
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
import clsx from "clsx";
import { CharactersSection } from "./CharactersSection";
import { CategoryDot } from "@/lib/providerVisuals";
import {
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  type ProviderCategory,
} from "@/lib/providerCategories";

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
      const [c, x, g, v, goose, opencode, ollama, codexAcp, kiro, qwen, kimi] =
        await Promise.all([
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
        ]);
      setStatus(c);
      setCxStatus(x);
      setGmStatus(g);
      setVersions(v);
      setAcpStates((prev) => ({
        goose: { ...prev.goose, status: goose },
        opencode: { ...prev.opencode, status: opencode },
        ollama: { ...prev.ollama, status: ollama },
        "codex-acp": { ...prev["codex-acp"], status: codexAcp },
        kiro: { ...prev.kiro, status: kiro },
        qwen: { ...prev.qwen, status: qwen },
        kimi: { ...prev.kimi, status: kimi },
      }));
    } finally {
      setRefreshing(false);
    }
  }, []);

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
        setUpdateLine(`エラー: ${e}`);
      } finally {
        setUpdatingCli(null);
      }
    },
    [refreshStatus],
  );

  useEffect(() => {
    if (open) {
      setAuthMode(settings.authMode);
      setShowActivity(settings.showActivity ?? true);
      getApiKey().then((k) => setApiKeyLocal(k ?? ""));
      getOpenAiApiKey()
        .then((k) => setOpenaiKeyLocal(k ?? ""))
        .catch(() => {});
      refreshStatus();
    }
  }, [open, settings.authMode, settings.showActivity, refreshStatus]);

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
      showActivity: beginnerMode ? false : showActivity,
      advancedMode,
      beginnerMode,
    });
    onClose();
  };

  const startInstall = async () => {
    setInstallStage("running");
    setInstallLine("");
    await installClaudeCode();
  };

  const startLogin = async () => {
    setLoginStage("starting");
    setLoginUrl(null);
    await startClaudeLogin();
  };

  const startCxInstall = async () => {
    setCxInstallStage("running");
    setCxInstallLine("");
    await installCodex();
  };

  const startCxLogin = async () => {
    setCxLoginStage("starting");
    setCxLoginUrl(null);
    await startCodexLogin();
  };

  const startGmInstall = async () => {
    setGmInstallStage("running");
    setGmInstallLine("");
    await installGemini();
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
          <h2 className="font-bold text-[15px]">設定</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--color-surface)] rounded transition"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto">
          <section>
            <h3 className="font-semibold text-sm mb-2">認証方法</h3>
            <p className="text-[12px] text-[var(--color-muted)] mb-3 leading-relaxed">
              UNICREW は Claude のサブスクリプション契約（Pro/Max）でも、
              開発者向けの API キーでも動かせます。
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
                    Claude Pro/Max でログイン
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white font-medium">
                    推奨
                  </span>
                </div>
                <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                  既に契約中の Claude プランで動きます。追加課金なし。
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
                    API キーで使う
                  </span>
                </div>
                <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                  従量課金。組織アカウント・チーム共有向け。
                </p>
              </button>
            </div>
          </section>

          {/* ── 接続済みエージェント（カテゴリ accordion） ── */}
          <div className="text-[11px] font-semibold text-[var(--color-muted)] uppercase tracking-wide pt-2">
            接続済みエージェント
          </div>

          {authMode === "subscription" && (
            <CategoryAccordion
              category="claude_family"
              connectedCount={status?.installed && status?.logged_in ? 1 : 0}
              totalCount={1}
              defaultOpen={!status?.installed || !status?.logged_in}
            >
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold text-[12.5px]">Claude（公式 CLI）</h4>
                <button
                  onClick={refreshStatus}
                  disabled={refreshing}
                  className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
                >
                  再確認
                </button>
              </div>

              {!status ? (
                <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
                  <Loader2 size={14} className="animate-spin" />
                  確認中…
                </div>
              ) : (
                <>
                  <StatusRow
                    label="Claude Code"
                    ok={status.installed}
                    detail={status.version ?? "未インストール"}
                  />
                  <StatusRow
                    label="ログイン状態"
                    ok={status.logged_in}
                    detail={
                      status.logged_in
                        ? "ログイン済み"
                        : status.installed
                          ? "未ログイン"
                          : "Claude のインストールが必要"
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
                  {!status.installed && installStage === "idle" && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
                        UNICREW が裏で Claude Code を自動インストールします。
                        ターミナルは開きません。インストールには2〜3分かかります。
                      </p>
                      <button
                        onClick={startInstall}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                      >
                        <Download size={13} />
                        Claude Code を自動インストール
                      </button>
                    </div>
                  )}

                  {installStage === "running" && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <div className="flex items-center gap-2 text-[12px] text-[var(--color-text)] mb-1.5">
                        <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                        <span>インストール中… (2〜3分かかります)</span>
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
                        インストール完了。続けてログインしてください。
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
                        ボタンを押すとブラウザが自動で開きます。
                        Claude にサインインするだけで完了します。
                      </p>
                      <button
                        onClick={startLogin}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                      >
                        <LogIn size={13} />
                        Claude にログイン
                      </button>
                    </div>
                  )}

                  {(loginStage === "starting" ||
                    loginStage === "waiting_browser" ||
                    loginStage === "polling") && (
                    <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
                      <div className="flex items-center gap-2 text-[12px] text-[var(--color-text)]">
                        <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                        {loginStage === "starting" && "Claude を準備中…"}
                        {loginStage === "waiting_browser" &&
                          "ブラウザでサインインしてください…"}
                        {loginStage === "polling" && "ログイン完了を確認中…"}
                      </div>
                      {loginUrl && (
                        <div className="text-[11px] text-[var(--color-muted)] break-all">
                          ブラウザが開かない場合はこの URL を直接開いてください：
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
                        ログイン完了。さっそく使えます。
                      </div>
                    </div>
                  )}

                  {loginStage === "failed" && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <div className="flex items-center gap-2 text-[12px] text-red-600">
                        <AlertCircle size={14} />
                        ログインに失敗しました。もう一度お試しください。
                      </div>
                    </div>
                  )}

                  {status.installed && status.logged_in && (
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <p className="text-[11.5px] text-emerald-600 leading-relaxed flex items-center gap-1.5">
                        <CheckCircle2 size={13} />
                        準備OK。Claude のサブスクリプションで動作します。
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
              <h4 className="font-semibold text-[12.5px]">Codex（公式 CLI）</h4>
              <button
                onClick={refreshStatus}
                disabled={refreshing}
                className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
              >
                再確認
              </button>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed mb-2">
              ChatGPT Plus/Pro/Business をお持ちなら、Codex も繋いで使えます（Claude と切替・並列可）。
              不要なら未接続のままで問題ありません。
            </p>

            {cxStatus && (
              <>
                <StatusRow
                  label="Codex CLI"
                  ok={cxStatus.installed}
                  detail={cxStatus.version ?? "未インストール"}
                />
                <StatusRow
                  label="ログイン状態"
                  ok={cxStatus.logged_in}
                  detail={
                    cxStatus.logged_in
                      ? "ログイン済み"
                      : cxStatus.installed
                        ? "未ログイン"
                        : "Codex CLI のインストールが必要"
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
                {!cxStatus.installed && cxInstallStage === "idle" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
                      npm 経由で公式 CLI をインストールします。ターミナルは開きません。
                    </p>
                    <button
                      onClick={startCxInstall}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                    >
                      <Download size={13} />
                      Codex CLI を自動インストール
                    </button>
                  </div>
                )}
                {cxInstallStage === "running" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-[var(--color-text)] mb-1.5">
                      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                      <span>Codex をインストール中…</span>
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
                      インストール完了。続けてログインしてください。
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
                        ボタンを押すとブラウザが開き、ChatGPT サインインで完了します。
                      </p>
                      <button
                        onClick={startCxLogin}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                      >
                        <LogIn size={13} />
                        ChatGPT でログイン
                      </button>
                    </div>
                  )}
                {(cxLoginStage === "starting" ||
                  cxLoginStage === "waiting_browser" ||
                  cxLoginStage === "polling") && (
                  <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
                    <div className="flex items-center gap-2 text-[12px] text-[var(--color-text)]">
                      <Loader2 size={14} className="animate-spin text-[var(--color-accent)]" />
                      {cxLoginStage === "starting" && "Codex を準備中…"}
                      {cxLoginStage === "waiting_browser" &&
                        "ブラウザでサインインしてください…"}
                      {cxLoginStage === "polling" && "ログイン完了を確認中…"}
                    </div>
                    {cxLoginUrl && (
                      <div className="text-[11px] text-[var(--color-muted)] break-all">
                        ブラウザが開かない場合：
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
                      Codex ログイン完了
                    </div>
                  </div>
                )}
                {cxLoginStage === "failed" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-red-600">
                      <AlertCircle size={14} />
                      ログインに失敗しました。
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
              <h4 className="font-semibold text-[12.5px]">Gemini（公式 CLI）</h4>
              <button
                onClick={refreshStatus}
                disabled={refreshing}
                className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
              >
                再確認
              </button>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed mb-2">
              Google 公式の <span className="font-mono">@google/gemini-cli</span> が必要です。
              インストール後は CLI 内で OAuth ログインするか、環境変数 <span className="font-mono">GEMINI_API_KEY</span> をセットすると使えます。
            </p>

            {gmStatus && (
              <>
                <StatusRow
                  label="Gemini CLI"
                  ok={gmStatus.installed}
                  detail={gmStatus.version ?? "未インストール"}
                />
                <StatusRow
                  label="認証状態"
                  ok={gmStatus.logged_in || gmStatus.has_api_key_env}
                  detail={
                    gmStatus.logged_in
                      ? "OAuth ログイン済み"
                      : gmStatus.has_api_key_env
                        ? "GEMINI_API_KEY 環境変数あり"
                        : gmStatus.installed
                          ? "未認証（OAuth ログインまたは GEMINI_API_KEY が必要）"
                          : "Gemini CLI のインストールが必要"
                  }
                />

                {/* Install */}
                {!gmStatus.installed && gmInstallStage === "idle" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
                      npm 経由で公式 CLI をインストールします。ターミナルは開きません。
                    </p>
                    <button
                      onClick={startGmInstall}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
                    >
                      <Download size={13} />
                      Gemini CLI をインストール
                    </button>
                  </div>
                )}
                {gmInstallStage === "running" && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)] mb-1">
                      <Loader2 size={13} className="animate-spin" />
                      インストール中…
                    </div>
                    <div className="text-[10.5px] text-[var(--color-muted)] font-mono truncate">
                      {gmInstallLine}
                    </div>
                  </div>
                )}
                {gmInstallStage === "done" && (
                  <div className="pt-2 border-t border-[var(--color-border)] text-[12px] text-emerald-600 flex items-center gap-1.5">
                    <CheckCircle2 size={13} />
                    インストール完了。次は CLI 内で OAuth ログインまたは APIキーを設定してください。
                  </div>
                )}
                {gmInstallStage === "failed" && (
                  <div className="pt-2 border-t border-[var(--color-border)] text-[12px] text-red-600 flex items-center gap-1.5">
                    <AlertCircle size={13} />
                    インストールに失敗しました。npm が PATH にあるか確認してください。
                  </div>
                )}
                {gmStatus.installed && !gmStatus.logged_in && !gmStatus.has_api_key_env && (
                  <div className="pt-2 border-t border-[var(--color-border)] text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                    認証方法は2通りあります:
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">
                      <li>
                        <span className="font-mono">gemini</span> を一度ターミナルから実行 → OAuth ログイン（無料枠あり）
                      </li>
                      <li>
                        AI Studio で <span className="font-mono">GEMINI_API_KEY</span> を発行 → OS 環境変数にセット
                      </li>
                    </ul>
                  </div>
                )}
              </>
            )}
            {!gmStatus && (
              <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
                <Loader2 size={14} className="animate-spin" />
                確認中…
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
                description:
                  "Block 製 OSS。ACP プロトコル対応。Claude/OpenAI/Ollama 等を BYOK or ローカルで動かせる。Windows は winget 公式無しのため手動配置：GitHub Releases から goose-x86_64-pc-windows-msvc.zip を解凍し、goose.exe を %LOCALAPPDATA%\\Programs\\Goose\\goose.exe に置く（配置に詰まったら結城さん→AI に依頼で OK）。",
                installHelpUrl:
                  "https://github.com/block/goose/releases/latest",
                kind: "manual",
              },
              {
                provider: "opencode",
                label: "OpenCode",
                description:
                  "sst 製 OSS（MIT）。75+ プロバイダ対応、Ollama 経由で完全無料起動が可能。",
                installHelpUrl: "https://opencode.ai/docs/install/",
                kind: "auto",
              },
              {
                provider: "ollama",
                label: "Ollama",
                description:
                  "ローカル LLM ランタイム。これがあれば API キーゼロで OpenCode/Goose を動かせる。",
                installHelpUrl: "https://ollama.com/download",
                kind: "auto",
              },
              {
                provider: "codex-acp",
                label: "Codex-ACP",
                description:
                  "Zed Industries 製 OSS（Apache-2.0）。codex を ACP 経由で動かす。インストールは npm 経由、実行時に環境変数 OPENAI_API_KEY が必要。",
                installHelpUrl:
                  "https://github.com/zed-industries/codex-acp",
                kind: "auto",
              },
              {
                provider: "kiro",
                label: "Kiro CLI",
                description:
                  "AWS 製。AWS Bedrock backed。AWS Builder ID と認証情報が必要（前提が複雑なため、配置や認証に詰まったら AI に丸投げ可）。",
                installHelpUrl: "https://kiro.dev/",
                kind: "manual",
              },
              {
                provider: "qwen",
                label: "Qwen Code",
                description:
                  "Alibaba QwenLM 製 OSS（Apache-2.0、Claude Code fork）。npm 経由でインストール、実行時に環境変数 DASHSCOPE_API_KEY（Alibaba Cloud Model Studio）が必要。",
                installHelpUrl: "https://github.com/QwenLM/qwen-code",
                kind: "auto",
              },
              {
                provider: "kimi",
                label: "Kimi Code CLI",
                description:
                  "Moonshot AI 製。ACP ネイティブサポート（kimi acp）。Python 3.12+ と uv が必要なため手動配置：公式インストールスクリプト（code.kimi.com）か `uv tool install kimi-cli`。認証は CLI 側で `/login` を実行（OAuth）。",
                installHelpUrl: "https://github.com/moonshotai/kimi-cli",
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
                  API キー不要・完全無料で動かせる OSS エージェントとローカル LLM ランタイム。
                  Goose / OpenCode / Ollama の 3 つ揃えると{" "}
                  <strong>Ollama → OpenCode → UNICREW</strong>{" "}
                  の無料起動経路が完成します。Codex-ACP / Kiro は議論プリセット用の手動インストール枠です。
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
                              {version ?? "インストール済み"}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--color-muted)]">
                              <AlertCircle size={12} />
                              未インストール
                            </span>
                          )}
                          {r.kind === "manual" && (
                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-[var(--color-muted)]">
                              手動のみ
                            </span>
                          )}
                          <a
                            href={r.installHelpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-[var(--color-accent)] hover:underline"
                          >
                            {r.kind === "manual" ? "インストール手順" : "手動手順"}
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
                                  ? "更新中…"
                                  : "再インストール"
                                : running
                                  ? "インストール中…"
                                  : "自動インストール"}
                            </button>
                            {s.stage === "done" && (
                              <span className="text-[10.5px] text-emerald-600 inline-flex items-center gap-1">
                                <CheckCircle2 size={12} />
                                完了
                              </span>
                            )}
                            {s.stage === "failed" && (
                              <span className="text-[10.5px] text-rose-600 inline-flex items-center gap-1">
                                <AlertCircle size={12} />
                                失敗
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
                  ※ Windows は winget / 全 OS は npm 経由。macOS/Linux の Goose・Ollama は「手動手順」リンクから。
                  Codex-ACP は OPENAI_API_KEY、Kiro は AWS Builder ID + 認証が前提です。
                </p>
              </CategoryAccordion>
            );
          })()}

          {authMode === "apikey" && (
            <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
              <h4 className="font-semibold text-[13px]">Anthropic API キー</h4>
              <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
                キーは OS の Keychain（Windows: Credential Manager / macOS: Keychain）に
                保存されます。アプリ設定ファイルには平文で保存されません。
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
                Anthropic Console でAPIキーを取得
                <ExternalLink size={11} />
              </a>
            </section>
          )}

          <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
            <h4 className="font-semibold text-[13px]">音声入力（任意）</h4>
            <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
              マイクボタンで日本語を話すと OpenAI Whisper が書き起こします。
              キーは OS Keychain に保管され、UNICREW 以外には送信されません。
              空欄でも他機能は動作します（音声入力だけ無効化）。
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
              OpenAI Platform で API キーを取得
              <ExternalLink size={11} />
            </a>
          </section>

          <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
            <h4 className="font-semibold text-[13px]">表示モード</h4>
            <label className="flex items-start gap-2 text-[12.5px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={beginnerMode}
                onChange={(e) => setBeginnerMode(e.target.checked)}
                className="w-4 h-4 mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium">
                  初心者モード（CLI 用語を完全に隠す・既定）
                </span>
                <span className="block text-[var(--color-muted)] text-[11.5px] mt-0.5 leading-relaxed">
                  AI は「コマンド」「ターミナル」等の専門用語を一切使わず、成果物ベースで報告します。
                  ツール実行の詳細表示も自動で隠されます。<strong>OFF にすると開発者向け表示</strong>になり、ファイル編集・コマンド実行のバブル / ターミナル風パネルが見えるようになります。
                </span>
              </span>
            </label>

          </section>

          <div className="border-t border-[var(--color-border)] pt-5">
            <CharactersSection onCharactersChanged={onCharactersChanged} />
          </div>

          <section className="border-t border-[var(--color-border)] pt-4 text-[12px] text-[var(--color-muted)] leading-relaxed">
            <div className="font-semibold text-[var(--color-text)] mb-1">
              UNICREW について
            </div>
            <p className="leading-relaxed mb-2">
              UNICREW は <strong>完全無料</strong> で配布しています。Claude
              Pro/Max・ChatGPT
              Plus/Pro のサブスクリプションでそのまま動かせるので、追加の API
              課金もありません。本命の uniLinks SaaS 群（UNICORE / UNICARTE
              / UNIDESK ほか）と組み合わせると最大の効果を発揮します。
            </p>
            <div className="font-semibold text-[var(--color-text)] mb-1 mt-2">
              開発中のもの
            </div>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>機能の追加: 1クリックインストール / 上級者向けカスタム追加（Phase C）</li>
              <li>UNI Series ハブ（販売開始タイミングで開放）</li>
              <li>配布版のコード署名（警告なしのインストール体験）</li>
            </ul>

            <div className="font-semibold text-[var(--color-text)] mb-1 mt-4">
              法的注意
            </div>
            <p className="leading-relaxed text-[11px]">
              UNICREW は <strong>Anthropic, PBC</strong> および{" "}
              <strong>OpenAI, Inc.</strong>{" "}
              とは無関係の独立したクライアントアプリです。Anthropic / OpenAI
              の公式ロゴ画像は一切使用していません。
              UNICREW は両社の公式 CLI（claude / codex）を subprocess
              として呼び出すランチャーで、サブスクリプションの OAuth
              トークンには一切触れません（CLI が自前で管理）。
            </p>
            <ul className="list-disc pl-4 space-y-0.5 mt-1 text-[11px]">
              <li>Claude / Anthropic は Anthropic, PBC の商標</li>
              <li>ChatGPT / Codex / GPT は OpenAI, Inc. の商標</li>
              <li>Gemini は Google LLC の商標</li>
            </ul>

            <div className="font-semibold text-[var(--color-text)] mb-1 mt-4">
              利用 OSS（Apache-2.0）
            </div>
            <ul className="list-disc pl-4 space-y-0.5 text-[11px]">
              <li>
                <strong>agent-client-protocol</strong>（Zed 主導の業界標準 ACP）
                — Goose / OpenCode / Codex-acp / Kiro 等の ACP 対応エージェントとの通信に使用。
                Copyright 2025 Zed Industries, Inc. and contributors. ライセンス全文は
                インストール先の <span className="font-mono">THIRD_PARTY_LICENSES/agent-client-protocol/NOTICE.md</span> を参照。
              </li>
            </ul>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md hover:bg-white transition"
          >
            キャンセル
          </button>
          <button
            onClick={save}
            className="px-4 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition"
          >
            保存
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
            ? "Coming soon"
            : allConnected
              ? "接続済み"
              : `${connectedCount} / ${totalCount} 接続`}
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

function detectOs(): "windows" | "mac" | "linux" | "unknown" {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac")) return "mac";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

function manualInstallCommand(
  product: "claude" | "codex",
  os: ReturnType<typeof detectOs>,
): string {
  if (product === "claude") {
    if (os === "windows")
      return "winget install --id Anthropic.ClaudeCode --accept-source-agreements --accept-package-agreements";
    if (os === "mac")
      return "brew install anthropic-ai/claude-code/claude-code || npm install -g @anthropic-ai/claude-code";
    return "npm install -g @anthropic-ai/claude-code";
  }
  return "npm install -g @openai/codex";
}

function InstallFailedFallback({
  product,
  productLabel,
  lastLine,
  helpUrl,
}: {
  product: "claude" | "codex";
  productLabel: string;
  lastLine: string;
  helpUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const os = detectOs();
  const command = manualInstallCommand(product, os);
  const osLabel =
    os === "windows" ? "Windows" : os === "mac" ? "macOS" : os === "linux" ? "Linux" : "OS不明";

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard 拒否時は select-all 領域から手動コピー
    }
  };

  const sendSupport = () => {
    const subject = `[UNICREW] ${productLabel} 自動インストール失敗`;
    const body =
      `${productLabel} の自動インストールが失敗しました。サポートをお願いします。\n\n` +
      `【試した手順】\n自動インストールボタンを押下\n\n` +
      `【手動コマンド（${osLabel}）】\n${command}\n\n` +
      `【最後のログ】\n${lastLine || "(ログ取得なし)"}\n\n` +
      `【環境】\nOS: ${osLabel}\nUA: ${typeof navigator !== "undefined" ? navigator.userAgent : ""}\nUNICREW: 0.1.0\n\n` +
      `――――――――――――――――――――\n` +
      `※ このメールに画面のスクリーンショットを添付していただけると解決が早いです。\n`;
    const url = `mailto:support@uni-core.jp?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = url;
  };

  return (
    <div className="pt-2 border-t border-[var(--color-border)] space-y-2.5">
      <div className="flex items-start gap-2 text-[12px] text-red-600">
        <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
        <span className="leading-relaxed">
          自動インストールに失敗しました。下のいずれかの方法で続行できます。
        </span>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] text-[var(--color-muted)] font-medium">
          ① 手動コマンドで入れる（{osLabel}用）
        </div>
        <div className="bg-white border border-[var(--color-border)] rounded p-2 flex items-start gap-2">
          <span className="flex-1 font-mono text-[11px] text-[var(--color-text)] break-all select-all leading-relaxed">
            {command}
          </span>
          <button
            type="button"
            onClick={copyCommand}
            className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[10.5px] rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] text-[var(--color-text)]"
            title="クリップボードにコピー"
          >
            {copied ? (
              <>
                <Check size={11} className="text-emerald-500" />
                コピー済
              </>
            ) : (
              <>
                <Copy size={11} />
                コピー
              </>
            )}
          </button>
        </div>
        <div className="text-[10.5px] text-[var(--color-muted)] leading-relaxed">
          コマンド画面（{os === "mac" ? "ターミナル" : os === "windows" ? "PowerShell" : "シェル"}）
          を開いて貼り付け→Enter で実行してください。
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={sendSupport}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] bg-white border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface)] text-[var(--color-text)] font-medium"
        >
          <Mail size={12} />
          ② サポートに送る
        </button>
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] bg-white border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface)] text-[var(--color-text)] font-medium"
        >
          <HelpCircle size={12} />
          ③ ヘルプを見る
          <ExternalLink size={10} className="text-[var(--color-muted)]" />
        </a>
      </div>
    </div>
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
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-md px-3 py-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] text-amber-800">
          <AlertCircle size={13} />
          <span className="font-medium">{info.name} の更新あり</span>
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
              更新中…
            </>
          ) : (
            <>
              <Download size={11} />
              今すぐ更新
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
