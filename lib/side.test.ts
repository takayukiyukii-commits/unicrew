import { describe, expect, it } from "vitest";
import type { Message, Thread } from "./types";
import {
  archivedCount,
  createSideThread,
  isSideThread,
  orderThreadsForSidebar,
  parseSideCommand,
  prependConclusions,
  sideConclusion,
  withPendingConclusion,
} from "./side";

function msg(id: string, role: Message["role"], content = `msg ${id}`, over: Partial<Message> = {}): Message {
  return { id, role, content, createdAt: 0, ...over };
}
function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    title: "本線",
    characterId: "tmpl-claude-normal",
    model: "claude-sonnet-4-5" as Thread["model"],
    workspace: "D:/repo",
    messages: [],
    createdAt: 0,
    updatedAt: 10,
    splitMode: false,
    conferenceMode: false,
    conferenceMaxRounds: 3,
    ...over,
  };
}

describe("parseSideCommand / createSideThread", () => {
  it("/side と質問を取り出す。質問無しでも可。/sidebar は弾く", () => {
    expect(parseSideCommand("/side この関数の計算量は？")).toEqual({ question: "この関数の計算量は？" });
    expect(parseSideCommand("/side")).toEqual({ question: "" });
    expect(parseSideCommand("/sidebar x")).toBeNull();
    expect(parseSideCommand("普通の発言")).toBeNull();
  });
  it("親のキャラ・作業フォルダ・モデルを引き継ぎ、plan 固定・parentId 付きで作る", () => {
    const p = thread({ participants: [{ id: "p1", provider: "codex", characterId: "tmpl-codex-normal" }] });
    const s = createSideThread(p, "計算量は？");
    expect(isSideThread(s)).toBe(true);
    expect(s.parentId).toBe("t1");
    expect(s.permissionMode).toBe("plan");
    expect(s.characterId).toBe("tmpl-codex-normal");
    expect(s.workspace).toBe("D:/repo");
    expect(s.model).toBe(p.model);
    expect(s.title).toBe("↳ 計算量は？");
    expect(s.id).not.toBe(p.id);
  });
  it("質問が無ければ親の題名、長ければ切り詰める", () => {
    expect(createSideThread(thread(), "").title).toBe("↳ 本線");
    expect(createSideThread(thread(), "あ".repeat(30)).title).toBe(`↳ ${"あ".repeat(24)}…`);
  });
});

describe("sideConclusion / withPendingConclusion / prependConclusions", () => {
  it("結論＝最後の AI 発言（監査・空は飛ばす）", () => {
    const s = thread({
      messages: [
        msg("u", "user"),
        msg("a1", "assistant", "結論A"),
        msg("a2", "assistant", "   "),
        msg("a3", "assistant", "監査", { audit: { auditor: "codex", characterId: "x", implementer: null, layer: 1, depth: "quick", sameCompany: false, targetCwd: "" } }),
      ],
    });
    expect(sideConclusion(s)).toBe("結論A");
    expect(sideConclusion(thread())).toBeNull();
  });
  it("親の次の送信に前置きし、前置きしたら消える", () => {
    const p = withPendingConclusion(withPendingConclusion(thread(), "結論1"), "結論2");
    expect(p.pendingSideConclusions).toEqual(["結論1", "結論2"]);
    const r = prependConclusions(p, "本題です");
    expect(r.thread.pendingSideConclusions).toBeUndefined();
    expect(r.text).toContain("## サイドチャットの結論");
    expect(r.text).toContain("結論1\n\n---\n\n結論2");
    expect(r.text.endsWith("[ユーザーからのメッセージ]\n本題です")).toBe(true);
    const none = prependConclusions(thread(), "x");
    expect(none.text).toBe("x");
  });
});

describe("orderThreadsForSidebar / archivedCount", () => {
  const p1 = thread({ id: "p1", updatedAt: 100 });
  const p2 = thread({ id: "p2", updatedAt: 50 });
  const s1 = thread({ id: "s1", kind: "side", parentId: "p1", updatedAt: 200 });
  const s2 = thread({ id: "s2", kind: "side", parentId: "p1", updatedAt: 150, archived: true });
  const orphan = thread({ id: "s3", kind: "side", parentId: "gone", updatedAt: 300 });
  it("本線は更新順、サイドは親の直下に depth 1。親が無いサイドは本線扱い", () => {
    const out = orderThreadsForSidebar([p1, p2, s1, s2, orphan]);
    expect(out.map((e) => [e.thread.id, e.depth])).toEqual([
      ["s3", 0],
      ["p1", 0],
      ["s1", 1],
      ["p2", 0],
    ]);
  });
  it("showArchived でアーカイブ済みも出す", () => {
    const out = orderThreadsForSidebar([p1, s1, s2], true);
    expect(out.map((e) => e.thread.id)).toEqual(["p1", "s1", "s2"]);
    expect(archivedCount([p1, s1, s2])).toBe(1);
  });
});
