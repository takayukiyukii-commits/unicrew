/**
 * marketplace_id / 著者名 → GitHub ユーザー名のマッピング。
 * `https://github.com/<user>.png` でアバターが取れる前提。
 *
 * - キーは namespace（marketplace_id）または author 名
 * - 値は GitHub の username（小文字でもケースは GitHub に合わせる）
 *
 * Tauri 側 `fetch_github_avatar` がキャッシュ + 取得を担当。
 */

export const MARKETPLACE_OWNER_GITHUB: Record<string, string> = {
  // Marketplace ごとのオーナー
  "claude-code-plugins": "anthropics",
  "openai-codex": "openai",
  "openai-bundled": "openai",
  "awesome-claude-plugins": "ComposioHQ",
  "ibrahim-plugins": "Ibrahim-3d",
};

/**
 * 著者名から GitHub username を推定するゆるいルールベースマッパー。
 * 完全一致が無くても、Anthropic / OpenAI / Composio などはキャッチする。
 */
export function authorToGithubUser(author: string | null | undefined): string | null {
  if (!author) return null;
  const lower = author.toLowerCase();
  if (lower.includes("anthropic")) return "anthropics";
  if (lower.includes("openai") || lower === "openai") return "openai";
  if (lower.includes("composio")) return "ComposioHQ";
  if (lower === "ibrahim" || lower.includes("ibrahim-3d")) return "Ibrahim-3d";
  if (lower === "community") return null; // 個別 user 未特定
  // それ以外は名前そのまま（既に github username になっている可能性）
  const cleaned = author.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 1 ? cleaned : null;
}

/**
 * AddonItem から「最も適切な」GitHub username を返す。
 * 1. namespace（marketplace owner）優先
 * 2. author 名から推定
 */
export function resolveGithubUserForItem(item: {
  namespace: string | null;
  author: string | null;
}): string | null {
  if (item.namespace && MARKETPLACE_OWNER_GITHUB[item.namespace]) {
    return MARKETPLACE_OWNER_GITHUB[item.namespace];
  }
  return authorToGithubUser(item.author);
}
