import { describe, expect, it } from "vitest";
import {
  availableTerminalClis,
  TERMINAL_CLIS,
  terminalCliById,
} from "./terminal-clis";

describe("terminal-clis", () => {
  it("id は一意", () => {
    const ids = TERMINAL_CLIS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("claude が先頭（既定の分割動作の互換）", () => {
    expect(TERMINAL_CLIS[0].id).toBe("claude");
    expect(TERMINAL_CLIS[0].program).toBe("claude");
  });

  it("Windows では cursor-agent が除外される（Windowsバイナリ無しの実測に基づく）", () => {
    const win = availableTerminalClis(true);
    expect(win.some((c) => c.id === "cursor")).toBe(false);
    const unix = availableTerminalClis(false);
    expect(unix.some((c) => c.id === "cursor")).toBe(true);
  });

  it("goose は session サブコマンドで起動する", () => {
    expect(terminalCliById("goose")?.args).toEqual(["session"]);
  });

  it("未知の id は undefined", () => {
    expect(terminalCliById("nope")).toBeUndefined();
  });
});
