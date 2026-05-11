"use client";

import { useEffect, useRef, useState } from "react";
import {
  Smartphone,
  X,
  Copy,
  Check,
  Cloud,
  Wifi,
  Power,
  AlertTriangle,
  Settings,
} from "lucide-react";
import QRCode from "qrcode";
import {
  generateMobileToken,
  MOBILE_TOKEN_LS_KEY,
} from "@/lib/mobile-bridge";
import {
  formatPairCode,
  generatePairCode,
  isCloudConfigured,
  MOBILE_PUBLIC_URL,
} from "@/lib/cloud-bridge";
import { getLanIp } from "@/lib/tauri";

interface Props {
  open: boolean;
  onClose: () => void;
  /** クラウドリレーの開始 / 停止（PC側 page.tsx で channel subscribe） */
  cloudPairCode: string | null;
  onStartCloudPairing: (code: string) => void;
  onStopCloudPairing: () => void;
}

const HOST_LS_KEY = "unicrew.mobile.host.v1";

/**
 * UNICREW スマホ連携の接続情報モーダル。
 *
 * - PC側React 起動時に保存された token を表示
 * - スマホ向けURL（/m?t=...）を表示・コピー
 * - 「トークンを再生成」ボタンで rotation 可能（古いスマホは再ログイン必要）
 *
 * Tailscale 経由で開く想定なので、PC のホスト名（windows.location.host）
 * をそのまま使う。Tailscale URL を持っているユーザーは hint で渡せばOK。
 */
type Mode = "lan" | "cloud";

export function MobileBridgeModal({
  open,
  onClose,
  cloudPairCode,
  onStartCloudPairing,
  onStopCloudPairing,
}: Props) {
  const [mode, setMode] = useState<Mode>("cloud");
  const [token, setToken] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [host, setHost] = useState<string>("");
  const [lanIp, setLanIp] = useState<string | null>(null);
  const cloudReady = isCloudConfigured();

  useEffect(() => {
    if (!open) return;
    const saved = localStorage.getItem(MOBILE_TOKEN_LS_KEY);
    if (saved) setToken(saved);
    else {
      const t = generateMobileToken();
      localStorage.setItem(MOBILE_TOKEN_LS_KEY, t);
      setToken(t);
      // サーバ側にも登録（React 全体起動時にも実行されるが、初回はここで触る）
      void fetch("/api/mobile/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: t }),
      });
    }
    // LAN IPを取得して候補に出す（Tauri 環境のみ動く）
    void getLanIp().then((ip) => {
      setLanIp(ip);
      const savedHost = localStorage.getItem(HOST_LS_KEY);
      if (savedHost) {
        setHost(savedHost);
      } else if (ip) {
        setHost(`${ip}:1420`);
      } else {
        setHost("localhost:1420");
      }
    });
  }, [open]);

  if (!open) return null;

  const setHostAndPersist = (h: string) => {
    setHost(h);
    localStorage.setItem(HOST_LS_KEY, h);
  };
  const url = token && host ? `http://${host}/m?t=${token}` : "";
  const candidates: string[] = [];
  if (lanIp) candidates.push(`${lanIp}:1420`);
  candidates.push("localhost:1420");

  const regenerate = () => {
    const t = generateMobileToken();
    localStorage.setItem(MOBILE_TOKEN_LS_KEY, t);
    setToken(t);
    void fetch("/api/mobile/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t }),
    });
    setCopied(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("URLをコピー：", url);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col">
        <div className="shrink-0 px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <Smartphone size={16} className="text-[var(--color-accent)]" />
          <h2 className="font-bold text-[15px] flex-1">スマホ連携</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label="閉じる"
          >
            <X size={16} />
          </button>
        </div>

        {/* モード切替タブ：QRですぐ（推奨）が左 */}
        <div className="shrink-0 px-3 pt-2 flex items-center gap-1 border-b border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => setMode("cloud")}
            className={`px-3 py-1.5 text-[12px] rounded-t-md border-b-2 ${
              mode === "cloud"
                ? "border-[var(--color-accent)] text-[var(--color-text)] font-semibold"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            <Cloud size={11} className="inline mr-1" />
            QRですぐ使う（推奨）
          </button>
          <button
            type="button"
            onClick={() => setMode("lan")}
            className={`px-3 py-1.5 text-[12px] rounded-t-md border-b-2 ${
              mode === "lan"
                ? "border-[var(--color-accent)] text-[var(--color-text)] font-semibold"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            <Wifi size={11} className="inline mr-1" />
            同じ Wi-Fi（上級者向け）
          </button>
        </div>

        {mode === "cloud" && (
          <CloudPairingPanel
            cloudReady={cloudReady}
            cloudPairCode={cloudPairCode}
            onStart={onStartCloudPairing}
            onStop={onStopCloudPairing}
          />
        )}

        {mode === "lan" && (
        <div className="px-5 py-4 space-y-3">
          <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed">
            スマホとPCを <strong>同じ Wi-Fi</strong> に繋いだ状態で、
            下記の URL をスマホブラウザで開くと PC の UNICREW にメッセージを
            送れる「リモコン」になります。
          </p>

          {/* ホスト名選択（LAN IP 自動検出 / 手動入力） */}
          <div className="rounded-md border border-[var(--color-border)] bg-white p-2.5 space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
              スマホがアクセスする UNICREW のアドレス
            </div>
            <div className="flex flex-wrap gap-1">
              {candidates.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setHostAndPersist(c)}
                  className={`px-2 py-0.5 rounded text-[10.5px] border ${
                    host === c
                      ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                      : "bg-white text-[var(--color-muted)] border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={host}
              onChange={(e) => setHostAndPersist(e.target.value)}
              placeholder="例: 192.168.1.10:1420（PC の LAN IP）"
              className="w-full font-mono text-[11px] border border-[var(--color-border)] rounded px-2 py-1 outline-none focus:border-[var(--color-accent)]"
            />
            <div className="text-[10px] text-[var(--color-muted)]">
              {lanIp
                ? `自動検出した PC の LAN IP: ${lanIp}`
                : "LAN IP を取得中… Wi-Fi に接続されていれば自動で出ます"}
            </div>
          </div>

          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] mb-1">
              スマホ用 URL
            </div>
            <div className="font-mono text-[11px] break-all text-[var(--color-text)] mb-1.5">
              {url || "—"}
            </div>
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--color-accent)] text-white text-[11px] font-medium hover:opacity-90"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? "コピーしました" : "URL をコピー"}
            </button>
          </div>

          <div className="rounded-md border border-amber-200 bg-amber-50/50 p-2.5 text-[11.5px] text-amber-900 leading-relaxed">
            <div className="font-semibold mb-1 flex items-center gap-1.5">
              <AlertTriangle size={12} aria-hidden="true" />
              繋がらない時のチェック
            </div>
            <ol className="list-decimal pl-4 space-y-1">
              <li>
                スマホとPCが <strong>同じ Wi-Fi</strong> に接続されているか
              </li>
              <li>
                UNICREW を <strong>起動したまま</strong>（dev サーバ稼働中）
              </li>
              <li>
                URL のホスト名は <code className="font-mono">localhost</code> ではなく
                <strong>PC の LAN IP</strong>（例:{" "}
                <code className="font-mono">192.168.x.x:1420</code>）を使う
              </li>
              <li>
                Windows Firewall でポート 1420 が LAN 内に許可されているか。
                <strong>管理者 PowerShell</strong> で次のコマンドを1度だけ実行：
                <pre className="mt-1 p-1.5 bg-amber-100 rounded font-mono text-[10.5px] overflow-x-auto whitespace-pre-wrap break-all">
{`New-NetFirewallRule -DisplayName "UNICREW-1420" \`
  -Direction Inbound -Protocol TCP -LocalPort 1420 \`
  -Action Allow -RemoteAddress LocalSubnet`}
                </pre>
              </li>
              <li>
                ルーターによっては「AP アイソレーション（端末分離）」が有効で
                スマホ↔PC通信が遮断されることがある。その場合はルーター設定で
                同機能を OFF にする
              </li>
            </ol>
          </div>

          <div className="rounded-md border border-[var(--color-border)] bg-white p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] mb-1">
              認証トークン（変更すると古いスマホは再ログイン必要）
            </div>
            <div className="font-mono text-[10px] break-all text-[var(--color-muted)]">
              {token}
            </div>
            <button
              type="button"
              onClick={regenerate}
              className="mt-1.5 text-[11px] text-red-600 hover:underline"
            >
              トークンを再生成
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

/**
 * Phase 2 クラウドリレー：ペアリングコード生成 + 表示パネル。
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
            クラウドリレー未設定
          </div>
          UNICREW 配布版で外出先からスマホ連携するには、Supabase 中継プロジェクトを
          1つ用意して環境変数に設定する必要があります。
          <pre className="mt-2 p-2 bg-amber-100 rounded font-mono text-[10.5px] overflow-x-auto">
{`# repos/unicrew/.env.local
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=ey...`}
          </pre>
          設定後 dev サーバ再起動で「クラウド経由」が使えるようになります。
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
      window.prompt("URLをコピー：", url);
    }
  };

  return (
    <div className="px-5 py-4 space-y-3">
      <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed">
        スマホで <strong>下のQRコードを読み取る</strong>と、外出先・別の Wi-Fi
        からでも、この PC の UNICREW にメッセージを送れます。
      </p>

      {cloudPairCode && (
        <>
          {/* QRコード（中央に大きく） */}
          <div className="rounded-xl border-2 border-emerald-200 bg-white p-4 flex flex-col items-center">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt="ペアリングQRコード"
                className="w-[240px] h-[240px]"
              />
            ) : (
              <div className="w-[240px] h-[240px] bg-[var(--color-surface)] flex items-center justify-center text-[12px] text-[var(--color-muted)]">
                QR生成中…
              </div>
            )}
            <div className="mt-3 text-center">
              <div className="text-[10.5px] text-emerald-700 font-semibold uppercase tracking-wide">
                スマホのカメラで読み取り
              </div>
              <div className="font-mono text-[18px] tracking-[0.25em] font-bold text-emerald-700 mt-0.5">
                {formatPairCode(cloudPairCode)}
              </div>
              <div className="text-[10px] text-emerald-700/70 mt-0.5">
                合言葉（24時間有効）
              </div>
            </div>
          </div>

          {/* QR読めない人向けフォールバック（折り畳み） */}
          <details className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-2.5 text-[11.5px]">
            <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-text)]">
              QRが読めない場合：URLをLINE等で送る
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
                {copied ? "コピーしました" : "URL をコピー"}
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
              スマホ連携をやめる
            </button>
            <button
              type="button"
              onClick={start}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-surface)] text-[11.5px]"
              title="合言葉を変える（古いスマホは再スキャン必要）"
            >
              新しい合言葉
            </button>
          </div>

          <div className="text-[10.5px] text-[var(--color-muted)] leading-relaxed">
            ※ UNICREW を <strong>起動したまま</strong>にしてください。閉じるとスマホから繋がりません。
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
          スマホ連携を開始（QRコードを表示）
        </button>
      )}
    </div>
  );
}
