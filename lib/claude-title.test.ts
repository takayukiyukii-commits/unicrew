import { describe, expect, it } from "vitest";
import {
  CLAUDE_IDLE_GRACE_MS,
  ClaudeTitleTracker,
  classifyClaudeTitle,
  summarizeInstruction,
  looksLikeWaiting,
} from "./claude-title";

describe("classifyClaudeTitle（実測したタイトル）", () => {
  it("◐ ◑ は作業中、✳ は止まった", () => {
    expect(classifyClaudeTitle("◐ nano-banana:gemini-image-gen")).toBe("working");
    expect(classifyClaudeTitle("◑ nano-banana:gemini-image-gen")).toBe("working");
    expect(classifyClaudeTitle("✳ nano-banana:gemini-image-gen")).toBe("idle");
    expect(classifyClaudeTitle("claude")).toBe("other");
    expect(classifyClaudeTitle("")).toBe("other");
  });
});

/** 実測した並び（秒）をそのまま流す */
function replay(t: ClaudeTitleTracker, seq: [number, string][]) {
  for (const [sec, title] of seq) t.feed(title, sec * 1000);
}

describe("ClaudeTitleTracker", () => {
  it("作業中→✳ で、猶予のあと1回だけ作業時間を返す", () => {
    const t = new ClaudeTitleTracker();
    replay(t, [
      [3.2, "claude"],
      [4.28, "✳ x"], // 起動直後の ✳ は作業の終わりではない
      [4.61, "◐ x"],
      [5.6, "◑ x"],
      [9.44, "◑ x"],
      [10.21, "✳ x"],
    ]);
    expect(t.settle(10_210 + CLAUDE_IDLE_GRACE_MS - 1)).toBeNull();
    expect(t.settle(10_210 + CLAUDE_IDLE_GRACE_MS)).toBe(10_210 - 4_610);
    expect(t.settle(20_000)).toBeNull(); // 2回目は鳴らない
  });

  it("起動直後の ✳ だけでは鳴らない", () => {
    const t = new ClaudeTitleTracker();
    replay(t, [[3.2, "claude"], [4.28, "✳ x"]]);
    expect(t.settle(60_000)).toBeNull();
    expect(t.seen).toBe(false);
  });

  it("一瞬 ✳ になってすぐ作業に戻ったら、続きとして数える（途中で鳴らない）", () => {
    const t = new ClaudeTitleTracker();
    replay(t, [[1, "◐ x"], [5, "✳ x"], [5.3, "◑ x"]]);
    expect(t.settle(7_000)).toBeNull();
    replay(t, [[9, "✳ x"]]);
    expect(t.settle(9_000 + CLAUDE_IDLE_GRACE_MS)).toBe(8_000);
  });

  it("短すぎる作業は知らせない", () => {
    const t = new ClaudeTitleTracker();
    replay(t, [[1, "◐ x"], [2, "✳ x"]]);
    expect(t.settle(5_000)).toBeNull();
  });
});

describe("summarizeInstruction", () => {
  it("1行に詰めて長ければ切る", () => {
    expect(summarizeInstruction("  ログイン画面を\n直して ")).toBe("ログイン画面を 直して");
    expect(summarizeInstruction("あ".repeat(70), 60)).toBe("あ".repeat(60) + "…");
    expect(summarizeInstruction(null)).toBeNull();
    expect(summarizeInstruction("   ")).toBeNull();
  });
});

describe("looksLikeWaiting（止まった後の出力の回数）", () => {
  it("点滅が続けば確認待ち、静かなら終わり", () => {
    // 実測: 確認待ちは 0.6 秒ごと → 1.3 秒で 2 回以上／普通の終わりは 0 回
    expect(looksLikeWaiting(2)).toBe(true);
    expect(looksLikeWaiting(0)).toBe(false);
    expect(looksLikeWaiting(1)).toBe(false);
  });
});
