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
import {
  claudeStatus,
  codexStatus,
  getApiKey,
  getOpenAiApiKey,
  installClaudeCode,
  installCodex,
  listenCodexInstallProgress,
  listenCodexLoginProgress,
  listenInstallProgress,
  listenLoginProgress,
  setApiKey,
  setOpenAiApiKey,
  startClaudeLogin,
  startCodexLogin,
  type ClaudeStatus,
  type CodexStatus,
} from "@/lib/tauri";
import clsx from "clsx";
import { CharactersSection } from "./CharactersSection";
import { AddonsSection } from "./AddonsSection";

interface Props {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (s: AppSettings) => void;
  onCharactersChanged?: () => void;
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
  const [installStage, setInstallStage] = useState<InstallStage>("idle");
  const [installLine, setInstallLine] = useState("");
  const [loginStage, setLoginStage] = useState<LoginStage>("idle");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [cxInstallStage, setCxInstallStage] = useState<InstallStage>("idle");
  const [cxInstallLine, setCxInstallLine] = useState("");
  const [cxLoginStage, setCxLoginStage] = useState<LoginStage>("idle");
  const [cxLoginUrl, setCxLoginUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cxPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      const [c, x] = await Promise.all([claudeStatus(), codexStatus()]);
      setStatus(c);
      setCxStatus(x);
    } finally {
      setRefreshing(false);
    }
  }, []);

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

          {authMode === "subscription" && (
            <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3 bg-[var(--color-surface)]">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-[13px]">Claude 接続状態</h4>
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
                    <div className="pt-2 border-t border-[var(--color-border)]">
                      <div className="flex items-center gap-2 text-[12px] text-red-600">
                        <AlertCircle size={14} />
                        インストールに失敗しました。手動インストールガイドをご確認ください。
                      </div>
                    </div>
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
                        ログイン完了 ✓ さっそく使えます。
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
            </section>
          )}

          {/* Codex setup (always shown so users can opt-in independently of Claude auth mode) */}
          <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3 bg-[var(--color-surface)]">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-[13px]">Codex 接続状態（任意）</h4>
              <button
                onClick={refreshStatus}
                disabled={refreshing}
                className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
              >
                再確認
              </button>
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
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
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="flex items-center gap-2 text-[12px] text-red-600">
                      <AlertCircle size={14} />
                      Codexのインストールに失敗しました。Node.js が PATH に通っているかご確認ください。
                    </div>
                  </div>
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
                      Codex ログイン完了 ✓
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
          </section>

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

            <label
              className={clsx(
                "flex items-start gap-2 text-[12.5px] select-none border-t border-[var(--color-border)] pt-3",
                beginnerMode ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
              )}
            >
              <input
                type="checkbox"
                checked={beginnerMode ? false : showActivity}
                onChange={(e) => setShowActivity(e.target.checked)}
                disabled={beginnerMode}
                className="w-4 h-4 mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium">
                  ツール実行・コード編集を表示する（上級者向け）
                </span>
                <span className="block text-[var(--color-muted)] text-[11.5px] mt-0.5 leading-relaxed">
                  ファイル編集・コマンド実行をバブルとターミナル風パネルで可視化。
                  初心者モード ON 時は自動で OFF になります。
                </span>
              </span>
            </label>
          </section>

          <div className="border-t border-[var(--color-border)] pt-5">
            <CharactersSection onCharactersChanged={onCharactersChanged} />
          </div>

          <div className="border-t border-[var(--color-border)] pt-5">
            <AddonsSection
              advancedMode={advancedMode}
              onAdvancedModeChange={setAdvancedMode}
            />
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
