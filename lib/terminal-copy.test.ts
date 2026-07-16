import { describe, expect, it } from "vitest";
import { displayWidth, joinHardWrappedLines } from "./terminal-copy";

describe("displayWidth", () => {
  it("ASCII は 1 セル", () => {
    expect(displayWidth("abc 123")).toBe(7);
  });
  it("日本語は 2 セル", () => {
    expect(displayWidth("あいう")).toBe(6);
    expect(displayWidth("aあ")).toBe(3);
  });
});

describe("joinHardWrappedLines", () => {
  const COLS = 20;

  it("幅いっぱいの日本語行は次行と空白なしで連結する", () => {
    // 「ああああああああああ」= 20セル（幅いっぱい）→ 次行と連結
    const text = "ああああああああああ\nいいい。";
    expect(joinHardWrappedLines(text, COLS)).toBe("ああああああああああいいい。");
  });

  it("幅いっぱいの英文行は空白 1 個で連結する（単語分断の復元）", () => {
    const text = "aaaaaaaaaaaaaaaaaaaa\nword continues";
    expect(joinHardWrappedLines(text, COLS)).toBe(
      "aaaaaaaaaaaaaaaaaaaa word continues",
    );
  });

  it("短い行はそのまま（通常の改行は保持）", () => {
    const text = "short line\nnext line";
    expect(joinHardWrappedLines(text, COLS)).toBe(text);
  });

  it("次行が空行なら連結しない（段落保持）", () => {
    const text = "ああああああああああ\n\n次の段落";
    expect(joinHardWrappedLines(text, COLS)).toBe(text);
  });

  it("連結時に次行の先頭インデント（Ink継続行）を除去する", () => {
    const text = "ああああああああああ\n  続きの文です。";
    expect(joinHardWrappedLines(text, COLS)).toBe(
      "ああああああああああ続きの文です。",
    );
  });

  it("罫線（Box Drawing）で終わる行は連結しない", () => {
    // ╭──...──╮ のような枠線行（幅いっぱい）は次行と繋がない
    const border = "╭" + "─".repeat(18) + "╮"; // 20セル
    const text = `${border}\n│ 中身 │`;
    expect(joinHardWrappedLines(text, COLS)).toBe(text);
  });

  it("3行連続の折返しも1行に戻す", () => {
    const text = "ああああああああああ\nああああああああああ\nおわり。";
    expect(joinHardWrappedLines(text, COLS)).toBe(
      "ああああああああああああああああああああおわり。",
    );
  });

  it("cols-1（全角で最終セルが埋まらない行）も満杯として連結する", () => {
    // 19セル = 全角9文字 + 半角1（20桁端末で全角は19セルまでしか置けないケース）
    const line = "あああああああああx"; // 19セル
    const text = `${line}\n続き`;
    expect(joinHardWrappedLines(text, COLS)).toBe(`${line}続き`);
  });

  it("空文字・極小colsはそのまま返す", () => {
    expect(joinHardWrappedLines("", COLS)).toBe("");
    expect(joinHardWrappedLines("a\nb", 3)).toBe("a\nb");
  });
});
