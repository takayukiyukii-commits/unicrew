import { describe, it, expect } from "vitest";
import {
  isDarkHex,
  terminalThemeFor,
  LIGHT_TERMINAL_THEME,
} from "./terminal-theme";
import {
  clampFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
} from "./terminal-prefs";

describe("isDarkHex", () => {
  it("明るい色は false / 暗い色は true", () => {
    expect(isDarkHex("#ffffff")).toBe(false);
    expect(isDarkHex("#faf9f6")).toBe(false); // 従来のターミナル背景
    expect(isDarkHex("#f7f3ec")).toBe(false); // セピア
    expect(isDarkHex("#f3faf7")).toBe(false); // ミント
    expect(isDarkHex("#f4f6f8")).toBe(false); // スレート
    expect(isDarkHex("#0f1117")).toBe(true); // ダーク
    expect(isDarkHex("#0b1020")).toBe(true); // ミッドナイト
  });

  it("3桁表記・前後の空白・#なしも扱える", () => {
    expect(isDarkHex("#000")).toBe(true);
    expect(isDarkHex("  #fff  ")).toBe(false);
    expect(isDarkHex("111111")).toBe(true);
  });

  it("壊れた値は「暗くない」に倒す（＝従来の白基調のまま）", () => {
    expect(isDarkHex("")).toBe(false);
    expect(isDarkHex(undefined)).toBe(false);
    expect(isDarkHex(null)).toBe(false);
    expect(isDarkHex("rgb(0,0,0)")).toBe(false);
    expect(isDarkHex("#12345")).toBe(false);
  });
});

describe("terminalThemeFor", () => {
  it("🚨明るいテーマでは従来の配色を 1 バイトも変えない（既存ユーザー保護）", () => {
    // 値そのものを固定する。ここが落ちたら「見た目を変えてしまった」ということ。
    expect(LIGHT_TERMINAL_THEME.background).toBe("#faf9f6");
    expect(LIGHT_TERMINAL_THEME.foreground).toBe("#1f2328");
    expect(LIGHT_TERMINAL_THEME.selectionBackground).toBe("#d0d7de");
    expect(LIGHT_TERMINAL_THEME.blue).toBe("#0969da");
    expect(LIGHT_TERMINAL_THEME.brightWhite).toBe("#1f2328");

    // 既定・セピア・ミント・スレート、どれでも同じオブジェクトを返す
    for (const bg of ["#ffffff", "#f7f3ec", "#f3faf7", "#f4f6f8"]) {
      expect(terminalThemeFor({ bg, text: "#111827", surface: "#fafafa" })).toEqual(
        LIGHT_TERMINAL_THEME,
      );
    }
  });

  it("設定が読めないとき（空）も従来の配色", () => {
    expect(terminalThemeFor({})).toEqual(LIGHT_TERMINAL_THEME);
  });

  it("暗いテーマでは背景・文字色が画面に追従し、ANSI も明るい側になる", () => {
    const theme = terminalThemeFor({
      bg: "#0f1117",
      text: "#e7eaf0",
      surface: "#171a21",
    });
    expect(theme.background).toBe("#0f1117");
    expect(theme.foreground).toBe("#e7eaf0");
    expect(theme.cursor).toBe("#e7eaf0");
    expect(theme.cursorAccent).toBe("#171a21");
    // 暗い背景に濃い ANSI（従来値）を使うと読めない → 明るい側へ
    expect(theme.blue).not.toBe(LIGHT_TERMINAL_THEME.blue);
    expect(theme.background).not.toBe(LIGHT_TERMINAL_THEME.background);
  });

  it("暗いテーマでも 16 色すべてが埋まっている（欠けると xterm が既定色に戻る）", () => {
    const theme = terminalThemeFor({ bg: "#0b1020", text: "#e6e9f5" });
    for (const key of [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const) {
      expect(theme[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("文字色が読めないときでも暗い背景用の既定文字色になる（黒文字にしない）", () => {
    const theme = terminalThemeFor({ bg: "#0f1117" });
    expect(theme.foreground).toBe("#e7eaf0");
  });
});

describe("clampFontSize", () => {
  it("範囲内はそのまま・範囲外は丸める", () => {
    expect(clampFontSize(13)).toBe(13);
    expect(clampFontSize(1)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(clampFontSize(999)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(clampFontSize(12.4)).toBe(12);
  });

  it("壊れた値は既定へ倒す（0 や NaN で文字が消えないように）", () => {
    expect(clampFontSize("abc")).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(clampFontSize(NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(clampFontSize(undefined)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(clampFontSize(null)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("文字列の数値は読める（localStorage は文字列で返る）", () => {
    expect(clampFontSize("16")).toBe(16);
  });
});
