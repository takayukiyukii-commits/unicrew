import { describe, expect, it } from "vitest";
import type { Message, Thread } from "./types";
import {
  buildAuditBrief,
  buildForwardPrompt,
  implementerOf,
  isAuditSid,
  isAuditSlotId,
  nextAuditLayer,
  parseAuditCommand,
  pickAuditor,
  type AuditMeta,
} from "./audit";

function msg(id: string, role: Message["role"], over: Partial<Message> = {}): Message {
  return { id, role, content: `msg ${id}`, createdAt: 0, ...over };
}
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
const meta = (layer: 1 | 2 | 3): AuditMeta => ({
  auditor: "codex",
  characterId: "tmpl-codex-normal",
  implementer: "claude",
  layer,
  depth: "quick",
  sameCompany: false,
  targetCwd: "D:/repo",
});

describe("pickAuditor", () => {
  it("実装した会社と別の会社を既定にする（claude→codex / codex→claude）", () => {
    expect(pickAuditor("claude", ["claude", "codex"])).toEqual({ auditor: "codex", sameCompany: false });
    expect(pickAuditor("codex", ["claude", "codex"])).toEqual({ auditor: "claude", sameCompany: false });
    expect(pickAuditor("gemini", ["claude", "codex"])).toEqual({ auditor: "claude", sameCompany: false });
  });
  it("codex-acp は OpenAI なので codex の実装に対しては別会社にならない", () => {
    expect(pickAuditor("codex", ["codex-acp", "gemini"])).toEqual({ auditor: "gemini", sameCompany: false });
  });
  it("別会社が居なければ同じ会社で続行し sameCompany を立てる", () => {
    expect(pickAuditor("claude", ["claude"])).toEqual({ auditor: "claude", sameCompany: true });
  });
  it("誰も居なければ null", () => {
    expect(pickAuditor("claude", [])).toBeNull();
  });
  it("実装者不明なら claude を優先", () => {
    expect(pickAuditor(null, ["codex", "claude"])).toEqual({ auditor: "claude", sameCompany: false });
  });
});

describe("implementerOf / nextAuditLayer", () => {
  it("直近の AI 発言（監査・審判を除く）のプロバイダを実装者とする", () => {
    const t = thread({
      messages: [
        msg("u1", "user"),
        msg("a1", "assistant", { provider: "codex", participantSlotId: "p2" }),
        msg("a2", "assistant", { provider: "claude", participantSlotId: "p1", participantRole: "moderator" }),
        msg("a3", "assistant", { provider: "claude", audit: meta(1) }),
      ],
    });
    expect(implementerOf(t)).toEqual({ provider: "codex", slotId: "p2" });
    expect(implementerOf(thread())).toEqual({ provider: null, slotId: null });
  });
  it("観点は前回と違う層に輪番する（1→2→3→1）", () => {
    expect(nextAuditLayer(thread())).toBe(1);
    expect(nextAuditLayer(thread({ messages: [msg("a", "assistant", { audit: meta(1) })] }))).toBe(2);
    expect(nextAuditLayer(thread({ messages: [msg("a", "assistant", { audit: meta(3) })] }))).toBe(1);
  });
});

describe("parseAuditCommand", () => {
  it("/監査 と /audit を解釈し、深さ・層・メモを取り出す", () => {
    expect(parseAuditCommand("/監査")).toEqual({ note: "" });
    expect(parseAuditCommand("/audit deep 2 429は仕様")).toEqual({ depth: "deep", layer: 2, note: "429は仕様" });
    expect(parseAuditCommand("/監査 第3層 Quick")).toEqual({ depth: "quick", layer: 3, note: "" });
  });
  it("監査コマンド以外は null（/auditor のような前方一致も弾く）", () => {
    expect(parseAuditCommand("こんにちは")).toBeNull();
    expect(parseAuditCommand("/auditor x")).toBeNull();
    expect(parseAuditCommand("/compact")).toBeNull();
  });
});

describe("isAuditSid / isAuditSlotId", () => {
  it("::audit- の suffix だけを監査セッションとみなす", () => {
    expect(isAuditSid("t1::audit-abc")).toBe(true);
    expect(isAuditSid("t1::p1")).toBe(false);
    expect(isAuditSid("t1")).toBe(false);
    expect(isAuditSlotId("audit-1")).toBe(true);
    expect(isAuditSlotId("p1")).toBe(false);
  });
});

describe("buildAuditBrief / buildForwardPrompt", () => {
  it("付録Bの5点（対象・差分・仕様・観点・出力形式）が全部入る", () => {
    const brief = buildAuditBrief({
      layer: 2,
      depth: "quick",
      files: [{ path: "a.ts", status: "M", old_path: null, additions: 3, deletions: 1, binary: false }],
      patch: "diff --git a/a.ts b/a.ts\n+x",
      patchTruncated: false,
      auditMd: "429 はレート制限の仕様",
      note: "ログ形式は変えない",
      implementer: "claude",
      baseKind: "head",
    });
    for (const k of ["## ① 対象", "## ② 差分本文", "## ③ 仕様であって欠陥ではないもの", "## ④ 観点", "## ⑤ 出力形式", "FINDINGS"]) {
      expect(brief).toContain(k);
    }
    expect(brief).toContain("第2層");
    expect(brief).toContain("429 はレート制限の仕様");
    expect(brief).toContain("ログ形式は変えない");
    expect(brief).toContain("M a.ts (+3/−1)");
    expect(brief).toContain("差分本文だけで判断");
  });
  it("Deep は関連ファイルの読み取りを許す文言になる", () => {
    const brief = buildAuditBrief({
      layer: 1,
      depth: "deep",
      files: [],
      patch: "",
      patchTruncated: true,
      auditMd: "",
      note: "",
      implementer: null,
      baseKind: "head",
    });
    expect(brief).toContain("関連ファイルを読んで裏取り");
    expect(brief).toContain("先頭だけ");
    expect(brief).toContain("実装したAI: 不明");
  });
  it("転送文は「裏取り」「却下」の指示と監査本文を含む", () => {
    const p = buildForwardPrompt(msg("a", "assistant", { content: "FINDINGS\n1. ...", audit: meta(1) }));
    expect(p).toContain("裏取り");
    expect(p).toContain("却下");
    expect(p).toContain("Codex");
    expect(p.endsWith("FINDINGS\n1. ...")).toBe(true);
  });
});
