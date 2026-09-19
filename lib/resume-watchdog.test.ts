import { describe, expect, it } from "vitest";
import { RESUME_STUCK_MS, shouldRecoverStuckResume, type ResumeWatchInput } from "./resume-watchdog";

const T0 = 1_000_000;
const base = (over: Partial<ResumeWatchInput>): ResumeWatchInput => ({
  now: T0,
  startedAt: T0,
  firstEventAt: null,
  blockCount: 0,
  hasCliSessionId: true,
  alreadyRecovered: false,
  ...over,
});

/** 旧判定（2026-09-20 まで）。毒味用に残す：新判定が旧判定と違う答えを出す場面を確かめる。 */
const legacyShouldRecover = (i: ResumeWatchInput) =>
  !i.alreadyRecovered && i.hasCliSessionId && i.blockCount === 0 && i.now - i.startedAt >= 30_000;

describe("shouldRecoverStuckResume", () => {
  it("本当に黙り込んだ再開（何も届かない）は、時間が来たら回復する", () => {
    expect(shouldRecoverStuckResume(base({ now: T0 + RESUME_STUCK_MS }))).toBe(true);
  });

  it("時間が来るまでは回復しない", () => {
    expect(shouldRecoverStuckResume(base({ now: T0 + RESUME_STUCK_MS - 1 }))).toBe(false);
  });

  it("考え中のセッションを殺さない：合図は届いているが本文がまだ無い", () => {
    const thinking = base({ now: T0 + 5 * 60_000, firstEventAt: T0 + 600 });
    expect(shouldRecoverStuckResume(thinking)).toBe(false);
  });

  it("毒味：同じ場面で旧判定は殺していた（この差がこの修正の中身）", () => {
    const thinking = base({ now: T0 + 45_000, firstEventAt: T0 + 600 });
    expect(legacyShouldRecover(thinking)).toBe(true);
    expect(shouldRecoverStuckResume(thinking)).toBe(false);
  });

  it("本文かツール実行が出ていれば回復しない", () => {
    expect(shouldRecoverStuckResume(base({ now: T0 + 10 * 60_000, blockCount: 1 }))).toBe(false);
  });

  it("再開用のセッション ID が無い無音は対象外（新規起動を強行しない）", () => {
    expect(shouldRecoverStuckResume(base({ now: T0 + 10 * 60_000, hasCliSessionId: false }))).toBe(false);
  });

  it("回復は 1 セッションにつき 1 回だけ", () => {
    expect(shouldRecoverStuckResume(base({ now: T0 + 10 * 60_000, alreadyRecovered: true }))).toBe(false);
  });
});
