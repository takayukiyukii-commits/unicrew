import { describe, it, expect } from "vitest";
import { findCompositionOverride, type TermSnapshot } from "./terminal-ime";

/**
 * フィクスチャは claude CLI 2.1.173 を ConPTY で実機キャプチャした画面状態
 * （2026-06-11 調査）を再現したもの。
 *
 * 新UI（2.1.17x）の特徴:
 *  - 過去のユーザー発言もトランスクリプトに「❯ 」付きで描画される
 *  - 実カーソルは入力挿入点に正確に置かれる（VS Code が依存する標準契約）
 *  - Ink の反転カーソルブロックは点滅（消えている瞬間がある）
 *
 * v0.2.30 設計原則: 実カーソルが入力領域内 → null（xterm ネイティブ配置を信頼）。
 * 上書きは実カーソルが入力領域より上にある異常時だけの保険。
 */
function snap(opts: {
  rows?: number;
  cols?: number;
  lines?: Record<number, string>;
  inverse?: Array<[number, number]>;
  cursorY?: number;
  cursorX?: number;
}): TermSnapshot {
  const rows = opts.rows ?? 30;
  const cols = opts.cols ?? 100;
  const lines = opts.lines ?? {};
  const inv = new Set((opts.inverse ?? []).map(([y, x]) => `${y}:${x}`));
  return {
    rows,
    cols,
    lineText: (y) => lines[y] ?? "",
    isInverse: (y, x) => inv.has(`${y}:${x}`),
    cursorY: opts.cursorY ?? 0,
    cursorX: opts.cursorX ?? 0,
  };
}

/** 会話1往復後の実機レイアウト（行7=過去発言、行14=入力ボックス） */
const conversationLines = {
  7: "❯ reply with exactly: hello unicrew test", // 過去の自分の発言（トランスクリプト）
  9: "● hello unicrew test",
  11: "✻ Brewed for 2s",
  14: "❯", // 本当の入力ボックス
  16: "  ⏵⏵ auto mode on (shift+tab to cycle)",
};

describe("findCompositionOverride (VS Code方式: 実カーソル信頼が第一)", () => {
  it("実カーソルが入力領域内なら null（xterm ネイティブ配置を信頼）", () => {
    // claude 2.1.17x の通常状態：カーソルは挿入点 (14,2)
    const s = snap({
      lines: conversationLines,
      inverse: [[14, 2]],
      cursorY: 14,
      cursorX: 2,
    });
    expect(findCompositionOverride(s)).toBeNull();
  });

  it("反転カーソルが点滅で消えていても、実カーソルが入力領域内なら null", () => {
    // 旧ロジック(v0.2.28以前)だと過去発言の行末 (7,40) に飛んでいたケース
    const s = snap({
      lines: conversationLines,
      inverse: [],
      cursorY: 14,
      cursorX: 5,
    });
    expect(findCompositionOverride(s)).toBeNull();
  });

  it("入力が折り返してカーソルが ❯ 行より下の行にあっても入力領域内として null", () => {
    const s = snap({
      lines: { 7: "❯ 過去発言", 14: "❯ ながいながい入力テキスト…" },
      inverse: [[15, 10]],
      cursorY: 15, // 折り返し2行目
      cursorX: 10,
    });
    expect(findCompositionOverride(s)).toBeNull();
  });

  it("【保険】実カーソルが入力領域より上の異常時は反転セル位置で上書き", () => {
    // 旧 claude 型の異常（カーソルがトランスクリプト側に取り残される）
    const s = snap({
      lines: conversationLines,
      inverse: [[14, 2]],
      cursorY: 3, // 入力領域(14以降)より上
      cursorX: 0,
    });
    expect(findCompositionOverride(s)).toEqual({ rowY: 14, col: 2 });
  });

  it("【保険】過去発言の ❯ ではなく最下の ❯（入力ボックス）を入力行とする", () => {
    // 復活バグの本体：上から走査だと行7（過去発言）を拾っていた
    const s = snap({
      lines: conversationLines,
      inverse: [[14, 6]],
      cursorY: 0,
      cursorX: 0,
    });
    expect(findCompositionOverride(s)).toEqual({ rowY: 14, col: 6 });
  });

  it("【保険】反転セルも無ければ ❯ 行のテキスト末尾へフォールバック", () => {
    const s = snap({
      lines: { 14: "❯ abc" },
      inverse: [],
      cursorY: 0,
      cursorX: 0,
    });
    expect(findCompositionOverride(s)).toEqual({ rowY: 14, col: 5 });
  });

  it("❯ が画面に無ければ null（ダイアログ等。ネイティブ信頼）", () => {
    const s = snap({ lines: { 5: "ただのテキスト" }, cursorY: 5, cursorX: 0 });
    expect(findCompositionOverride(s)).toBeNull();
  });

  it("rows/cols が 0 なら null", () => {
    const s = snap({ rows: 0, lines: conversationLines });
    expect(findCompositionOverride(s)).toBeNull();
  });

  it("起動直後（会話なし・カーソルが ❯ 行）は null（ネイティブ信頼）", () => {
    // 実機キャプチャ: 行8 "❯"、反転 (8,2)、カーソル (8,2)
    const s = snap({
      lines: { 8: "❯" },
      inverse: [[8, 2]],
      cursorY: 8,
      cursorX: 2,
    });
    expect(findCompositionOverride(s)).toBeNull();
  });
});
