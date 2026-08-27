/**
 * Marketplace プラグイン / スキルの **日本語ローカライズ説明** テーブル。
 *
 * - キーは `<name>@<marketplace>` 形式（installed_plugins.json と揃える）
 * - 値は { ja, en } の2言語
 * - 未掲載のプラグインは plugin.json の description（多くは英語）にフォールバック
 *
 * 海外向け（locale = "en"）は plugin.json の英語説明をそのまま見せ、
 * 日本向け（locale = "ja"）は本テーブル優先で表示する。
 */

export type Locale = "ja" | "en";

export interface BilingualDescription {
  ja: string;
  en: string;
  /** その機能を入れると何ができるようになるか（日本語のみ。CTA 用の便益コピー） */
  benefitJa?: string;
}

export const PLUGIN_DESCRIPTIONS: Record<string, BilingualDescription> = {
  // === Anthropic 公式（claude-code-plugins）===
  "feature-dev@claude-code-plugins": {
    ja: "コードベースを把握しながら新機能の設計と実装を支援するエージェント群",
    en: "Comprehensive feature development workflow with specialized agents for codebase exploration, architecture design, and quality review",
    benefitJa: "「○○機能を追加して」だけで、設計→実装→レビューまで自動で進む",
  },
  "code-review@claude-code-plugins": {
    ja: "プルリクや差分を品質・セキュリティ観点でレビュー",
    en: "Review pull requests and diffs for quality, security, and conventions",
    benefitJa: "「このPRレビューして」でバグ・脆弱性・改善点を日本語で指摘",
  },
  "frontend-design@claude-code-plugins": {
    ja: "汎用AIっぽくない、個性のあるフロントエンドUIをコードで生成",
    en: "Generate distinctive, production-grade frontend interfaces with high design quality",
    benefitJa: "「ランディングページ作って」で量産AI感のないデザインが出る",
  },
  "commit-commands@claude-code-plugins": {
    ja: "良いコミットメッセージとPR文を自動作成",
    en: "Helpers for crafting good commit messages and PR descriptions",
    benefitJa: "「コミットして」だけで日本語の的確なメッセージが入る",
  },
  "security-guidance@claude-code-plugins": {
    ja: "セキュリティ観点のガイダンス・脆弱性スキャン補助",
    en: "Security guidance and vulnerability scanning helpers",
    benefitJa: "「セキュリティチェックして」で危険な箇所を一覧化",
  },
  "pr-review-toolkit@claude-code-plugins": {
    ja: "プルリクレビューに使う一連のツール群",
    en: "Toolkit for thorough pull request reviews",
    benefitJa: "PR1本に対して複数の角度（ロジック・型・命名・テスト）から自動レビュー",
  },
  "agent-sdk-dev@claude-code-plugins": {
    ja: "Claude Agent SDK を使ったエージェント開発を支援",
    en: "Helpers for building agents with the Claude Agent SDK",
    benefitJa: "自前のエージェントを作る時に SDK の落とし穴を回避してくれる",
  },
  "explanatory-output-style@claude-code-plugins": {
    ja: "応答スタイルを「説明的」に切替（教育向け）",
    en: "Output style: explanatory mode (good for teaching contexts)",
    benefitJa: "答えだけでなく「なぜそうなるのか」を毎回説明してくれる",
  },
  "learning-output-style@claude-code-plugins": {
    ja: "応答スタイルを「学習向け」に切替",
    en: "Output style: learning-friendly mode",
    benefitJa: "初学者向けに段階的・反復確認スタイルで応答する",
  },
  "claude-opus-4-5-migration@claude-code-plugins": {
    ja: "Claude Opus 4.5 への移行時に使うマイグレーションヘルパー",
    en: "Migration helpers for Claude Opus 4.5",
    benefitJa: "古いモデル前提のコードを Opus 4.5 流に書き直す手伝い",
  },
  "hookify@claude-code-plugins": {
    ja: "Claude Code の hooks 機能を簡単に組むためのテンプレ",
    en: "Templates and helpers for setting up Claude Code hooks",
    benefitJa: "「保存時にフォーマット」「コミット前にテスト」を hooks で自動化",
  },
  "plugin-dev@claude-code-plugins": {
    ja: "Claude プラグイン自作時の雛形・ヘルパー",
    en: "Helpers for building your own Claude plugins",
    benefitJa: "自分用プラグインを作る時に骨格を一発で生成してくれる",
  },
  "ralph-wiggum@claude-code-plugins": {
    ja: "Ralph Wiggum 風のお茶目な応答スタイル（実験的）",
    en: "Ralph Wiggum-style playful output (experimental)",
    benefitJa: "息抜き用の遊び心キャラ。本番では使わない方が無難",
  },

  // === OpenAI 公式（openai-codex）===
  "codex@openai-codex": {
    ja: "Claude から OpenAI Codex を呼び出して結果を比較",
    en: "Bridge to invoke OpenAI Codex from Claude Code and compare outputs",
    benefitJa: "Claude と Codex の両方の意見が同じスレッドで聞ける",
  },

  // === awesome-claude-plugins（コミュニティ）===
  "artifacts-builder@awesome-claude-plugins": {
    ja: "claude.ai 向けの複雑な HTML アーティファクトを構築",
    en: "Build elaborate, multi-component claude.ai HTML artifacts",
  },
  "audit-project@awesome-claude-plugins": {
    ja: "プロジェクト全体を監査（コード品質・依存関係・セキュリティ）",
    en: "Comprehensive project audit (code quality, dependencies, security)",
  },
  "backend-architect@awesome-claude-plugins": {
    ja: "バックエンドアーキテクチャの設計を支援",
    en: "Backend architecture design assistant",
  },
  "bug-fix@awesome-claude-plugins": {
    ja: "バグ修正フロー（再現→原因特定→修正→検証）を体系化",
    en: "Structured bug-fixing workflow (repro → diagnose → fix → verify)",
  },
  "canvas-design@awesome-claude-plugins": {
    ja: "PNG/PDF のビジュアルアートを設計哲学に沿って作成",
    en: "Create visual art (PNG/PDF) following design philosophy",
  },
  "changelog-generator@awesome-claude-plugins": {
    ja: "Git コミットからユーザー向け changelog を自動生成",
    en: "Auto-generate user-facing changelogs from git commits",
  },
  "code-review@awesome-claude-plugins": {
    ja: "コミュニティ版コードレビューツール",
    en: "Community-flavor code review tool",
  },
  "commit@awesome-claude-plugins": {
    ja: "コミット作成の補助",
    en: "Commit helper",
  },
  "connect-apps@awesome-claude-plugins": {
    ja: "Gmail / Slack / Notion など 1000 以上のアプリへの接続",
    en: "Connect Claude to Gmail, Slack, GitHub, Notion, and 1000+ apps",
  },
  "create-pr@awesome-claude-plugins": {
    ja: "Pull Request の作成補助",
    en: "Pull request creation helper",
  },
  "debugger@awesome-claude-plugins": {
    ja: "デバッグセッションを構造化して進めるエージェント",
    en: "Structured debugging session agent",
  },
  "developer-growth-analysis@awesome-claude-plugins": {
    ja: "Claude Code の利用履歴から学習ギャップを分析",
    en: "Analyze your Claude Code chat history for skill gaps and growth opportunities",
  },
  "documentation-generator@awesome-claude-plugins": {
    ja: "コードからドキュメントを生成",
    en: "Generate documentation from code",
  },
  "frontend-design@awesome-claude-plugins": {
    ja: "frontend-design のコミュニティ版",
    en: "Community version of frontend-design",
  },
  "frontend-developer@awesome-claude-plugins": {
    ja: "フロントエンド開発全般のエージェント",
    en: "General-purpose frontend developer agent",
  },
  "mcp-builder@awesome-claude-plugins": {
    ja: "MCP サーバーの新規作成を支援（Python FastMCP / Node SDK）",
    en: "Build high-quality MCP servers (Python FastMCP / Node TypeScript)",
  },
  "perf@awesome-claude-plugins": {
    ja: "パフォーマンス最適化ガイド",
    en: "Performance optimization guide",
  },

  // === ibrahim-plugins ===
  "nano-banana@ibrahim-plugins": {
    ja: "Google Gemini 経由で画像生成（写真・イラスト・アイコンなど）",
    en: "Google Gemini image generation (photos, illustrations, icons, banners)",
    benefitJa: "「○○の画像作って」で Gemini 経由のフリー画像生成が動く",
  },
  // === awesome-claude-plugins / ibrahim-plugins（コミュニティ・2026-08-27 追加）===
  "senior-frontend@awesome-claude-plugins": {
    ja: "React / Next.js / TypeScript の実践パターンでフロントを実装し、バンドル分析と最適化まで行う",
    en: "React/Next.js/TypeScript patterns with bundle analysis and optimization",
    benefitJa: "「この画面を実装して」で、無駄なバンドルまで削った実務水準のReact/Nextコードが出る",
  },
  "test-writer-fixer@awesome-claude-plugins": {
    ja: "ユニットテストの作成と、落ちているテストの修正を自動で行う",
    en: "Automatically write and fix unit tests",
    benefitJa: "「テスト書いて」「テスト直して」で、抜けているテストの追加と赤いテストの修復が進む",
  },
  "ship@awesome-claude-plugins": {
    ja: "コミットから本番反映まで、PR の一連の流れをまとめて進める",
    en: "Complete PR workflow from commit to production",
    benefitJa: "「これリリースまで持っていって」でコミット→PR→マージの導線が一気に流れる",
  },
  "pr-review@awesome-claude-plugins": {
    ja: "プルリクを詳細なフィードバック付きで多角的にレビューする",
    en: "Comprehensive PR reviews with detailed feedback",
    benefitJa: "「このPR見て」で観点別の指摘とコメント案がまとまって返る",
  },
  "theme-factory@awesome-claude-plugins": {
    ja: "スライド・ドキュメント・レポート・LP 向けのプロ品質テーマを10種そろえる",
    en: "10 professional themes for slides, docs, reports, and landing pages",
    benefitJa: "「資料の見た目を整えて」で、量産感のない配色・タイポのテーマが選べる",
  },
  "agent-sdk-dev@awesome-claude-plugins": {
    ja: "Claude Agent SDK を使った開発を支援するキット（公式版の別マーケットプレイス配布）",
    en: "Claude Agent SDK development helper",
    benefitJa: "「Agent SDK で○○を作って」で、SDK前提のコードと設定がそろう",
  },
  "security-guidance@awesome-claude-plugins": {
    ja: "セキュリティのベストプラクティスと脆弱性検出（公式版の別マーケットプレイス配布）",
    en: "Security best practices and vulnerability detection",
    benefitJa: "「セキュリティチェックして」で危険な箇所を一覧化",
  },
  "conductor-orchestrator-supaconductor@ibrahim-plugins": {
    ja: "複数エージェントの並列実行と評価ループで、大きめのタスクを分割・統括する司令塔",
    en: "Conductor v3 — multi-agent orchestration with evaluate-loop, parallel execution, and a board of reviewers",
    benefitJa: "「この案件を分担して進めて」で、複数AIが並列で動き結果を突き合わせてくれる",
  },
};

/**
 * id（"<name>@<marketplace>"）を渡すと、ロケールに合わせた説明文と benefit を返す。
 * テーブルにない場合は fallback（plugin.json の description）を使う。
 */
export function describePlugin(
  id: string,
  fallback: string | null,
  locale: Locale = "ja",
): { description: string; benefit?: string } {
  const entry = PLUGIN_DESCRIPTIONS[id];
  if (entry) {
    return {
      description: locale === "ja" ? entry.ja : entry.en,
      benefit: locale === "ja" ? entry.benefitJa : undefined,
    };
  }
  return { description: fallback ?? "" };
}
