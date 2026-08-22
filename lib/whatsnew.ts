/**
 * What's New ページの表示判定。
 *
 * - `package.json` の version を `process.env.NEXT_PUBLIC_UNICREW_VERSION` 経由で受ける
 *   （無ければ APP_VERSION 定数で fallback。next.config.ts は触らない方針）
 * - `unicrew.lastSeenVersion` localStorage と比較
 * - 既知の公開バージョン未満からの初回起動（バージョン記録なし）では出さない
 *   （古い localStorage を壊さないため）
 */

import { compare as compareVersions } from "./semver-mini";

/**
 * 表示中バージョン。リリース時に更新する単一ソース。
 * `public/whatsnew/{version}.md` と一致させる。
 */
export const UNICREW_VERSION = "0.2.50";

const STORAGE_KEY = "unicrew.lastSeenVersion";

/**
 * What's New を出すべきか判定。
 *
 * @returns true なら出す。false ならスキップ。
 */
export function shouldShowWhatsNew(): boolean {
  if (typeof window === "undefined") return false;
  const seen = localStorage.getItem(STORAGE_KEY);
  if (!seen) {
    // 初回起動: 記録だけ残して What's New は出さない
    localStorage.setItem(STORAGE_KEY, UNICREW_VERSION);
    return false;
  }
  return compareVersions(seen, UNICREW_VERSION) < 0;
}

/** 表示完了。次回以降は出さない。 */
export function markWhatsNewSeen(version: string = UNICREW_VERSION): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, version);
}

/** Palette / Help から強制再表示する用 */
export function resetWhatsNew(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * What's New の Markdown を取得。
 * 静的アセット `public/whatsnew/{version}.md` を fetch する。
 *
 * 配布版（output: export）でも同じパスで配信される。
 */
export async function fetchWhatsNew(version: string = UNICREW_VERSION): Promise<string | null> {
  try {
    const res = await fetch(`/whatsnew/${version}.md`, { cache: "no-cache" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
