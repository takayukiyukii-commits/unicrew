import { describe, it, expect } from "vitest";
import {
  readLogicalLine,
  matchToBufferRange,
  type LineLike,
  type CellLike,
} from "./terminal-links";
import { findPathMatches, findUrlMatches } from "./file-link";

/* ------------------------------------------------------------------ */
/* テスト用ヘルパー：論理テキストを cols 桁の端末グリッドへレイアウトする */
/* （xterm と同じく全角=2セル・行末に収まらない全角は次行へ送り空セルを残す） */
/* ------------------------------------------------------------------ */

const isWide = (ch: string) =>
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(
    ch,
  );

interface FakeCell extends CellLike {
  chars: string;
  width: number;
}

function cell(chars: string, width: number): FakeCell {
  return {
    chars,
    width,
    getChars: () => chars,
    getWidth: () => width,
  };
}

function layout(text: string, cols: number): LineLike[] {
  const rows: FakeCell[][] = [[]];
  const wrapped: boolean[] = [false];
  let cur = rows[0];
  for (const ch of text) {
    const w = isWide(ch) ? 2 : 1;
    if (cur.length + w > cols) {
      // 全角が行末1セルに収まらない場合は空セル(width1, 空文字)を置いて折り返し
      while (cur.length < cols) cur.push(cell("", 1));
      cur = [];
      rows.push(cur);
      wrapped.push(true);
    }
    cur.push(cell(ch, w));
    for (let i = 1; i < w; i++) cur.push(cell("", 0)); // 全角の後半セル
  }
  return rows.map((cells, i) => ({
    isWrapped: wrapped[i],
    length: cols,
    getCell: (x: number) => cells[x] ?? cell("", 1),
  }));
}

/** rows 配列を getLine 関数化（バッファ絶対行 = 配列 index） */
function asGetLine(lines: LineLike[]) {
  return (row: number) => lines[row];
}

/* ------------------------------------------------------------------ */

describe("readLogicalLine", () => {
  it("ASCII のみ・折り返しなし：テキストとセル座標が 1:1", () => {
    const lines = layout("hello D:/repo/file.md", 80);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    expect(info.text).toBe("hello D:/repo/file.md");
    expect(info.map[0]).toEqual({ row: 0, x: 0, width: 1 });
    expect(info.map[6]).toEqual({ row: 0, x: 6, width: 1 }); // "D"
  });

  it("全角を含む行：文字列1文字でもセルは2進む", () => {
    const lines = layout("メモ D:/a.md", 80);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    expect(info.text).toBe("メモ D:/a.md");
    // "メ"=cell0(幅2), "モ"=cell2(幅2), " "=cell4, "D"=cell5
    expect(info.map[0]).toEqual({ row: 0, x: 0, width: 2 });
    expect(info.map[1]).toEqual({ row: 0, x: 2, width: 2 });
    expect(info.map[3]).toEqual({ row: 0, x: 5, width: 1 });
  });

  it("折り返し行を連結し、途中の行から呼んでも同じ論理行を返す", () => {
    const text = "D:/company/very/long/path/to/some/deep/file_name_here.md";
    const lines = layout(text, 20); // 3行に折り返し
    expect(lines.length).toBeGreaterThan(1);
    const fromFirst = readLogicalLine(asGetLine(lines), 0)!;
    const fromLast = readLogicalLine(asGetLine(lines), lines.length - 1)!;
    expect(fromFirst.text).toBe(text);
    expect(fromLast.text).toBe(text);
    expect(fromLast.startRow).toBe(0);
    expect(fromLast.endRow).toBe(lines.length - 1);
  });

  it("行末に収まらない全角の折り返し（空きセル）を正しく読み飛ばす", () => {
    // cols=5: "ab" + "あ"(2セル) + "い" → "い"は行末1セルに入らず次行へ
    const lines = layout("abあいう.md", 5);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    expect(info.text).toBe("abあいう.md");
    // "い" は row1 の先頭セル
    expect(info.map[3]).toEqual({ row: 1, x: 0, width: 2 });
  });
});

describe("matchToBufferRange（部分クリックバグの回帰テスト）", () => {
  it("日本語入りパス：クリック範囲がパス全体のセルをカバーする", () => {
    const line = "保存先: D:/company/作業レポート/20260611_レポート.md です";
    const lines = layout(line, 200);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    const matches = findPathMatches(info.text);
    expect(matches).toHaveLength(1);
    const mt = matches[0];
    const range = matchToBufferRange(info, mt.start, mt.end)!;
    // 開始セル: "保存先: "=保(2)存(2)先(2):(1)空白(1)=8セル → "D"は cell8（1-based で 9）
    expect(range.start).toEqual({ x: 9, y: 1 });
    // 終了セル: 行全体から " です"(=1+2+2=5セル)を引いた位置まで
    const totalCells = [...line].reduce((a, c) => a + (isWide(c) ? 2 : 1), 0);
    expect(range.end).toEqual({ x: totalCells - 5, y: 1 });
  });

  it("旧実装の再現：文字列インデックスをセル座標に使うと範囲が短くなる（バグの証明）", () => {
    const line = "保存先: D:/company/作業レポート/20260611_レポート.md です";
    const lines = layout(line, 200);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    const mt = findPathMatches(info.text)[0];
    const correct = matchToBufferRange(info, mt.start, mt.end)!;
    // 旧実装: end = mt.end（文字列インデックス）→ 正しいセル終端より小さい
    expect(mt.end).toBeLessThan(correct.end.x);
  });

  it("折り返しパス：複数行にまたがるセル範囲を返す", () => {
    const path = "D:/company/projects/unicrew/components/InteractiveTerminal.tsx";
    const lines = layout(path, 40); // 2行に折り返し
    const info = readLogicalLine(asGetLine(lines), 1)!; // 2行目から呼んでも
    const mt = findPathMatches(info.text)[0];
    expect(mt.raw).toBe(path); // パス全体がマッチ
    const range = matchToBufferRange(info, mt.start, mt.end)!;
    expect(range.start).toEqual({ x: 1, y: 1 });
    expect(range.end.y).toBe(2); // 2行目まで届く
    expect(range.end.x).toBe(path.length - 40);
  });

  it("URL も同様にセル座標へ変換できる（手前に日本語があるケース）", () => {
    const line = "ドキュメント → https://example.com/docs/page を参照";
    const lines = layout(line, 200);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    const mt = findUrlMatches(info.text)[0];
    const range = matchToBufferRange(info, mt.start, mt.end)!;
    // "ドキュメント → " = ド(2)キ(2)ュ(2)メ(2)ン(2)ト(2)空白(1)→(1)空白(1) = 15セル
    expect(range.start).toEqual({ x: 16, y: 1 });
    expect(range.end.x - range.start.x + 1).toBe(mt.url.length); // URL はASCIIなのでセル数=文字数
  });

  it("末尾が全角のトークンは2セル目まで範囲に含める", () => {
    const lines = layout("あ", 80);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    const range = matchToBufferRange(info, 0, 1)!;
    expect(range).toEqual({ start: { x: 1, y: 1 }, end: { x: 2, y: 1 } });
  });

  it("範囲が不正なら null", () => {
    const lines = layout("abc", 80);
    const info = readLogicalLine(asGetLine(lines), 0)!;
    expect(matchToBufferRange(info, 2, 2)).toBeNull();
    expect(matchToBufferRange(info, -1, 2)).toBeNull();
    expect(matchToBufferRange(info, 0, 99)).toBeNull();
  });
});
