import { describe, expect, it } from "vitest";
import type { ParticipantSlot, Thread } from "./types";
import { isolatedSlots, shouldIsolate, slotWorkspace, withSlotWorktree } from "./worktree";

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

const p1: ParticipantSlot = { id: "p1", provider: "claude", characterId: "tmpl-claude-normal" };
const p2: ParticipantSlot = { id: "p2", provider: "codex", characterId: "tmpl-codex-normal" };
const judge: ParticipantSlot = { id: "m", provider: "claude", characterId: "tmpl-claude-normal", role: "moderator" };

describe("shouldIsolate", () => {
  it("並列（2人以上）・workspace あり・自動編集なら隔離する", () => {
    expect(shouldIsolate(thread({ participants: [p1, p2], splitMode: true }), p1)).toBe(true);
  });
  it("単独スレッドは何も変えない", () => {
    expect(shouldIsolate(thread(), { id: "single", provider: "claude", characterId: "x" })).toBe(false);
  });
  it("plan モード（読み取り専用）は隔離しない", () => {
    expect(
      shouldIsolate(thread({ participants: [p1, p2], splitMode: true, permissionMode: "plan" }), p1),
    ).toBe(false);
  });
  it("熟考モード等は acceptEdits 扱いなので隔離する", () => {
    expect(
      shouldIsolate(thread({ participants: [p1, p2], splitMode: true, permissionMode: "deepThink" }), p1),
    ).toBe(true);
  });
  it("審判（moderator）は隔離しない", () => {
    expect(shouldIsolate(thread({ participants: [p1, p2], moderator: judge, splitMode: true }), judge)).toBe(false);
  });
  it("workspace 未選択なら隔離しない", () => {
    expect(shouldIsolate(thread({ participants: [p1, p2], splitMode: true, workspace: null }), p1)).toBe(false);
  });
});

describe("withSlotWorktree / slotWorkspace / isolatedSlots", () => {
  it("該当スロットだけに worktree 情報が入り、cwd が差し替わる", () => {
    const t = withSlotWorktree(thread({ participants: [p1, p2], splitMode: true }), "p2", {
      path: "C:/AppData/worktrees/abc/t1/p2",
      branch: "unicrew/t1/p2",
    });
    const s1 = t.participants!.find((p) => p.id === "p1")!;
    const s2 = t.participants!.find((p) => p.id === "p2")!;
    expect(s1.worktreePath).toBeUndefined();
    expect(s2.worktreePath).toBe("C:/AppData/worktrees/abc/t1/p2");
    expect(s2.worktreeBranch).toBe("unicrew/t1/p2");
    expect(slotWorkspace(t, s1)).toBe("D:/repo");
    expect(slotWorkspace(t, s2)).toBe("C:/AppData/worktrees/abc/t1/p2");
    expect(isolatedSlots(t).map((p) => p.id)).toEqual(["p2"]);
  });
  it("旧2way（splitMode + participants 未設定）でも participants 化して書き込める", () => {
    const t = withSlotWorktree(thread({ splitMode: true }), "codex", { path: "W", branch: "unicrew/t1/codex" });
    expect(t.participants?.map((p) => p.id)).toEqual(["claude", "codex"]);
    expect(t.participants?.[1].worktreePath).toBe("W");
  });
  it("null で解除できる", () => {
    const t0 = withSlotWorktree(thread({ participants: [p1, p2], splitMode: true }), "p1", { path: "W", branch: "b" });
    const t1 = withSlotWorktree(t0, "p1", null);
    expect(t1.participants![0].worktreePath).toBeUndefined();
    expect(isolatedSlots(t1)).toHaveLength(0);
  });
});
