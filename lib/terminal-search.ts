/**
 * ターミナル内検索（Ctrl+F）の純ロジック。
 *
 * 【なぜ自前か】
 * xterm 公式の SearchAddon を足すと依存とビルドが増える。ここで必要なのは
 * 「バッファから一致位置を出す」だけで、そこは純関数にできる＝単体テストで
 * 回帰を止められる。DOM も xterm も import しない（テストがブラウザ非依存）。
 *
 * 【2段階で探す理由】
 * スクロールバックは 50,000 行ある。全行に対して折り返し連結＋セル対応表
 * （readLogicalLine）を作ると 1 回の検索で数百万回の getCell が走って重い。
 * そこで
 *   1段目: 行テキスト（translateToString 相当の文字列）だけで候補行を絞る（安い）
 *   2段目: 候補行だけ readLogicalLine でセル座標に直す（正確）
 * とする。1段目は「折り返しをまたいだ一致」を取りこぼすので、
 * 行末と次行頭の継ぎ目も見る（scanCandidateRows の boundary 判定）。
 *
 * 【座標の約束】
 * - row は xterm のバッファ絶対行（0-based）
 * - col はセル桁（0-based）。全角は 2 セルを占める
 * - length はセル数。行をまたぐ場合は「次の行の先頭へ続く」ものとして数える
 *   （xterm の Terminal.select(column, row, length) がこの数え方）
 */

import {
  readLogicalLine,
  type LineLike,
  type LogicalLineInfo,
} from "./terminal-links";

/** 検索ヒット 1 件（xterm の select にそのまま渡せる形）。 */
export interface SearchHit {
  /** バッファ絶対行（0-based） */
  row: number;
  /** セル桁（0-based） */
  col: number;
  /** セル数（行をまたぐ場合は跨いだぶんを含む） */
  length: number;
}

/** 走査の上限。これを超えるヒットは数えない（暴走防止）。 */
export const MAX_HITS = 2000;

function fold(s: string, caseSensitive: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

/**
 * 1 つの文字列の中の一致開始インデックスを全部返す（重なりは許さない）。
 * 空クエリは 0 件（「全部が一致」にしない）。
 */
export function findAllIndexes(
  text: string,
  query: string,
  caseSensitive = false,
): number[] {
  if (!text || !query) return [];
  const hay = fold(text, caseSensitive);
  const needle = fold(query, caseSensitive);
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + needle.length;
    if (out.length >= MAX_HITS) break;
  }
  return out;
}

/**
 * 1段目：行テキストだけを見て「この行を詳しく調べる価値がある」行を返す。
 *
 * - 行内に一致があればその行
 * - 折り返しの継ぎ目（行末＋次行頭）に一致が生まれる場合はその行
 *   （query の長さ-1 文字ぶんの窓を継ぎ目に当てる）
 */
export function scanCandidateRows(
  getLineText: (row: number) => string | undefined,
  rowCount: number,
  query: string,
  caseSensitive = false,
): number[] {
  if (!query || rowCount <= 0) return [];
  const q = fold(query, caseSensitive);
  const rows: number[] = [];
  let prev = "";
  for (let r = 0; r < rowCount; r++) {
    const raw = getLineText(r);
    if (raw === undefined) {
      prev = "";
      continue;
    }
    const cur = fold(raw, caseSensitive);
    if (cur.includes(q)) {
      rows.push(r);
    } else if (q.length > 1 && prev) {
      // 継ぎ目チェック：前行の末尾 (q.length-1) ＋ 今の行の先頭 (q.length-1)
      const tail = prev.slice(Math.max(0, prev.length - (q.length - 1)));
      const head = cur.slice(0, q.length - 1);
      if ((tail + head).includes(q)) {
        // 一致は前行から始まる。前行を候補に入れる（重複は入れない）
        if (rows[rows.length - 1] !== r - 1) rows.push(r - 1);
      }
    }
    prev = cur;
  }
  return rows;
}

/**
 * 論理行テキスト上の一致を、セル座標のヒットへ変換する。
 * 行をまたぐ一致は length に「跨いだセル数」を含める（cols 基準）。
 */
export function hitsInLogicalLine(
  info: LogicalLineInfo,
  query: string,
  cols: number,
  caseSensitive = false,
): SearchHit[] {
  const out: SearchHit[] = [];
  if (cols <= 0) return out;
  for (const start of findAllIndexes(info.text, query, caseSensitive)) {
    const end = start + query.length; // exclusive
    const s = info.map[start];
    const e = info.map[end - 1];
    if (!s || !e) continue;
    // 終端セルは全角なら 2 セル目まで含める
    const length = (e.row - s.row) * cols + (e.x + e.width) - s.x;
    if (length <= 0) continue;
    out.push({ row: s.row, col: s.x, length });
  }
  return out;
}

/** ヒットを行→桁の順に並べ、同一位置の重複を落とす。 */
export function dedupeSorted(hits: SearchHit[]): SearchHit[] {
  const sorted = [...hits].sort((a, b) =>
    a.row === b.row ? a.col - b.col : a.row - b.row,
  );
  const out: SearchHit[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && last.row === h.row && last.col === h.col) continue;
    out.push(h);
  }
  return out;
}

export interface SearchBufferParams {
  /** バッファ総行数（buffer.active.length） */
  rowCount: number;
  /** 端末の桁数（buffer 行の折り返し幅） */
  cols: number;
  /** 行テキスト（translateToString(true) 相当）。無ければ undefined */
  getLineText: (row: number) => string | undefined;
  /** セル対応表を作るための行オブジェクト（readLogicalLine 用） */
  getLine: (row: number) => LineLike | undefined;
  query: string;
  caseSensitive?: boolean;
}

/**
 * バッファ全体のヒットを行順で返す。
 * 候補行だけ readLogicalLine を通すので、全行走査でも実測で軽い。
 */
export function searchBuffer(p: SearchBufferParams): SearchHit[] {
  const { rowCount, cols, getLineText, getLine, query } = p;
  const caseSensitive = p.caseSensitive ?? false;
  if (!query) return [];
  const candidates = scanCandidateRows(
    getLineText,
    rowCount,
    query,
    caseSensitive,
  );
  const hits: SearchHit[] = [];
  const seenLogicalStart = new Set<number>();
  for (const row of candidates) {
    const info = readLogicalLine(getLine, row);
    if (!info) continue;
    // 同じ論理行を 2 回展開しない（折り返し行が複数候補に入るため）
    if (seenLogicalStart.has(info.startRow)) continue;
    seenLogicalStart.add(info.startRow);
    for (const h of hitsInLogicalLine(info, query, cols, caseSensitive)) {
      hits.push(h);
      if (hits.length >= MAX_HITS) return dedupeSorted(hits);
    }
  }
  return dedupeSorted(hits);
}

/**
 * 現在位置から見て次（direction=1）／前（direction=-1）のヒットの添字を返す。
 * 端まで来たら反対の端へ回り込む。ヒットが無ければ -1。
 *
 * from が null（まだ一度も選んでいない）のときは、
 * - 前方検索: viewport の先頭以降で最初のヒット
 * - 後方検索: viewport の先頭より前で最後のヒット
 * を選ぶ。「今見ているところ」から探し始めるための引数が viewportTop。
 */
export function pickHitIndex(
  hits: SearchHit[],
  from: { row: number; col: number } | null,
  direction: 1 | -1,
  viewportTop = 0,
): number {
  if (hits.length === 0) return -1;
  if (!from) {
    if (direction === 1) {
      const i = hits.findIndex((h) => h.row >= viewportTop);
      return i >= 0 ? i : 0;
    }
    for (let i = hits.length - 1; i >= 0; i--) {
      if (hits[i].row < viewportTop) return i;
    }
    return hits.length - 1;
  }
  if (direction === 1) {
    const i = hits.findIndex(
      (h) => h.row > from.row || (h.row === from.row && h.col > from.col),
    );
    return i >= 0 ? i : 0; // 末尾まで来たら先頭へ回り込む
  }
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.row < from.row || (h.row === from.row && h.col < from.col)) return i;
  }
  return hits.length - 1; // 先頭まで来たら末尾へ回り込む
}
