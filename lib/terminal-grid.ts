/**
 * ターミナルのペイン分割（グリッド）の寸法計算。
 *
 * 【設計の勘所】
 * 分割線は「グリッドの子」としてではなく、グリッドの**上に重ねる**。
 * 子として挿すと列の数が変わり、既存の「段組みが変わってもペインを
 * 再マウントしない（＝PTY とスクロールバックを保つ）」性質が壊れるため。
 * よってここでは「境界が左から何％の位置にあるか」だけを計算する。
 *
 * 比率は fr（比の配列）で持つ。合計は 1 でなくてよい（比率だから）。
 */

/** 1 枚あたりの最小の割合（%）。これ以下には縮めない。 */
export const MIN_PANE_PCT = 12;

/** 比率配列 → CSS の grid-template（"1.2fr 0.8fr"）。 */
export function templateFromFractions(fr: number[]): string {
  if (fr.length === 0) return "";
  return fr.map((f) => `${Math.max(0.0001, f)}fr`).join(" ");
}

/** 比率配列 → 各要素の割合（%）。合計 100。 */
export function fractionsToPercents(fr: number[]): number[] {
  const total = fr.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return fr.map(() => 100 / Math.max(1, fr.length));
  return fr.map((f) => (Math.max(0, f) / total) * 100);
}

/**
 * 内部の境界（分割線）の位置（%）。要素が n 個なら n-1 本。
 * 例: [1,1,1] → [33.33, 66.67]
 */
export function boundaryPercents(fr: number[]): number[] {
  const pcts = fractionsToPercents(fr);
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < pcts.length - 1; i++) {
    acc += pcts[i];
    out.push(acc);
  }
  return out;
}

/**
 * 境界 index（0 始まり）を targetPct（コンテナ左端からの%）へ動かした比率配列を返す。
 * 動かすのは隣り合う 2 つだけ（他の列の幅は変えない＝VS Code と同じ挙動）。
 * 最小幅より小さくなる操作は、最小幅で止める。
 */
export function resizeAtBoundary(
  fr: number[],
  index: number,
  targetPct: number,
  minPct: number = MIN_PANE_PCT,
): number[] {
  if (index < 0 || index >= fr.length - 1) return fr;
  const pcts = fractionsToPercents(fr);
  // 境界より左側の合計（動かさない部分）
  let left = 0;
  for (let i = 0; i < index; i++) left += pcts[i];
  const pairTotal = pcts[index] + pcts[index + 1];
  // 2 枚ぶんの領域の中で、左の枚の割合を決める
  let a = targetPct - left;
  a = Math.max(minPct, Math.min(pairTotal - minPct, a));
  if (!Number.isFinite(a) || pairTotal <= 0) return fr;
  const b = pairTotal - a;
  const next = [...pcts];
  next[index] = a;
  next[index + 1] = b;
  // % をそのまま比率として返す（合計 100 の比率配列）
  return next;
}

/**
 * ペイン数が変わったときに比率配列を作り直す。
 * 長さが合っていればそのまま、違えば均等（全部 1）に戻す。
 * 🚨 「前の比率を無理に引き延ばす」ことはしない。分割数が変わったのに
 * 古い比率を残すと、たまたま極端に細いペインが生まれて操作不能になる。
 */
export function fitFractions(fr: number[] | undefined, count: number): number[] {
  if (count <= 0) return [];
  if (fr && fr.length === count && fr.every((f) => Number.isFinite(f) && f > 0)) {
    return fr;
  }
  return Array.from({ length: count }, () => 1);
}
