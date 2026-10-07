import { describe, expect, it } from "vitest";
import {
  appendTail,
  isAwaitingChoice,
  isClaudePane,
  sequenceFor,
  splitModelTargets,
} from "./terminal-model";

describe("ターミナルのモデル一括切替", () => {
  it("Claude Code のペインだけが対象（シェル・他社AIには流さない）", () => {
    const panes = [
      { key: "a", kind: "claude" as const },
      { key: "b", kind: "claude" as const, cliId: "claude" },
      { key: "c", kind: "shell" as const, cliId: "codex" },
      { key: "d", kind: "shell" as const },
      { key: "e", kind: "shell" as const, cliId: "gemini" },
      { key: "f", kind: "claude" as const },
    ];
    const { targets, skipped } = splitModelTargets(panes);
    expect(targets.map((p) => p.key)).toEqual(["a", "b", "f"]);
    expect(skipped).toBe(3);
    expect(isClaudePane({ kind: "shell" })).toBe(false);
  });

  it("文字と Enter を分けて送る（1回で流すと貼り付け扱いで送信されないことがある）", () => {
    expect(sequenceFor("haiku")).toEqual(["/model haiku", "\r"]);
    for (const part of sequenceFor("opus")[0]) expect(part).not.toBe("\r");
  });

  it("許可の確認画面が出ているペインは見分ける（Enter が「はい」を押してしまうため送らない）", () => {
    const prompt =
      "\x1b[1mBash command\x1b[0m\r\n  rm -rf build\r\n Do you want to proceed?\r\n\x1b[36m❯ 1. Yes\x1b[0m\r\n  2. Yes, and don't ask again\r\n  3. No";
    expect(isAwaitingChoice(prompt)).toBe(true);
    expect(isAwaitingChoice("Do you want to make this edit to page.tsx?")).toBe(true);
    // ふつうの入力待ち・作業中の表示は確認画面ではない
    expect(isAwaitingChoice("> \r\n  ? for shortcuts")).toBe(false);
    expect(isAwaitingChoice("✻ Thinking… (12s · esc to interrupt)")).toBe(false);
  });

  it("出力の末尾は決まった長さだけ保つ", () => {
    const t = appendTail("a".repeat(3990), "b".repeat(20), 4000);
    expect(t.length).toBe(4000);
    expect(t.endsWith("b".repeat(20))).toBe(true);
  });

  it("知らない値は送らない（シェルなら任意コマンドになりうる）", () => {
    // @ts-expect-error わざと不正な値
    expect(() => sequenceFor("opus; rm -rf ~")).toThrow();
  });
});
