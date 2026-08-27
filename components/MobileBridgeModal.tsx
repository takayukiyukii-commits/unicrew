"use client";

import { useEffect, useState } from "react";
import {
  Smartphone,
  X,
  Copy,
  Check,
  Cloud,
  Power,
  Settings,
} from "lucide-react";
import QRCode from "qrcode";
import {
  formatPairCode,
  generatePairCode,
  isCloudConfigured,
  MOBILE_PUBLIC_URL,
} from "@/lib/cloud-bridge";
import { useTranslation } from "@/lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** クラウドリレーの開始 / 停止（PC側 page.tsx で channel subscribe） */
  cloudPairCode: string | null;
  onStartCloudPairing: (code: string) => void;
  onStopCloudPairing: () => void;
}

/**
 * UNICREW スマホ連携の接続情報モーダル。
 *
 * Supabase Realtime 経由のクラウドリレー一本（旧LANモードは2026-08-28に廃止）。
 * - ペアリングコード（6桁）とQRコードを表示し、スマホ側 `/m` ページと接続する
 * - 同一 Wi-Fi・Tailscale・VPN 不要。外出先からでも使える
 */
export function MobileBridgeModal({
  open,
  onClose,
  cloudPairCode,
  onStartCloudPairing,
  onStopCloudPairing,
}: Props) {
  const { t } = useTranslation();

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col">
        <div className="shrink-0 px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <Smartphone size={16} className="text-[var(--color-accent)]" />
          <h2 className="font-bold text-[15px] flex-1">{t("mobile.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <CloudPairingPanel
          cloudReady={isCloudConfigured()}
          cloudPairCode={cloudPairCode}
          onStart={onStartCloudPairing}
          onStop={onStopCloudPairing}
        />
      </div>
    </div>
  );
}

/**
 * クラウドリレー：ペアリングコード生成 + 表示パネル。
 *
 * - 「ペアリングを開始」ボタンで6桁コード生成→PC側 channel subscribe
 * - スマホは /m?cloud=1&pair=<code> でアクセス（同じ channel に subscribe）
 * - 「停止」ボタンで channel unsubscribe
 */
function CloudPairingPanel({
  cloudReady,
  cloudPairCode,
  onStart,
  onStop,
}: {
  cloudReady: boolean;
  cloudPairCode: string | null;
  onStart: (code: string) => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");

  const url = cloudPairCode
    ? `${MOBILE_PUBLIC_URL}/m?cloud=1&pair=${cloudPairCode}`
    : "";

  // パネルが表示された時にまだコードが無ければ自動でペアリング開始
  // （初心者がボタンを押す手間を省き、開いた瞬間にQRが出る）
  useEffect(() => {
    if (cloudReady && !cloudPairCode) {
      onStart(generatePairCode());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudReady]);

  // ペアリングコードが変わるたびにQRコードDataURLを再生成
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

  if (!cloudReady) {
    return (
      <div className="px-5 py-4">
        <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-[12px] text-amber-900 leading-relaxed">
          <div className="font-semibold mb-1 flex items-center gap-1.5">
            <Settings size={12} aria-hidden="true" />
            {t("mobile.cloud.notReadyTitle")}
          </div>
          {t("mobile.cloud.notReadyBody")}
          <pre className="mt-2 p-2 bg-amber-100 rounded font-mono text-[10.5px] overflow-x-auto">
{`# repos/unicrew/.env.local
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=ey...`}
          </pre>
          {t("mobile.cloud.notReadyAfter")}
        </div>
      </div>
    );
  }

  const start = () => {
    onStart(generatePairCode());
    setCopied(false);
  };

  const stop = () => {
    onStop();
    setCopied(false);
  };

  const copy = async () => {
    if (!cloudPairCode) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt(t("mobile.lan.copyPrompt"), url);
    }
  };

  return (
    <div className="px-5 py-4 space-y-3">
      <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed">
        {t("mobile.cloud.introA")} <strong>{t("mobile.cloud.introB")}</strong>{t("mobile.cloud.introC")}
      </p>

      {cloudPairCode && (
        <>
          {/* QRコード（中央に大きく） */}
          <div className="rounded-xl border-2 border-emerald-200 bg-white p-4 flex flex-col items-center">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt={t("mobile.cloud.qrAlt")}
                className="w-[240px] h-[240px]"
              />
            ) : (
              <div className="w-[240px] h-[240px] bg-[var(--color-surface)] flex items-center justify-center text-[12px] text-[var(--color-muted)]">
                {t("mobile.cloud.qrLoading")}
              </div>
            )}
            <div className="mt-3 text-center">
              <div className="text-[10.5px] text-emerald-700 font-semibold uppercase tracking-wide">
                {t("mobile.cloud.scanWithCamera")}
              </div>
              <div className="font-mono text-[18px] tracking-[0.25em] font-bold text-emerald-700 mt-0.5">
                {formatPairCode(cloudPairCode)}
              </div>
              <div className="text-[10px] text-emerald-700/70 mt-0.5">
                {t("mobile.cloud.passphraseHint")}
              </div>
            </div>
          </div>

          {/* QR読めない人向けフォールバック（折り畳み） */}
          <details className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-2.5 text-[11.5px]">
            <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-text)]">
              {t("mobile.cloud.qrFallback")}
            </summary>
            <div className="mt-1.5 space-y-1.5">
              <div className="font-mono text-[10.5px] break-all text-[var(--color-text)]">
                {url}
              </div>
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--color-accent)] text-white text-[10.5px] font-medium hover:opacity-90"
              >
                {copied ? <Check size={10} /> : <Copy size={10} />}
                {copied ? t("mobile.lan.copiedUrl") : t("mobile.lan.copyUrl")}
              </button>
            </div>
          </details>

          {/* 操作 */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={stop}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-surface)] text-[11.5px]"
            >
              <Power size={10} />
              {t("mobile.cloud.stop")}
            </button>
            <button
              type="button"
              onClick={start}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-surface)] text-[11.5px]"
              title={t("mobile.cloud.regenerateTitle")}
            >
              {t("mobile.cloud.regenerate")}
            </button>
          </div>

          <div className="text-[10.5px] text-[var(--color-muted)] leading-relaxed">
            {t("mobile.cloud.keepRunningA")} <strong>{t("mobile.cloud.keepRunningB")}</strong>{t("mobile.cloud.keepRunningC")}
          </div>
        </>
      )}

      {!cloudPairCode && (
        <button
          type="button"
          onClick={start}
          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-[var(--color-accent)] text-white font-semibold text-[13px] hover:opacity-90"
        >
          <Cloud size={13} />
          {t("mobile.cloud.startCta")}
        </button>
      )}
    </div>
  );
}
