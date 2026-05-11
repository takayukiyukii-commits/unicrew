/**
 * 軽量 fzf 風サブシーケンス・スコアラ。
 *
 * - クエリの全文字が、対象文字列にこの順に出現する必要がある（部分マッチ）
 * - 連続マッチ・先頭マッチ・単語境界マッチを高評価
 * - 大文字小文字を無視
 * - 依存ゼロ
 */

export interface FuzzyMatch {
  score: number;
  /** マッチした文字位置の集合（ハイライト用） */
  positions: number[];
}

/**
 * クエリを対象文字列に対してマッチさせる。
 * マッチ不能なら null。
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qi = 0;
  let score = 0;
  let prevMatchIndex = -1;
  const positions: number[] = [];

  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    let bonus = 1;
    if (i === 0) bonus += 5; // 先頭マッチ
    if (prevMatchIndex !== -1 && i === prevMatchIndex + 1) bonus += 4; // 連続
    const prevChar = i > 0 ? t[i - 1] : "";
    if (prevChar === " " || prevChar === "/" || prevChar === "_" || prevChar === "-") {
      bonus += 3; // 単語境界
    }
    score += bonus;
    positions.push(i);
    prevMatchIndex = i;
    qi++;
  }
  if (qi < q.length) return null;
  // 短いほうが嬉しい（1文字あたりのスコア）
  score += Math.max(0, 50 - target.length);
  return { score, positions };
}

/**
 * クエリで items をフィルタしつつ並び替える。
 * 同点の場合は元の順序を保つ（stable sort）。
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): Array<{ item: T; match: FuzzyMatch }> {
  const out: Array<{ item: T; match: FuzzyMatch; idx: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const m = fuzzyMatch(query, getText(items[i]));
    if (m) out.push({ item: items[i], match: m, idx: i });
  }
  out.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    return a.idx - b.idx;
  });
  return out.map(({ item, match }) => ({ item, match }));
}
