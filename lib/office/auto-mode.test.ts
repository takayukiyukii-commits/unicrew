import { describe, expect, it } from "vitest";
import { emptyRun, MAX_AUTO_ANSWERS, step, waitingForBoss } from "./engine";
import { attentionInput } from "./runner";
import { buildOffice, OFFICE_TEMPLATES } from "./templates";
import type { Office, OfficeAgentEvent, OfficeEffect, OfficeInput, OfficeRun } from "./types";

function office(autoMode: boolean): Office {
  return { ...buildOffice({ template: OFFICE_TEMPLATES.find((t) => t.id === "site")!, name: "試験の会社", workspace: "D:/work", now: 1000 }), autoMode };
}

function drive(o: Office, run: OfficeRun, inputs: OfficeInput[]): { run: OfficeRun; effects: OfficeEffect[] } {
  const effects: OfficeEffect[] = [];
  for (const i of inputs) {
    const r = step(run, o, i, "ja");
    run = r.run;
    effects.push(...r.effects);
  }
  return { run, effects };
}

const say = (staffId: string, text: string, at: number): OfficeInput[] => [
  { t: "agent", staffId, ev: { kind: "assistant_text", text } as OfficeAgentEvent, at },
  { t: "agent", staffId, ev: { kind: "result", subtype: "success" } as OfficeAgentEvent, at: at + 1 },
];
const ask = (staffId: string, requestId: string, at: number): OfficeInput => ({
  t: "agent", staffId, ev: { kind: "permission_request", request_id: requestId, tool_name: "Bash", input: { command: "npm test" } } as OfficeAgentEvent, at,
});
const leadId = (o: Office) => o.staff.find((s) => s.lead)!.id;
const REVIEW = "できました。\n[[確認:ホームページ（第1版）]]\n確認をお願いします。\nファイル: site/index.html\n[[/確認]]";
const QUESTION = "[[質問]]\n①安心感 ②手軽さ、どちらですか？\n[[/質問]]";

describe("最後まで自動で進める：切のとき（これまでどおり社長を待つ）", () => {
  it("許可の求めは札になり、通知には「許可する／許可しない」のボタンが付く", () => {
    const o = office(false);
    const lead = leadId(o);
    const r = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ask(lead, "req-1", 20)]);
    expect(r.run.permissions).toHaveLength(1);
    expect(r.run.staff[lead].status).toBe("waiting");
    expect(r.effects.some((e) => e.t === "permission")).toBe(false);
    const att = r.effects.find((e) => e.t === "attention");
    expect(att && att.t === "attention" ? att.ask : null).toEqual({
      tag: `perm:${r.run.permissions[0].id}`,
      actions: [{ id: "allow", label: "許可する" }, { id: "deny", label: "許可しない" }],
    });
  });

  it("確認のお願いは社長を待ち、通知には「OKを出す」のボタンが付く", () => {
    const o = office(false);
    const lead = leadId(o);
    const r = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ...say(lead, REVIEW, 20)]);
    expect(r.run.approval?.title).toBe("ホームページ（第1版）");
    const att = r.effects.filter((e) => e.t === "attention").pop();
    expect(att && att.t === "attention" ? att.ask?.tag : null).toBe(`approval:${r.run.approval!.id}`);
    expect(att && att.t === "attention" ? att.ask?.actions.map((a) => a.id) : null).toEqual(["ok", "open"]);
  });

  it("質問は社長を待つ", () => {
    const o = office(false);
    const lead = leadId(o);
    const r = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ...say(lead, QUESTION, 20)]);
    expect(waitingForBoss(r.run)).toBe(1);
    expect(r.run.staff[lead].status).toBe("waiting");
  });
});

describe("最後まで自動で進める：入のとき", () => {
  it("許可の求めは札にならず、その場で通る。何を通したかは知らせに残る", () => {
    const o = office(true);
    const lead = leadId(o);
    const r = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ask(lead, "req-1", 20)]);
    expect(r.run.permissions).toHaveLength(0);
    expect(r.run.staff[lead].status).toBe("working");
    expect(r.effects).toContainEqual({ t: "permission", staffId: lead, requestId: "req-1", allow: true });
    expect(r.run.notices[0].text).toContain("自動で許可しました");
    expect(r.run.notices[0].text).toContain("npm test");
    // 社長を呼ぶ通知は出さない
    expect(r.effects.some((e) => e.t === "attention")).toBe(false);
    expect(waitingForBoss(r.run)).toBe(0);
  });

  it("止まったあとに遅れて届いた許可の求めは、自動でも通さない", () => {
    const o = office(true);
    const lead = leadId(o);
    const r = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, { t: "stop", at: 15 }, ask(lead, "req-1", 20)]);
    expect(r.effects.some((e) => e.t === "permission")).toBe(false);
  });

  it("確認のお願いは、待たずに OK として続きを頼む（記録に残る）", () => {
    const o = office(true);
    const lead = leadId(o);
    const r = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ...say(lead, REVIEW, 20)]);
    expect(r.run.approval).toBeNull();
    expect(r.run.staff[lead].status).toBe("working");
    expect(r.run.busy).toBe(true);
    const sends = r.effects.filter((e) => e.t === "send");
    expect(sends).toHaveLength(2);
    expect(sends[1].t === "send" ? sends[1].text : "").toContain("「ホームページ（第1版）」は OK です");
    expect(r.run.log.some((m) => m.kind === "system" && m.text.includes("確認を待たずに OK"))).toBe(true);
  });

  it("質問は、おすすめの案で進めてもらう。外に出す・お金・消すは進めないと伝える", () => {
    const o = office(true);
    const lead = leadId(o);
    const r = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ...say(lead, QUESTION, 20)]);
    expect(waitingForBoss(r.run)).toBe(0);
    expect(r.run.staff[lead].status).toBe("working");
    const last = r.effects.filter((e) => e.t === "send").pop();
    const text = last && last.t === "send" ? last.text : "";
    expect(text).toContain("おすすめの案で進めてください");
    expect(text).toMatch(/公開・送信・支払い・消す/);
    // 質問そのものは記録に残る（あとで何を聞かれたか分かる）
    expect(r.run.log.some((m) => m.kind === "question" && m.answered)).toBe(true);
  });

  it(`質問が${MAX_AUTO_ANSWERS}回を超えたら、回り続けずに社長に聞く`, () => {
    const o = office(true);
    const lead = leadId(o);
    let run = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }]).run;
    for (let i = 0; i < MAX_AUTO_ANSWERS; i++) run = drive(o, run, say(lead, QUESTION, 100 + i * 10)).run;
    expect(waitingForBoss(run)).toBe(0);
    const r = drive(o, run, say(lead, QUESTION, 900));
    expect(waitingForBoss(r.run)).toBe(1);
    expect(r.run.staff[lead].status).toBe("waiting");
    expect(r.effects.some((e) => e.t === "attention")).toBe(true);
  });

  it("新しい仕事では、自動で返した回数を数え直す", () => {
    const o = office(true);
    const lead = leadId(o);
    let run = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ...say(lead, QUESTION, 20), ...say(lead, "終わりました。\n[[完了]]", 40)]).run;
    expect(run.autoAnswers).toBe(1);
    run = drive(o, run, [{ t: "boss", text: "次の仕事", at: 100 }]).run;
    expect(run.autoAnswers).toBe(0);
  });
});

describe("最後まで自動で進める：途中で切り替える", () => {
  it("入れた瞬間に、待っていた許可を全部通す", () => {
    const off = office(false);
    const lead = leadId(off);
    const member = off.staff.find((s) => !s.lead)!;
    let run = drive(off, emptyRun(off), [
      { t: "boss", text: "作って", at: 10 },
      ...say(lead, `[[依頼:${member.name}]]\nお願いします。\n[[/依頼]]`, 20),
      ask(member.id, "req-1", 30),
      ask(member.id, "req-2", 31),
    ]).run;
    expect(run.permissions).toHaveLength(2);
    const r = drive({ ...off, autoMode: true }, run, [{ t: "auto", at: 40 }]);
    expect(r.run.permissions).toHaveLength(0);
    expect(r.effects.filter((e) => e.t === "permission" && e.allow)).toHaveLength(2);
    expect(r.run.staff[member.id].status).toBe("working");
    expect(r.run.busy).toBe(true);
    expect(r.run.log.some((m) => m.kind === "system" && m.text.includes("最後まで自動で進める」を入れました"))).toBe(true);
    run = r.run;
  });

  it("入れた瞬間に、待っていた確認を OK として進める", () => {
    const off = office(false);
    const lead = leadId(off);
    const run = drive(off, emptyRun(off), [{ t: "boss", text: "作って", at: 10 }, ...say(lead, REVIEW, 20)]).run;
    const r = drive({ ...off, autoMode: true }, run, [{ t: "auto", at: 40 }]);
    expect(r.run.approval).toBeNull();
    expect(r.run.staff[lead].status).toBe("working");
    expect(r.effects.some((e) => e.t === "send" && e.text.includes("OK です"))).toBe(true);
  });

  it("入れた瞬間に、待っていた質問をおすすめの案で進める", () => {
    const off = office(false);
    const lead = leadId(off);
    const run = drive(off, emptyRun(off), [{ t: "boss", text: "作って", at: 10 }, ...say(lead, QUESTION, 20)]).run;
    const r = drive({ ...off, autoMode: true }, run, [{ t: "auto", at: 40 }]);
    expect(waitingForBoss(r.run)).toBe(0);
    expect(r.effects.some((e) => e.t === "send" && e.text.includes("おすすめの案"))).toBe(true);
  });

  it("切ったときは、記録に残すだけで何も進めない", () => {
    const o = office(false);
    const lead = leadId(o);
    const run = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ask(lead, "req-1", 20)]).run;
    const r = drive(o, run, [{ t: "auto", at: 40 }]);
    expect(r.run.permissions).toHaveLength(1);
    expect(r.effects).toHaveLength(0);
    expect(r.run.log.some((m) => m.kind === "system" && m.text.includes("を切りました"))).toBe(true);
  });
});

describe("通知のボタン", () => {
  it("「許可する」「許可しない」は、その許可への答えになる", () => {
    expect(attentionInput({ tag: "perm:p-1", action: "allow" }, 5)).toEqual({ t: "permission", askId: "p-1", allow: true, at: 5 });
    expect(attentionInput({ tag: "perm:p-1", action: "deny" }, 5)).toEqual({ t: "permission", askId: "p-1", allow: false, at: 5 });
  });

  it("「OKを出す」は、その確認への OK になる", () => {
    expect(attentionInput({ tag: "approval:a-1", action: "ok" }, 5)).toEqual({ t: "approve", ok: true, comment: "", at: 5, approvalId: "a-1" });
  });

  it("本文を押しただけ・「開いて確かめる」・知らない札は、何も答えない", () => {
    expect(attentionInput({ tag: "perm:p-1", action: "" }, 5)).toBeNull();
    expect(attentionInput({ tag: "approval:a-1", action: "open" }, 5)).toBeNull();
    expect(attentionInput({ tag: "approval:a-1", action: "allow" }, 5)).toBeNull();
    expect(attentionInput({ tag: "other:x", action: "ok" }, 5)).toBeNull();
    expect(attentionInput({ tag: "perm:", action: "allow" }, 5)).toBeNull();
    expect(attentionInput({ tag: "noseparator", action: "allow" }, 5)).toBeNull();
  });

  it("通知から押した許可は、画面で押したのと同じに進む", () => {
    const o = office(false);
    const lead = leadId(o);
    const run = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ask(lead, "req-1", 20)]).run;
    const input = attentionInput({ tag: `perm:${run.permissions[0].id}`, action: "allow" }, 30)!;
    const r = drive(o, run, [input]);
    expect(r.effects).toContainEqual({ t: "permission", staffId: lead, requestId: "req-1", allow: true });
    expect(r.run.staff[lead].status).toBe("working");
  });

  it("古い通知の「OKを出す」で、あとから出た別の確認を通さない", () => {
    const o = office(false);
    const lead = leadId(o);
    let run = drive(o, emptyRun(o), [{ t: "boss", text: "作って", at: 10 }, ...say(lead, REVIEW, 20)]).run;
    const oldId = run.approval!.id;
    // 画面で差し戻し → 直した第2版の確認が出る
    run = drive(o, run, [{ t: "approve", ok: false, comment: "色を直して", at: 30 }, ...say(lead, REVIEW.replace("第1版", "第2版"), 40)]).run;
    expect(run.approval!.id).not.toBe(oldId);
    const r = drive(o, run, [attentionInput({ tag: `approval:${oldId}`, action: "ok" }, 50)!]);
    expect(r.run.approval?.title).toBe("ホームページ（第2版）");
    expect(r.effects).toHaveLength(0);
    // いまの確認の通知なら通る
    const ok = drive(o, run, [attentionInput({ tag: `approval:${run.approval!.id}`, action: "ok" }, 60)!]);
    expect(ok.run.approval).toBeNull();
  });

  it("もう無い許可への答えは捨てる（止めたあと・別の会社）", () => {
    const o = office(false);
    const r = drive(o, emptyRun(o), [attentionInput({ tag: "perm:p-gone", action: "allow" }, 5)!]);
    expect(r.effects).toHaveLength(0);
  });
});
