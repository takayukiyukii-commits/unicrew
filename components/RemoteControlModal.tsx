"use client";

import { useEffect, useRef, useState } from "react";
import {
  Smartphone,
  X,
  Copy,
  Check,
  Power,
  Loader2,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import QRCode from "qrcode";
import { InteractiveTerminal } from "@/components/InteractiveTerminal";
import { RemoteControlOutputParser } from "@/lib/remote-control";
import { runCodexRc, type CodexRcPair } from "@/lib/codex-remote";
import { useTranslation } from "@/lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** アクティブスレッドのワークスペース（開始時点の値で固定する） */
  workspace: string | null;
}

type Tab = "claude" | "codex";
type CodexPhase = "idle" | "starting" | "ready" | "error";

/**
 * 公式 Remote Control ランチャー（Claude / Codex）。
 *
 * - Claude: `claude remote-control` を PTY（InteractiveTerminal）でそのまま動かし、
 *   出力から接続 URL を拾って QR 表示。trust/ログインは CLI の画面に任せる。
 * - Codex: `codex remote-control start/pair --json` を PTY で1回ずつ実行し、
 *   手入力ペアコード（例 4VPU-CU3B）を表示する。ChatGPT アプリ側で入力する方式。
 *   🚨 Codex の daemon は Unix 限定（0.150.0 実測）。Windows では案内のみ出す。
 * - 旧・自前リレー（MobileBridgeModal）とは完全に独立。互いに干渉しない。
 */
export function RemoteControlModal({ open, onClose, workspace }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("claude");

  // ── Claude 側 ─────────────────────────────────────────────
  const [started, setStarted] = useState(false);
  /** 開始時点の workspace（スレッド切替でサーバーが再起動しないよう固定） */
  const [frozenWs, setFrozenWs] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [exited, setExited] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loginHint, setLoginHint] = useState(false);
  const parserRef = useRef<RemoteControlOutputParser | null>(null);

  // ── Codex 側 ─────────────────────────────────────────────
  const isWindows =
    typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
  const [codexPhase, setCodexPhase] = useState<CodexPhase>("idle");
  const [codexPair, setCodexPair] = useState<CodexRcPair | null>(null);
  const [codexErr, setCodexErr] = useState("");
  const [codexCopied, setCodexCopied] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  /** 古い非同期結果を捨てるための世代カウンタ */
  const codexGenRef = useRef(0);

  const handleStart = () => {
    parserRef.current = new RemoteControlOutputParser();
    setUrl(null);
    setQrDataUrl("");
    setExited(false);
    setLoginHint(false);
    setFrozenWs(workspace);
    setStarted(true);
  };

  const handleStop = () => {
    // InteractiveTerminal の unmount が ptyKill する
    setStarted(false);
    setUrl(null);
    setQrDataUrl("");
    setExited(false);
    setLoginHint(false);
  };

  const handleOutput = (text: string) => {
    const parser = parserRef.current;
    if (!parser) return;
    parser.push(text);
    const found = parser.url;
    // setState は値が同じでも再レンダーを起こすので、変化した時だけ呼ぶ
    setUrl((prev) => (found && found !== prev ? found : prev));
    if (parser.sawLoginHint) setLoginHint(true);
  };

  // URL が決まったら QR を生成（MobileBridgeModal と同じ設定）
  useEffect(() => {
    if (!url) {
      setQrDataUrl("");
      return;
    }
    void QRCode.toDataURL(url, {
      width: 280,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172a", light: "#ffffff" },
    }).then(setQrDataUrl);
  }, [url]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("URL", url);
    }
  };

  // ── Codex 操作 ────────────────────────────────────────────
  const codexStart = async () => {
    const gen = ++codexGenRef.current;
    setCodexBusy(true);
    setCodexPhase("starting");
    setCodexErr("");
    setCodexPair(null);
    try {
      const started = await runCodexRc("start", { cwd: workspace });
      if (gen !== codexGenRef.current) return;
      if (started.json?.status !== "connected") {
        setCodexErr(started.raw.trim() || t("rc.codex.noResponse"));
        setCodexPhase("error");
        return;
      }
      const paired = await runCodexRc("pair", { cwd: workspace });
      if (gen !== codexGenRef.current) return;
      const pj = paired.json as CodexRcPair | null;
      if (!pj?.manualPairingCode) {
        setCodexErr(paired.raw.trim() || t("rc.codex.noResponse"));
        setCodexPhase("error");
        return;
      }
      setCodexPair(pj);
      setCodexPhase("ready");
    } finally {
      if (gen === codexGenRef.current) setCodexBusy(false);
    }
  };

  const codexRepair = async () => {
    const gen = ++codexGenRef.current;
    setCodexBusy(true);
    try {
      const paired = await runCodexRc("pair", { cwd: workspace });
      if (gen !== codexGenRef.current) return;
      const pj = paired.json as CodexRcPair | null;
      if (pj?.manualPairingCode) {
        setCodexPair(pj);
        setCodexPhase("ready");
      } else {
        setCodexErr(paired.raw.trim() || t("rc.codex.noResponse"));
        setCodexPhase("error");
      }
    } finally {
      if (gen === codexGenRef.current) setCodexBusy(false);
    }
  };

  const codexStop = async () => {
    const gen = ++codexGenRef.current;
    setCodexBusy(true);
    try {
      await runCodexRc("stop", { cwd: workspace, timeoutMs: 30_000 });
    } finally {
      if (gen === codexGenRef.current) {
        setCodexBusy(false);
        setCodexPhase("idle");
        setCodexPair(null);
        setCodexErr("");
      }
    }
  };

  const copyCodexCode = async () => {
    const code = codexPair?.manualPairingCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCodexCopied(true);
      setTimeout(() => setCodexCopied(false), 1500);
    } catch {
      window.prompt("code", code);
    }
  };

  const codexExpiryText = (() => {
    const exp = codexPair?.expiresAt;
    if (!exp) return "";
    const d = new Date(exp * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return t("rc.codex.expires", { time: `${hh}:${mm}` });
  })();

  const tabBtn = (id: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`px-3 py-1.5 text-[12px] rounded-t-md border-b-2 ${
        tab === id
          ? "border-[var(--color-accent)] text-[var(--color-text)] font-semibold"
          : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
    </button>
  );

  // モーダルを閉じてもサーバー（PTY/daemon）は維持したいので、started の間は
  // 中身をアンマウントせず、外枠だけ hidden にする。タブ切替も同様に hidden で残す。
  return (
    <div
      className={
        open
          ? "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          : "hidden"
      }
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[92vh]">
        <div className="shrink-0 px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <Smartphone size={16} className="text-[var(--color-accent)]" />
          <h2 className="font-bold text-[15px] flex-1">{t("rc.title")}</h2>
          {(started && !exited) || codexPhase === "ready" ? (
            <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">
              {t("rc.running")}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="shrink-0 px-3 pt-2 flex items-center gap-1 border-b border-[var(--color-border)]">
          {tabBtn("claude", t("rc.tabClaude"))}
          {tabBtn("codex", t("rc.tabCodex"))}
        </div>

        {/* ── Claude タブ（started の間はタブを離れてもマウント維持） ── */}
        <div
          className={
            tab === "claude" ? "px-5 py-4 space-y-3 overflow-y-auto" : "hidden"
          }
        >
          <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed">
            {t("rc.intro")}
          </p>

          {!started && (
            <>
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                {t("rc.requirements")}
              </div>
              <button
                type="button"
                onClick={handleStart}
                className="w-full h-9 rounded-md bg-[var(--color-accent)] text-white text-[13px] font-semibold hover:opacity-90 transition"
              >
                {t("rc.start")}
              </button>
            </>
          )}

          {started && (
            <>
              {exited ? (
                <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-[12px] text-amber-900 leading-relaxed flex items-start gap-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <div>
                    {t("rc.exited")}
                    {loginHint && (
                      <div className="mt-1 font-semibold">{t("rc.loginHint")}</div>
                    )}
                  </div>
                </div>
              ) : url ? (
                <div className="rounded-xl border-2 border-emerald-200 bg-white p-4 flex flex-col items-center gap-2">
                  {qrDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={qrDataUrl}
                      alt="QR"
                      width={220}
                      height={220}
                      className="rounded"
                    />
                  ) : (
                    <Loader2 size={20} className="animate-spin text-[var(--color-muted)]" />
                  )}
                  <p className="text-[11.5px] text-[var(--color-muted)]">
                    {t("rc.scanHint")}
                  </p>
                  <div className="w-full flex items-center gap-1.5">
                    <code className="flex-1 min-w-0 truncate text-[10.5px] px-2 py-1.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)]">
                      {url}
                    </code>
                    <button
                      type="button"
                      onClick={copy}
                      className="shrink-0 p-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                      title={t("rc.copyUrl")}
                    >
                      {copied ? (
                        <Check size={13} className="text-emerald-600" />
                      ) : (
                        <Copy size={13} />
                      )}
                    </button>
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 p-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                      title={t("rc.openUrl")}
                    >
                      <ExternalLink size={13} />
                    </a>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[12px] text-[var(--color-muted)] flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin shrink-0" />
                  {t("rc.waitingUrl")}
                </div>
              )}

              {/* CLI そのままの端末。trust/ログイン等のやり取りはここで完結する */}
              <div className="rounded-md border border-[var(--color-border)] overflow-hidden">
                <div className="px-2 py-1 text-[10.5px] text-[var(--color-muted)] bg-[var(--color-surface)] border-b border-[var(--color-border)]">
                  {t("rc.terminalHint")}
                </div>
                <div style={{ height: 220 }}>
                  <InteractiveTerminal
                    workspace={frozenWs}
                    paneKey="remote-control"
                    kind="remote-control"
                    onOutput={handleOutput}
                    onExited={() => setExited(true)}
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={handleStop}
                className="w-full h-9 rounded-md border border-red-200 text-red-600 text-[13px] font-semibold hover:bg-red-50 transition inline-flex items-center justify-center gap-1.5"
              >
                <Power size={13} />
                {exited ? t("rc.reset") : t("rc.stop")}
              </button>
            </>
          )}
        </div>

        {/* ── Codex タブ ── */}
        <div
          className={
            tab === "codex" ? "px-5 py-4 space-y-3 overflow-y-auto" : "hidden"
          }
        >
          <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed">
            {t("rc.codex.intro")}
          </p>

          {isWindows ? (
            <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-[12px] text-amber-900 leading-relaxed flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <div>{t("rc.codex.winUnsupported")}</div>
            </div>
          ) : (
            <>
              {codexPhase === "idle" && (
                <>
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                    {t("rc.codex.requirements")}
                  </div>
                  <button
                    type="button"
                    onClick={() => void codexStart()}
                    disabled={codexBusy}
                    className="w-full h-9 rounded-md bg-[var(--color-accent)] text-white text-[13px] font-semibold hover:opacity-90 transition disabled:opacity-60"
                  >
                    {t("rc.codex.start")}
                  </button>
                </>
              )}

              {codexPhase === "starting" && (
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[12px] text-[var(--color-muted)] flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin shrink-0" />
                  {t("rc.codex.starting")}
                </div>
              )}

              {codexPhase === "ready" && codexPair && (
                <>
                  <div className="rounded-xl border-2 border-emerald-200 bg-white p-4 flex flex-col items-center gap-2">
                    <p className="text-[11.5px] text-[var(--color-muted)]">
                      {t("rc.codex.codeLabel")}
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="text-[22px] font-bold tracking-widest px-3 py-1.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)]">
                        {codexPair.manualPairingCode}
                      </code>
                      <button
                        type="button"
                        onClick={copyCodexCode}
                        className="p-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                        title={t("rc.copyUrl")}
                      >
                        {codexCopied ? (
                          <Check size={13} className="text-emerald-600" />
                        ) : (
                          <Copy size={13} />
                        )}
                      </button>
                    </div>
                    {codexExpiryText && (
                      <p className="text-[10.5px] text-[var(--color-muted)]">
                        {codexExpiryText}
                      </p>
                    )}
                  </div>
                  <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                    {t("rc.codex.howto")}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void codexRepair()}
                      disabled={codexBusy}
                      className="flex-1 h-9 rounded-md border border-[var(--color-border)] text-[12.5px] font-semibold hover:bg-[var(--color-surface)] transition inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                    >
                      <RefreshCw size={13} />
                      {t("rc.codex.repair")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void codexStop()}
                      disabled={codexBusy}
                      className="flex-1 h-9 rounded-md border border-red-200 text-red-600 text-[12.5px] font-semibold hover:bg-red-50 transition inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                    >
                      <Power size={13} />
                      {t("rc.codex.stop")}
                    </button>
                  </div>
                  <p className="text-[10.5px] text-[var(--color-muted)] leading-relaxed">
                    {t("rc.codex.daemonNote")}
                  </p>
                </>
              )}

              {codexPhase === "error" && (
                <>
                  <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-[12px] text-amber-900 leading-relaxed">
                    <div className="font-semibold mb-1 flex items-center gap-1.5">
                      <AlertTriangle size={12} />
                      {t("rc.codex.errorHead")}
                    </div>
                    <pre className="whitespace-pre-wrap break-all font-mono text-[10.5px] max-h-40 overflow-y-auto">
                      {codexErr}
                    </pre>
                  </div>
                  <button
                    type="button"
                    onClick={() => void codexStart()}
                    disabled={codexBusy}
                    className="w-full h-9 rounded-md bg-[var(--color-accent)] text-white text-[13px] font-semibold hover:opacity-90 transition disabled:opacity-60"
                  >
                    {t("rc.codex.retry")}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
