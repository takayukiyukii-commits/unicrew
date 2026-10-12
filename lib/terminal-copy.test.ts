import { describe, expect, it } from "vitest";
import { cleanTerminalCopy, displayWidth, joinHardWrappedLines } from "./terminal-copy";

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

describe("cleanTerminalCopy（コピーで空白が付いてくる問題）", () => {
  it("行末の空白（Ink の埋め草）を消す", () => {
    expect(cleanTerminalCopy("abc     \ndef   ", 80)).toBe("abc\ndef");
  });
  it("空白で埋まって幅いっぱいに見える行を、次の行とつなげない", () => {
    const cols = 20;
    const padded = "short line".padEnd(cols, " ");
    expect(cleanTerminalCopy(`${padded}\nnext line`, cols)).toBe("short line\nnext line");
  });
  it("Claude Code の本文の字下げ（全行に2つ）を外す", () => {
    expect(cleanTerminalCopy("  一行目です。\n  二行目です。\n\n  三行目。", 80)).toBe("一行目です。\n二行目です。\n\n三行目。");
  });
  it("選択の始まりが行の途中（1行目だけ字下げなし）でも、2行目以降の字下げを外す", () => {
    // 選択開始の行は画面上で2字下げ（Claude Code の本文の余白）→ 2つ外す
    expect(cleanTerminalCopy("目です。\n  二行目です。\n  三行目。", 80, 2)).toBe("目です。\n二行目です。\n三行目。");
  });
  it("行の途中から選んでも、その行が字下げ0なら YAML の子の字下げは残す（第12回）", () => {
    // 画面「説明: root:」の root: から選択。行の字下げは 0
    expect(cleanTerminalCopy("root:\r\n  enabled: true", 80, 0)).toBe("root:\n  enabled: true");
  });
  it("コードの相対的な字下げは残す", () => {
    expect(cleanTerminalCopy("  if (a) {\n    b();\n  }", 80)).toBe("if (a) {\n  b();\n}");
  });
  it("本物の折返しは今までどおりつなぐ", () => {
    const cols = 10;
    expect(cleanTerminalCopy("abcdefghij\nklm", cols)).toBe("abcdefghij klm");
  });
  it("Windows の CRLF でも行末の空白を消し、改行を残す（2026-10-13 監査）", () => {
    expect(cleanTerminalCopy("abc     \r\ndef   ", 80)).toBe("abc\ndef");
    expect(cleanTerminalCopy("short line".padEnd(20, " ") + "\r\nnext line", 20)).toBe("short line\nnext line");
  });
  it("語の区切りの空白1つで折り返した行は、空白1つでつなぐ（コマンドを壊さない）", () => {
    expect(cleanTerminalCopy("/opt/test \n--help", 10)).toBe("/opt/test --help");
  });
  it("行頭から選んだ Python・YAML の字下げ（構造）は壊さない（2026-10-13 監査）", () => {
    expect(cleanTerminalCopy("if True:\n    print(1)", 80)).toBe("if True:\n    print(1)");
    expect(cleanTerminalCopy("root:\n  enabled: true", 80)).toBe("root:\n  enabled: true");
    // Claude Code の本文の字下げ（全行に共通）だけは外す
    expect(cleanTerminalCopy("  if True:\n      print(1)", 80)).toBe("if True:\n    print(1)");
  });
  it("一度つないだ後の短い行の改行は残す（既存の不具合）", () => {
    expect(cleanTerminalCopy("abcdefghij\nshort\nthird", 10)).toBe("abcdefghij short\nthird");
    expect(joinHardWrappedLines("abcdefghij\nshort\nthird", 10)).toBe("abcdefghij short\nthird");
  });
});
