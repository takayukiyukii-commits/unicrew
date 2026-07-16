"use client";

/**
 * 設定モーダル内「リモート受付（UNIHUB連携）」セクション（UNIPILOT P3-M3）。
 *
 * - トグルは既定 OFF。ペアリングコードは UNIHUB の AI 秘書画面「PCリモート連携」で発行
 * - 状態表示はカラードット（オンライン/一時エラー/停止/解除済み）
 * - 受信ジョブと結果の履歴をシンプルなリストで表示
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import {
  loadRemoteJobLog,
  remoteNodeManager,
  type RemoteJobLogEntry,
  type RemoteNodeStatus,
} from "@/lib/remote-node";
import { isTauri } from "@/lib/tauri";

const STATUS_META: Record<
  RemoteNodeStatus,
  { label: string; dot: string }
> = {
  off: { label: "停止中", dot: "#9ca3af" },
  connecting: { label: "接続中…", dot: "#f59e0b" },
  online: { label: "オンライン", dot: "#22c55e" },
  error: { label: "一時エラー（再試行中）", dot: "#f59e0b" },
  revoked: { label: "解除済み（要・再ペアリング）", dot: "#ef4444" },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 入力コードを正規化。"crew-abc123" / "ABC123" どちらでも CREW-ABC123 に揃える。 */
function normalizeCode(input: string): string {
  const raw = input.trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "";
  return raw.startsWith("CREW-") ? raw : `CREW-${raw}`;
}

async function detectHostname(): Promise<string> {
  if (isTauri()) {
    try {
      const os = await import("@tauri-apps/plugin-os");
      const h = await os.hostname();
      if (h && h.trim()) return h.trim();
    } catch {
      /* フォールバックへ */
    }
  }
  return "UNICREWのPC";
}

export function RemoteAccessSection() {
  const [, setTick] = useState(0);
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [log, setLog] = useState<RemoteJobLogEntry[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  useEffect(() => {
    remoteNodeManager.init();
    setLog(loadRemoteJobLog());
    const unsub = remoteNodeManager.subscribe(() => {
      setTick((t) => t + 1);
      setLog(loadRemoteJobLog());
    });
    return unsub;
  }, []);

  const config = remoteNodeManager.getConfig();
  const status = remoteNodeManager.getStatus();
  const lastError = remoteNodeManager.getLastError();
  const runningJobId = remoteNodeManager.getRunningJobId();
  const meta = STATUS_META[status];

  const handlePair = useCallback(async () => {
    const normalized = normalizeCode(code);
    if (!normalized || normalized.length < 8) {
      setPairError("UNIHUBで発行されたコード（CREW-XXXXXX）を入力してください。");
      return;
    }
    setPairing(true);
    setPairError(null);
    try {
      const name = await detectHostname();
      await remoteNodeManager.pair(normalized, name);
      setCode("");
    } catch (e) {
      setPairError(e instanceof Error ? e.message : String(e));
    } finally {
      setPairing(false);
    }
  }, [code]);

  return (
    <section className="border border-[var(--color-border)] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold text-[13px] flex items-center gap-2">
          <MonitorSmartphone size={15} className="text-[var(--color-accent)]" />
          リモート受付（UNIHUB連携）
        </h4>
        {config && (
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: meta.dot }}
              aria-hidden
            />
            {meta.label}
          </span>
        )}
      </div>

      <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
        UNIHUBのAI秘書に頼んだPC作業を、このパソコンのClaude
        Codeで実行して結果を返します。実行されるのは
        <strong>UNIHUB側であなたが承認した依頼だけ</strong>
        です。連携の解除（緊急停止）はこのトグルOFF、またはUNIHUBの「PCリモート連携」画面からいつでもできます。
      </p>

      {!config ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="CREW-XXXXXX"
              disabled={pairing}
              className="flex-1 border border-[var(--color-border)] rounded-md px-3 py-2 text-sm font-mono"
            />
            <button
              type="button"
              onClick={() => void handlePair()}
              disabled={pairing || !code.trim()}
              className="px-3 py-2 text-[12.5px] rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 transition disabled:opacity-50 flex items-center gap-1.5 shrink-0"
            >
              {pairing && <Loader2 size={13} className="animate-spin" />}
              接続する
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-muted)] leading-relaxed">
            コードはUNIHUB（hub.uni-core.jp）のAI秘書画面「PCリモート連携」で発行できます（10分有効・使い捨て）。
          </p>
          {pairError && (
            <p className="text-[11.5px] text-red-600 flex items-start gap-1">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              {pairError}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2.5">
          {config.revoked && (
            <div className="border border-red-200 bg-red-50 rounded-md px-3 py-2 text-[11.5px] text-red-700 leading-relaxed flex items-start gap-1.5">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              UNIHUB側で連携が解除されました。再度使うには「連携を解除」してから、新しいコードでペアリングし直してください。
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-[12.5px] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={config.enabled && !config.revoked}
                disabled={Boolean(config.revoked)}
                onChange={(e) =>
                  void remoteNodeManager.setEnabled(e.target.checked)
                }
                className="w-4 h-4"
              />
              <span className="font-medium">リモート受付を有効にする</span>
            </label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => remoteNodeManager.pollNow()}
                disabled={!config.enabled || Boolean(config.revoked)}
                className="px-2 py-1 text-[11px] rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] transition disabled:opacity-40 flex items-center gap-1"
              >
                <RefreshCw size={11} />
                今すぐ確認
              </button>
              <button
                type="button"
                onClick={() => void remoteNodeManager.unpair()}
                className="px-2 py-1 text-[11px] rounded border border-[var(--color-border)] text-red-600 hover:bg-red-50 transition"
              >
                連携を解除
              </button>
            </div>
          </div>

          <p className="text-[11px] text-[var(--color-muted)]">
            接続名: <span className="font-mono">{config.nodeName}</span>
          </p>

          {status === "error" && lastError && (
            <p className="text-[11px] text-amber-700 flex items-start gap-1">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              {lastError}
            </p>
          )}

          {runningJobId && (
            <p className="text-[11.5px] text-[var(--color-accent)] flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" />
              PC作業を実行中です…（最長20分で自動打ち切り）
            </p>
          )}

          {log.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-semibold text-[var(--color-muted)]">
                実行履歴（新しい順・最大{Math.min(log.length, 10)}件表示）
              </div>
              <ul className="space-y-1 max-h-48 overflow-y-auto">
                {log.slice(0, 10).map((entry) => (
                  <li
                    key={`${entry.jobId}-${entry.finishedAt}`}
                    className="border border-[var(--color-border)] rounded-md px-2.5 py-1.5 text-[11.5px]"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedJobId((prev) =>
                          prev === entry.jobId ? null : entry.jobId,
                        )
                      }
                      className="w-full text-left flex items-center gap-1.5"
                    >
                      {entry.ok ? (
                        <CheckCircle2
                          size={13}
                          className="text-green-600 shrink-0"
                        />
                      ) : (
                        <XCircle size={13} className="text-red-500 shrink-0" />
                      )}
                      <span className="text-[var(--color-muted)] shrink-0 font-mono">
                        {formatTime(entry.finishedAt)}
                      </span>
                      <span className="truncate flex-1">{entry.prompt}</span>
                    </button>
                    <div
                      className={clsx(
                        "mt-1 text-[11px] text-[var(--color-muted)] whitespace-pre-wrap leading-relaxed",
                        expandedJobId === entry.jobId
                          ? "max-h-40 overflow-y-auto"
                          : "line-clamp-2",
                      )}
                    >
                      {entry.result}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
