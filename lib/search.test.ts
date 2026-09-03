import { describe, expect, it } from "vitest";
import type { Message, Thread } from "./types";
import { matchingMessageIds, searchConversations } from "./search";

function msg(id: string, role: Message["role"], content: string): Message {
  return { id, role, content, createdAt: 0 };
}
function thread(id: string, title: string, messages: Message[], updatedAt = 0): Thread {
  return {
    id,
    title,
    characterId: "tmpl-claude-normal",
    model: "claude-sonnet-4-5" as Thread["model"],
    workspace: null,
    messages,
    createdAt: 0,
    updatedAt,
    splitMode: false,
    conferenceMode: false,
    conferenceMaxRounds: 3,
  };
}

describe("searchConversations", () => {
  const threads = [
    thread("old", "古い会話", [msg("o1", "user", "Stripe の webhook を直したい")], 1),
    thread("new", "Webhook 設計", [msg("n1", "assistant", "前置き。".repeat(20) + "webhook の署名検証を入れる。" + "後置き。".repeat(20))], 9),
  ];
  it("小文字化した部分一致で、新しいスレッドから返す。題名ヒットは messageId null", () => {
    const hits = searchConversations(threads, "WEBHOOK");
    expect(hits.map((h) => [h.threadId, h.messageId])).toEqual([
      ["new", null],
      ["new", "n1"],
      ["old", "o1"],
    ]);
    expect(hits[0].role).toBe("title");
  });
  it("snippet は前後30字＋省略記号で、hitStart が語の位置を指す", () => {
    const hit = searchConversations(threads, "署名検証")[0];
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.endsWith("…")).toBe(true);
    expect(hit.snippet.slice(hit.hitStart, hit.hitStart + hit.hitLength)).toBe("署名検証");
    expect(hit.snippet.length).toBeLessThanOrEqual(4 + 30 + 4 + 30 + 2);
  });
  it("limit で打ち切る。空の query は空", () => {
    expect(searchConversations(threads, "webhook", 2)).toHaveLength(2);
    expect(searchConversations(threads, "   ")).toEqual([]);
  });
  it("改行は空白に潰す", () => {
    const t = thread("x", "x", [msg("m", "user", "一行目\n二行目にキーワード\n三行目")]);
    expect(searchConversations([t], "キーワード")[0].snippet).toBe("一行目 二行目にキーワード 三行目");
  });
});

describe("matchingMessageIds", () => {
  it("本文に含むメッセージを順番どおりに返す", () => {
    const ms = [msg("a", "user", "Foo"), msg("b", "assistant", "bar"), msg("c", "user", "foo bar")];
    expect(matchingMessageIds(ms, "foo")).toEqual(["a", "c"]);
    expect(matchingMessageIds(ms, "")).toEqual([]);
  });
});
