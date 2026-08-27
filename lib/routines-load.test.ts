import { describe, expect, it, beforeEach } from "vitest";
import { loadRoutines } from "./routines";

function ensureLocalStorage() {
  if (typeof globalThis.localStorage !== "undefined") return;
  const store = new Map<string, string>();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

const KEY = "unicrew.routines.v1";

describe("loadRoutines（監査R1: 破損データの防御）", () => {
  beforeEach(() => {
    ensureLocalStorage();
    localStorage.clear();
  });

  it("非配列は [] を返す", () => {
    localStorage.setItem(KEY, '{"id":"x"}');
    expect(loadRoutines()).toEqual([]);
  });

  it("schedule 欠落の要素は捨てる（管理画面・発火判定を落とさない）", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "bad", threadId: "t", prompt: "p", enabled: true }, // schedule 無し
        {
          id: "ok",
          threadId: "t",
          prompt: "p",
          enabled: true,
          schedule: { hour: 9, minute: 0 },
        },
      ]),
    );
    const rs = loadRoutines();
    expect(rs.length).toBe(1);
    expect(rs[0].id).toBe("ok");
  });

  it("hour/minute が数値でない要素は捨てる", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          id: "x",
          threadId: "t",
          prompt: "p",
          enabled: true,
          schedule: { hour: "9", minute: 0 },
        },
      ]),
    );
    expect(loadRoutines()).toEqual([]);
  });

  it("壊れたJSONは [] を返す", () => {
    localStorage.setItem(KEY, "[not json");
    expect(loadRoutines()).toEqual([]);
  });
});

import { initialLastFiredDay, shouldFire } from "./routines";

describe("initialLastFiredDay + shouldFire（監査R3: 即時発火防止）", () => {
  it("当日の過去時刻で作成したら発火済み扱い（即時発火しない）", () => {
    const now = new Date(2026, 0, 1, 18, 0, 0); // 18:00
    const stamp = initialLastFiredDay(9, 0, now); // 09:00 は過去
    expect(stamp).toBeTruthy();
    const routine = {
      id: "x", label: "l", threadId: "t", prompt: "p", enabled: true,
      createdAt: 0,
      schedule: { type: "daily" as const, hour: 9, minute: 0, lastFiredDay: stamp },
    };
    expect(shouldFire(routine as never, now)).toBe(false);
  });

  it("未来時刻で作成したら undefined（当日中に発火する）", () => {
    const now = new Date(2026, 0, 1, 8, 0, 0); // 08:00
    expect(initialLastFiredDay(9, 0, now)).toBeUndefined();
  });
});
