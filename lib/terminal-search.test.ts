import { describe, it, expect } from "vitest";
import {
  findAllIndexes,
  scanCandidateRows,
  hitsInLogicalLine,
  searchBuffer,
  pickHitIndex,
  dedupeSorted,
  type SearchHit,
} from "./terminal-search";
import { readLogicalLine, type LineLike, type CellLike } from "./terminal-links";

/* ------------------------------------------------------------------ */
/* テスト用ヘルパー（terminal-links.test.ts と同じ方式で端末グリッドを作る） */
/* ------------------------------------------------------------------ */

const isWide = (ch: string) =>
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch);

interface FakeCell extends CellLike {
  chars: string;
  width: number;
}

function cell(chars: string, width: number): FakeCell {
  return { chars, width, getChars: () => chars, getWidth: () => width };
}

/** 1 本の論理行を cols 桁に折り返して行配列にする（全角=2セル）。 */
function layoutOne(text: string, cols: number): LineLike[] {
  const rows: FakeCell[][] = [[]];
  const wrapped: boolean[] = [false];
  let cur = rows[0];
  for (const ch of text) {
    const w = isWide(ch) ? 2 : 1;
    if (cur.length + w > cols) {
      while (cur.length < cols) cur.push(cell("", 1));
      cur = [];
      rows.push(cur);
      wrapped.push(true);
    }
    cur.push(cell(ch, w));
    for (let i = 1; i < w; i++) cur.push(cell("", 0));
  }
  return rows.map((cells, i) => ({
    isWrapped: wrapped[i],
    length: cols,
    getCell: (x: number) => cells[x] ?? cell("", 1),
  }));
}

/** 複数の論理行を並べたバッファを作る。 */
function layoutLines(texts: string[], cols: number): LineLike[] {
  return texts.flatMap((t) => layoutOne(t, cols));
}

const asGetLine = (lines: LineLike[]) => (row: number) => lines[row];

/** 行テキスト（translateToString(true) 相当：末尾空白トリム）。 */
function asGetLineText(lines: LineLike[]) {
  return (row: number) => {
    const line = lines[row];
    if (!line) return undefined;
    let s = "";
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x);
      if (!c) continue;
      if (c.getWidth() === 0) continue;
      s += c.getChars() || " ";
    }
    return s.replace(/\s+$/, "");
  };
}

function bufferOf(texts: string[], cols: number) {
  const lines = layoutLines(texts, cols);
  return {
    lines,
    params: {
      rowCount: lines.length,
      cols,
      getLine: asGetLine(lines),
      getLineText: asGetLineText(lines),
    },
  };
}

/* ------------------------------------------------------------------ */

describe("findAllIndexes", () => {
  it("重ならない一致を全部返す", () => {
    expect(findAllIndexes("abcabcabc", "abc")).toEqual([0, 3, 6]);
  });

  it("既定は大文字小文字を区別しない／区別モードでは分かれる", () => {
    expect(findAllIndexes("Error error ERROR", "error")).toEqual([0, 6, 12]);
    expect(findAllIndexes("Error error ERROR", "error", true)).toEqual([6]);
  });

  it("空クエリは 0 件（全部一致にしない）", () => {
    expect(findAllIndexes("abc", "")).toEqual([]);
  });
});

describe("scanCandidateRows", () => {
  it("一致のある行だけを候補にする", () => {
    const { params } = bufferOf(["hello world", "no match here", "world tour"], 40);
    expect(
      scanCandidateRows(params.getLineText, params.rowCount, "world"),
    ).toEqual([0, 2]);
  });

  it("折り返しをまたぐ一致は「始まる行」を候補にする", () => {
    // cols=10 で "npm run build" は "npm run bu" / "ild" に割れる
    const { params } = bufferOf(["npm run build"], 10);
    expect(params.getLineText(0)).toBe("npm run bu");
    expect(params.getLineText(1)).toBe("ild");
    expect(
      scanCandidateRows(params.getLineText, params.rowCount, "build"),
    ).toEqual([0]);
  });

  it("空クエリ・空バッファは 0 件", () => {
    const { params } = bufferOf(["abc"], 40);
    expect(scanCandidateRows(params.getLineText, params.rowCount, "")).toEqual(
      [],
    );
    expect(scanCandidateRows(() => undefined, 0, "abc")).toEqual([]);
  });
});

describe("hitsInLogicalLine", () => {
  it("全角を含む行でもセル桁が合う（文字数ではなくセル数）", () => {
    const lines = layoutOne("メモ error です", 80);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    const hits = hitsInLogicalLine(info, "error", 80);
    // "メ"(2) + "モ"(2) + " "(1) = 5 桁目から
    expect(hits).toEqual([{ row: 0, col: 5, length: 5 }]);
  });

  it("末尾が全角の一致は 2 セル目まで length に含める", () => {
    const lines = layoutOne("これはエラー", 80);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    const hits = hitsInLogicalLine(info, "エラー", 80);
    expect(hits).toEqual([{ row: 0, col: 6, length: 6 }]);
  });

  it("折り返しをまたぐ一致は跨いだセル数を length に含める", () => {
    const cols = 10;
    const lines = layoutOne("npm run build", cols);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    const hits = hitsInLogicalLine(info, "build", cols);
    // "build" は row0 の col8 から始まり row1 の col2 まで（2 セル分は次行）
    expect(hits).toEqual([{ row: 0, col: 8, length: 5 }]);
  });
});

describe("searchBuffer", () => {
  it("バッファ全体を行順に返す", () => {
    const { params } = bufferOf(
      ["first error line", "clean line", "second error line"],
      40,
    );
    const hits = searchBuffer({ ...params, query: "error" });
    expect(hits.map((h) => h.row)).toEqual([0, 2]);
    expect(hits[0].col).toBe(6);
  });

  it("同じ論理行を 2 回数えない（折り返し行の重複展開を防ぐ）", () => {
    const cols = 12;
    const { params } = bufferOf(["error and error again in one long line"], cols);
    const hits = searchBuffer({ ...params, query: "error" });
    expect(hits.length).toBe(2);
    expect(hits[0].row).toBe(0);
  });

  it("大文字小文字の区別を切り替えられる", () => {
    const { params } = bufferOf(["Error", "error"], 40);
    expect(searchBuffer({ ...params, query: "error" }).length).toBe(2);
    expect(
      searchBuffer({ ...params, query: "error", caseSensitive: true }).length,
    ).toBe(1);
  });

  it("空クエリは 0 件", () => {
    const { params } = bufferOf(["error"], 40);
    expect(searchBuffer({ ...params, query: "" })).toEqual([]);
  });
});

describe("pickHitIndex", () => {
  const hits: SearchHit[] = [
    { row: 1, col: 0, length: 3 },
    { row: 5, col: 2, length: 3 },
    { row: 9, col: 4, length: 3 },
  ];

  it("前方：現在位置より後の最初、末尾まで来たら先頭へ回り込む", () => {
    expect(pickHitIndex(hits, { row: 1, col: 0 }, 1)).toBe(1);
    expect(pickHitIndex(hits, { row: 9, col: 4 }, 1)).toBe(0);
  });

  it("後方：現在位置より前の最後、先頭まで来たら末尾へ回り込む", () => {
    expect(pickHitIndex(hits, { row: 5, col: 2 }, -1)).toBe(0);
    expect(pickHitIndex(hits, { row: 1, col: 0 }, -1)).toBe(2);
  });

  it("初回は「いま見ている位置」から探し始める", () => {
    expect(pickHitIndex(hits, null, 1, 4)).toBe(1);
    expect(pickHitIndex(hits, null, -1, 4)).toBe(0);
  });

  it("ヒットが無ければ -1", () => {
    expect(pickHitIndex([], null, 1)).toBe(-1);
  });
});

describe("dedupeSorted", () => {
  it("行→桁で並べ、同一位置の重複を落とす", () => {
    const out = dedupeSorted([
      { row: 5, col: 1, length: 2 },
      { row: 1, col: 3, length: 2 },
      { row: 5, col: 1, length: 2 },
    ]);
    expect(out).toEqual([
      { row: 1, col: 3, length: 2 },
      { row: 5, col: 1, length: 2 },
    ]);
  });
});
