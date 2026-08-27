/**
 * Curated カタログ：UNICREW が「verified」として 1クリック追加を許可する公式・準公式ソース。
 *
 * 安全方針（販売開始時の既定）:
 *  - Anthropic / OpenAI 公式 marketplace は無条件で verified
 *  - その他はメンテナが手動で追加した運営側ホワイトリストのみ verified
 *  - 上級者モード ON の時だけ「カスタム marketplace 追加」フォームが表示される
 *
 * `verified: true` を付ける基準（2026-05-10 制定 / 商標希釈・誤認混同リスク回避のため）:
 *  1. **公式判定**: 配布元が当該プロダクトの一次ベンダー（例: anthropics/* リポジトリ）
 *     または、ベンダー本体から公式に「公認パートナー」として明示されている
 *  2. **改変なし**: ロゴ・名称・説明文を当該ベンダーの公開資料からそのまま転載しており、
 *     UNICREW 側で誇張・脚色していない
 *  3. **公式提携の含意なし**: ラベル・description で "公式提携" "Powered by ◯◯" 等の
 *     公式提携を匂わせる表現を使っていない（「公式」の語は1のみ可）
 *  4. **GitHub アバターのみ**: 個別プラグインのアイコンとして第三者ロゴ画像をリポに
 *     バンドルしない。`PluginAvatar` 経由の GitHub プロフィール画像表示のみ
 *
 * 4つすべて満たさない限り `verified: false`。判断に迷うものは必ず false で出して
 * 上級者モード経由に回す（信頼バッジ乱発による商標希釈・ユーザー誤認を避ける）。
 *
 * 第三者から「自分のアバター/プラグインを載せないでくれ」と削除依頼を受けた場合:
 *  - 当該エントリを CURATED_ADDONS から削除
 *  - `~/.claude/plugins/cache/avatars/<key>.png` を削除（次回起動でキャッシュ再構築されない）
 *  - 受付は support@uni-core.jp（販売開始までに `/help` にも導線）
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
    // 🚨 2026-08-28: 旧 id は "security-review" だったが、上流のマーケットプレイスで
    //    "security-guidance" に置き換わっていた（一覧13件を実測して確認）。
    //    説明も実物の description に合わせて書き直している（脆弱性スキャンではなく
    //    編集時に警告を出すフック）。ここは推測で書かない。
    id: "security-guidance@claude-code-plugins",
    source: "claude",
    kind: "plugin",
    name: "security-guidance",
    marketplaceId: "claude-code-plugins",
    label: "セキュリティ注意",
    description: "ファイル編集時に、コマンド注入・XSS・危険なコードを警告する",
    benefit: "編集のたびに、危ないコードをその場で指摘してくれる",
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
    // 🚨 2026-08-28: 旧 id は "browser-use" だったが、openai-bundled の実際の
    //    プラグイン名は "chrome"（codex config の実測値）。
    id: "chrome@openai-bundled",
    source: "codex",
    kind: "plugin",
    name: "chrome",
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
  /** 英語のショートタグライン（海外向け）。 */
  tagline: string;
  /** 日本語の短い説明（既定の表示）。 */
  taglineJa: string;
  url: string | null;
  status: "coming-soon" | "live";
}

/**
 * UNI シリーズ製品カタログ。
 * - status "live" = 現に販売中／無料公開中のもの（zuboland.jp と GitHub Releases に実在）
 * - status "coming-soon" = 準備中。UI では件数のみ（鍵アイコン）で見せる
 * - 販売状況の正本: KUZIRA ストア `kuzira/ui/uni-products.js`（zuboland.jp 照合 2026-08-27）
 * - MCP の稼働・APIキー発行 URL は 2026-08-28 に実測（404/転送切れを排除済み）
 * 並び順 = 「機能の追加」タブで重要なものから上に表示する順番。
 */
export const UNI_PRODUCTS: UniProduct[] = [
  // Services
  { id: "unicore", name: "UNICORE", category: "service", tagline: "Member sites & LMS", taglineJa: "会員サイト・教材販売・コース運営の本体", url: "https://unilinks.uni-core.jp", status: "live" }, // 🚨 uni-core.jp は hub へ308転送される（2026-08-28 実測）ため本体を直指定
  { id: "unidesk", name: "UNIDESK", category: "service", tagline: "Personal desk & social hub", taglineJa: "個人の作業デスク＋ソーシャル機能（家族・カップル・友人モード）", url: "https://desk.uni-core.jp", status: "live" },
  { id: "unicarte", name: "UNICARTE", category: "service", tagline: "Coaching & client management", taglineJa: "コーチング・クライアント管理・カルテ記録", url: "https://carte.uni-core.jp", status: "coming-soon" },
  { id: "unihub", name: "UNIHUB", category: "service", tagline: "Team chat for tiny teams", taglineJa: "少人数チーム向けのチャット（Slack 代替・人数課金なし）", url: "https://hub.uni-core.jp", status: "live" },
  { id: "unistep", name: "UNISTEP", category: "service", tagline: "LINE-first marketing automation", taglineJa: "LINE 公式アカウントのステップ配信・自動応答・友だち管理", url: "https://step.uni-core.jp", status: "live" },
  { id: "unibase", name: "UNIBASE", category: "service", tagline: "All-in-one growth toolkit", taglineJa: "5カテゴリ16機能をひとまとめにした成長支援ハブ", url: "https://base.uni-core.jp", status: "coming-soon" },
  { id: "uniscan", name: "UNISCAN", category: "service", tagline: "Market & persona analytics", taglineJa: "市場・トレンド・競合・顧客心理の分析", url: "https://scan.uni-core.jp", status: "coming-soon" },
  { id: "uniwrite", name: "UNIWRITE", category: "service", tagline: "Long-form writing AI", taglineJa: "note 記事・YouTube 台本（長尺/ショート）を執筆する AI", url: "https://uniwrite.uni-core.jp", status: "coming-soon" },
  { id: "uniwire", name: "UNIWIRE", category: "service", tagline: "AI knowledge media", taglineJa: "AI 専門の自動更新メディア（記事＋X 投稿を毎日生成）", url: "https://uniwire.uni-core.jp", status: "coming-soon" },
  { id: "unipin", name: "UNIPIN", category: "service", tagline: "Visual bookmarking", taglineJa: "サムネイル付きの見やすいブックマーク", url: "https://pin.uni-core.jp", status: "coming-soon" },
  { id: "unidrop", name: "UNIDROP", category: "service", tagline: "MCP marketplace", taglineJa: "UNI 製品の MCP を一覧から導入できるマーケットプレイス", url: "https://drop.uni-core.jp", status: "coming-soon" },
  { id: "uniskill", name: "UNISKILL", category: "service", tagline: "Skill share marketplace", taglineJa: "Claude スキル・MCP を売買できるマーケットプレイス", url: "https://uniskill.uni-core.jp", status: "coming-soon" },
  { id: "unireach", name: "UNIREACH", category: "service", tagline: "Instagram / Threads DM automation", taglineJa: "Instagram・Threads の DM 対応と集客を自動化する SNS 運用ツール", url: "https://reach.uni-core.jp", status: "live" },
  { id: "unipost", name: "UNIPOST", category: "service", tagline: "X scheduling & engagement CRM", taglineJa: "X（旧Twitter）の予約投稿・リプ / DM 対応・キャンペーンをまとめる運用 CRM", url: "https://post.uni-core.jp", status: "live" },
  { id: "unisign", name: "UNISIGN", category: "service", tagline: "Lightweight e-signing", taglineJa: "個人事業主・小規模事業者向けの軽量な電子契約", url: "https://sign.uni-core.jp", status: "coming-soon" },
  { id: "unibook", name: "UNIBOOK", category: "service", tagline: "Course authoring", taglineJa: "コース教材の構成・執筆を支援", url: null, status: "coming-soon" },
  { id: "unidrive", name: "UNIDRIVE", category: "service", tagline: "Knowledge drive", taglineJa: "AI から参照できるナレッジドライブ", url: null, status: "coming-soon" },
  { id: "unicart", name: "UNICART", category: "service", tagline: "Lightweight checkout", taglineJa: "軽量な決済・カート（Stripe 直接連携）", url: null, status: "coming-soon" },
  { id: "uniwiki", name: "UNIWIKI", category: "service", tagline: "Internal AI knowledge wiki", taglineJa: "社内向けの AI 参照ナレッジ Wiki", url: null, status: "coming-soon" },
  // 無料公開アプリ（UNI シリーズと同じ ZUBOLAND 製。登録不要で使える）
  { id: "kuzira", name: "KUZIRA", category: "service", tagline: "Marketer's second browser (free)", taglineJa: "マーケター特化のセカンドブラウザ（無料・登録不要）", url: "https://zuboland.jp/products/kuzira", status: "live" },
  { id: "honjin", name: "HONJIN", category: "service", tagline: "Local business cockpit (free)", taglineJa: "事業の今と動きを手元で見る作業台（無料公開・GitHub 配布）", url: "https://github.com/zuboland/honjin", status: "live" },

  // MCP servers (one per UNI product, exposed via HTTP MCP)
  // live の MCP は url = APIキー発行ページ（ここでキーを作って接続する）。ツール数は 2026-08-27 実測。
  // 🚨 MCP エンドポイント・発行 URL の正本は lib/uni-mcp-endpoints.ts（一括接続が使う方）。
  //    どちらかだけ直すと UI 表示と接続導線がズレる。直すときは必ず両方を照合すること。
  { id: "unicore-mcp", name: "UNICORE MCP", category: "mcp", tagline: "Member-site automation from any AI (10 tools)", taglineJa: "AI から UNICORE の会員・受講状況・教材を操作する MCP（ツール10個）", url: "https://unilinks.uni-core.jp/admin/api-keys", status: "live" },
  { id: "unidesk-mcp", name: "UNIDESK MCP", category: "mcp", tagline: "Desk + social actions from any AI (44 tools)", taglineJa: "UNIDESK のメモ・タスク・予定を AI から操作する MCP（ツール44個）", url: "https://desk.uni-core.jp/api-keys", status: "live" },
  { id: "unihub-mcp", name: "UNIHUB MCP", category: "mcp", tagline: "Team chat actions from any AI (8 tools)", taglineJa: "UNIHUB のチャンネル投稿・検索・タスクを AI から操作する MCP（ツール8個）", url: "https://hub.uni-core.jp/app/settings/api-keys", status: "live" },
  { id: "unistep-mcp", name: "UNISTEP MCP", category: "mcp", tagline: "LINE step delivery from any AI (13 tools)", taglineJa: "UNISTEP の LINE 配信・シナリオを AI から制御する MCP（ツール13個）", url: "https://step.uni-core.jp/api-keys", status: "live" },
  { id: "unipost-mcp", name: "UNIPOST MCP", category: "mcp", tagline: "X scheduling from any AI (8 tools)", taglineJa: "UNIPOST の X 予約投稿・投稿管理を AI から行う MCP（ツール8個）", url: "https://post.uni-core.jp/api-keys", status: "live" },
  { id: "uniwire-mcp", name: "UNIWIRE MCP", category: "mcp", tagline: "Article publishing from any AI", taglineJa: "UNIWIRE への記事投稿を AI から行う MCP", url: null, status: "coming-soon" },
  { id: "unireach-mcp", name: "UNIREACH MCP", category: "mcp", tagline: "IG/Threads DM ops from any AI (19 tools)", taglineJa: "UNIREACH の DM 送信・シナリオ・Threads 予約を AI から行う MCP（ツール19個）", url: "https://reach.uni-core.jp/api-keys", status: "live" },
  { id: "unipin-mcp", name: "UNIPIN MCP", category: "mcp", tagline: "Bookmark search from any AI", taglineJa: "UNIPIN のブックマーク検索を AI から呼べる MCP", url: null, status: "coming-soon" },
  { id: "uniscan-mcp", name: "UNISCAN MCP", category: "mcp", tagline: "Persona research from any AI", taglineJa: "UNISCAN のペルソナ・市場調査を AI から実行する MCP", url: null, status: "coming-soon" },
  { id: "unicarte-mcp", name: "UNICARTE MCP", category: "mcp", tagline: "Coaching ops from any AI", taglineJa: "UNICARTE のコーチング業務操作を AI から行う MCP", url: null, status: "coming-soon" },
  { id: "unisign-mcp", name: "UNISIGN MCP", category: "mcp", tagline: "E-signing from any AI", taglineJa: "UNISIGN の電子契約処理を AI から呼べる MCP", url: null, status: "coming-soon" },

  // Claude Skills (curated UNI-specific)
  { id: "uni-lp-studio", name: "uni-lp-studio", category: "skill", tagline: "End-to-end UNI landing page pipeline", taglineJa: "UNI 製品の LP を多段パイプラインで一気に作るスキル", url: null, status: "coming-soon" },
  { id: "uni-appearance-rollout", name: "uni-appearance-rollout", category: "skill", tagline: "Theme/dark/radius rollout to UNI products", taglineJa: "テーマ色・ダークモード・角丸の設定を UNI 製品全部に横展開", url: null, status: "coming-soon" },
  { id: "lp-illustration-enhancer", name: "lp-illustration-enhancer", category: "skill", tagline: "Inject Gemini illustrations into UNI LPs", taglineJa: "既存 LP に Gemini で生成したイラストを注入して強化", url: null, status: "coming-soon" },
  { id: "uni-mcp-builder", name: "uni-mcp-builder", category: "skill", tagline: "Scaffold a new UNI HTTP MCP", taglineJa: "新しい UNI 製品用の HTTP MCP を雛形から立ち上げ", url: null, status: "coming-soon" },

  // Extensions (VS Code etc.)
  { id: "uni-cmd-launcher", name: "UNI Command Launcher", category: "extension", tagline: "VS Code: Ctrl+Alt+C → Japanese command palette", taglineJa: "VS Code 拡張：Ctrl+Alt+C で日本語ラベルからコマンドを呼ぶ", url: null, status: "coming-soon" },
  { id: "uni-claude-pack", name: "UNI Claude Pack", category: "extension", tagline: "VS Code recommended extensions for UNI dev", taglineJa: "UNI 開発用の VS Code 推奨拡張パック", url: null, status: "coming-soon" },
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
