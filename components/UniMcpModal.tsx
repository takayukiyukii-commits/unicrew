"use client";

import { useEffect, useState } from "react";
import {
  X,
  ExternalLink,
  Plug,
  PlugZap,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import {
  UNI_MCP_ENDPOINTS,
  mcpServerName,
  type UniMcpEndpoint,
} from "@/lib/uni-mcp-endpoints";
import {
  addClaudeMcp,
  addCodexMcp,
  isTauri,
  listClaudeMcp,
  listCodexMcp,
  removeClaudeMcp,
  removeCodexMcp,
  type AddonItem,
} from "@/lib/tauri";

interface Props {
  open: boolean;
  onClose: () => void;
}

const STORAGE_KEY = "unicrew.uni_mcp_keys.v1";
const TARGET_STORAGE_KEY = "unicrew.uni_mcp_target.v1";

type KeysMap = Record<string, string>;
type Target = "claude" | "codex" | "both";

function loadTarget(): Target {
  if (typeof window === "undefined") return "both";
  const v = localStorage.getItem(TARGET_STORAGE_KEY);
  return v === "claude" || v === "codex" || v === "both" ? v : "both";
}

function saveTarget(t: Target) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TARGET_STORAGE_KEY, t);
}

function loadKeys(): KeysMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as KeysMap) : {};
  } catch {
    return {};
  }
}

function saveKeys(keys: KeysMap) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function UniMcpModal({ open, onClose }: Props) {
  const [keys, setKeysState] = useState<KeysMap>({});
  const [installedClaude, setInstalledClaude] = useState<Set<string>>(new Set());
  const [installedCodex, setInstalledCodex] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [target, setTargetState] = useState<Target>("both");

  const setTarget = (t: Target) => {
    setTargetState(t);
    saveTarget(t);
  };

  useEffect(() => {
    if (!open) return;
    setKeysState(loadKeys());
    setTargetState(loadTarget());
    void refreshInstalled();
  }, [open]);

  const refreshInstalled = async () => {
    if (!isTauri()) return;
    try {
      const [cl, cx] = await Promise.all([
        listClaudeMcp().catch(() => [] as AddonItem[]),
        listCodexMcp().catch(() => [] as AddonItem[]),
      ]);
      setInstalledClaude(new Set(cl.map((x) => x.id)));
      setInstalledCodex(new Set(cx.map((x) => x.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setKey = (id: string, value: string) => {
    setKeysState((prev) => {
      const next = { ...prev, [id]: value };
      saveKeys(next);
      return next;
    });
  };

  /**
   * 「target に対して」既に登録されているか。
   * - claude: Claude 側に入っていれば true
   * - codex : Codex 側に入っていれば true
   * - both  : 両方とも入っていれば true（片方だけだと未完了扱い）
   */
  const isInstalled = (e: UniMcpEndpoint) => {
    const name = mcpServerName(e.id);
    const c = installedClaude.has(name);
    const x = installedCodex.has(name);
    if (target === "claude") return c;
    if (target === "codex") return x;
    return c && x;
  };

  const canConnect = (e: UniMcpEndpoint): boolean => {
    if (e.noAuth) return true;
    return !!(keys[e.id] && keys[e.id].trim());
  };

  /** target を踏まえて、UNI MCP を Claude / Codex に追加する（必要な側だけ）。 */
  const addForTarget = async (e: UniMcpEndpoint) => {
    const name = mcpServerName(e.id);
    const headers = e.noAuth
      ? undefined
      : { Authorization: `Bearer ${keys[e.id].trim()}` };
    const tasks: Array<Promise<unknown>> = [];
    if (target !== "codex" && !installedClaude.has(name)) {
      tasks.push(addClaudeMcp({ name, kind: "http", url: e.url, headers }));
    }
    if (target !== "claude" && !installedCodex.has(name)) {
      tasks.push(addCodexMcp({ name, kind: "http", url: e.url, headers }));
    }
    await Promise.all(tasks);
  };

  /** target を踏まえて、UNI MCP を Claude / Codex から削除する（入っている側だけ）。 */
  const removeForTarget = async (e: UniMcpEndpoint) => {
    const name = mcpServerName(e.id);
    const tasks: Array<Promise<unknown>> = [];
    if (target !== "codex" && installedClaude.has(name)) {
      tasks.push(removeClaudeMcp(name));
    }
    if (target !== "claude" && installedCodex.has(name)) {
      tasks.push(removeCodexMcp(name));
    }
    await Promise.all(tasks);
  };

  const connectOne = async (e: UniMcpEndpoint) => {
    if (!canConnect(e)) return;
    if (!isTauri()) {
      setError("MCP接続は Tauri デスクトップアプリ起動時のみ可能です。");
      return;
    }
    setBusy((s) => new Set(s).add(e.id));
    setError(null);
    try {
      await addForTarget(e);
      await refreshInstalled();
    } catch (err) {
      setError(
        `${e.name} の接続に失敗: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(e.id);
        return n;
      });
    }
  };

  const disconnectOne = async (e: UniMcpEndpoint) => {
    if (!isTauri()) return;
    setBusy((s) => new Set(s).add(e.id));
    setError(null);
    try {
      await removeForTarget(e);
      await refreshInstalled();
    } catch (err) {
      setError(
        `${e.name} の切断に失敗: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(e.id);
        return n;
      });
    }
  };

  const connectAll = async () => {
    setBulkBusy(true);
    setError(null);
    try {
      for (const e of UNI_MCP_ENDPOINTS) {
        if (!canConnect(e)) continue;
        if (isInstalled(e)) continue;
        try {
          await addForTarget(e);
        } catch (err) {
          setError(
            `${e.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await refreshInstalled();
    } finally {
      setBulkBusy(false);
    }
  };

  const disconnectAll = async () => {
    setBulkBusy(true);
    setError(null);
    try {
      for (const e of UNI_MCP_ENDPOINTS) {
        if (!isInstalled(e)) continue;
        try {
          await removeForTarget(e);
        } catch {
          // ignore
        }
      }
      await refreshInstalled();
    } finally {
      setBulkBusy(false);
    }
  };

  if (!open) return null;

  const connectableCount = UNI_MCP_ENDPOINTS.filter(
    (e) => canConnect(e) && !isInstalled(e),
  ).length;
  const installedCount = UNI_MCP_ENDPOINTS.filter((e) =>
    isInstalled(e),
  ).length;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="shrink-0 px-5 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <PlugZap size={16} className="text-[var(--color-accent)]" />
          <h2 className="font-bold text-[15px] flex-1">
            UNI 製品 MCP 一括接続
          </h2>
          <span className="text-[11px] text-[var(--color-muted)]">
            接続中 {installedCount} / {UNI_MCP_ENDPOINTS.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label="閉じる"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]/40 text-[12px] text-[var(--color-muted)] leading-relaxed">
          各製品の <code className="font-mono">/api-keys</code> から発行した APIキーを
          貼り付けて「接続」を押すと、選んだ AI（Claude / Codex / 両方）から直接 UNI 製品の
          データにアクセスできるようになります。一度接続すれば以降は再起動しても保持されます。
        </div>

        <div className="px-5 py-2 border-b border-[var(--color-border)] flex items-center gap-2 text-[12px]">
          <span className="text-[11px] text-[var(--color-muted)] font-medium">
            接続先:
          </span>
          {(["claude", "codex", "both"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTarget(t)}
              className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium border transition ${
                target === t
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-white text-[var(--color-muted)] border-[var(--color-border)] hover:bg-[var(--color-surface)]"
              }`}
            >
              {t === "claude" ? "🟠 Claude" : t === "codex" ? "🟢 Codex" : "両方"}
            </button>
          ))}
          <span className="ml-auto text-[10.5px] text-[var(--color-muted)]">
            Claude {installedClaude.size} / Codex {installedCodex.size}
          </span>
        </div>

        <div className="px-5 py-2 border-b border-[var(--color-border)] flex items-center gap-2 text-[12px]">
          <button
            type="button"
            onClick={connectAll}
            disabled={bulkBusy || connectableCount === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--color-accent)] text-white font-medium disabled:opacity-30"
          >
            {bulkBusy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Plug size={12} />
            )}
            鍵が入っているものを全部接続（{connectableCount}件）
          </button>
          <button
            type="button"
            onClick={disconnectAll}
            disabled={bulkBusy || installedCount === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-surface)] disabled:opacity-30"
          >
            <X size={12} />
            全切断
          </button>
          <a
            href="https://drop.uni-core.jp/mcp"
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
          >
            UNIDROP カタログ
            <ExternalLink size={11} />
          </a>
        </div>

        {error && (
          <div className="shrink-0 px-5 py-2 bg-red-50 border-b border-red-200 flex items-start gap-1.5 text-[11.5px] text-red-700">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto unicrew-scroll px-3 py-2 space-y-1.5">
          {UNI_MCP_ENDPOINTS.map((e) => {
            const isOn = isInstalled(e);
            const isBusy = busy.has(e.id);
            return (
              <div
                key={e.id}
                className={`border rounded-lg px-3 py-2.5 ${
                  isOn
                    ? "border-emerald-200 bg-emerald-50/40"
                    : "border-[var(--color-border)] bg-white"
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[13px] font-semibold flex items-center gap-1.5">
                    {isOn && (
                      <CheckCircle2
                        size={13}
                        className="text-emerald-500"
                      />
                    )}
                    {e.name}
                  </span>
                  <span className="text-[10.5px] text-[var(--color-muted)] font-mono">
                    {e.shortLabel}.uni-core.jp
                  </span>
                  <a
                    href={e.apiKeyPath}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-[10.5px] text-[var(--color-accent)] hover:underline inline-flex items-center gap-0.5"
                  >
                    APIキー発行
                    <ExternalLink size={9} />
                  </a>
                </div>
                <div className="text-[11px] text-[var(--color-muted)] mb-1.5">
                  {e.description}
                </div>
                <div className="flex items-center gap-1.5">
                  {!e.noAuth && (
                    <input
                      type="password"
                      value={keys[e.id] ?? ""}
                      onChange={(ev) => setKey(e.id, ev.target.value)}
                      placeholder={`APIキー（${e.keyPrefix}）`}
                      className="flex-1 border border-[var(--color-border)] rounded px-2 py-1 text-[11.5px] outline-none focus:border-[var(--color-accent)] font-mono"
                    />
                  )}
                  {e.noAuth && (
                    <span className="flex-1 text-[11px] text-[var(--color-muted)] italic">
                      認証不要
                    </span>
                  )}
                  {isOn ? (
                    <button
                      type="button"
                      onClick={() => disconnectOne(e)}
                      disabled={isBusy}
                      className="shrink-0 px-2.5 py-1 rounded border border-red-200 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-30 inline-flex items-center gap-1"
                    >
                      {isBusy ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <X size={11} />
                      )}
                      切断
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => connectOne(e)}
                      disabled={isBusy || !canConnect(e)}
                      className="shrink-0 px-2.5 py-1 rounded bg-[var(--color-accent)] text-white text-[11px] font-medium disabled:opacity-30 inline-flex items-center gap-1"
                    >
                      {isBusy ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Plug size={11} />
                      )}
                      接続
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
