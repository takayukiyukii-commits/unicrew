import { describe, it, expect } from "vitest";
import { findPromptInsertPoint, type TermSnapshot } from "./terminal-ime";

/**
 * フィクスチャは claude CLI 2.1.173 を ConPTY で実機キャプチャした画面状態
 * （2026-06-11 調査）を再現したもの。
 *
 * 新UI（2.1.17x）の特徴:
 *  - 過去のユーザー発言もトランスクリプトに「❯ 」付きで描画される
 *  - 実カーソルは入力挿入点に正確に置かれる
 *  - Ink の反転カーソルブロックは点滅（消えている瞬間がある）
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

describe("findPromptInsertPoint (claude 2.1.17x 新UI)", () => {
  it("過去発言の ❯ ではなく最下の ❯（入力ボックス）を入力行とする（復活バグの本体）", () => {
    // 反転カーソル点滅オン：入力行14のカーソルブロックを採る
    const s = snap({
      lines: conversationLines,
      inverse: [[14, 2]],
      cursorY: 14,
      cursorX: 2,
    });
    expect(findPromptInsertPoint(s)).toEqual({ rowY: 14, col: 2 });
  });

  it("反転カーソルが点滅で消えている瞬間は実カーソル位置を採る", () => {
    // 点滅オフ：旧ロジックだと過去発言の行末 (7, 40) に飛んでいた
    const s = snap({
      lines: conversationLines,
      inverse: [],
      cursorY: 14,
      cursorX: 5,
    });
    expect(findPromptInsertPoint(s)).toEqual({ rowY: 14, col: 5 });
  });

  it("入力が折り返して反転カーソルが ❯ 行より下にあるときは折り返し行を採る", () => {
    const s = snap({
      lines: { 7: "❯ 過去発言", 14: "❯ ながいながい入力テキスト…" },
      inverse: [[15, 10]], // 折り返し2行目のカーソル
      cursorY: 15,
      cursorX: 10,
    });
    expect(findPromptInsertPoint(s)).toEqual({ rowY: 15, col: 10 });
  });

  it("反転セルなし＆実カーソルが入力領域外なら ❯ 行のテキスト末尾へフォールバック", () => {
    const s = snap({
      lines: { 14: "❯ abc" },
      inverse: [],
      cursorY: 0, // 入力領域(14以降)の外
      cursorX: 0,
    });
    expect(findPromptInsertPoint(s)).toEqual({ rowY: 14, col: 5 });
  });

  it("❯ が画面に無ければ null（補正しない）", () => {
    const s = snap({ lines: { 5: "ただのテキスト" } });
    expect(findPromptInsertPoint(s)).toBeNull();
  });

  it("rows/cols が 0 なら null", () => {
    const s = snap({ rows: 0, lines: conversationLines });
    expect(findPromptInsertPoint(s)).toBeNull();
  });

  it("起動直後（会話なし・入力空）はカーソルブロック位置を採る", () => {
    // 実機キャプチャ: 行8 "❯"、反転 (8,2)、カーソル (8,2)
    const s = snap({
      lines: { 8: "❯" },
      inverse: [[8, 2]],
      cursorY: 8,
      cursorX: 2,
    });
    expect(findPromptInsertPoint(s)).toEqual({ rowY: 8, col: 2 });
  });
});
