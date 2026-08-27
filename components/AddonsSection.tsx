"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpCircle,
  Blocks,
  BookOpen,
  Brush,
  CheckCircle2,
  Code2,
  Cog,
  ExternalLink,
  FlaskConical,
  GraduationCap,
  Layers,
  Loader2,
  Lock,
  Network,
  Palette,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import {
  addClaudeMarketplace,
  addClaudeMcp,
  addCodexMcp,
  applyAddonUpdate,
  checkAddonUpdates,
  installClaudePlugin,
  installCodexPlugin,
  listClaudeMarketplaceCatalog,
  listClaudeMcp,
  listCodexMcp,
  listClaudePlugins,
  listClaudeSkills,
  listCodexMarketplaceCatalog,
  listCodexPlugins,
  listCodexSkills,
  removeClaudeMcp,
  removeCodexMcp,
  toggleClaudeMcp,
  toggleCodexMcp,
  uninstallClaudePlugin,
  uninstallCodexPlugin,
  type AddonItem,
  type AddonSource,
  type AddonUpdateItem,
  type McpAddRequest,
} from "@/lib/tauri";
import {
  CURATED_ADDONS,
  uniProductsByCategory,
  UNI_PRODUCTS,
  type CuratedAddon,
  type UniCategory,
} from "@/lib/addons";
import { describePlugin, type Locale } from "@/lib/plugin-descriptions";
import { PluginAvatar } from "./PluginAvatar";
import { withTracking, UNILINKS } from "@/lib/outbound";
import { useTranslation } from "@/lib/i18n";

interface Props {
  workspace?: string | null;
  advancedMode?: boolean;
  onAdvancedModeChange?: (next: boolean) => void;
  /** 起動時の自動アップデートチェックを行うか（既定 true）。 */
  autoCheckAddonUpdates?: boolean;
  /**
   * 自動チェックで検知した更新をバックグラウンド適用するか（既定 false）。
   * true の場合、ユーザー承認なしに `applyAllUpdates` 相当を走らせる。
   */
  autoApplyAddonUpdates?: boolean;
  /** 外部から開く時の初期タブ（例: /mcp → "claude-mcp"）。未指定で "claude-plugin"。 */
  initialTab?: string;
}

type TabId =
  | "claude-plugin"
  | "claude-skill"
  | "claude-mcp"
  | "codex-plugin"
  | "codex-skill"
  | "codex-mcp"
  | "uni-series";

interface TabDef {
  id: TabId;
  /** i18n key for label */
  labelKey: string;
  source: AddonSource;
  kind: AddonItem["kind"];
  icon: typeof Blocks;
  /** i18n key for empty hint */
  emptyHintKey: string;
}

const TABS: TabDef[] = [
  {
    id: "claude-plugin",
    labelKey: "addons.tab.claudePlugin",
    source: "claude",
    kind: "plugin",
    icon: Plug,
    emptyHintKey: "addons.empty.claudePlugin",
  },
  {
    id: "claude-skill",
    labelKey: "addons.tab.claudeSkill",
    source: "claude",
    kind: "skill",
    icon: Sparkles,
    emptyHintKey: "addons.empty.claudeSkill",
  },
  {
    id: "claude-mcp",
    labelKey: "addons.tab.claudeMcp",
    source: "claude",
    kind: "mcp",
    icon: Blocks,
    emptyHintKey: "addons.empty.claudeMcp",
  },
  {
    id: "codex-plugin",
    labelKey: "addons.tab.codexPlugin",
    source: "codex",
    kind: "plugin",
    icon: Code2,
    emptyHintKey: "addons.empty.codexPlugin",
  },
  {
    id: "codex-skill",
    labelKey: "addons.tab.codexSkill",
    source: "codex",
    kind: "skill",
    icon: BookOpen,
    emptyHintKey: "addons.empty.codexSkill",
  },
  {
    id: "codex-mcp",
    labelKey: "addons.tab.codexMcp",
    source: "codex",
    kind: "mcp",
    icon: Blocks,
    emptyHintKey: "addons.empty.codexMcp",
  },
  // UNI Series は別構造（Coming Soon カタログ表示）。kind/source は plugin/claude のダミー。
  {
    id: "uni-series",
    labelKey: "addons.tab.uniSeries",
    source: "claude",
    kind: "plugin",
    icon: Puzzle,
    emptyHintKey: "",
  },
];

export function AddonsSection({
  workspace,
  advancedMode = false,
  onAdvancedModeChange,
  autoCheckAddonUpdates = true,
  autoApplyAddonUpdates = false,
  initialTab,
}: Props) {
  const { locale, t: tr, setLocale: applyLocale } = useTranslation();
  const coerceTab = (v: string | undefined): TabId =>
    (TABS.find((t) => t.id === v)?.id as TabId) ?? "claude-plugin";
  const [active, setActive] = useState<TabId>(coerceTab(initialTab));
  useEffect(() => {
    if (initialTab) setActive(coerceTab(initialTab));
  }, [initialTab]);
  const [installed, setInstalled] = useState<Record<TabId, AddonItem[]>>({
    "claude-plugin": [],
    "claude-skill": [],
    "claude-mcp": [],
    "codex-plugin": [],
    "codex-skill": [],
    "codex-mcp": [],
    "uni-series": [],
  });
  const [marketplaceCatalog, setMarketplaceCatalog] = useState<AddonItem[]>([]);
  const [codexCatalog, setCodexCatalog] = useState<AddonItem[]>([]);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  // 監査LOW（2026-08-28 Codex）: id だけだと Claude/Codex で同名 id が衝突した
  // ときに別ソースのカードまで pending 表示になるため source も持つ。
  const [pendingInstall, setPendingInstall] = useState<{
    src: "claude" | "codex";
    id: string;
  } | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 更新チェック関連の state（Phase 1）。
  // items は「has_update=true」のものだけを保持し、id → AddonUpdateItem の Map。
  // チェック中・適用中の進捗用 string も同居させる。
  const [updates, setUpdates] = useState<Map<string, AddonUpdateItem>>(
    () => new Map(),
  );
  const [updatesCheckedAt, setUpdatesCheckedAt] = useState<number | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<string | null>(null);
  const [bulkUpdating, setBulkUpdating] = useState(false);

  // 言語選好は lib/i18n の useTranslation 経由でグローバル管理。
  // 旧 "unicrew.addons.locale" キーは setLocale 側で同期される（後方互換）。

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 監査R3: 各取得の失敗を握りつぶすと「0件」と誤表示され、既存アドオンが
      // 読めていないのに正常に見える。失敗したカテゴリ名を集めて後で通知する。
      const loadErrors: string[] = [];
      const guard = <T,>(label: string, pr: Promise<T[]>): Promise<T[]> =>
        pr.catch((e) => {
          loadErrors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
          return [] as T[];
        });
      const [cp, cs, cm, xp, xs, xm, catalog, xcatalog] = await Promise.all([
        guard("Claude plugins", listClaudePlugins()),
        guard("Claude skills", listClaudeSkills(workspace ?? null)),
        guard("Claude MCP", listClaudeMcp()),
        guard("Codex plugins", listCodexPlugins()),
        guard("Codex skills", listCodexSkills()),
        guard("Codex MCP", listCodexMcp()),
        guard("Claude marketplace", listClaudeMarketplaceCatalog()),
        guard("Codex marketplace", listCodexMarketplaceCatalog()),
      ]);
      setInstalled({
        "claude-plugin": cp,
        "claude-skill": cs,
        "claude-mcp": cm,
        "codex-plugin": xp,
        "codex-skill": xs,
        "codex-mcp": xm,
        "uni-series": [],
      });
      setMarketplaceCatalog(catalog);
      setCodexCatalog(xcatalog);
      // 監査R3: 一部カテゴリの取得に失敗していたら、空表示のまま黙らせずに通知する
      if (loadErrors.length > 0) {
        setError(
          tr("addons.partialLoadError", { detail: loadErrors.join(" / ") }),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workspace, tr]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeTab = TABS.find((t) => t.id === active)!;
  const activeItems = installed[active];
  const isUniSeries = active === "uni-series";

  const recommendations = useMemo<CuratedAddon[]>(() => {
    if (isUniSeries) return [];
    return CURATED_ADDONS.filter(
      (c) => c.source === activeTab.source && c.kind === activeTab.kind,
    ).filter((c) => !activeItems.some((it) => it.id === c.id));
  }, [activeTab, activeItems, isUniSeries]);

  const onToggleMcp = useCallback(
    async (item: AddonItem, nextEnabled: boolean) => {
      if (item.kind !== "mcp") return;
      setPendingToggle(item.id);
      try {
        if (item.source === "codex") {
          await toggleCodexMcp(item.name, nextEnabled);
        } else {
          await toggleClaudeMcp(item.name, nextEnabled);
        }
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingToggle(null);
      }
    },
    [reload],
  );

  const onInstallPlugin = useCallback(
    async (id: string) => {
      setPendingInstall({ src: "claude", id });
      setError(null);
      setInfo(null);
      try {
        const result = await installClaudePlugin(id);
        setInfo(tr("addons.installedToast", { id, detail: result ? `: ${result.slice(0, 200)}` : "" }));
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingInstall(null);
      }
    },
    [reload, tr],
  );

  /** Codex プラグインの1クリック追加（`codex plugin add`・2026-08-28 実装）。 */
  const onInstallCodexPlugin = useCallback(
    async (id: string) => {
      setPendingInstall({ src: "codex", id });
      setError(null);
      setInfo(null);
      try {
        const result = await installCodexPlugin(id);
        setInfo(tr("addons.installedToast", { id, detail: result ? `: ${result.slice(0, 200)}` : "" }));
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingInstall(null);
      }
    },
    [reload, tr],
  );

  // ----- 更新チェック / 適用（Phase 1） -----

  /**
   * Rust `check_addon_updates` を呼び、has_update=true の項目だけ Map に格納する。
   * 自動呼び出し（マウント時 1 日 1 回）と「いま確認」ボタンの両方から使う。
   */
  const checkUpdates = useCallback(async (silent = false) => {
    if (checkingUpdates) return;
    setCheckingUpdates(true);
    if (!silent) {
      setError(null);
      setInfo(null);
    }
    try {
      const res = await checkAddonUpdates();
      if (!res) return;
      const m = new Map<string, AddonUpdateItem>();
      for (const item of res.items) {
        if (item.has_update) {
          m.set(`${item.kind}:${item.id}`, item);
        }
      }
      setUpdates(m);
      setUpdatesCheckedAt(res.checked_at);
      if (!silent) {
        setInfo(
          m.size === 0
            ? tr("addons.updates.allLatest")
            : tr("addons.updates.foundShort", { count: m.size }),
        );
      }
      // localStorage に時刻だけ保存（毎回チェックしないため）
      try {
        localStorage.setItem(
          "unicrew.addons.updates.lastCheckedAt",
          String(res.checked_at),
        );
      } catch {
        /* noop */
      }
    } catch (e) {
      if (!silent) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setCheckingUpdates(false);
    }
  }, [checkingUpdates, tr]);

  /** 1 アイテム適用。成功時はそのアイテムを updates Map から外す。 */
  const applyOneUpdate = useCallback(
    async (item: AddonUpdateItem) => {
      const key = `${item.kind}:${item.id}`;
      setPendingUpdate(key);
      setError(null);
      try {
        await applyAddonUpdate(item.kind, item.id);
        setUpdates((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        setInfo(tr("addons.updates.applied", { name: item.name }));
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingUpdate(null);
      }
    },
    [reload, tr],
  );

  /** 全 has_update を順次適用。失敗してもループは続けて、最後にまとめてエラー表示。 */
  const applyAllUpdates = useCallback(async () => {
    if (bulkUpdating || updates.size === 0) return;
    setBulkUpdating(true);
    setError(null);
    setInfo(null);
    const errors: string[] = [];
    const items = Array.from(updates.values());
    for (const item of items) {
      const key = `${item.kind}:${item.id}`;
      setPendingUpdate(key);
      try {
        await applyAddonUpdate(item.kind, item.id);
        setUpdates((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      } catch (e) {
        errors.push(`${item.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setPendingUpdate(null);
      }
    }
    setBulkUpdating(false);
    await reload();
    if (errors.length === 0) {
      setInfo(tr("addons.updates.bulkApplied", { count: items.length }));
    } else {
      setError(
        tr("addons.updates.bulkPartial", { ok: items.length - errors.length, fail: errors.length }) +
          errors.join("\n"),
      );
    }
  }, [bulkUpdating, updates, reload, tr]);

  // マウント時に 1 日 1 回の自動チェック（localStorage の前回時刻と比較）。
  // 設定で OFF になっていれば手動チェックボタンに任せて自動チェックは行わない。
  // 失敗は静かに飲み込む（オフライン等）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const last = parseInt(
      localStorage.getItem("unicrew.addons.updates.lastCheckedAt") || "0",
      10,
    );
    if (!autoCheckAddonUpdates) {
      setUpdatesCheckedAt(last || null);
      return;
    }
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (!last || Date.now() - last > ONE_DAY) {
      void (async () => {
        await checkUpdates(true);
        // 自動適用がオプトインで ON なら、検知直後にそのままバックグラウンドで適用。
        // 既に「更新中…」状態のセットを待つので、ボタンクリックと二重発火しない。
        if (autoApplyAddonUpdates) {
          await applyAllUpdates();
        }
      })();
    } else {
      setUpdatesCheckedAt(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheckAddonUpdates, autoApplyAddonUpdates]);

  const onUninstallItem = useCallback(
    async (item: AddonItem) => {
      // Codex MCP（codex mcp remove）・Codex プラグイン（codex plugin remove）は対応済み。
      // Codex スキルのみ手動（配置ディレクトリ直削除）のまま。
      if (item.source === "codex" && item.kind === "skill") {
        setError(tr("addons.uninstallCodexUnsupported"));
        return;
      }
      setPendingUninstall(item.id);
      setError(null);
      setInfo(null);
      try {
        if (item.kind === "mcp" && item.source === "codex") {
          await removeCodexMcp(item.name);
          setInfo(tr("addons.removedCodexMcp", { name: item.name }));
        } else if (item.kind === "mcp") {
          await removeClaudeMcp(item.name);
          setInfo(tr("addons.removedClaudeMcp", { name: item.name }));
        } else if (item.kind === "plugin" && item.source === "codex") {
          const r = await uninstallCodexPlugin(item.id);
          setInfo(tr("addons.removedPlugin", { name: item.name, detail: r.slice(0, 200) }));
        } else if (item.kind === "plugin") {
          const r = await uninstallClaudePlugin(item.id);
          setInfo(tr("addons.removedPlugin", { name: item.name, detail: r.slice(0, 200) }));
        } else {
          setError(tr("addons.uninstallSkillManual"));
        }
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingUninstall(null);
      }
    },
    [reload, tr],
  );

  const updateCount = updates.size;

  return (
    <div className="space-y-3">
      {/* アップデート通知バナー。1日1回の自動チェックで件数があれば表示。 */}
      {updateCount > 0 && (
        <div className="border border-amber-300 bg-amber-50 rounded-lg px-3 py-2.5 flex items-center gap-2.5">
          <ArrowUpCircle size={18} className="text-amber-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold text-amber-900">
              {tr("addons.updates.found", { count: updateCount })}
            </div>
            <div className="text-[11px] text-amber-700/90 leading-snug">
              {tr("addons.updates.intro")}
              {updatesCheckedAt && (
                <>
                  {" "}
                  <span className="opacity-70">
                    {tr("addons.updates.lastChecked", {
                      time: new Date(updatesCheckedAt).toLocaleString(
                        locale === "ja" ? "ja-JP" : "en-US",
                        {
                          month: "numeric",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        },
                      ),
                    })}
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void applyAllUpdates()}
            disabled={bulkUpdating || pendingUpdate !== null}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-600 text-white text-[12px] font-medium hover:opacity-90 disabled:opacity-50"
          >
            {bulkUpdating ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                {tr("addons.updates.updating")}
              </>
            ) : (
              <>
                <ArrowUpCircle size={12} />
                {tr("addons.updates.updateAll")}
              </>
            )}
          </button>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {/* アップデート確認ボタン。タブ切替に関係なくチェック対象は全カテゴリ。 */}
        <button
          onClick={() => void checkUpdates(false)}
          disabled={checkingUpdates}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-md border border-[var(--color-border)] hover:bg-white transition disabled:opacity-50"
          title={tr("addons.updates.checkTooltip")}
        >
          {checkingUpdates ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <ArrowUpCircle size={13} />
          )}
          {checkingUpdates ? tr("addons.updates.checking") : tr("addons.updates.checkCta")}
        </button>
        {/* 言語切替（lib/i18n のグローバル locale を切替） */}
        <div
          className="inline-flex rounded-md border border-[var(--color-border)] overflow-hidden text-[11px] font-mono"
          role="group"
          aria-label={tr("addons.langGroupLabel")}
        >
          {(["ja", "en"] as const).map((l) => (
            <button
              key={l}
              onClick={() => applyLocale(l)}
              className={clsx(
                "px-2.5 py-1 transition",
                locale === l
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-white hover:bg-[var(--color-surface)] text-[var(--color-muted)]",
              )}
              title={l === "ja" ? tr("addons.langTitleJa") : tr("addons.langTitleEn")}
            >
              {l === "ja" ? tr("addons.langJa") : tr("addons.langEn")}
            </button>
          ))}
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-md border border-[var(--color-border)] hover:bg-white transition disabled:opacity-50"
          title={tr("addons.reloadTooltip")}
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          {tr("addons.reload")}
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-[var(--color-border)] pb-2">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          // uni-series は「公開中（live）の実数」を出す。旧実装は null → "Soon"
          // バッジ固定だったが、販売中製品が並んだため件数表示に統一（2026-08-28）。
          const count =
            tab.id === "uni-series"
              ? UNI_PRODUCTS.filter((p) => p.status === "live").length
              : installed[tab.id].length;
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md border transition",
                isActive
                  ? "bg-[var(--color-accent)] text-white border-transparent"
                  : "border-[var(--color-border)] hover:bg-white",
              )}
            >
              <Icon size={13} />
              {tr(tab.labelKey)}
              <span
                className={clsx(
                  "ml-0.5 px-1.5 rounded-full text-[10.5px] font-mono",
                  isActive
                    ? "bg-white/25 text-white"
                    : "bg-[var(--color-surface)] text-[var(--color-muted)]",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="text-[12px] text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-2.5 py-1.5">
          {error}
        </div>
      )}
      {info && (
        <div className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2.5 py-1.5">
          {info}
        </div>
      )}

      {isUniSeries ? (
        <UniSeriesPanel locale={locale} />
      ) : (
        <div>
          <div className="text-[11.5px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-1.5">
            {tr("addons.installed", { count: activeItems.length })}
          </div>
          {activeItems.length === 0 ? (
            <div className="text-[12px] text-[var(--color-muted)] bg-[var(--color-surface)] border border-dashed border-[var(--color-border)] rounded-md px-3 py-3">
              {activeTab.emptyHintKey ? tr(activeTab.emptyHintKey) : ""}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {activeItems.map((it) => {
                // 更新キー命名規則は Rust 側と揃える: "claude_plugin" / "skill"。
                // MCP は今回対象外、Codex plugin は version 検出が辛いので Phase 2 で。
                const updateKey =
                  it.source === "claude" && it.kind === "plugin"
                    ? `claude_plugin:${it.id}`
                    : it.source === "claude" && it.kind === "skill" && it.path
                      ? `skill:${it.path}`
                      : null;
                const updateInfo = updateKey ? updates.get(updateKey) : null;
                return (
                  <InstalledRow
                    key={`${it.kind}:${it.id}`}
                    item={it}
                    locale={locale}
                    pending={pendingToggle === it.id}
                    uninstalling={pendingUninstall === it.id}
                    updateInfo={updateInfo}
                    updating={
                      updateKey != null && pendingUpdate === updateKey
                    }
                    onUpdate={
                      updateInfo
                        ? () => void applyOneUpdate(updateInfo)
                        : undefined
                    }
                    onToggle={
                      it.kind === "mcp" && it.source === "claude"
                        ? (next) => void onToggleMcp(it, next)
                        : undefined
                    }
                    onUninstall={
                      (it.source === "claude" && it.kind !== "skill") ||
                      (it.source === "codex" && it.kind === "mcp")
                        ? () => void onUninstallItem(it)
                        : undefined
                    }
                  />
                );
              })}
            </ul>
          )}
        </div>
      )}

      {recommendations.length > 0 && (
        <div>
          <div className="text-[11.5px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-1.5 mt-3">
            {tr("addons.recommended", { count: recommendations.length })}
          </div>
          <ul className="space-y-1.5">
            {recommendations.map((c) => (
              <RecommendationRow
                key={c.id}
                item={c}
                locale={locale}
                installing={
                  pendingInstall?.id === c.id && pendingInstall.src === c.source
                }
                onInstall={
                  c.kind === "plugin" && c.source === "claude"
                    ? () => void onInstallPlugin(c.id)
                    : c.kind === "plugin" && c.source === "codex"
                      ? () => void onInstallCodexPlugin(c.id)
                      : undefined
                }
              />
            ))}
          </ul>
        </div>
      )}

      {/* Claude プラグインタブ：marketplace 全件カタログ（実物リスト）。 */}
      {active === "claude-plugin" && marketplaceCatalog.length > 0 && (
        <MarketplaceCatalogPanel
          catalog={marketplaceCatalog}
          installed={installed["claude-plugin"]}
          locale={locale}
          pendingInstall={
            pendingInstall?.src === "claude" ? pendingInstall.id : null
          }
          onInstall={(id) => void onInstallPlugin(id)}
        />
      )}
      {/* Codex プラグインタブ：bundled-marketplaces から全件。
          `codex plugin add` が公式提供された（v0.147 実測）ため1クリック追加できる。 */}
      {active === "codex-plugin" && codexCatalog.length > 0 && (
        <MarketplaceCatalogPanel
          catalog={codexCatalog}
          installed={installed["codex-plugin"]}
          locale={locale}
          pendingInstall={
            pendingInstall?.src === "codex" ? pendingInstall.id : null
          }
          onInstall={(id) => void onInstallCodexPlugin(id)}
        />
      )}

      <div className="border-t border-[var(--color-border)] pt-3 mt-3">
        <label className="inline-flex items-center gap-2 text-[12px] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={advancedMode}
            onChange={(e) => onAdvancedModeChange?.(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          <span>
            {tr("addons.advanced.title")}
            <span className="block text-[11px] text-[var(--color-muted)] mt-0.5">
              {tr("addons.advanced.desc")}
            </span>
          </span>
        </label>

        {advancedMode && (
          <div className="mt-3 space-y-3">
            <CustomMarketplaceForm
              onAdded={(msg) => {
                setInfo(msg);
                void reload();
              }}
              onError={setError}
            />
            <CustomMcpForm
              source={activeTab.source}
              onAdded={(msg) => {
                setInfo(msg);
                void reload();
              }}
              onError={setError}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function InstalledRow({
  item,
  locale,
  pending,
  uninstalling,
  updateInfo,
  updating,
  onUpdate,
  onToggle,
  onUninstall,
}: {
  item: AddonItem;
  locale: Locale;
  pending?: boolean;
  uninstalling?: boolean;
  /** 「このアイテムにアップデートあり」情報。null なら最新 or 検知対象外。 */
  updateInfo?: AddonUpdateItem | null;
  updating?: boolean;
  onUpdate?: () => void;
  onToggle?: (next: boolean) => void;
  onUninstall?: () => void;
}) {
  const { t: tr } = useTranslation();
  // Claude のプラグイン/スキルは多言語化テーブルでローカライズ
  const localized =
    item.source === "claude" && (item.kind === "plugin" || item.kind === "skill")
      ? describePlugin(item.id, item.description, locale)
      : { description: item.description ?? "" };
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2 rounded-md border border-[var(--color-border)] bg-white">
      <PluginAvatar
        name={item.name}
        category={item.category ?? item.kind}
        namespace={item.namespace}
        author={item.author}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold text-[13px] truncate">{item.name}</span>
          {item.namespace && (
            <span className="text-[10.5px] font-mono text-[var(--color-muted)] px-1.5 py-0.5 bg-[var(--color-surface)] rounded">
              {item.namespace}
            </span>
          )}
          {item.version && (
            <span className="text-[10.5px] font-mono text-[var(--color-muted)]">
              v{item.version}
            </span>
          )}
          <span
            className={clsx(
              "text-[10px] px-1.5 py-0.5 rounded font-medium",
              item.enabled
                ? "bg-emerald-100 text-emerald-700"
                : "bg-zinc-200 text-zinc-600",
            )}
          >
            {item.enabled ? tr("addons.row.enabled") : tr("addons.row.disabled")}
          </span>
          {item.author && (
            <span className="text-[10.5px] text-[var(--color-muted)]">
              by {item.author}
            </span>
          )}
        </div>
        {localized.description && (
          <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5 line-clamp-2">
            {localized.description}
          </div>
        )}
        {item.path && (
          <div className="text-[10.5px] font-mono text-[var(--color-muted)] mt-0.5 truncate">
            {item.path}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 pt-0.5 shrink-0">
        {updateInfo && onUpdate && (
          <button
            type="button"
            disabled={updating}
            onClick={onUpdate}
            title={
              updateInfo.detail ??
              (updateInfo.latest
                ? tr("addons.row.updateTooltipLatest", { ver: updateInfo.latest })
                : tr("addons.row.updateTooltipPlain"))
            }
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500 text-white text-[11px] font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {updating ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <ArrowUpCircle size={11} />
            )}
            {updating
              ? tr("addons.row.updateBtnDoing")
              : updateInfo.latest
                ? tr("addons.row.updateBtnTo", { ver: updateInfo.latest })
                : tr("addons.row.updateBtnPlain")}
          </button>
        )}
        {onToggle && (
          <button
            type="button"
            disabled={pending}
            onClick={() => onToggle(!item.enabled)}
            title={item.enabled ? tr("addons.row.toggleDisable") : tr("addons.row.toggleEnable")}
            className={clsx(
              "relative w-9 h-5 rounded-full transition disabled:opacity-50",
              item.enabled ? "bg-emerald-500" : "bg-zinc-300",
            )}
          >
            <span
              className={clsx(
                "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all",
                item.enabled ? "left-[18px]" : "left-0.5",
              )}
            />
          </button>
        )}
        {onUninstall && (
          <button
            type="button"
            disabled={uninstalling}
            onClick={onUninstall}
            title={tr("addons.row.delete")}
            className="p-1 rounded text-[var(--color-muted)] hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            {uninstalling ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
          </button>
        )}
        <div className="text-[11px] text-[var(--color-muted)] whitespace-nowrap">
          {item.scope}
        </div>
      </div>
    </li>
  );
}

/**
 * カテゴリーから lucide アイコンと色を返す。アイコンが取れないプラグインの代替表示。
 * marketplace.json の `category` フィールド（development / productivity / frontend 等）
 * を見て、適切な視覚アンカーを与える。
 */
function categoryVisual(category: string | null | undefined, name: string): {
  Icon: typeof Code2;
  bg: string;
  fg: string;
} {
  const c = (category ?? "").toLowerCase();
  if (c.includes("front") || c.includes("design") || c.includes("ui"))
    return { Icon: Palette, bg: "#f0e7ff", fg: "#6d28d9" };
  if (c.includes("creat") || c.includes("art") || c.includes("image"))
    return { Icon: Brush, bg: "#fff1f2", fg: "#be185d" };
  if (c.includes("integration") || c.includes("connect"))
    return { Icon: Network, bg: "#ecfeff", fg: "#0891b2" };
  if (c.includes("product") || c.includes("commit") || c.includes("git"))
    return { Icon: Zap, bg: "#fef3c7", fg: "#b45309" };
  if (c.includes("learn") || c.includes("educ") || c.includes("teach"))
    return { Icon: GraduationCap, bg: "#dcfce7", fg: "#15803d" };
  if (c.includes("test") || c.includes("qa") || c.includes("debug"))
    return { Icon: FlaskConical, bg: "#fef9c3", fg: "#a16207" };
  if (c.includes("security") || c.includes("audit"))
    return { Icon: ShieldCheck, bg: "#fee2e2", fg: "#b91c1c" };
  if (c.includes("perf") || c.includes("optim") || c.includes("bench"))
    return { Icon: Rocket, bg: "#ede9fe", fg: "#5b21b6" };
  if (c.includes("infra") || c.includes("deploy") || c.includes("ops"))
    return { Icon: Cog, bg: "#e0e7ff", fg: "#3730a3" };
  if (c === "skill" || c.includes("skill"))
    return { Icon: Sparkles, bg: "#fef3c7", fg: "#92400e" };
  if (c === "mcp" || c.includes("mcp"))
    return { Icon: Blocks, bg: "#ddd6fe", fg: "#5b21b6" };
  if (c === "tool" || c.includes("tool"))
    return { Icon: Wrench, bg: "#e2e8f0", fg: "#334155" };
  if (c.includes("dev")) return { Icon: Code2, bg: "#dbeafe", fg: "#1d4ed8" };
  // 名前から推測
  const lname = name.toLowerCase();
  if (lname.includes("review")) return { Icon: ShieldCheck, bg: "#fee2e2", fg: "#b91c1c" };
  if (lname.includes("commit") || lname.includes("git"))
    return { Icon: Zap, bg: "#fef3c7", fg: "#b45309" };
  if (lname.includes("design") || lname.includes("ui") || lname.includes("frontend"))
    return { Icon: Palette, bg: "#f0e7ff", fg: "#6d28d9" };
  if (lname.includes("image") || lname.includes("nano-banana"))
    return { Icon: Brush, bg: "#fff1f2", fg: "#be185d" };
  // 既定
  return { Icon: Layers, bg: "#f1f5f9", fg: "#475569" };
}

function CategoryIcon({
  category,
  name,
  size = 32,
}: {
  category: string | null | undefined;
  name: string;
  size?: number;
}) {
  const { Icon, bg, fg } = categoryVisual(category, name);
  return (
    <div
      className="rounded-lg shrink-0 flex items-center justify-center"
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        color: fg,
      }}
      aria-hidden
    >
      <Icon size={Math.round(size * 0.55)} />
    </div>
  );
}

function MarketplaceCatalogPanel({
  catalog,
  installed,
  locale,
  pendingInstall,
  onInstall,
}: {
  catalog: AddonItem[];
  installed: AddonItem[];
  locale: Locale;
  pendingInstall: string | null;
  onInstall: (id: string) => void;
}) {
  const { t: tr } = useTranslation();
  const installedIds = new Set(installed.map((it) => it.id));
  const grouped = catalog.reduce<Record<string, AddonItem[]>>((acc, item) => {
    const ns = item.namespace ?? "(unknown)";
    (acc[ns] ??= []).push(item);
    return acc;
  }, {});
  const namespaces = Object.keys(grouped).sort();
  const totalAvailable = catalog.filter((c) => !installedIds.has(c.id)).length;

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-3">
      <div className="text-[11.5px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-1.5">
        {tr("addons.marketplaceTitle", { total: catalog.length, available: totalAvailable })}
      </div>
      <div className="text-[11px] text-[var(--color-muted)] mb-2 leading-relaxed">
        {tr("addons.marketplaceIntro")}
      </div>
      <div className="space-y-3">
        {namespaces.map((ns) => (
          <div key={ns}>
            <div className="text-[10.5px] font-mono text-[var(--color-muted)] mb-1">
              {ns}（{grouped[ns].length}）
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {grouped[ns].map((it) => {
                const isInstalled = installedIds.has(it.id);
                const localized = describePlugin(it.id, it.description, locale);
                const installing = pendingInstall === it.id;
                return (
                  <li
                    key={it.id}
                    className="flex items-start justify-between gap-2 px-3 py-2 rounded-md border border-[var(--color-border)] bg-white"
                  >
                    <PluginAvatar
                      name={it.name}
                      category={it.category}
                      namespace={it.namespace}
                      author={it.author}
                      size={28}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-[12.5px] truncate">
                          {it.name}
                        </span>
                        {it.version && (
                          <span className="text-[10px] font-mono text-[var(--color-muted)]">
                            v{it.version}
                          </span>
                        )}
                        {isInstalled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                            {tr("addons.marketplaceInstalledTag")}
                          </span>
                        )}
                        {it.author && (
                          <span className="text-[10px] text-[var(--color-muted)]">
                            by {it.author}
                          </span>
                        )}
                      </div>
                      {localized.description && (
                        <div className="text-[11px] text-[var(--color-muted)] mt-0.5 line-clamp-2">
                          {localized.description}
                        </div>
                      )}
                    </div>
                    {!isInstalled && (
                      <button
                        onClick={() => onInstall(it.id)}
                        disabled={installing}
                        className="shrink-0 px-2 py-1 text-[11px] rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1"
                        title={tr("addons.installOneClickTitle")}
                      >
                        {installing ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Plus size={10} />
                        )}
                        {tr("addons.install")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function UniSeriesPanel({ locale }: { locale: Locale }) {
  const { t: tr } = useTranslation();
  const grouped = uniProductsByCategory();
  const sections: {
    id: UniCategory;
    label: string;
    descKey: string;
  }[] = [
    {
      id: "service",
      label: "Services",
      descKey: "addons.uni.servicesDesc",
    },
    {
      id: "mcp",
      label: "MCP Servers",
      descKey: "addons.uni.mcpDesc",
    },
    {
      id: "skill",
      label: "Claude Skills",
      descKey: "addons.uni.skillDesc",
    },
    {
      id: "extension",
      label: "Extensions",
      descKey: "addons.uni.extensionDesc",
    },
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-[12px] text-amber-900 leading-relaxed">
        <div className="font-semibold mb-0.5 inline-flex items-center gap-1.5">
          <Puzzle size={13} />
          {tr("addons.uni.bannerTitle")}
        </div>
        {tr("addons.uni.bannerBody")}
      </div>
      {sections.map((sec) => {
        const items = grouped[sec.id];
        if (items.length === 0) return null;
        const liveItems = items.filter((p) => p.status === "live");
        const lockedCount = items.length - liveItems.length;
        return (
          <div key={sec.id}>
            <div className="text-[11.5px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-1.5">
              {tr("addons.uni.sectionCount", { label: sec.label, count: items.length })}
            </div>
            <div className="text-[11.5px] text-[var(--color-muted)] mb-1.5">
              {tr(sec.descKey)}
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {liveItems.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start justify-between gap-3 px-3 py-2 rounded-md border border-[var(--color-border)] bg-white"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold text-[13px] truncate">
                        {p.name}
                      </span>
                    </div>
                    <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5 leading-snug">
                      {locale === "ja" ? p.taglineJa : p.tagline}
                    </div>
                  </div>
                  {p.url && (
                    <a
                      href={withTracking(p.url, "addons_uni")}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-[var(--color-muted)] hover:text-[var(--color-accent)] mt-0.5"
                      title={tr("addons.uni.openLink", { url: p.url })}
                    >
                      <ExternalLink size={13} />
                    </a>
                  )}
                </li>
              ))}
              {lockedCount > 0 && (
                <li className="flex items-center gap-2 px-3 py-2 rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]/40 text-[var(--color-muted)] select-none">
                  <Lock size={13} className="shrink-0" />
                  <span className="text-[12px]">
                    {tr("addons.uni.lockedCount", { count: lockedCount })}
                  </span>
                </li>
              )}
            </ul>
          </div>
        );
      })}
      <UniLinksBand />
    </div>
  );
}

/**
 * uniLinks（UNIシリーズ使い放題メンバーシップ）の帯。
 *
 * 一覧の一番下に置く（先に出すと売り込みの画面になる）。
 * 🚨 数字は販売ページの掲載値だけを書く。書かれていない限定・締切は足さない。
 */
function UniLinksBand() {
  const { t: tr } = useTranslation();
  return (
    <a
      href={withTracking(UNILINKS.url, "addons_membership")}
      target="_blank"
      rel="noreferrer"
      className="block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/50 px-4 py-3 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]/40 transition group"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-[13px]">uniLinks</span>
        <span className="text-[11px] text-[var(--color-muted)]">
          {tr("addons.uni.membershipLead")}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-accent)] group-hover:underline shrink-0">
          {tr("addons.uni.membershipCta")}
          <ExternalLink size={11} />
        </span>
      </div>
      <div className="text-[11.5px] text-[var(--color-muted)] mt-1 leading-relaxed">
        {tr("addons.uni.membershipBody", {
          price: UNILINKS.price.toLocaleString(),
          compare: UNILINKS.compare.toLocaleString(),
          trial: UNILINKS.trial,
        })}
      </div>
    </a>
  );
}

function RecommendationRow({
  item,
  locale,
  installing,
  onInstall,
}: {
  item: CuratedAddon;
  locale: Locale;
  installing?: boolean;
  onInstall?: () => void;
}) {
  const { t: tr } = useTranslation();
  const supported = !!onInstall;
  const localized = describePlugin(item.id, item.description, locale);
  const description = localized.description || item.description;
  const benefit = locale === "ja" ? (localized.benefit ?? item.benefit) : null;
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 rounded-md border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-accent)_4%,white)]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold text-[13px]">{item.label}</span>
          {item.verified && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
              <CheckCircle2 size={10} />
              {tr("addons.row.verified")}
            </span>
          )}
          <span className="text-[10.5px] font-mono text-[var(--color-muted)]">
            {item.id}
          </span>
        </div>
        <div className="text-[12px] text-[var(--color-text)] mt-0.5">
          {description}
        </div>
        {benefit && (
          <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5 italic">
            → {benefit}
          </div>
        )}
      </div>
      <button
        disabled={!supported || installing}
        onClick={onInstall}
        title={
          supported
            ? tr("addons.row.installSupportedTitle")
            : tr("addons.row.installUnsupportedTitle")
        }
        className={clsx(
          "px-3 py-1.5 text-[12px] rounded-md text-white whitespace-nowrap inline-flex items-center gap-1.5",
          supported
            ? "bg-[var(--color-accent)] hover:opacity-90 disabled:opacity-50"
            : "bg-[var(--color-accent)] opacity-40 cursor-not-allowed",
        )}
      >
        {installing ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            {tr("addons.row.installingShort")}
          </>
        ) : supported ? (
          <>
            <Plus size={12} />
            {tr("addons.install")}
          </>
        ) : (
          tr("addons.row.soonShort")
        )}
      </button>
    </li>
  );
}

function CustomMarketplaceForm({
  onAdded,
  onError,
}: {
  onAdded: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { t: tr } = useTranslation();
  const [id, setId] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!id.trim() || !repo.trim()) {
      onError(tr("addons.market.errIdRepo"));
      return;
    }
    setBusy(true);
    try {
      const msg = await addClaudeMarketplace(id.trim(), repo.trim());
      onAdded(msg);
      setId("");
      setRepo("");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="p-3 rounded-md bg-amber-50/60 border border-amber-200 text-[12px] space-y-2">
      <div className="font-semibold text-amber-800 flex items-center gap-1.5">
        <ShieldCheck size={13} />
        {tr("addons.market.heading")}
      </div>
      <div className="text-amber-800/80 leading-relaxed text-[11.5px]">
        {tr("addons.market.desc")}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder={tr("addons.market.idPlaceholder")}
          className="border border-amber-300 rounded-md px-2 py-1.5 text-[12px] bg-white"
        />
        <input
          type="text"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder={tr("addons.market.repoPlaceholder")}
          className="border border-amber-300 rounded-md px-2 py-1.5 text-[12px] bg-white"
        />
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="px-3 py-1.5 rounded-md bg-amber-600 text-white text-[12px] hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5"
      >
        {busy ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            {tr("addons.market.cloning")}
          </>
        ) : (
          <>
            <Plus size={12} />
            {tr("addons.market.add")}
          </>
        )}
      </button>
    </div>
  );
}

function CustomMcpForm({
  source = "claude",
  onAdded,
  onError,
}: {
  source?: AddonSource;
  onAdded: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { t: tr } = useTranslation();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"stdio" | "sse" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      onError(tr("addons.mcp.errName"));
      return;
    }
    const req: McpAddRequest = {
      name: name.trim(),
      kind,
      command: kind === "stdio" ? command.trim() : null,
      args:
        kind === "stdio" && args.trim()
          ? args.trim().split(/\s+/)
          : null,
      url: kind !== "stdio" ? url.trim() : null,
      env: null,
    };
    if (kind === "stdio" && !req.command) {
      onError(tr("addons.mcp.errStdioCmd"));
      return;
    }
    if (kind !== "stdio" && !req.url) {
      onError(tr("addons.mcp.errUrl", { kind }));
      return;
    }
    setBusy(true);
    try {
      if (source === "codex") {
        await addCodexMcp(req);
        onAdded(tr("addons.mcp.addedCodex", { name: req.name }));
      } else {
        await addClaudeMcp(req);
        onAdded(tr("addons.mcp.addedClaude", { name: req.name }));
      }
      setName("");
      setCommand("");
      setArgs("");
      setUrl("");
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-3 rounded-md bg-sky-50/60 border border-sky-200 text-[12px] space-y-2">
      <div className="font-semibold text-sky-800 flex items-center gap-1.5">
        <Blocks size={13} />
        {tr("addons.mcp.heading")}
      </div>
      <div className="text-sky-800/80 leading-relaxed text-[11.5px]">
        {tr("addons.mcp.desc")}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={tr("addons.mcp.namePlaceholder")}
          className="border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white sm:col-span-2"
        />
        <select
          value={kind}
          onChange={(e) =>
            setKind(e.target.value as "stdio" | "sse" | "http")
          }
          className="border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white"
        >
          <option value="stdio">{tr("addons.mcp.stdioOption")}</option>
          <option value="sse">sse</option>
          <option value="http">http</option>
        </select>
      </div>
      {kind === "stdio" ? (
        <>
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={tr("addons.mcp.commandPlaceholder")}
            className="w-full border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white font-mono"
          />
          <input
            type="text"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={tr("addons.mcp.argsPlaceholder")}
            className="w-full border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white font-mono"
          />
        </>
      ) : (
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={tr("addons.mcp.urlPlaceholder")}
          className="w-full border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white font-mono"
        />
      )}
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="px-3 py-1.5 rounded-md bg-sky-600 text-white text-[12px] hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5"
      >
        {busy ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            {tr("addons.mcp.adding")}
          </>
        ) : (
          <>
            <Plus size={12} />
            {tr("addons.mcp.addBtn")}
          </>
        )}
      </button>
    </div>
  );
}
