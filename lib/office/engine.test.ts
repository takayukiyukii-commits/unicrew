import { describe, expect, it } from "vitest";
import { boardOf, emptyRun, reconcileRun, step, waitingForBoss } from "./engine";
import { findStaffByName, leadSystemPrompt, parseLeadDirectives } from "./protocol";
import { buildOffice, OFFICE_TEMPLATES } from "./templates";
import type { Office, OfficeAgentEvent, OfficeEffect, OfficeRun } from "./types";

function office(): Office {
  return buildOffice({ template: OFFICE_TEMPLATES.find((t) => t.id === "site")!, name: "試験の会社", workspace: "D:/work", now: 1000 });
}

/** 出来事を順に流して、最後の状態と、途中で出た「外でやること」を返す。 */
function drive(o: Office, run: OfficeRun, inputs: Parameters<typeof step>[2][]): { run: OfficeRun; effects: OfficeEffect[] } {
  const effects: OfficeEffect[] = [];
  for (const i of inputs) {
    const r = step(run, o, i);
    run = r.run;
    effects.push(...r.effects);
  }
  return { run, effects };
}

const say = (staffId: string, text: string, at: number) => [
  { t: "agent" as const, staffId, ev: { kind: "assistant_text", text } as OfficeAgentEvent, at },
  { t: "agent" as const, staffId, ev: { kind: "result", subtype: "success" } as OfficeAgentEvent, at: at + 1 },
];

describe("合図の読み取り", () => {
  it("依頼を複数・質問・確認・完了を拾い、社長に見せる文から合図を除く", () => {
    const d = parseLeadDirectives(
      "デザインと文章を頼みます。\n[[依頼:小川]]\n方針を design.md に。\n[[/依頼]]\n[[依頼:中野 まひろ]]\n見出しを copy.md に。\n[[/依頼]]",
    );
    expect(d.delegations.map((x) => x.to)).toEqual(["小川", "中野 まひろ"]);
    expect(d.plain).toBe("デザインと文章を頼みます。");
    expect(d.done).toBe(false);

    const q = parseLeadDirectives("[[質問]]\n①安心感 ②来店、どちらですか？\n[[/質問]]");
    expect(q.question).toContain("どちらですか");

    const a = parseLeadDirectives("できました。\n[[確認:ホームページ（第1版）]]\n確認をお願いします。\nファイル: site/index.html\n[[/確認]]");
    expect(a.approval).toEqual({ title: "ホームページ（第1版）", body: "確認をお願いします。", file: "site/index.html" });

    expect(parseLeadDirectives("全部終わりました。\n[[完了]]").done).toBe(true);
  });

  it("全角の括弧とコロンで書かれても拾う", () => {
    const d = parseLeadDirectives("［［依頼：村上］］\n組み立てて。\n［［／依頼］］");
    expect(d.delegations).toEqual([{ to: "村上", text: "組み立てて。" }]);
  });

  it("合図が無い文は、そのまま社長に見せる文になる", () => {
    const d = parseLeadDirectives("承知しました。");
    expect(d).toMatchObject({ plain: "承知しました。", delegations: [], question: null, approval: null, done: false });
  });

  it("名前は姓だけ・さん付き・担当名でも当たる。取りまとめ役には当たらない", () => {
    const o = office();
    expect(findStaffByName(o, "小川さん")?.name).toBe("小川 いろは");
    expect(findStaffByName(o, "組み立て担当")?.name).toBe("村上 はると");
    expect(findStaffByName(o, "森")).toBeNull();
    expect(findStaffByName(o, "だれか")).toBeNull();
  });

  it("取りまとめ役への決まりに、社員の名前と合図の書き方が入る（道具の名前は書かない）", () => {
    const o = office();
    const p = leadSystemPrompt(o, o.staff.find((s) => s.lead)!);
    expect(p).toContain("小川 いろは");
    expect(p).toContain("[[依頼:");
    expect(p).not.toMatch(/\b(Read|Write|Bash|Task)\b/);
  });
});

describe("仕事の流れ", () => {
  it("指示 → 質問 → 依頼（同時に2人）→ 報告がそろってから取りまとめ役へ → 確認 → OK → 完了", () => {
    const o = office();
    const lead = o.staff.find((s) => s.lead)!;
    const ogawa = o.staff.find((s) => s.name.startsWith("小川"))!;
    const nakano = o.staff.find((s) => s.name.startsWith("中野"))!;
    let run = emptyRun(o);

    // 社長の指示
    let r = drive(o, run, [{ t: "boss", text: "ホームページを作って", at: 10 }]);
    run = r.run;
    expect(r.effects).toEqual([{ t: "send", staffId: lead.id, text: "【社長から】\nホームページを作って" }]);
    expect(run.busy).toBe(true);
    expect(run.staff[lead.id].status).toBe("working");

    // 取りまとめ役が質問
    r = drive(o, run, say(lead.id, "[[質問]]\n①安心感 ②来店 どちら？\n[[/質問]]", 20));
    run = r.run;
    expect(run.busy).toBe(false);
    expect(waitingForBoss(run)).toBe(1);
    expect(boardOf(run, o).waiting.map((x) => x.staff.id)).toEqual([lead.id]);
    expect(r.effects.some((e) => e.t === "attention")).toBe(true);

    // 社長が答える → 取りまとめ役が2人に依頼
    r = drive(o, run, [{ t: "boss", text: "1で", at: 30 }, ...say(lead.id, "進めます。\n[[依頼:小川]]\n方針を。\n[[/依頼]]\n[[依頼:中野]]\n文を。\n[[/依頼]]", 40)]);
    run = r.run;
    expect(waitingForBoss(run)).toBe(0);
    const sends = r.effects.filter((e) => e.t === "send").map((e) => (e as { staffId: string }).staffId);
    expect(sends).toEqual([lead.id, ogawa.id, nakano.id]);
    expect(run.awaiting).toEqual([ogawa.id, nakano.id]);
    expect(boardOf(run, o).working.map((x) => x.staff.id).sort()).toEqual([lead.id, ogawa.id, nakano.id].sort());

    // 小川だけ終わる → まだ取りまとめ役には渡さない
    r = drive(o, run, [
      { t: "agent", staffId: ogawa.id, ev: { kind: "tool_use", tool_use_id: "t1", tool_name: "Write", tool_input: { file_path: "design.md" } }, at: 50 },
    ]);
    run = r.run;
    expect(run.staff[ogawa.id].bubble).toBe("design.md を書いています");
    r = drive(o, run, [
      { t: "agent", staffId: ogawa.id, ev: { kind: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }, at: 51 },
      ...say(ogawa.id, "design.md を作りました。", 52),
    ]);
    run = r.run;
    expect(r.effects.filter((e) => e.t === "send")).toEqual([]);
    expect(run.staff[ogawa.id].status).toBe("done");
    expect(run.deliveries.map((d) => d.artifact.target)).toEqual(["D:/work/design.md"]);

    // 中野も終わる → 2人分まとめて取りまとめ役へ
    r = drive(o, run, say(nakano.id, "copy.md を作りました。", 60));
    run = r.run;
    const toLead = r.effects.filter((e) => e.t === "send") as { staffId: string; text: string }[];
    expect(toLead).toHaveLength(1);
    expect(toLead[0].staffId).toBe(lead.id);
    expect(toLead[0].text).toContain("小川 いろはさんからの報告");
    expect(toLead[0].text).toContain("中野 まひろさんからの報告");
    expect(toLead[0].text).toContain("D:/work/design.md");

    // 確認 → OK → 完了
    r = drive(o, run, say(lead.id, "[[確認:ホームページ]]\nできました。\nファイル: index.html\n[[/確認]]", 70));
    run = r.run;
    expect(run.approval?.title).toBe("ホームページ");
    expect(run.busy).toBe(false);
    r = drive(o, run, [{ t: "approve", ok: true, comment: "", at: 80 }, ...say(lead.id, "ありがとうございます。\n[[完了]]", 90)]);
    run = r.run;
    expect(run.approval).toBeNull();
    expect(run.staff[lead.id].status).toBe("done");
    expect(run.busy).toBe(false);
    expect(run.usage.leadTurns).toBe(4);
    expect(run.usage.staffTurns).toBe(2);
    expect(run.usage.activeSince).toBeNull();
    expect(run.usage.activeMs).toBeGreaterThan(0);
  });

  it("いない名前に頼んだら、取りまとめ役に言い直してもらう（社長には出さない）", () => {
    const o = office();
    const lead = o.staff.find((s) => s.lead)!;
    const r = drive(o, emptyRun(o), [{ t: "boss", text: "頼む", at: 1 }, ...say(lead.id, "[[依頼:山田]]\nやって。\n[[/依頼]]", 2)]);
    const last = r.effects[r.effects.length - 1] as { t: string; staffId: string; text: string };
    expect(last.t).toBe("send");
    expect(last.staffId).toBe(lead.id);
    expect(last.text).toContain("山田");
    expect(r.run.staff[lead.id].status).toBe("working");
  });

  it("社員が途中で止まったら、止まったことを報告として取りまとめ役に返す", () => {
    const o = office();
    const lead = o.staff.find((s) => s.lead)!;
    const murakami = o.staff.find((s) => s.name.startsWith("村上"))!;
    let { run } = drive(o, emptyRun(o), [{ t: "boss", text: "頼む", at: 1 }, ...say(lead.id, "[[依頼:村上]]\n組み立てて。\n[[/依頼]]", 2)]);
    const r = drive(o, run, [{ t: "agent", staffId: murakami.id, ev: { kind: "error", message: "CLI が落ちた" }, at: 5 }]);
    run = r.run;
    const sent = r.effects.find((e) => e.t === "send") as { staffId: string; text: string };
    expect(sent.staffId).toBe(lead.id);
    expect(sent.text).toContain("途中で止まりました");
    expect(run.staff[murakami.id].status).toBe("idle");
    expect(run.staff[murakami.id].started).toBe(false);
  });

  it("許可を求められたら社長の番になり、答えると続きに戻る", () => {
    const o = office();
    const lead = o.staff.find((s) => s.lead)!;
    let { run } = drive(o, emptyRun(o), [
      { t: "boss", text: "頼む", at: 1 },
      { t: "agent", staffId: lead.id, ev: { kind: "permission_request", request_id: "r1", tool_name: "Bash", input: { command: "npm install" } }, at: 2 },
    ]);
    expect(run.permissions).toHaveLength(1);
    expect(run.permissions[0].text).toContain("インストール");
    expect(run.busy).toBe(false);
    const r = drive(o, run, [{ t: "permission", askId: run.permissions[0].id, allow: true, at: 3 }]);
    run = r.run;
    expect(r.effects).toEqual([{ t: "permission", staffId: lead.id, requestId: "r1", allow: true }]);
    expect(run.staff[lead.id].status).toBe("working");
    expect(run.busy).toBe(true);
  });

  it("止めると、動いている全員に止める合図を出して社長の番に戻る", () => {
    const o = office();
    const lead = o.staff.find((s) => s.lead)!;
    const ogawa = o.staff.find((s) => s.name.startsWith("小川"))!;
    const { run } = drive(o, emptyRun(o), [{ t: "boss", text: "頼む", at: 1 }, ...say(lead.id, "[[依頼:小川]]\nやって。\n[[/依頼]]", 2)]);
    const r = step(run, o, { t: "stop", at: 9 });
    expect(r.effects.map((e) => (e as { staffId: string }).staffId).sort()).toEqual([lead.id, ogawa.id].sort());
    expect(r.run.busy).toBe(false);
    expect(r.run.awaiting).toEqual([]);
  });

  it("トークンは同じターンの中で増えた分だけ足す（同じ数字が何度届いても二重に数えない）", () => {
    const o = office();
    const lead = o.staff.find((s) => s.lead)!;
    const { run } = drive(o, emptyRun(o), [
      { t: "boss", text: "頼む", at: 1 },
      { t: "agent", staffId: lead.id, ev: { kind: "usage_delta", input_tokens: 100, output_tokens: 10 }, at: 2 },
      { t: "agent", staffId: lead.id, ev: { kind: "usage_delta", input_tokens: 100, output_tokens: 40 }, at: 3 },
      { t: "agent", staffId: lead.id, ev: { kind: "usage_delta", input_tokens: 100, output_tokens: 40 }, at: 4 },
      ...say(lead.id, "はい。", 5),
      { t: "boss", text: "続き", at: 6 },
      { t: "agent", staffId: lead.id, ev: { kind: "usage_delta", input_tokens: 50, output_tokens: 5 }, at: 7 },
    ]);
    expect(run.usage.inputTokens).toBe(150);
    expect(run.usage.outputTokens).toBe(45);
  });

  it("道具を使う前のつぶやきは報告に入れない（最後の道具のあとの文だけを報告にする）", () => {
    const o = office();
    const lead = o.staff.find((s) => s.lead)!;
    const murakami = o.staff.find((s) => s.name.startsWith("村上"))!;
    const { run } = drive(o, emptyRun(o), [{ t: "boss", text: "頼む", at: 1 }, ...say(lead.id, "[[依頼:村上]]\n組み立てて。\n[[/依頼]]", 2)]);
    const r = drive(o, run, [
      { t: "agent", staffId: murakami.id, ev: { kind: "assistant_text", text: "まずファイルを見ます。" }, at: 5 },
      { t: "agent", staffId: murakami.id, ev: { kind: "tool_use", tool_use_id: "t9", tool_name: "Read", tool_input: { file_path: "a.md" } }, at: 6 },
      { t: "agent", staffId: murakami.id, ev: { kind: "tool_result", tool_use_id: "t9", is_error: false, content: "ok" }, at: 7 },
      ...say(murakami.id, "①組み立てました。", 8),
    ]);
    const sent = r.effects.find((e) => e.t === "send") as { text: string };
    expect(sent.text).toContain("①組み立てました。");
    expect(sent.text).not.toContain("まずファイルを見ます");
  });

  it("新しい仕事を頼むと、前の仕事の印と使った量を数え直す（会話の記録は残す）", () => {
    const o = office();
    const lead = o.staff.find((s) => s.lead)!;
    let { run } = drive(o, emptyRun(o), [{ t: "boss", text: "1つ目", at: 1 }, ...say(lead.id, "終わりました。\n[[完了]]", 2)]);
    expect(run.usage.leadTurns).toBe(1);
    run = step(run, o, { t: "boss", text: "2つ目", at: 10 }).run;
    expect(run.usage.leadTurns).toBe(0);
    expect(run.log.filter((m) => m.kind === "boss")).toHaveLength(2);
    expect(run.staff[lead.id].task).toBe("2つ目");
  });

  it("開き直したあとは、動いていた仕事が止まっていることを社長に伝える", () => {
    const o = office();
    const { run } = drive(o, emptyRun(o), [{ t: "boss", text: "頼む", at: 1 }]);
    const after = reconcileRun(run, o, { afterRestart: true });
    expect(after.busy).toBe(false);
    expect(Object.values(after.staff).every((s) => s.status !== "working" && !s.started)).toBe(true);
    expect(after.log[after.log.length - 1].kind).toBe("system");
  });
});
