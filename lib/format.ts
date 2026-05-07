/**
 * トークン数・経過時間の表示用フォーマッタ。
 * UI 全体で同じ見た目にするために 1 ファイルに集約。
 */

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** ストリーミング中の経過時間。秒/分秒で出す（時間まで行ったら h を付与）。 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) {
    // 1秒未満は "0.4s" 形式、それ以降は "47s"
    if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${totalSec}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const mm = min % 60;
  return `${hr}h ${mm.toString().padStart(2, "0")}m`;
}

/** "thought for 6s" 用の短い思考時間表現。 */
export function formatThinking(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return `${min}m ${rem.toString().padStart(2, "0")}s`;
}
