import { describe, expect, it } from "vitest";
import { nextTerminalActivity, paneNumberOf, parseToolLine, ToolLineWatcher, type TerminalActivity } from "./terminal-link";

describe("ターミナルとオフィスの連動", () => {
  it("ペインの名前から番号を取る（番号が無い名前は対象にしない）", () => {
    expect(paneNumberOf("2. Claude Code")).toBe(2);
    expect(paneNumberOf("12. Codex")).toBe(12);
    expect(paneNumberOf("Claude Code")).toBeNull();
    expect(paneNumberOf(undefined)).toBeNull();
  });

  it("画面の文字から、いちばん新しい道具の行を読む（色の制御文字が混ざっていても読む）", () => {
    expect(parseToolLine("\u001b[32m●\u001b[0m Read(src/app.ts)\r\n  ⎿ 120 lines")).toEqual({ tool: "Read", detail: "src/app.ts" });
    expect(parseToolLine("● Read(a.ts)\n● Bash(npm test)")).toEqual({ tool: "Bash", detail: "npm test" });
    expect(parseToolLine("⏺ Write(docs/plan.md)")).toEqual({ tool: "Write", detail: "docs/plan.md" });
  });

  it("道具の行でない文は拾わない（普通の文・箇条書き・関数の説明）", () => {
    expect(parseToolLine("まず app.ts を読みます。")).toBeNull();
    expect(parseToolLine("- 手順(1) を進める")).toBeNull();
    expect(parseToolLine("")).toBeNull();
  });

  it("同じ行の描き直しでは、もう一度知らせない。別の道具になったら知らせる", () => {
    const w = new ToolLineWatcher();
    expect(w.feed(1, "● Read(a.ts)", 1000)).toEqual({ tool: "Read", detail: "a.ts" });
    expect(w.feed(1, "● Read(a.ts)", 3000)).toBeNull();
    expect(w.feed(1, "● Edit(a.ts)", 5000)).toEqual({ tool: "Edit", detail: "a.ts" });
    // 別のペインは別に数える
    expect(w.feed(2, "● Read(a.ts)", 5000)).toEqual({ tool: "Read", detail: "a.ts" });
    // 終わったら忘れる（次の作業で同じ道具から始まっても知らせる）
    w.forget(1);
    expect(w.feed(1, "● Edit(a.ts)", 9000)).toEqual({ tool: "Edit", detail: "a.ts" });
  });

  it("始まり → 道具 → 次の道具（前の道具は使い終えた扱い）→ 許可待ち → 終わり", () => {
    let a: TerminalActivity | undefined;
    a = nextTerminalActivity(a, { pane: 3, kind: "start", instruction: "README を直して", at: 1 });
    expect(a).toMatchObject({ pane: 3, status: "working", instruction: "README を直して", tool: null });
    a = nextTerminalActivity(a, { pane: 3, kind: "activity", tool: "Read", detail: "README.md", at: 2 });
    expect(a.tool?.name).toBe("Read");
    expect(a.finished).toBeNull();
    const readId = a.tool!.id;
    a = nextTerminalActivity(a, { pane: 3, kind: "activity", tool: "Edit", detail: "README.md", at: 3 });
    expect(a.tool?.name).toBe("Edit");
    expect(a.finished).toEqual({ id: readId, name: "Read" });
    a = nextTerminalActivity(a, { pane: 3, kind: "waiting", at: 4 });
    expect(a.status).toBe("waiting");
    expect(a.instruction).toBe("README を直して");
    a = nextTerminalActivity(a, { pane: 3, kind: "stop", at: 5 });
    expect(a).toMatchObject({ status: "done", tool: null });
    expect(a.finished?.name).toBe("Edit");
  });

  it("始まりの知らせを取りこぼしても、道具や終わりの知らせだけで動く", () => {
    const a = nextTerminalActivity(undefined, { pane: 1, kind: "activity", tool: "Bash", detail: "npm test", at: 1 });
    expect(a).toMatchObject({ pane: 1, status: "working" });
    expect(nextTerminalActivity(undefined, { pane: 2, kind: "stop", at: 1 }).status).toBe("done");
  });
});
