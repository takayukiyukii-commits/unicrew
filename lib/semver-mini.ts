/**
 * 必要最低限の semver 比較。`major.minor.patch` のみ対応。
 * pre-release / build metadata は素朴に文字列比較に fallback。
 */

export function compare(a: string, b: string): number {
  const pa = parsePart(a);
  const pb = parsePart(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parsePart(v: string): [number, number, number] {
  const m = v.split(".").slice(0, 3).map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0];
}
