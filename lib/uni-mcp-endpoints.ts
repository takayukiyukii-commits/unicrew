/**
 * UNI シリーズ製品の HTTP MCP エンドポイント定義（アイデア5: UNI製品MCP一括接続）。
 *
 * 13製品中12製品で標準JSON-RPC（MCP protocol 2024-11-05）の HTTP MCP が公開済。
 * UNICART のみ未公開。出典: company/.../memory/reference_mcp_endpoints.md
 *
 * 認証は基本 Bearer。各製品の API キーは「APIキープレフィックス」で識別する。
 * UNIWIKI のみ認証不要、UNIHUB は admin key 発行 UI が別途必要。
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
    id: "unicarte",
    name: "UNIカルテ",
    shortLabel: "carte",
    url: "https://carte.uni-core.jp/api/mcp",
    keyPrefix: "ucarte_*",
    description: "顧客カルテ管理・ステータス推移・コーチング履歴",
    apiKeyPath: "https://carte.uni-core.jp/api-keys",
  }),
  E({
    id: "unibook",
    name: "UNIBOOK",
    shortLabel: "unibook",
    url: "https://unibook.uni-core.jp/api/mcp",
    keyPrefix: "ubook_*",
    description: "教材・電子書籍ストア（読了率・購入履歴）",
    apiKeyPath: "https://unibook.uni-core.jp/api-keys",
  }),
  E({
    id: "unicore",
    name: "UNICORE（会員サイト）",
    shortLabel: "unilinks",
    url: "https://unilinks.uni-core.jp/api/mcp",
    keyPrefix: "ucore_*",
    description: "会員サイト本体。カリキュラム・進捗・グループ機能",
    apiKeyPath: "https://unilinks.uni-core.jp/api-keys",
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
    id: "unisign",
    name: "UNISIGN",
    shortLabel: "sign",
    url: "https://sign.uni-core.jp/api/mcp",
    keyPrefix: "usign_*",
    description: "電子署名・契約書管理",
    apiKeyPath: "https://sign.uni-core.jp/api-keys",
  }),
  E({
    id: "unidrive",
    name: "UNIDRIVE",
    shortLabel: "drive",
    url: "https://drive.uni-core.jp/api/mcp",
    keyPrefix: "udrive_*",
    description: "ファイル保管・共有",
    apiKeyPath: "https://drive.uni-core.jp/api-keys",
  }),
  E({
    id: "uniwiki",
    name: "UNIWIKI",
    shortLabel: "wiki",
    url: "https://wiki.uni-core.jp/api/mcp",
    keyPrefix: "（認証不要）",
    noAuth: true,
    description: "公開ナレッジベース。認証不要で読み取り可",
    apiKeyPath: "https://wiki.uni-core.jp/",
  }),
  E({
    id: "unilinks-asp",
    name: "UNILINKS-ASP",
    shortLabel: "asp",
    url: "https://asp.uni-core.jp/api/mcp",
    keyPrefix: "uasp_*",
    description: "アフィリエイト管理（リンク・成果計測）",
    apiKeyPath: "https://asp.uni-core.jp/api-keys",
  }),
  E({
    id: "uniq",
    name: "UNIQ",
    shortLabel: "uniq",
    url: "https://uniq.uni-core.jp/api/mcp",
    keyPrefix: "uniq_*",
    description: "セールス管理（商談・見込み客・契約）",
    apiKeyPath: "https://uniq.uni-core.jp/api-keys",
  }),
  E({
    id: "unipost",
    name: "UNIPOST",
    shortLabel: "unipost",
    url: "https://x-bot.takayuki-yukii.workers.dev/mcp",
    keyPrefix: "upost_*",
    description: "X（旧Twitter）自動投稿・スレッド組立",
    apiKeyPath: "https://desk.uni-core.jp/unipost",
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
    id: "uniskill",
    name: "UNISKILL",
    shortLabel: "uniskill",
    url: "https://uniskill.uni-core.jp/api/mcp",
    keyPrefix: "usk_*",
    description: "Claude Code Skill 診断・パッケージ・配布",
    apiKeyPath: "https://uniskill.uni-core.jp/api-keys",
  }),
  E({
    id: "unihub",
    name: "UNIHUB（横断統合）",
    shortLabel: "hub",
    url: "https://hub.uni-core.jp/api/mcp",
    keyPrefix: "uhk_*",
    description:
      "全UNI製品を横断する統合ハブ。61ツールで横串アクセス可能（admin key 必須）",
    apiKeyPath: "https://hub.uni-core.jp/admin/api-keys",
  }),
];

/** mcp サーバー名は unicrew_<id> 固定で衝突を避ける */
export function mcpServerName(endpointId: string): string {
  return `unicrew_${endpointId}`;
}
