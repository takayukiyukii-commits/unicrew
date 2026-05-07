/**
 * Curated カタログ：UNICREW が「verified」として 1クリック追加を許可する公式・準公式ソース。
 *
 * 安全方針（販売開始時の既定）:
 *  - Anthropic / OpenAI 公式 marketplace は無条件で verified
 *  - その他は結城さんが手動で追加した運営側ホワイトリストのみ verified
 *  - 上級者モード ON の時だけ「カスタム marketplace 追加」フォームが表示される
 */

export type AddonSourceTag = "claude" | "codex";

export interface CuratedMarketplace {
  id: string;
  source: AddonSourceTag;
  label: string;
  repo: string;
  verified: boolean;
  description: string;
}

export interface CuratedAddon {
  id: string;
  source: AddonSourceTag;
  kind: "plugin" | "skill" | "mcp";
  name: string;
  marketplaceId: string;
  label: string;
  description: string;
  benefit: string;
  riskLevel: "low" | "medium" | "high";
  verified: boolean;
}

export const CURATED_MARKETPLACES: CuratedMarketplace[] = [
  {
    id: "claude-code-plugins",
    source: "claude",
    label: "Anthropic 公式プラグイン",
    repo: "anthropics/claude-code",
    verified: true,
    description: "Anthropic が公式に配布する Claude Code 用プラグイン群",
  },
  {
    id: "openai-codex",
    source: "claude",
    label: "OpenAI 公式 Codex プラグイン",
    repo: "openai/codex-plugin-cc",
    verified: true,
    description: "OpenAI が公式に配布する Claude Code から Codex を呼ぶプラグイン",
  },
  {
    id: "openai-bundled",
    source: "codex",
    label: "OpenAI バンドル（Codex CLI 同梱）",
    repo: "(local)",
    verified: true,
    description: "Codex CLI に同梱されている公式プラグイン群",
  },
];

export const CURATED_ADDONS: CuratedAddon[] = [
  // Claude プラグイン（Anthropic 公式）
  {
    id: "feature-dev@claude-code-plugins",
    source: "claude",
    kind: "plugin",
    name: "feature-dev",
    marketplaceId: "claude-code-plugins",
    label: "機能開発アシスタント",
    description: "コードベースを把握しながら新機能の設計と実装を支援",
    benefit: "「○○機能を追加して」と頼むだけで、設計→実装→レビューまで自動で進む",
    riskLevel: "low",
    verified: true,
  },
  {
    id: "code-review@claude-code-plugins",
    source: "claude",
    kind: "plugin",
    name: "code-review",
    marketplaceId: "claude-code-plugins",
    label: "コードレビュー",
    description: "プルリクエストや差分を品質・セキュリティ観点でレビュー",
    benefit: "「このPRレビューして」で、バグ・脆弱性・改善点を日本語で指摘",
    riskLevel: "low",
    verified: true,
  },
  {
    id: "frontend-design@claude-code-plugins",
    source: "claude",
    kind: "plugin",
    name: "frontend-design",
    marketplaceId: "claude-code-plugins",
    label: "フロントエンドデザイン",
    description: "汎用AIっぽくない、個性のあるUIをコードで生成",
    benefit: "「ランディングページ作って」で量産AI感のないデザインが出る",
    riskLevel: "low",
    verified: true,
  },
  {
    id: "commit-commands@claude-code-plugins",
    source: "claude",
    kind: "plugin",
    name: "commit-commands",
    marketplaceId: "claude-code-plugins",
    label: "Git コミット支援",
    description: "良いコミットメッセージとPR文を自動作成",
    benefit: "「コミットして」だけで日本語の的確なコミットメッセージが入る",
    riskLevel: "low",
    verified: true,
  },
  {
    id: "security-review@claude-code-plugins",
    source: "claude",
    kind: "plugin",
    name: "security-review",
    marketplaceId: "claude-code-plugins",
    label: "セキュリティ監査",
    description: "OWASP Top 10 などの観点で脆弱性をスキャン",
    benefit: "「セキュリティチェックして」で危険な箇所を一覧化",
    riskLevel: "low",
    verified: true,
  },
  {
    id: "codex@openai-codex",
    source: "claude",
    kind: "plugin",
    name: "codex",
    marketplaceId: "openai-codex",
    label: "Codex 連携",
    description: "Claude から OpenAI Codex を呼び出して結果を比較",
    benefit: "Claude と Codex の両方の意見が同じスレッドで聞ける",
    riskLevel: "low",
    verified: true,
  },

  // Codex 公式バンドル
  {
    id: "browser-use@openai-bundled",
    source: "codex",
    kind: "plugin",
    name: "browser-use",
    marketplaceId: "openai-bundled",
    label: "ブラウザ操作",
    description: "Codex がブラウザを開いて Web 操作を実行",
    benefit: "「○○のサイト見てきて」で実際にブラウザを動かして調べてくれる",
    riskLevel: "medium",
    verified: true,
  },
];

export function curatedFor(
  source: AddonSourceTag,
  kind: CuratedAddon["kind"],
): CuratedAddon[] {
  return CURATED_ADDONS.filter((c) => c.source === source && c.kind === kind);
}

export function curatedMarketplacesFor(
  source: AddonSourceTag,
): CuratedMarketplace[] {
  return CURATED_MARKETPLACES.filter((m) => m.source === source);
}

// ---------- UNI Series catalog ----------

export type UniCategory = "service" | "mcp" | "skill" | "extension";

export interface UniProduct {
  id: string;
  name: string;
  category: UniCategory;
  tagline: string;
  url: string | null;
  status: "coming-soon" | "live";
}

/**
 * UNI シリーズ製品カタログ。販売開始までは `coming-soon` で英語表示。
 * 並び順 = 「機能の追加」タブで重要なものから上に表示する順番。
 */
export const UNI_PRODUCTS: UniProduct[] = [
  // Services
  { id: "unicore", name: "UNICORE", category: "service", tagline: "Member sites & LMS", url: "https://uni-core.jp", status: "coming-soon" },
  { id: "unidesk", name: "UNIDESK", category: "service", tagline: "Personal desk & social hub", url: "https://desk.uni-core.jp", status: "coming-soon" },
  { id: "unicarte", name: "UNICARTE", category: "service", tagline: "Coaching & client management", url: "https://carte.uni-core.jp", status: "coming-soon" },
  { id: "unihub", name: "UNIHUB", category: "service", tagline: "Team chat for tiny teams", url: "https://hub.uni-core.jp", status: "coming-soon" },
  { id: "unistep", name: "UNISTEP", category: "service", tagline: "LINE-first marketing automation", url: "https://step.uni-core.jp", status: "coming-soon" },
  { id: "unibase", name: "UNIBASE", category: "service", tagline: "All-in-one growth toolkit", url: "https://base.uni-core.jp", status: "coming-soon" },
  { id: "uniscan", name: "UNISCAN", category: "service", tagline: "Market & persona analytics", url: "https://scan.uni-core.jp", status: "coming-soon" },
  { id: "uniwrite", name: "UNIWRITE", category: "service", tagline: "Long-form writing AI", url: "https://uniwrite.uni-core.jp", status: "coming-soon" },
  { id: "uniwire", name: "UNIWIRE", category: "service", tagline: "AI knowledge media", url: "https://uniwire.uni-core.jp", status: "coming-soon" },
  { id: "unipin", name: "UNIPIN", category: "service", tagline: "Visual bookmarking", url: "https://pin.uni-core.jp", status: "coming-soon" },
  { id: "unidrop", name: "UNIDROP", category: "service", tagline: "MCP marketplace", url: "https://drop.uni-core.jp", status: "coming-soon" },
  { id: "uniskill", name: "UNISKILL", category: "service", tagline: "Skill share marketplace", url: "https://uniskill.uni-core.jp", status: "coming-soon" },
  { id: "unireach", name: "UNIREACH", category: "service", tagline: "Multi-channel social posting", url: "https://reach.uni-core.jp", status: "coming-soon" },
  { id: "unipost", name: "UNIPOST", category: "service", tagline: "Cross-platform broadcasting", url: null, status: "coming-soon" },
  { id: "unisign", name: "UNISIGN", category: "service", tagline: "Lightweight e-signing", url: "https://sign.uni-core.jp", status: "coming-soon" },
  { id: "unibook", name: "UNIBOOK", category: "service", tagline: "Course authoring", url: null, status: "coming-soon" },
  { id: "unidrive", name: "UNIDRIVE", category: "service", tagline: "Knowledge drive", url: null, status: "coming-soon" },
  { id: "unicart", name: "UNICART", category: "service", tagline: "Lightweight checkout", url: null, status: "coming-soon" },
  { id: "uniwiki", name: "UNIWIKI", category: "service", tagline: "Internal AI knowledge wiki", url: null, status: "coming-soon" },

  // MCP servers (one per UNI product, exposed via HTTP MCP)
  { id: "unicore-mcp", name: "UNICORE MCP", category: "mcp", tagline: "Member-site automation from any AI", url: null, status: "coming-soon" },
  { id: "unidesk-mcp", name: "UNIDESK MCP", category: "mcp", tagline: "Desk + social actions from any AI", url: null, status: "coming-soon" },
  { id: "unihub-mcp", name: "UNIHUB MCP", category: "mcp", tagline: "Team chat actions from any AI", url: null, status: "coming-soon" },
  { id: "unistep-mcp", name: "UNISTEP MCP", category: "mcp", tagline: "LINE step delivery from any AI", url: null, status: "coming-soon" },
  { id: "uniwire-mcp", name: "UNIWIRE MCP", category: "mcp", tagline: "Article publishing from any AI", url: null, status: "coming-soon" },
  { id: "unireach-mcp", name: "UNIREACH MCP", category: "mcp", tagline: "Cross-channel posting from any AI", url: null, status: "coming-soon" },
  { id: "unipin-mcp", name: "UNIPIN MCP", category: "mcp", tagline: "Bookmark search from any AI", url: null, status: "coming-soon" },
  { id: "uniscan-mcp", name: "UNISCAN MCP", category: "mcp", tagline: "Persona research from any AI", url: null, status: "coming-soon" },
  { id: "unicarte-mcp", name: "UNICARTE MCP", category: "mcp", tagline: "Coaching ops from any AI", url: null, status: "coming-soon" },
  { id: "unisign-mcp", name: "UNISIGN MCP", category: "mcp", tagline: "E-signing from any AI", url: null, status: "coming-soon" },

  // Claude Skills (curated UNI-specific)
  { id: "uni-lp-studio", name: "uni-lp-studio", category: "skill", tagline: "End-to-end UNI landing page pipeline", url: null, status: "coming-soon" },
  { id: "uni-appearance-rollout", name: "uni-appearance-rollout", category: "skill", tagline: "Theme/dark/radius rollout to UNI products", url: null, status: "coming-soon" },
  { id: "lp-illustration-enhancer", name: "lp-illustration-enhancer", category: "skill", tagline: "Inject Gemini illustrations into UNI LPs", url: null, status: "coming-soon" },
  { id: "uni-mcp-builder", name: "uni-mcp-builder", category: "skill", tagline: "Scaffold a new UNI HTTP MCP", url: null, status: "coming-soon" },

  // Extensions (VS Code etc.)
  { id: "uni-cmd-launcher", name: "UNI Command Launcher", category: "extension", tagline: "VS Code: Ctrl+Alt+C → Japanese command palette", url: null, status: "coming-soon" },
  { id: "uni-claude-pack", name: "UNI Claude Pack", category: "extension", tagline: "VS Code recommended extensions for UNI dev", url: null, status: "coming-soon" },
];

export function uniProductsByCategory(): Record<UniCategory, UniProduct[]> {
  const out: Record<UniCategory, UniProduct[]> = {
    service: [],
    mcp: [],
    skill: [],
    extension: [],
  };
  for (const p of UNI_PRODUCTS) {
    out[p.category].push(p);
  }
  return out;
}
