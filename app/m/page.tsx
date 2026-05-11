"use client";

import { useEffect, useRef, useState } from "react";
import { Smartphone, Cloud, Wifi, AlertTriangle } from "lucide-react";
import type {
  MobileStateSnapshot,
} from "@/lib/mobile-bridge";
import {
  formatPairCode,
  isCloudConfigured,
  joinPairChannel,
  sendCloudEvent,
  type CloudEvent,
} from "@/lib/cloud-bridge";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * UNICREW スマホ用リモコンUI（A案・最小MVP）。
 *
 * URL: /m?t=<token>
 *  - PC側UNICREWを開いた状態で、スマホブラウザから Tailscale経由でアクセスする
 *  - token が一致しないと API は 401 を返す
 *  - 最低限「現在のアクティブスレッドを把握 / テキスト送信 / 最新応答プレビュー」を提供
 */
type Mode = "lan" | "cloud";

export default function MobilePage() {
  const [mode, setMode] = useState<Mode>("lan");
  const [token, setToken] = useState<string>("");
  const [pairCode, setPairCode] = useState<string>("");
  const [snapshot, setSnapshot] = useState<MobileStateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const tokenRef = useRef("");
  const cloudChannelRef = useRef<RealtimeChannel | null>(null);
  const [cloudConnected, setCloudConnected] = useState(false);
  /** クラウドモード時のPC情報（プロバイダ・キャラ・スレッド一覧） */
  const [cloudInfo, setCloudInfo] = useState<{
    activeProviderLabel: string | null;
    activeCharacterName: string | null;
    threads: {
      id: string;
      title: string;
      providerLabel: string;
      characterName: string;
    }[];
  }>({ activeProviderLabel: null, activeCharacterName: null, threads: [] });

  // クエリから mode/token/pair を取得
  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    const t = u.searchParams.get("t") ?? "";
    const cloudFlag = u.searchParams.get("cloud") === "1";
    const pair = u.searchParams.get("pair") ?? "";
    if (cloudFlag || pair) {
      setMode("cloud");
      setPairCode(pair);
    }
    setToken(t);
    tokenRef.current = t;
  }, []);

  // クラウドモード: Supabase Realtime channel に subscribe
  useEffect(() => {
    if (mode !== "cloud" || !pairCode) return;
    if (!isCloudConfigured()) {
      setError("このスマホ画面では中継サーバが設定されていません。配布版または .env.local 設定をご確認ください。");
      return;
    }
    const ch = joinPairChannel(pairCode, (ev: CloudEvent) => {
      if (ev.kind === "from_pc") {
        setSnapshot({
          updatedAt: Date.now(),
          activeThreadId: ev.activeThreadId,
          activeThreadTitle: ev.activeThreadTitle,
          threads: [],
          lastAssistantPreview: ev.lastAssistantPreview,
          isStreaming: ev.isStreaming,
        });
        setCloudInfo({
          activeProviderLabel: ev.activeProviderLabel ?? null,
          activeCharacterName: ev.activeCharacterName ?? null,
          threads: ev.threads ?? [],
        });
        setError(null);
        setCloudConnected(true);
      }
    });
    cloudChannelRef.current = ch;
    setCloudConnected(false);
    return () => {
      void ch?.unsubscribe();
      cloudChannelRef.current = null;
      setCloudConnected(false);
    };
  }, [mode, pairCode]);

  // 状態ポーリング（LANモードのみ）
  useEffect(() => {
    if (mode !== "lan") return;
    if (!token) return;
    let active = true;
    const fetchState = async () => {
      try {
        const r = await fetch(`/api/mobile/state?t=${token}`, {
          cache: "no-store",
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          if (active) {
            setError(j.error || `${r.status}`);
            setSnapshot(null);
          }
          return;
        }
        const j = await r.json();
        if (active) {
          setSnapshot(j.snapshot ?? null);
          setError(null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void fetchState();
    const id = setInterval(fetchState, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [mode, token]);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setHint(null);
    try {
      if (mode === "cloud") {
        const ch = cloudChannelRef.current;
        if (!ch) {
          setError("中継チャンネルに接続できていません。ペアリングコードを確認してください。");
          return;
        }
        await sendCloudEvent(ch, {
          kind: "from_mobile",
          threadId: "active",
          text: text.trim(),
        });
        setHint("PC に送信しました。応答が来るまで少し待ってください。");
        setText("");
        return;
      }
      // LAN モード
      if (!token) {
        setError("URL に ?t=<トークン> が付いていません。");
        return;
      }
      const r = await fetch(`/api/mobile/inbox?t=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "active",
          text: text.trim(),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || `送信失敗: ${r.status}`);
      } else {
        setHint("PC に送信しました。応答が来るまで少し待ってください。");
        setText("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <main
      className="min-h-screen bg-white text-[var(--color-text)] flex flex-col"
      style={
        {
          // iOS Safari の env() bottom（ホームインジケータ分）を吸収
          paddingBottom: "env(safe-area-inset-bottom)",
        } as React.CSSProperties
      }
    >
      <header className="shrink-0 border-b border-[var(--color-border)] bg-white px-3 py-2 flex items-center gap-2">
        <Smartphone size={18} className="text-[var(--color-accent)] shrink-0" aria-hidden="true" />
        <span className="font-bold text-[15px]">UNICREW Remote</span>
        <span className="text-[9.5px] px-1.5 py-0.5 rounded font-medium bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-muted)] inline-flex items-center gap-1">
          {mode === "cloud" ? (
            <>
              <Cloud size={10} aria-hidden="true" />
              クラウド経由
            </>
          ) : (
            <>
              <Wifi size={10} aria-hidden="true" />
              同じ Wi-Fi
            </>
          )}
        </span>
        {mode === "cloud" && pairCode && (
          <span className="text-[10px] font-mono text-[var(--color-accent)]">
            {formatPairCode(pairCode)}
          </span>
        )}
        <span
          className={`ml-auto text-[10.5px] px-1.5 py-0.5 rounded font-medium ${
            error
              ? "bg-red-50 text-red-600 border border-red-200"
              : (mode === "lan" ? snapshot : cloudConnected)
              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
              : "bg-amber-50 text-amber-700 border border-amber-200"
          }`}
        >
          {error
            ? "未接続"
            : mode === "lan"
            ? snapshot
              ? "接続中"
              : "接続中…"
            : cloudConnected
            ? "接続中"
            : pairCode
            ? "接続待ち…"
            : "コード未入力"}
        </span>
      </header>

      {/* LANモードでトークンが無い時 */}
      {mode === "lan" && !token && (
        <div className="m-3 p-3 rounded-md border border-amber-200 bg-amber-50 text-[12px] text-amber-800 leading-relaxed">
          URL に <code>?t=&lt;トークン&gt;</code>{" "}
          が付いていません。PCの UNICREW で
          <br />
          ファイルメニュー →「スマホ連携…」を開いて、 表示された URL を
          再度開いてください。
        </div>
      )}

      {/* クラウドモードでペアコード未入力 */}
      {mode === "cloud" && !pairCode && (
        <div className="m-3 p-3 rounded-md border border-[var(--color-border)] bg-white space-y-2">
          <div className="text-[12.5px] font-semibold">
            ペアリングコードを入力
          </div>
          <div className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
            PC の UNICREW で「スマホ連携…」→「クラウド経由」タブの
            「ペアリングを開始」を押すと、6桁のコードが表示されます。
          </div>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={pairCode}
            onChange={(e) =>
              setPairCode(e.target.value.replace(/[^0-9]/g, ""))
            }
            placeholder="123456"
            className="w-full text-center text-[24px] tracking-[0.3em] font-mono border border-[var(--color-border)] rounded-md py-2 outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      )}

      {error && (
        <div className="m-3 p-2.5 rounded-md border border-red-200 bg-red-50 text-[11.5px] text-red-700 flex items-start gap-1.5">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* アクティブスレッド情報 + 切替 */}
      <section className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]/40">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] font-semibold">
            現在のスレッド
          </span>
          {mode === "cloud" && cloudInfo.activeProviderLabel && (
            <span className="text-[10.5px] font-semibold text-[var(--color-accent)]">
              {cloudInfo.activeProviderLabel}
            </span>
          )}
          {mode === "cloud" && cloudInfo.activeCharacterName && (
            <span className="text-[10.5px] text-[var(--color-muted)]">
              ／ {cloudInfo.activeCharacterName}
            </span>
          )}
        </div>
        <div className="text-[14px] font-semibold mt-0.5 truncate">
          {snapshot?.activeThreadTitle ?? "（未選択）"}
        </div>
        {snapshot && (
          <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5 inline-flex items-center gap-1.5">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                snapshot.isStreaming ? "bg-amber-500" : "bg-emerald-500"
              }`}
              aria-hidden="true"
            />
            {snapshot.isStreaming ? "PC で応答中…" : "待機中（送信OK）"}
          </div>
        )}
        {mode === "cloud" && cloudInfo.threads.length >= 1 && (
          <div className="mt-1.5">
            <select
              value={snapshot?.activeThreadId ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                const ch = cloudChannelRef.current;
                if (!ch || !id) return;
                void sendCloudEvent(ch, {
                  kind: "from_mobile_switch",
                  threadId: id,
                });
              }}
              className="w-full border border-[var(--color-border)] rounded-md px-2 py-1.5 text-[12px] bg-white"
            >
              {cloudInfo.threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.providerLabel} ／ {t.characterName} ／ {t.title}
                </option>
              ))}
            </select>
            <div className="text-[10px] text-[var(--color-muted)] mt-0.5">
              スレッドを切り替えると Claude / Codex / 並列 も自動で切り替わります
            </div>
          </div>
        )}
      </section>

      {/* 直近の応答プレビュー */}
      <section className="flex-1 overflow-y-auto px-3 py-3 bg-white">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] font-semibold mb-1">
          直近の応答
        </div>
        {snapshot?.lastAssistantPreview ? (
          <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words bg-[var(--color-surface)]/40 border border-[var(--color-border)] rounded-md p-2.5">
            {snapshot.lastAssistantPreview}
          </div>
        ) : (
          <div className="text-[12px] text-[var(--color-muted)] italic">
            まだ応答はありません。
          </div>
        )}
      </section>

      {/* 入力 */}
      <footer className="shrink-0 border-t border-[var(--color-border)] bg-white p-2 space-y-1.5">
        {hint && (
          <div className="text-[11px] text-emerald-700">{hint}</div>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="メッセージを入力…"
            rows={3}
            className="flex-1 resize-none border border-[var(--color-border)] rounded-md px-2 py-1.5 text-[14px] outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={send}
            disabled={
              !text.trim() ||
              sending ||
              (mode === "lan" ? !token : !pairCode)
            }
            className="shrink-0 px-3 py-2 rounded-md bg-[var(--color-accent)] text-white font-semibold text-[13px] disabled:opacity-30"
          >
            {sending ? "送信中…" : "送信"}
          </button>
        </div>
      </footer>
    </main>
  );
}
