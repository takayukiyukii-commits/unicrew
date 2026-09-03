import { describe, it, expect } from "vitest";
import {
  parseShellEvents,
  splitPendingOsc,
  fileUrlToPath,
  integrationSnippet,
} from "./terminal-shell-integration";

const ESC = "\x1b";
const BEL = "\x07";
const osc = (body: string, st: string = BEL) => `${ESC}]${body}${st}`;

describe("fileUrlToPath", () => {
  it("Windows パスを取り出す（先頭の / を落とす）", () => {
    expect(fileUrlToPath("file://host/D:/work/repo")).toBe("D:/work/repo");
    expect(fileUrlToPath("file:///D:/work")).toBe("D:/work");
  });

  it("Unix パスはそのまま", () => {
    expect(fileUrlToPath("file://host/home/me/src")).toBe("/home/me/src");
  });

  it("% エスケープを戻す", () => {
    expect(fileUrlToPath("file:///home/me/my%20dir")).toBe("/home/me/my dir");
  });

  it("file:// でなければ null", () => {
    expect(fileUrlToPath("https://example.com/x")).toBeNull();
    expect(fileUrlToPath("")).toBeNull();
  });
});

describe("parseShellEvents", () => {
  it("OSC 133 の A/B/C/D を拾う", () => {
    const text =
      osc("133;A") + "prompt$ " + osc("133;B") + osc("133;C") + "out" + osc("133;D;0");
    expect(parseShellEvents(text)).toEqual([
      { kind: "prompt-start" },
      { kind: "command-input" },
      { kind: "command-start" },
      { kind: "command-end", exitCode: 0 },
    ]);
  });

  it("終了コードは数値で取れる（失敗もそのまま）", () => {
    expect(parseShellEvents(osc("133;D;1"))).toEqual([
      { kind: "command-end", exitCode: 1 },
    ]);
    expect(parseShellEvents(osc("133;D;127"))).toEqual([
      { kind: "command-end", exitCode: 127 },
    ]);
  });

  it("終了コードが無い/壊れているときは null（0 で埋めない）", () => {
    expect(parseShellEvents(osc("133;D"))).toEqual([
      { kind: "command-end", exitCode: null },
    ]);
    expect(parseShellEvents(osc("133;D;abc"))).toEqual([
      { kind: "command-end", exitCode: null },
    ]);
  });

  it("ST（ESC 終端）でも読める", () => {
    expect(parseShellEvents(osc("133;A", `${ESC}\\`))).toEqual([
      { kind: "prompt-start" },
    ]);
  });

  it("OSC 7 で作業ディレクトリを拾う", () => {
    expect(parseShellEvents(osc("7;file://pc/D:/work"))).toEqual([
      { kind: "cwd", cwd: "D:/work" },
    ]);
  });

  it("OSC 633 のコマンド行と Cwd を拾う", () => {
    expect(parseShellEvents(osc("633;E;npm run build"))).toEqual([
      { kind: "command-line", command: "npm run build" },
    ]);
    expect(parseShellEvents(osc("633;P;Cwd=D:/work"))).toEqual([
      { kind: "cwd", cwd: "D:/work" },
    ]);
  });

  it("633 のエスケープ（\\x3b 等）を戻す", () => {
    expect(parseShellEvents(osc("633;E;echo a\\x3b b"))[0]).toEqual({
      kind: "command-line",
      command: "echo a; b",
    });
  });

  it("普通の出力からは何も拾わない（誤検知しない）", () => {
    expect(parseShellEvents("ただのログ行です 133;D;0")).toEqual([]);
    expect(parseShellEvents("")).toEqual([]);
  });

  it("色指定などの他の OSC は無視する", () => {
    expect(parseShellEvents(osc("0;window title"))).toEqual([]);
    expect(parseShellEvents(osc("10;#ffffff"))).toEqual([]);
  });
});

describe("splitPendingOsc", () => {
  it("終端まで来ているものはそのまま処理する", () => {
    const t = osc("133;A") + "abc";
    expect(splitPendingOsc(t)).toEqual([t, ""]);
  });

  it("🚨 途中で切れた OSC は次のチャンクへ持ち越す（取りこぼし防止）", () => {
    const [now, pending] = splitPendingOsc(`out${ESC}]133;D;`);
    expect(now).toBe("out");
    expect(pending).toBe(`${ESC}]133;D;`);
    // 持ち越した続きと繋ぐと読める
    expect(parseShellEvents(pending + BEL)).toEqual([
      { kind: "command-end", exitCode: null },
    ]);
  });

  it("長すぎる持ち越しは捨てる（壊れた出力で溜め込まない）", () => {
    const [now, pending] = splitPendingOsc(`${ESC}]` + "x".repeat(5000));
    expect(pending).toBe("");
    expect(now.length).toBeGreaterThan(4000);
  });

  it("OSC が無ければ丸ごと処理する", () => {
    expect(splitPendingOsc("plain")).toEqual(["plain", ""]);
  });
});

describe("integrationSnippet", () => {
  it("bash / zsh / powershell それぞれの案内を出す", () => {
    expect(integrationSnippet("bash")).toContain("PROMPT_COMMAND");
    expect(integrationSnippet("bash")).toContain("DEBUG");
    expect(integrationSnippet("zsh")).toContain("precmd_functions");
    expect(integrationSnippet("powershell")).toContain("function Global:prompt");
  });

  it("どれも 133;D（終了コード）と 7（cwd）を含む", () => {
    for (const sh of ["bash", "zsh", "powershell"] as const) {
      expect(integrationSnippet(sh)).toContain("133;D");
      expect(integrationSnippet(sh)).toContain("7;file://");
    }
  });
});
