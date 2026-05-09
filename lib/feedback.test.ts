import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  countUserMessages,
  shouldShowFeedback,
  markFeedbackShown,
  markFeedbackDismissed,
  recordFeedback,
  getFeedbackHistory,
  setOptedOut,
  isOptedOut,
  RATING_OPTIONS,
  type FeedbackPayload,
} from "./feedback";

const STORAGE_KEY = "unicrew_feedback_state_v1";
const HISTORY_KEY = "unicrew_feedback_history_v1";

beforeEach(() => {
  localStorage.clear();
  // fetch を握りつぶす（recordFeedback 内のリモートPOSTがエラーで止まらないように）
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  // window.open（mailto）も握りつぶす
  vi.stubGlobal("open", vi.fn());
});

describe("countUserMessages", () => {
  it("空の threads では 0 を返す", () => {
    expect(countUserMessages([])).toBe(0);
  });

  it("user メッセージのみカウントする", () => {
    const threads = [
      {
        messages: [
          { role: "user" },
          { role: "assistant" },
          { role: "user" },
        ],
      },
      {
        messages: [{ role: "user" }, { role: "assistant" }],
      },
    ];
    expect(countUserMessages(threads)).toBe(3);
  });

  it("複数スレッドでも合算する", () => {
    const threads = [
      { messages: [{ role: "user" }, { role: "user" }] },
      { messages: [{ role: "user" }] },
      { messages: [] },
    ];
    expect(countUserMessages(threads)).toBe(3);
  });
});

describe("shouldShowFeedback", () => {
  it("メッセージ数が閾値未満なら false", () => {
    expect(shouldShowFeedback(0)).toBe(false);
    expect(shouldShowFeedback(4)).toBe(false);
  });

  it("初回 5 メッセージ到達で true", () => {
    expect(shouldShowFeedback(5)).toBe(true);
  });

  it("opt-out していたら false", () => {
    setOptedOut(true);
    expect(shouldShowFeedback(100)).toBe(false);
    setOptedOut(false);
    expect(shouldShowFeedback(100)).toBe(true);
  });

  it("提出直後は 60 日クールダウンで false", () => {
    const payload: FeedbackPayload = {
      rating: "good",
      improvement: "x",
      feature_request: "y",
      app_version: "0.1.0",
      user_message_count: 10,
      submitted_at: new Date().toISOString(),
    };
    recordFeedback(payload);
    expect(shouldShowFeedback(100)).toBe(false);
  });

  it("提出から 61 日経過すれば true", () => {
    const longAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        last_shown_at: longAgo.toISOString(),
        last_submitted_at: longAgo.toISOString(),
        submitted_count: 1,
        opted_out: false,
      }),
    );
    expect(shouldShowFeedback(100)).toBe(true);
  });

  it("dismiss 直後は 14 日クールダウンで false", () => {
    markFeedbackDismissed();
    expect(shouldShowFeedback(100)).toBe(false);
  });

  it("dismiss から 15 日経過すれば true", () => {
    const longAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        last_shown_at: longAgo.toISOString(),
        last_submitted_at: null,
        submitted_count: 0,
        opted_out: false,
      }),
    );
    expect(shouldShowFeedback(100)).toBe(true);
  });
});

describe("recordFeedback", () => {
  it("履歴に追加され、mailto URL が返る", () => {
    const payload: FeedbackPayload = {
      rating: "great",
      improvement: "起動を速くしてほしい",
      feature_request: "Slack 連携",
      email: "test@example.com",
      app_version: "0.1.0",
      user_message_count: 12,
      submitted_at: "2026-05-08T10:00:00.000Z",
    };
    const { mailtoUrl } = recordFeedback(payload);

    expect(mailtoUrl).toMatch(/^mailto:support@uni-core\.jp/);
    expect(decodeURIComponent(mailtoUrl)).toContain("最高");
    expect(decodeURIComponent(mailtoUrl)).toContain("起動を速くしてほしい");
    expect(decodeURIComponent(mailtoUrl)).toContain("Slack 連携");
    expect(decodeURIComponent(mailtoUrl)).toContain("test@example.com");

    const history = getFeedbackHistory();
    expect(history).toHaveLength(1);
    expect(history[0].rating).toBe("great");
  });

  it("履歴は 50 件で頭から切られる", () => {
    for (let i = 0; i < 60; i++) {
      const payload: FeedbackPayload = {
        rating: "good",
        improvement: `imp-${i}`,
        feature_request: `req-${i}`,
        app_version: "0.1.0",
        user_message_count: i,
        submitted_at: new Date(Date.now() + i * 1000).toISOString(),
      };
      // 履歴枠の確認だけしたいので state は手動でリセット
      localStorage.removeItem(STORAGE_KEY);
      recordFeedback(payload);
    }
    const history = getFeedbackHistory();
    expect(history).toHaveLength(50);
    // 最古は 60 件中の 11 番目（i=10）
    expect(history[0].improvement).toBe("imp-10");
    expect(history[49].improvement).toBe("imp-59");
  });

  it("リモートPOSTが失敗しても例外を伝播しない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network")),
    );
    const payload: FeedbackPayload = {
      rating: "neutral",
      improvement: "",
      feature_request: "",
      app_version: "0.1.0",
      user_message_count: 5,
      submitted_at: new Date().toISOString(),
    };
    expect(() => recordFeedback(payload)).not.toThrow();
  });
});

describe("RATING_OPTIONS", () => {
  it("5段階すべての ID が一意", () => {
    const ids = RATING_OPTIONS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("5段階それぞれが絵文字とラベルを持つ", () => {
    for (const opt of RATING_OPTIONS) {
      expect(opt.emoji).toBeTruthy();
      expect(opt.label).toBeTruthy();
    }
  });
});

describe("opt-out", () => {
  it("初期値は false", () => {
    expect(isOptedOut()).toBe(false);
  });
  it("setOptedOut で切替可能", () => {
    setOptedOut(true);
    expect(isOptedOut()).toBe(true);
    setOptedOut(false);
    expect(isOptedOut()).toBe(false);
  });
});

describe("markFeedbackShown / markFeedbackDismissed", () => {
  it("どちらも last_shown_at を更新する", () => {
    const before = new Date().toISOString();
    markFeedbackShown();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    expect(stored.last_shown_at).toBeTruthy();
    expect(stored.last_shown_at >= before).toBe(true);

    localStorage.removeItem(STORAGE_KEY);
    markFeedbackDismissed();
    const stored2 = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    expect(stored2.last_shown_at).toBeTruthy();
  });
});

// HISTORY_KEY を直接参照する確認用
describe("storage isolation", () => {
  it("HISTORY_KEY と STORAGE_KEY は別キー", () => {
    expect(HISTORY_KEY).not.toBe(STORAGE_KEY);
  });
});
