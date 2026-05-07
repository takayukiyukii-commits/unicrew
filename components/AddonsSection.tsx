"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
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
  installClaudePlugin,
  listClaudeMarketplaceCatalog,
  listClaudeMcp,
  listClaudePlugins,
  listClaudeSkills,
  listCodexMarketplaceCatalog,
  listCodexPlugins,
  listCodexSkills,
  removeClaudeMcp,
  toggleClaudeMcp,
  uninstallClaudePlugin,
  type AddonItem,
  type AddonSource,
  type McpAddRequest,
} from "@/lib/tauri";
import {
  CURATED_ADDONS,
  uniProductsByCategory,
  type CuratedAddon,
  type UniCategory,
} from "@/lib/addons";
import { describePlugin, type Locale } from "@/lib/plugin-descriptions";

interface Props {
  workspace?: string | null;
  advancedMode?: boolean;
  onAdvancedModeChange?: (next: boolean) => void;
}

type TabId =
  | "claude-plugin"
  | "claude-skill"
  | "claude-mcp"
  | "codex-plugin"
  | "codex-skill"
  | "uni-series";

interface TabDef {
  id: TabId;
  label: string;
  source: AddonSource;
  kind: AddonItem["kind"];
  icon: typeof Blocks;
  emptyHint: string;
}

const TABS: TabDef[] = [
  {
    id: "claude-plugin",
    label: "Claude プラグイン",
    source: "claude",
    kind: "plugin",
    icon: Plug,
    emptyHint:
      "まだ Claude プラグインは入っていません。下の「おすすめ」から1クリックで追加できます。",
  },
  {
    id: "claude-skill",
    label: "Claude スキル",
    source: "claude",
    kind: "skill",
    icon: Sparkles,
    emptyHint:
      "~/.claude/skills/ にスキルが見つかりません。プラグインを入れると一緒に追加されることもあります。",
  },
  {
    id: "claude-mcp",
    label: "Claude MCP",
    source: "claude",
    kind: "mcp",
    icon: Blocks,
    emptyHint:
      "MCP サーバーは未登録です。Notion / Slack / GitHub 等の外部サービスを Claude から操作したい場合に追加します。",
  },
  {
    id: "codex-plugin",
    label: "Codex プラグイン",
    source: "codex",
    kind: "plugin",
    icon: Code2,
    emptyHint:
      "Codex 公式バンドル以外を入れたい場合は、上級者モードで marketplace を追加できます。",
  },
  {
    id: "codex-skill",
    label: "Codex スキル",
    source: "codex",
    kind: "skill",
    icon: BookOpen,
    emptyHint: "~/.codex/skills/ にスキルが見つかりません。",
  },
  // UNI Series は別構造（Coming Soon カタログ表示）。kind/source は plugin/claude のダミー。
  {
    id: "uni-series",
    label: "UNI Series",
    source: "claude",
    kind: "plugin",
    icon: Puzzle,
    emptyHint: "",
  },
];

export function AddonsSection({
  workspace,
  advancedMode = false,
  onAdvancedModeChange,
}: Props) {
  const [active, setActive] = useState<TabId>("claude-plugin");
  const [installed, setInstalled] = useState<Record<TabId, AddonItem[]>>({
    "claude-plugin": [],
    "claude-skill": [],
    "claude-mcp": [],
    "codex-plugin": [],
    "codex-skill": [],
    "uni-series": [],
  });
  const [marketplaceCatalog, setMarketplaceCatalog] = useState<AddonItem[]>([]);
  const [codexCatalog, setCodexCatalog] = useState<AddonItem[]>([]);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>("ja");

  // localStorage で言語選好を永続化（プラグインタブのみのスコープ）
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("unicrew.addons.locale");
    if (saved === "ja" || saved === "en") setLocale(saved);
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem("unicrew.addons.locale", locale);
  }, [locale]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cp, cs, cm, xp, xs, catalog, xcatalog] = await Promise.all([
        listClaudePlugins().catch(() => []),
        listClaudeSkills(workspace ?? null).catch(() => []),
        listClaudeMcp().catch(() => []),
        listCodexPlugins().catch(() => []),
        listCodexSkills().catch(() => []),
        listClaudeMarketplaceCatalog().catch(() => []),
        listCodexMarketplaceCatalog().catch(() => []),
      ]);
      setInstalled({
        "claude-plugin": cp,
        "claude-skill": cs,
        "claude-mcp": cm,
        "codex-plugin": xp,
        "codex-skill": xs,
        "uni-series": [],
      });
      setMarketplaceCatalog(catalog);
      setCodexCatalog(xcatalog);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workspace]);

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
      if (item.kind !== "mcp" || item.source !== "claude") return;
      setPendingToggle(item.id);
      try {
        await toggleClaudeMcp(item.name, nextEnabled);
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
      setPendingInstall(id);
      setError(null);
      setInfo(null);
      try {
        const result = await installClaudePlugin(id);
        setInfo(`プラグイン '${id}' を追加しました${result ? `: ${result.slice(0, 200)}` : ""}`);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingInstall(null);
      }
    },
    [reload],
  );

  const onUninstallItem = useCallback(
    async (item: AddonItem) => {
      if (item.source !== "claude") {
        setError("Codex 側のアンインストールは Phase D で対応予定です");
        return;
      }
      setPendingUninstall(item.id);
      setError(null);
      setInfo(null);
      try {
        if (item.kind === "mcp") {
          await removeClaudeMcp(item.name);
          setInfo(`MCP '${item.name}' を削除しました`);
        } else if (item.kind === "plugin") {
          const r = await uninstallClaudePlugin(item.id);
          setInfo(`プラグイン '${item.name}' を削除しました: ${r.slice(0, 200)}`);
        } else {
          setError("スキルの削除はファイルマネージャーから手動で行ってください（~/.claude/skills/）");
        }
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPendingUninstall(null);
      }
    },
    [reload],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        {/* 言語切替（プラグイン説明の表示言語のみを切替） */}
        <div
          className="inline-flex rounded-md border border-[var(--color-border)] overflow-hidden text-[11px] font-mono"
          role="group"
          aria-label="Description language"
        >
          {(["ja", "en"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLocale(l)}
              className={clsx(
                "px-2.5 py-1 transition",
                locale === l
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-white hover:bg-[var(--color-surface)] text-[var(--color-muted)]",
              )}
              title={l === "ja" ? "日本語表示" : "English"}
            >
              {l === "ja" ? "日本語" : "EN"}
            </button>
          ))}
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-md border border-[var(--color-border)] hover:bg-white transition disabled:opacity-50"
          title="再読み込み"
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          {locale === "ja" ? "再読み込み" : "Reload"}
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-[var(--color-border)] pb-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const count =
            t.id === "uni-series" ? null : installed[t.id].length;
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md border transition",
                isActive
                  ? "bg-[var(--color-accent)] text-white border-transparent"
                  : "border-[var(--color-border)] hover:bg-white",
              )}
            >
              <Icon size={13} />
              {t.label}
              {count !== null ? (
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
              ) : (
                <span
                  className={clsx(
                    "ml-0.5 px-1.5 rounded-full text-[10px] font-medium uppercase tracking-wider",
                    isActive
                      ? "bg-white/25 text-white"
                      : "bg-amber-100 text-amber-700",
                  )}
                >
                  Soon
                </span>
              )}
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
            {locale === "ja"
              ? `インストール済み（${activeItems.length}）`
              : `Installed (${activeItems.length})`}
          </div>
          {activeItems.length === 0 ? (
            <div className="text-[12px] text-[var(--color-muted)] bg-[var(--color-surface)] border border-dashed border-[var(--color-border)] rounded-md px-3 py-3">
              {activeTab.emptyHint}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {activeItems.map((it) => (
                <InstalledRow
                  key={`${it.kind}:${it.id}`}
                  item={it}
                  locale={locale}
                  pending={pendingToggle === it.id}
                  uninstalling={pendingUninstall === it.id}
                  onToggle={
                    it.kind === "mcp" && it.source === "claude"
                      ? (next) => void onToggleMcp(it, next)
                      : undefined
                  }
                  onUninstall={
                    it.source === "claude" && it.kind !== "skill"
                      ? () => void onUninstallItem(it)
                      : undefined
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {recommendations.length > 0 && (
        <div>
          <div className="text-[11.5px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-1.5 mt-3">
            {locale === "ja"
              ? `おすすめ（公式・検証済み ${recommendations.length}）`
              : `Recommended (verified ${recommendations.length})`}
          </div>
          <ul className="space-y-1.5">
            {recommendations.map((c) => (
              <RecommendationRow
                key={c.id}
                item={c}
                locale={locale}
                installing={pendingInstall === c.id}
                onInstall={
                  c.kind === "plugin" && c.source === "claude"
                    ? () => void onInstallPlugin(c.id)
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
          pendingInstall={pendingInstall}
          onInstall={(id) => void onInstallPlugin(id)}
        />
      )}
      {/* Codex プラグインタブ：bundled-marketplaces から全件 */}
      {active === "codex-plugin" && codexCatalog.length > 0 && (
        <MarketplaceCatalogPanel
          catalog={codexCatalog}
          installed={installed["codex-plugin"]}
          locale={locale}
          pendingInstall={null}
          onInstall={() => {
            setError(
              locale === "ja"
                ? "Codex 側の 1 クリックインストールは Phase D で実装予定です"
                : "Codex 1-click install will land in Phase D",
            );
          }}
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
            上級者モードを有効にする
            <span className="block text-[11px] text-[var(--color-muted)] mt-0.5">
              任意の GitHub リポジトリや MCP サーバーを追加できるようになります。検証されていないコードを実行することになるので、信頼できるソースだけを追加してください。
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
  onToggle,
  onUninstall,
}: {
  item: AddonItem;
  locale: Locale;
  pending?: boolean;
  uninstalling?: boolean;
  onToggle?: (next: boolean) => void;
  onUninstall?: () => void;
}) {
  // Claude のプラグイン/スキルは多言語化テーブルでローカライズ
  const localized =
    item.source === "claude" && (item.kind === "plugin" || item.kind === "skill")
      ? describePlugin(item.id, item.description, locale)
      : { description: item.description ?? "" };
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2 rounded-md border border-[var(--color-border)] bg-white">
      <CategoryIcon category={item.category ?? item.kind} name={item.name} />
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
            {locale === "ja"
              ? item.enabled
                ? "有効"
                : "無効"
              : item.enabled
                ? "Enabled"
                : "Disabled"}
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
        {onToggle && (
          <button
            type="button"
            disabled={pending}
            onClick={() => onToggle(!item.enabled)}
            title={item.enabled ? "無効化する" : "有効化する"}
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
            title="削除する"
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
        {locale === "ja"
          ? `Marketplace カタログ（全 ${catalog.length} 件 / 未追加 ${totalAvailable} 件）`
          : `Marketplace catalog (${catalog.length} total / ${totalAvailable} not installed)`}
      </div>
      <div className="text-[11px] text-[var(--color-muted)] mb-2 leading-relaxed">
        {locale === "ja"
          ? "ローカルに clone 済みの marketplace から実在する全プラグインを表示しています。"
          : "Showing every plugin found in locally cloned marketplaces."}
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
                    <CategoryIcon
                      category={it.category}
                      name={it.name}
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
                            {locale === "ja" ? "インストール済み" : "Installed"}
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
                        title={
                          locale === "ja"
                            ? "1 クリックで追加"
                            : "Install with one click"
                        }
                      >
                        {installing ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <Plus size={10} />
                        )}
                        {locale === "ja" ? "追加" : "Install"}
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
  const grouped = uniProductsByCategory();
  const sections: {
    id: UniCategory;
    label: string;
    descriptionJa: string;
    descriptionEn: string;
  }[] = [
    {
      id: "service",
      label: "Services",
      descriptionJa: "uniLinks が運営する SaaS 群（販売開始準備中）",
      descriptionEn: "SaaS suite by uniLinks (preparing for launch)",
    },
    {
      id: "mcp",
      label: "MCP Servers",
      descriptionJa: "各 UNI 製品を任意の AI クライアントから操作する HTTP MCP",
      descriptionEn:
        "HTTP MCP servers to operate each UNI product from any AI client",
    },
    {
      id: "skill",
      label: "Claude Skills",
      descriptionJa: "UNI シリーズ向け専用スキル（LP・テーマ展開など）",
      descriptionEn:
        "Claude skills tailored for UNI workflows (LPs, theming, etc.)",
    },
    {
      id: "extension",
      label: "Extensions",
      descriptionJa: "VS Code など外部ツール用拡張",
      descriptionEn: "Extensions for VS Code and other external tools",
    },
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-[12px] text-amber-900 leading-relaxed">
        <div className="font-semibold mb-0.5 inline-flex items-center gap-1.5">
          <Puzzle size={13} />
          UNI Series — Coming Soon
        </div>
        {locale === "ja"
          ? "UNICREW 内から uniLinks の SaaS 群・MCP・スキル・拡張をワンクリックで導入できる UNI ハブを開発中です。販売開始までは一覧プレビューのみ公開しています。"
          : "We are building a one-click UNI hub inside UNICREW for the uniLinks SaaS suite, MCP servers, skills, and extensions. Until launch this is a preview-only listing."}
      </div>
      {sections.map((sec) => {
        const items = grouped[sec.id];
        if (items.length === 0) return null;
        return (
          <div key={sec.id}>
            <div className="text-[11.5px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-1.5">
              {sec.label}（{items.length}）
            </div>
            <div className="text-[11.5px] text-[var(--color-muted)] mb-1.5">
              {locale === "ja" ? sec.descriptionJa : sec.descriptionEn}
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {items.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start justify-between gap-3 px-3 py-2 rounded-md border border-[var(--color-border)] bg-white"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold text-[13px] truncate">
                        {p.name}
                      </span>
                      <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                        Coming Soon
                      </span>
                    </div>
                    <div className="text-[11.5px] text-[var(--color-muted)] mt-0.5 leading-snug">
                      {locale === "ja" ? p.taglineJa : p.tagline}
                    </div>
                  </div>
                  {p.url && (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-[var(--color-muted)] hover:text-[var(--color-accent)] mt-0.5"
                      title={`${p.url} を開く`}
                    >
                      <ExternalLink size={13} />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
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
              {locale === "ja" ? "検証済み" : "Verified"}
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
            ? locale === "ja"
              ? "1クリックで追加（claude CLI 経由）"
              : "Install with one click (via claude CLI)"
            : locale === "ja"
              ? "Codex 側の 1 クリック追加は Phase D で実装予定"
              : "Codex 1-click install coming in Phase D"
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
            {locale === "ja" ? "追加中…" : "Installing…"}
          </>
        ) : supported ? (
          <>
            <Plus size={12} />
            {locale === "ja" ? "追加" : "Install"}
          </>
        ) : locale === "ja" ? (
          "近日"
        ) : (
          "Soon"
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
  const [id, setId] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!id.trim() || !repo.trim()) {
      onError("ID と GitHub リポを両方入れてください");
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
        カスタム marketplace を追加
      </div>
      <div className="text-amber-800/80 leading-relaxed text-[11.5px]">
        Anthropic / OpenAI 公式以外の Claude プラグイン marketplace（GitHub リポ）を登録します。
        信頼できるソースのみ追加してください。
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="ID（例: my-team-plugins）"
          className="border border-amber-300 rounded-md px-2 py-1.5 text-[12px] bg-white"
        />
        <input
          type="text"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="GitHub repo（例: my-org/my-plugins）"
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
            clone 中…
          </>
        ) : (
          <>
            <Plus size={12} />
            marketplace を追加
          </>
        )}
      </button>
    </div>
  );
}

function CustomMcpForm({
  onAdded,
  onError,
}: {
  onAdded: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"stdio" | "sse" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      onError("MCP サーバー名を入力してください");
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
      onError("stdio タイプには command を入れてください");
      return;
    }
    if (kind !== "stdio" && !req.url) {
      onError(`${kind} タイプには URL を入れてください`);
      return;
    }
    setBusy(true);
    try {
      await addClaudeMcp(req);
      onAdded(`MCP '${req.name}' を ~/.claude.json に追加しました`);
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
        MCP サーバーを追加
      </div>
      <div className="text-sky-800/80 leading-relaxed text-[11.5px]">
        Notion / Slack / GitHub など外部サービスを Claude から操作する MCP サーバーを登録します。
        次回起動時に有効化されます。
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="サーバー名（例: notion）"
          className="border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white sm:col-span-2"
        />
        <select
          value={kind}
          onChange={(e) =>
            setKind(e.target.value as "stdio" | "sse" | "http")
          }
          className="border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white"
        >
          <option value="stdio">stdio（コマンド型）</option>
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
            placeholder="command（例: npx）"
            className="w-full border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white font-mono"
          />
          <input
            type="text"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="args をスペース区切り（例: -y @notionhq/mcp）"
            className="w-full border border-sky-300 rounded-md px-2 py-1.5 text-[12px] bg-white font-mono"
          />
        </>
      ) : (
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="URL（例: https://example.com/mcp）"
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
            追加中…
          </>
        ) : (
          <>
            <Plus size={12} />
            MCP サーバーを追加
          </>
        )}
      </button>
    </div>
  );
}
