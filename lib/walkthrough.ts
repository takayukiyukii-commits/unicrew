/**
 * Welcome Walkthrough の進捗フラグ管理。
 *
 * 完了したら `unicrew.walkthroughDone = "1"` を localStorage に書く。
 * バージョンを変えれば再度表示できる（"v1" を増やしていく）。
 */

const KEY = "unicrew.walkthroughDone";
const CURRENT_WALKTHROUGH_VERSION = "v1";

export function isWalkthroughDone(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(KEY) === CURRENT_WALKTHROUGH_VERSION;
}

export function markWalkthroughDone(): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, CURRENT_WALKTHROUGH_VERSION);
}

export function resetWalkthrough(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
}
