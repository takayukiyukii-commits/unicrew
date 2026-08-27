/**
 * UNI シリーズ製品の HTTP MCP エンドポイント定義（アイデア5: UNI製品MCP一括接続）。
 *
 * 🚨 一覧は「今販売しているプロダクト」だけに絞る（2026-08-28）。
 * 出典: company/CDO（技術責任者）/成果物/kuzira/ui/uni-products.js（KUZIRAストアの正本）
 *   ＝ zuboland.jp に「公開中」で掲載されている6製品と一致させる。
 * coming-soon・社内専用・未公開ドメインの製品はここに載せない
 * （押しても使えないボタンを並べない）。
 *
 * 認証は基本 Bearer。各製品の API キーは「APIキープレフィックス」で識別する。
 */
export interface UniMcpEndpoint {
  /** Claude Code の `~/.claude.json` に登録するときの mcp サーバー名（unicrew_<id> プレフィックス推奨） */
  id: string;
  /** UI 表示用の正式名 */
  name: string;
  /** ドメイン（drop.uni-core.jp/mcp の slug 等の参照に使う） */
  shortLabel: string;
  url: string;
  /** API キーのプレフィックス（例: "ureach_*"）。UI のヒントに表示。 */
  keyPrefix: string;
  /** 認証不要なら true。Bearer トークン入力欄を非表示にする。 */
  noAuth?: boolean;
  /** 簡単な機能説明（UIホバー用） */
  description: string;
  /** API キー発行UIへのパス（フルURL組み立て用） */
  apiKeyPath: string;
}

const E = (e: UniMcpEndpoint) => e;

export const UNI_MCP_ENDPOINTS: UniMcpEndpoint[] = [
  E({
    id: "unireach",
    name: "UNIREACH",
    shortLabel: "reach",
    url: "https://reach.uni-core.jp/api/mcp",
    keyPrefix: "ureach_*",
    description:
      "X / Instagram / Threads 連携。投稿スケジュール・アナリティクス取得",
    apiKeyPath: "https://reach.uni-core.jp/api-keys",
  }),
  E({
    id: "unicore",
    name: "UNICORE（会員サイト）",
    shortLabel: "unilinks",
    url: "https://unilinks.uni-core.jp/api/mcp",
    keyPrefix: "ucore_*",
    description: "会員サイト本体。カリキュラム・進捗・グループ機能",
    // APIキー発行は管理画面側（KUZIRAストア 2026-08-27 実測）
    apiKeyPath: "https://unilinks.uni-core.jp/admin/api-keys",
  }),
  E({
    id: "unidesk",
    name: "UNIDESK",
    shortLabel: "desk",
    url: "https://desk.uni-core.jp/api/mcp",
    keyPrefix: "udesk_*",
    description: "コラボ・タスク・SNS型統合ワークスペース",
    apiKeyPath: "https://desk.uni-core.jp/api-keys",
  }),
  E({
    id: "unipost",
    name: "UNIPOST",
    shortLabel: "unipost",
    url: "https://x-bot.takayuki-yukii.workers.dev/mcp",
    keyPrefix: "upost_*",
    description: "X（旧Twitter）自動投稿・スレッド組立",
    // 2026-08-28 実測: 旧 desk.uni-core.jp/unipost は転送だけ残った旧導線。現行は post 側
    apiKeyPath: "https://post.uni-core.jp/api-keys",
  }),
  E({
    id: "unistep",
    name: "UNISTEP",
    shortLabel: "unistep",
    url: "https://unistep.takayuki-yukii.workers.dev/mcp",
    keyPrefix: "ustep_*",
    description: "LINE ステップ配信",
    apiKeyPath: "https://step.uni-core.jp/api-keys",
  }),
  E({
    id: "unihub",
    name: "UNIHUB（横断統合）",
    shortLabel: "hub",
    url: "https://hub.uni-core.jp/api/mcp",
    keyPrefix: "uhk_*",
    description:
      "全UNI製品を横断する統合ハブ。61ツールで横串アクセス可能（admin key 必須）",
    // 2026-08-28 実測: /admin/api-keys は 404。発行UIは app 側にある
    apiKeyPath: "https://hub.uni-core.jp/app/settings/api-keys",
  }),
];

/** mcp サーバー名は unicrew_<id> 固定で衝突を避ける */
export function mcpServerName(endpointId: string): string {
  return `unicrew_${endpointId}`;
}
