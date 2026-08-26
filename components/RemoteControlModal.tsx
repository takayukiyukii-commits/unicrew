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
} from "lucide-react";
import QRCode from "qrcode";
import { InteractiveTerminal } from "@/components/InteractiveTerminal";
import { RemoteControlOutputParser } from "@/lib/remote-control";
import { useTranslation } from "@/lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** アクティブスレッドのワークスペース（開始時点の値で固定する） */
  workspace: string | null;
}

/**
 * 公式 Remote Control（`claude remote-control`）ランチャー。
 *
 * - CLI を PTY（InteractiveTerminal）でそのまま動かし、出力から接続 URL を
 *   拾って QR 表示する。trust ダイアログやログイン案内も端末にそのまま出る
 *   ので、CLI の UI 変更に強い。
 * - サーバーは「停止」を押すまで動き続ける（モーダルを閉じても切れない）。
 * - 旧・自前リレー（MobileBridgeModal）とは完全に独立。互いに干渉しない。
 */
export function RemoteControlModal({ open, onClose, workspace }: Props) {
  const { t } = useTranslation();
  const [started, setStarted] = useState(false);
  /** 開始時点の workspace（スレッド切替でサーバーが再起動しないよう固定） */
  const [frozenWs, setFrozenWs] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [exited, setExited] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loginHint, setLoginHint] = useState(false);
  const parserRef = useRef<RemoteControlOutputParser | null>(null);

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

  // モーダルを閉じてもサーバー（PTY）は維持したいので、started の間は
  // 中身をアンマウントせず、外枠だけ hidden にする。
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
          {started && !exited && (
            <span className="text-[10.5px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">
              {t("rc.running")}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto">
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
      </div>
    </div>
  );
}
