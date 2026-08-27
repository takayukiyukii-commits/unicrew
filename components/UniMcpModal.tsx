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
import { withTracking } from "@/lib/outbound";
import { useTranslation } from "@/lib/i18n";

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
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: KeysMap = {};
    for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function saveKeys(keys: KeysMap) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function UniMcpModal({ open, onClose }: Props) {
  const { t } = useTranslation();
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

  const forgetKey = (id: string) => {
    setKeysState((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
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
    const v = keys[e.id];
    return typeof v === "string" && v.trim().length > 0;
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
      setError(t("mcp.errTauriOnly"));
      return;
    }
    setBusy((s) => new Set(s).add(e.id));
    setError(null);
    try {
      await addForTarget(e);
    } catch (err) {
      setError(
        t("mcp.errConnect", { name: e.name, error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      await refreshInstalled();
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
      forgetKey(e.id);
    } catch (err) {
      setError(
        t("mcp.errDisconnect", { name: e.name, error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      await refreshInstalled();
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
            t("mcp.errConnect", { name: e.name, error: err instanceof Error ? err.message : String(err) }),
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
    const failed: string[] = [];
    try {
      for (const e of UNI_MCP_ENDPOINTS) {
        if (!isInstalled(e)) continue;
        try {
          await removeForTarget(e);
          forgetKey(e.id);
        } catch {
          failed.push(e.name);
        }
      }
      await refreshInstalled();
      if (failed.length > 0) {
        setError(t("mcp.errDisconnectSome", { names: failed.join(", ") }));
      }
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
            {t("mcp.title")}
          </h2>
          <span className="text-[11px] text-[var(--color-muted)]">
            {t("mcp.count", { installed: installedCount, total: UNI_MCP_ENDPOINTS.length })}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface)]/40 text-[12px] text-[var(--color-muted)] leading-relaxed">
          {t("mcp.introA")} <code className="font-mono">/api-keys</code> {t("mcp.introB")}
        </div>

        <div className="px-5 py-2 border-b border-[var(--color-border)] flex items-center gap-2 text-[12px]">
          <span className="text-[11px] text-[var(--color-muted)] font-medium">
            {t("mcp.targetLabel")}
          </span>
          {(["claude", "codex", "both"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setTarget(kind)}
              className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium border transition ${
                target === kind
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-white text-[var(--color-muted)] border-[var(--color-border)] hover:bg-[var(--color-surface)]"
              }`}
            >
              {kind === "claude" ? "🟠 Claude" : kind === "codex" ? "🟢 Codex" : t("mcp.targetBoth")}
            </button>
          ))}
          <span className="ml-auto text-[10.5px] text-[var(--color-muted)]">
            {t("mcp.targetCounts", { claude: installedClaude.size, codex: installedCodex.size })}
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
            {t("mcp.connectAll", { count: connectableCount })}
          </button>
          <button
            type="button"
            onClick={disconnectAll}
            disabled={bulkBusy || installedCount === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-surface)] disabled:opacity-30"
          >
            <X size={12} />
            {t("mcp.disconnectAll")}
          </button>
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
                    href={withTracking(e.apiKeyPath, "mcp_apikey")}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto text-[10.5px] text-[var(--color-accent)] hover:underline inline-flex items-center gap-0.5"
                  >
                    {t("mcp.apiKeyIssue")}
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
                      placeholder={t("mcp.keyPlaceholder", { prefix: e.keyPrefix })}
                      className="flex-1 border border-[var(--color-border)] rounded px-2 py-1 text-[11.5px] outline-none focus:border-[var(--color-accent)] font-mono"
                    />
                  )}
                  {e.noAuth && (
                    <span className="flex-1 text-[11px] text-[var(--color-muted)] italic">
                      {t("mcp.noAuth")}
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
                      {t("mcp.disconnect")}
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
                      {t("mcp.connect")}
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
