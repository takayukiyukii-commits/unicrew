import { describe, expect, it } from "vitest";
import { cliModelFor, MODEL_LABELS, normalizeModelId } from "./types";
import { TEMPLATE_CHARACTERS } from "./characters";

// 2026-10-07 実測：チャットが版数つきの古いモデル（claude-opus-4-7 等）で起動していたため、
// 単価が高く・思考も深い（xhigh/high）状態で、ターミナルより多く使っていた。
describe("チャットのモデル指定", () => {
  it("旧版の保存値は別名へ直る", () => {
    expect(normalizeModelId("claude-opus-4-7")).toBe("opus");
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("sonnet");
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(normalizeModelId("opus")).toBe("opus");
    expect(normalizeModelId(undefined)).toBe("sonnet");
    expect(normalizeModelId("なにか壊れた値")).toBe("sonnet");
  });

  it("CLI へ版数つきの名前を渡さない（選択肢・テンプレートとも別名だけ）", () => {
    for (const m of Object.keys(MODEL_LABELS)) {
      expect(m).not.toMatch(/\d/);
    }
    for (const c of TEMPLATE_CHARACTERS) {
      expect(c.defaultModel).not.toMatch(/\d/);
    }
  });

  it("Claude にだけモデル名を渡し、他社 CLI には渡さない", () => {
    expect(cliModelFor("claude", "claude-opus-4-7")).toBe("opus");
    expect(cliModelFor("codex", "opus")).toBe("");
    expect(cliModelFor("gemini", "claude-sonnet-4-6")).toBe("");
  });
});
