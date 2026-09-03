import { describe, expect, it } from "vitest";
import type { Message, ParticipantSlot, Thread } from "./types";
import { excerpt, hasCheckpoint, restoreTargets, turnNumberOf, withCheckpoint } from "./checkpoint";

function msg(id: string, role: Message["role"], over: Partial<Message> = {}): Message {
  return { id, role, content: `msg ${id}`, createdAt: 0, ...over };
}

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

describe("withCheckpoint / hasCheckpoint", () => {
  it("指定したユーザー発言にだけ記録を書き込む", () => {
    const t = thread({ messages: [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user")] });
    const next = withCheckpoint(t, "u2", { "D:/repo": "abc" });
    expect(next.messages[0].checkpoint).toBeUndefined();
    expect(next.messages[2].checkpoint).toEqual({ "D:/repo": "abc" });
    expect(hasCheckpoint(next.messages[2])).toBe(true);
    expect(hasCheckpoint(next.messages[0])).toBe(false);
  });

  it("空の記録では Thread を変えない（同一参照）", () => {
    const t = thread({ messages: [msg("u1", "user")] });
    expect(withCheckpoint(t, "u1", {})).toBe(t);
    expect(withCheckpoint(t, "u1", { "D:/repo": "" })).toBe(t);
  });

  it("既存の記録に cwd を足す（上書きは同じ cwd だけ）", () => {
    const t = thread({ messages: [msg("u1", "user", { checkpoint: { "D:/repo": "old" } })] });
    const next = withCheckpoint(t, "u1", { "D:/repo": "new", "C:/wt": "x" });
    expect(next.messages[0].checkpoint).toEqual({ "D:/repo": "new", "C:/wt": "x" });
  });

  it("assistant の発言は記録があっても戻す対象にしない", () => {
    expect(hasCheckpoint(msg("a1", "assistant", { checkpoint: { "D:/repo": "abc" } }))).toBe(false);
  });
});

describe("restoreTargets", () => {
  it("作業フォルダと隔離中スロットのうち、記録がある cwd だけを返す", () => {
    const m = msg("u1", "user", { checkpoint: { "D:/repo": "aaa", "C:/AppData/worktrees/x/t1/p1": "bbb" } });
    const t = thread({ participants: [p1, p2], messages: [m] });
    const targets = restoreTargets(t, m);
    expect(targets.map((x) => [x.key, x.oid])).toEqual([
      ["workspace", "aaa"],
      ["p1", "bbb"],
    ]);
  });

  it("記録した後に消えた worktree は対象から外れる", () => {
    const m = msg("u1", "user", { checkpoint: { "D:/repo": "aaa", "C:/gone": "ccc" } });
    const t = thread({ participants: [p2], messages: [m] });
    expect(restoreTargets(t, m).map((x) => x.key)).toEqual(["workspace"]);
  });

  it("workspace が無ければ空", () => {
    const m = msg("u1", "user", { checkpoint: { "D:/repo": "aaa" } });
    expect(restoreTargets(thread({ workspace: null, messages: [m] }), m)).toEqual([]);
  });
});

describe("turnNumberOf / excerpt", () => {
  it("ユーザー発言だけを数えて 1 始まりで返す", () => {
    const t = thread({
      messages: [msg("u1", "user"), msg("a1", "assistant"), msg("a2", "assistant"), msg("u2", "user")],
    });
    expect(turnNumberOf(t, "u1")).toBe(1);
    expect(turnNumberOf(t, "u2")).toBe(2);
    expect(turnNumberOf(t, "a1")).toBe(0);
    expect(turnNumberOf(t, "nope")).toBe(0);
  });

  it("改行を潰して冒頭だけ返す", () => {
    expect(excerpt("  一行目\n二行目  ")).toBe("一行目 二行目");
    expect(excerpt("a".repeat(70), 60)).toBe(`${"a".repeat(60)}…`);
  });
});
