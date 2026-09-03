import { describe, expect, it } from "vitest";
import type { ParticipantSlot, Thread } from "./types";
import { changeTargets, snapshotCwds, statusGlyph, turnBaseFor, withTurnBase } from "./changes";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    title: "",
    characterId: "tmpl-claude-normal",
    model: "claude-sonnet-4-5" as Thread["model"],
    workspace: "D:/repo",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    splitMode: false,
    conferenceMode: false,
    conferenceMaxRounds: 3,
    ...over,
  };
}

const p1: ParticipantSlot = {
  id: "p1",
  provider: "claude",
  characterId: "tmpl-claude-normal",
  worktreePath: "C:/AppData/worktrees/x/t1/p1",
  worktreeBranch: "unicrew/t1/p1",
};
const p2: ParticipantSlot = { id: "p2", provider: "codex", characterId: "tmpl-codex-normal" };

describe("changeTargets", () => {
  it("workspace が無ければ空", () => {
    expect(changeTargets(thread({ workspace: null }))).toEqual([]);
  });
  it("単独スレッドは作業フォルダ1件だけ", () => {
    const t = changeTargets(thread());
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ key: "workspace", cwd: "D:/repo" });
  });
  it("隔離中スロットは作業フォルダの後ろに並ぶ（隔離していないスロットは出ない）", () => {
    const t = changeTargets(thread({ participants: [p1, p2], splitMode: true }));
    expect(t.map((x) => x.key)).toEqual(["workspace", "p1"]);
    expect(t[1].cwd).toBe(p1.worktreePath);
    expect(t[1].slot?.id).toBe("p1");
  });
});

describe("snapshotCwds / turnBase", () => {
  it("記録すべき cwd は重複なし", () => {
    const dup: ParticipantSlot = { ...p2, worktreePath: p1.worktreePath, worktreeBranch: "unicrew/t1/p2" };
    expect(snapshotCwds(thread({ participants: [p1, dup], splitMode: true }))).toEqual([
      "D:/repo",
      p1.worktreePath,
    ]);
  });
  it("withTurnBase は cwd ごとに上書き・空値は無視・空なら同じ Thread を返す", () => {
    const t0 = thread();
    expect(withTurnBase(t0, {})).toBe(t0);
    const t1 = withTurnBase(t0, { "D:/repo": "aaa", "C:/wt": "" });
    expect(t1.turnBase).toEqual({ "D:/repo": "aaa" });
    const t2 = withTurnBase(t1, { "D:/repo": "bbb", "C:/wt": "ccc" });
    expect(t2.turnBase).toEqual({ "D:/repo": "bbb", "C:/wt": "ccc" });
    expect(turnBaseFor(t2, "D:/repo")).toBe("bbb");
    expect(turnBaseFor(t2, "D:/other")).toBeUndefined();
  });
});

describe("statusGlyph", () => {
  it("A/D/R とそれ以外", () => {
    expect(statusGlyph("A")).toBe("+");
    expect(statusGlyph("D")).toBe("−");
    expect(statusGlyph("R")).toBe("→");
    expect(statusGlyph("M")).toBe("±");
  });
});
