import { describe, expect, it, beforeEach } from "vitest";
import { importTeamFromJson, loadUserTeams, saveUserTeams } from "./teams";

// localStorage の最小モック（vitest の jsdom 環境が無い場合の保険）
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

const validTeam = JSON.stringify({
  schema: "unicrew.team.v1",
  name: "My Team",
  participants: [{ provider: "claude", characterId: "tmpl-claude-normal" }],
});

describe("importTeamFromJson（監査R1: 入力検証）", () => {
  it("正常なチームJSONを取り込める", () => {
    const t = importTeamFromJson(validTeam);
    expect(t.name).toBe("My Team");
    expect(t.participants[0].provider).toBe("claude");
  });

  it("未知 provider は claude にフォールバックする", () => {
    const t = importTeamFromJson(
      JSON.stringify({
        schema: "unicrew.team.v1",
        name: "x",
        participants: [{ provider: "evil-model", characterId: "c" }],
      }),
    );
    expect(t.participants[0].provider).toBe("claude");
  });

  it("participants が上限超過なら拒否する", () => {
    const many = Array.from({ length: 50 }, () => ({ provider: "claude" }));
    expect(() =>
      importTeamFromJson(
        JSON.stringify({ schema: "unicrew.team.v1", name: "x", participants: many }),
      ),
    ).toThrow();
  });

  it("巨大な name は切り詰められる（保存を許すが肥大させない）", () => {
    const t = importTeamFromJson(
      JSON.stringify({
        schema: "unicrew.team.v1",
        name: "a".repeat(10000),
        participants: [{ provider: "claude" }],
      }),
    );
    expect(t.name.length).toBeLessThanOrEqual(120);
  });

  it("スキーマ不一致は拒否する", () => {
    expect(() =>
      importTeamFromJson(JSON.stringify({ schema: "wrong", name: "x", participants: [] })),
    ).toThrow();
  });
});

describe("loadUserTeams（監査R1: 破損データの防御）", () => {
  beforeEach(() => {
    ensureLocalStorage();
    localStorage.clear();
  });

  it("非配列が保存されていても [] を返す（クラッシュしない）", () => {
    localStorage.setItem("unicrew.user_teams.v1", '{"id":"x"}');
    expect(loadUserTeams()).toEqual([]);
  });

  it("participants が配列でないチームは捨てる", () => {
    localStorage.setItem(
      "unicrew.user_teams.v1",
      '[{"id":"bad","name":"bad","participants":null},{"id":"ok","name":"ok","participants":[]}]',
    );
    const teams = loadUserTeams();
    expect(teams.every((t) => Array.isArray(t.participants))).toBe(true);
    expect(teams.length).toBe(1);
  });

  it("壊れたJSONは [] を返す", () => {
    localStorage.setItem("unicrew.user_teams.v1", "{not json");
    expect(loadUserTeams()).toEqual([]);
  });

  it("save→load が往復する", () => {
    const t = importTeamFromJson(validTeam);
    saveUserTeams([t]);
    expect(loadUserTeams().length).toBe(1);
  });
});
