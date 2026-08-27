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
