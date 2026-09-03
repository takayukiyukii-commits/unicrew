import { describe, it, expect } from "vitest";
import {
  templateFromFractions,
  fractionsToPercents,
  boundaryPercents,
  resizeAtBoundary,
  fitFractions,
  MIN_PANE_PCT,
} from "./terminal-grid";

const near = (a: number, b: number, tol = 0.001) => Math.abs(a - b) < tol;

describe("templateFromFractions", () => {
  it("CSS の grid-template 文字列になる", () => {
    expect(templateFromFractions([1, 1, 1])).toBe("1fr 1fr 1fr");
    expect(templateFromFractions([1.5, 0.5])).toBe("1.5fr 0.5fr");
    expect(templateFromFractions([])).toBe("");
  });

  it("0 や負の値でも列が消えない（最低値で描く）", () => {
    expect(templateFromFractions([0, 1])).toBe("0.0001fr 1fr");
    expect(templateFromFractions([-3, 1])).toBe("0.0001fr 1fr");
  });
});

describe("fractionsToPercents", () => {
  it("合計 100 になる", () => {
    const p = fractionsToPercents([1, 1, 2]);
    expect(near(p.reduce((a, b) => a + b, 0), 100)).toBe(true);
    expect(near(p[2], 50)).toBe(true);
  });

  it("合計 0 のときは均等割り（0 除算で NaN にしない）", () => {
    expect(fractionsToPercents([0, 0])).toEqual([50, 50]);
  });
});

describe("boundaryPercents", () => {
  it("要素 n 個に対して境界は n-1 本", () => {
    expect(boundaryPercents([1]).length).toBe(0);
    expect(boundaryPercents([1, 1]).length).toBe(1);
    expect(boundaryPercents([1, 1, 1]).length).toBe(2);
  });

  it("均等なら等間隔", () => {
    const b = boundaryPercents([1, 1, 1]);
    expect(near(b[0], 33.3333)).toBe(true);
    expect(near(b[1], 66.6667)).toBe(true);
  });
});

describe("resizeAtBoundary", () => {
  it("隣り合う 2 枚だけが変わり、他は動かない", () => {
    const out = resizeAtBoundary([1, 1, 1], 1, 80);
    const p = fractionsToPercents(out);
    expect(near(p[0], 33.3333)).toBe(true); // 左端は不変
    expect(near(p[1], 46.6667)).toBe(true); // 80 - 33.33
    expect(near(p[2], 20)).toBe(true);
    expect(near(p.reduce((a, b) => a + b, 0), 100)).toBe(true);
  });

  it("最小幅より小さくしようとしても最小幅で止まる（潰れて操作不能にならない）", () => {
    const shrinkLeft = fractionsToPercents(resizeAtBoundary([1, 1], 0, 0));
    expect(near(shrinkLeft[0], MIN_PANE_PCT)).toBe(true);
    const shrinkRight = fractionsToPercents(resizeAtBoundary([1, 1], 0, 100));
    expect(near(shrinkRight[1], MIN_PANE_PCT)).toBe(true);
  });

  it("範囲外の境界 index は何もしない", () => {
    const fr = [1, 1];
    expect(resizeAtBoundary(fr, -1, 50)).toBe(fr);
    expect(resizeAtBoundary(fr, 1, 50)).toBe(fr);
    expect(resizeAtBoundary([1], 0, 50)).toEqual([1]);
  });

  it("NaN を渡しても壊れない（元の比率を返す）", () => {
    const fr = [1, 1];
    expect(resizeAtBoundary(fr, 0, NaN)).toBe(fr);
  });
});

describe("fitFractions", () => {
  it("枚数が合っていればそのまま使う", () => {
    const fr = [2, 1];
    expect(fitFractions(fr, 2)).toBe(fr);
  });

  it("枚数が変わったら均等に戻す", () => {
    expect(fitFractions([2, 1], 3)).toEqual([1, 1, 1]);
    expect(fitFractions(undefined, 2)).toEqual([1, 1]);
    expect(fitFractions([], 1)).toEqual([1]);
  });

  it("壊れた比率（0・NaN・負）は均等に戻す", () => {
    expect(fitFractions([0, 1], 2)).toEqual([1, 1]);
    expect(fitFractions([NaN, 1], 2)).toEqual([1, 1]);
    expect(fitFractions([-1, 2], 2)).toEqual([1, 1]);
  });

  it("0 枚なら空", () => {
    expect(fitFractions([1], 0)).toEqual([]);
  });
});
