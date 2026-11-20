/**
 * 出荷前の監査（2026-11-21）で見つかった不具合が戻らないことを確かめる。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { boardOf, emptyRun, reconcileRun, step } from "./engine";
import { findStaffByName, parseLeadDirectives } from "./protocol";
import { planSend, sessionKeyOf } from "./runner";
import { brokenStores, loadOffices, loadRun, repairRun, saveRun } from "./store";
import { buildOffice, OFFICE_TEMPLATES } from "./templates";
import type { Office, OfficeAgentEvent, OfficeEffect, OfficeInput, OfficeRun } from "./types";

function office(): Office {
  return buildOffice({ template: OFFICE_TEMPLATES.find((t) => t.id === "site")!, name: "試験の会社", workspace: "D:/work", now: 1000 });
}

function world(o = office()) {
  let run: OfficeRun = emptyRun(o);
  const effects: OfficeEffect[] = [];
  const lead = o.staff.find((s) => s.lead)!;
  const members = o.staff.filter((s) => !s.lead);
  const send = (input: OfficeInput) => {
    const r = step(run, o, input, "ja");
    run = r.run;
    effects.push(...r.effects);
    return r.effects;
  };
  const agent = (staffId: string, ev: OfficeAgentEvent, at = 10) => send({ t: "agent", staffId, ev, at });
  const say = (staffId: string, text: string, subtype = "success") => {
    agent(staffId, { kind: "assistant_text", text });
    return agent(staffId, { kind: "result", subtype });
  };
  const sends = () => effects.filter((e): e is Extract<OfficeEffect, { t: "send" }> => e.t === "send");
  return { o, lead, members, send, agent, say, sends, effects, get run() { return run; }, set run(r: OfficeRun) { run = r; } };
}

describe("指示の受け付け", () => {
  it("取りまとめ役の返事の途中に届いた指示は割り込ませず、返事が終わってから渡す（先の返事を消さない）", () => {
    const w = world();
    w.send({ t: "boss", text: "指示1", at: 1 });
    w.send({ t: "boss", text: "指示2", at: 2 });
    expect(w.sends().map((e) => e.text)).toEqual(["【社長から】\n指示1"]);
    expect(w.run.pending).toEqual(["【社長から】\n指示2"]);
    w.say(w.lead.id, "回答1");
    expect(w.run.log.some((m) => m.kind === "lead" && m.text === "回答1")).toBe(true);
    expect(w.sends().map((e) => e.text)).toEqual(["【社長から】\n指示1", "【社長から】\n指示2"]);
    expect(w.run.pending).toEqual([]);
    w.say(w.lead.id, "回答2");
    expect(w.run.log.filter((m) => m.kind === "lead").map((m) => m.text)).toEqual(["回答1", "回答2"]);
  });

  it("社員の報告を待っている間の指示は、報告がそろって取りまとめ役が返事を終えてから渡す（先の依頼の報告を失わない）", () => {
    const w = world();
    const [a, b] = w.members;
    w.send({ t: "boss", text: "作って", at: 1 });
    w.say(w.lead.id, `[[依頼:${a.name}]]資料A[[/依頼]]`);
    w.send({ t: "boss", text: "追加の指示", at: 3 });
    expect(w.run.awaiting).toEqual([a.id]);
    w.say(a.id, "A の報告");
    // 報告が取りまとめ役へ届く
    expect(w.sends().some((e) => e.staffId === w.lead.id && e.text.includes("A の報告"))).toBe(true);
    expect(w.run.pending).toEqual(["【社長から】\n追加の指示"]);
    w.say(w.lead.id, "まとめました。");
    expect(w.sends()[w.sends().length - 1].text).toBe("【社長から】\n追加の指示");
    void b;
  });

  it("確認待ちの間に別の入口から届いた指示は、確認に答えるまで預かる（古い確認の札を置き去りにしない）", () => {
    const w = world();
    w.send({ t: "boss", text: "見積書を作って", at: 1 });
    w.say(w.lead.id, "[[確認:見積書]]金額を確認してください[[/確認]]");
    w.send({ t: "boss", text: "議事録を作って", at: 5 });
    expect(w.run.approval?.title).toBe("見積書");
    expect(w.run.pending).toHaveLength(1);
    expect(w.sends()).toHaveLength(1);
    w.send({ t: "approve", ok: true, comment: "", at: 6 });
    expect(w.run.approval).toBeNull();
    w.say(w.lead.id, "[[完了]]");
    expect(w.sends()[w.sends().length - 1].text).toBe("【社長から】\n議事録を作って");
  });

  it("止めたら、預かっていた指示も捨てる", () => {
    const w = world();
    w.send({ t: "boss", text: "指示1", at: 1 });
    w.send({ t: "boss", text: "指示2", at: 2 });
    w.send({ t: "stop", at: 3 });
    expect(w.run.pending).toEqual([]);
    expect(w.run.busy).toBe(false);
  });
});

describe("失敗の扱い", () => {
  it("失敗で終わった返事は、できた報告として渡さない", () => {
    const w = world();
    const [a] = w.members;
    w.send({ t: "boss", text: "作って", at: 1 });
    w.say(w.lead.id, `[[依頼:${a.name}]]report.md を作成[[/依頼]]`);
    w.say(a.id, "", "error_during_execution");
    expect(w.run.staff[a.id].status).toBe("idle");
    const toLead = w.sends().filter((e) => e.staffId === w.lead.id).pop()!;
    expect(toLead.text).toContain("止まりました");
  });

  it("失敗で終わった取りまとめ役の返事に書かれた合図は実行しない", () => {
    const w = world();
    const [a] = w.members;
    w.send({ t: "boss", text: "作って", at: 1 });
    w.say(w.lead.id, `[[依頼:${a.name}]]やって[[/依頼]]`, "error");
    expect(w.sends().filter((e) => e.staffId === a.id)).toEqual([]);
    expect(w.run.staff[w.lead.id].status).toBe("idle");
  });

  it("同じ人の失敗が2回届いても、報告は1件", () => {
    const w = world();
    const [a, b] = w.members;
    w.send({ t: "boss", text: "作って", at: 1 });
    w.say(w.lead.id, `[[依頼:${a.name}]]A[[/依頼]][[依頼:${b.name}]]B[[/依頼]]`);
    w.agent(a.id, { kind: "error", message: "Error: disconnected" });
    w.agent(a.id, { kind: "error", message: "Failed to read response" });
    expect(w.run.reports.filter((r) => r.staffId === a.id)).toHaveLength(1);
  });

  it("止まった AI の許可の求めは消える。止めたあとに遅れて届いた許可の求めは受けない", () => {
    const w = world();
    w.send({ t: "boss", text: "作って", at: 1 });
    w.agent(w.lead.id, { kind: "permission_request", request_id: "p1", tool_name: "Bash", input: { command: "npm install" } });
    expect(w.run.permissions).toHaveLength(1);
    w.agent(w.lead.id, { kind: "error", message: "process exited" });
    expect(w.run.permissions).toEqual([]);
    expect(w.run.busy).toBe(false);
    w.agent(w.lead.id, { kind: "permission_request", request_id: "late", tool_name: "Bash", input: { command: "rm" } });
    expect(w.run.permissions).toEqual([]);
    expect(w.run.staff[w.lead.id].status).toBe("idle");
  });

  it("入っていない AI を選んでいたら、直し方が分かる文を出す", () => {
    const w = world();
    w.send({ t: "boss", text: "作って", at: 1 });
    w.send({ t: "start_failed", staffId: w.lead.id, message: "spawn failed: program not found", at: 2 });
    const last = w.run.log[w.run.log.length - 1].text;
    expect(last).toContain("入っていない");
    expect(last).toContain("社員の設定");
  });
});

describe("社員・会社を変えたとき", () => {
  it("報告を待っていた社員を消したら、残りの報告で先へ進む", () => {
    const w = world();
    const [a, b] = w.members;
    w.send({ t: "boss", text: "作って", at: 1 });
    w.say(w.lead.id, `[[依頼:${a.name}]]A[[/依頼]][[依頼:${b.name}]]B[[/依頼]]`);
    w.say(a.id, "A の報告");
    const o2: Office = { ...w.o, staff: w.o.staff.filter((s) => s.id !== b.id) };
    const r = step(w.run, o2, { t: "sync", at: 9 }, "ja");
    expect(r.run.awaiting).toEqual([]);
    expect(r.effects.some((e) => e.t === "send" && e.staffId === w.lead.id && e.text.includes("A の報告"))).toBe(true);
  });

  it("待っていた社員が1人だけで、その人を消したら、取りまとめ役は待つのをやめる", () => {
    const w = world();
    const [a] = w.members;
    w.send({ t: "boss", text: "作って", at: 1 });
    w.say(w.lead.id, `[[依頼:${a.name}]]A[[/依頼]]`);
    const o2: Office = { ...w.o, staff: w.o.staff.filter((s) => s.id !== a.id) };
    const r = step(w.run, o2, { t: "sync", at: 9 }, "ja");
    expect(r.run.staff[w.lead.id].status).toBe("idle");
    expect(r.run.busy).toBe(false);
  });

  it("会社を切り替えるときは、許可待ちの AI も止める。確認の札は残す", () => {
    const w = world();
    w.send({ t: "boss", text: "作って", at: 1 });
    w.send({ t: "started", staffId: w.lead.id, sessionKey: "claude|D:/work" });
    w.agent(w.lead.id, { kind: "permission_request", request_id: "p1", tool_name: "Bash", input: { command: "npm install" } });
    expect(w.run.busy).toBe(false); // 全員が許可待ち
    const fx = w.send({ t: "suspend", at: 5 });
    expect(fx).toEqual([{ t: "stop", staffId: w.lead.id }]);
    expect(w.run.permissions).toEqual([]);
    expect(w.run.staff[w.lead.id]).toMatchObject({ status: "idle", started: false });

    const v = world();
    v.send({ t: "boss", text: "作って", at: 1 });
    v.say(v.lead.id, "[[確認:見積書]]確認してください[[/確認]]");
    v.send({ t: "suspend", at: 5 });
    expect(v.run.approval?.title).toBe("見積書");
    expect(v.run.staff[v.lead.id].status).toBe("waiting");
  });

  it("開き直したあと、報告待ちだった取りまとめ役を「作業中」に残さない。閉じていた時間は動いた時間に足さない", () => {
    const w = world();
    const [a] = w.members;
    w.send({ t: "boss", text: "作って", at: 1000 });
    w.say(w.lead.id, `[[依頼:${a.name}]]A[[/依頼]]`);
    const before = w.run.usage.activeMs;
    const r = reconcileRun(w.run, w.o, { afterRestart: true });
    expect(r.staff[w.lead.id].status).toBe("idle");
    expect(boardOf(r, w.o).working).toEqual([]);
    expect(r.usage.activeSince).toBeNull();
    expect(r.usage.activeMs).toBe(before);
  });
});

describe("合図の読み取り（追加）", () => {
  it("``` で囲んだ説明の中の合図は実行しない。合図の中の囲みは中身として残す", () => {
    const d = parseLeadDirectives("書き方の例です。\n```text\n[[依頼:Alice]]report.md を作成[[/依頼]]\n```\n以上です。");
    expect(d.delegations).toEqual([]);
    expect(d.plain).toContain("[[依頼:Alice]]");
    const a = parseLeadDirectives("[[確認:手順]]\n次のとおりです。\n```sh\nnpm test\n```\n[[/確認]]");
    expect(a.approval?.body).toContain("npm test");
  });

  it("同じ名前の社員が2人いたら、どちらにも決めない", () => {
    const o = office();
    const members = o.staff.filter((s) => !s.lead);
    members[0].name = "田中";
    members[1].name = "田中";
    expect(findStaffByName(o, "田中")).toBeNull();
    expect(findStaffByName(o, members[1].id)?.id).toBe(members[1].id);
  });
});

describe("起動し直しの判断", () => {
  const base = { started: true, savedKey: "claude|D:/a", key: "claude|D:/a", rules: "r1", provider: "claude", hasResume: true };
  it("何も変わっていなければ、そのまま送る", () => {
    expect(planSend({ ...base, running: { key: "claude|D:/a", rules: "r1" } })).toEqual({ restart: false, resume: false, prefixRules: false });
  });
  it("作業フォルダが変わったら、起動し直して前の続きにはしない", () => {
    const key = sessionKeyOf("claude", "D:/b");
    expect(planSend({ ...base, key, running: { key: "claude|D:/a", rules: "r1" } })).toEqual({ restart: true, resume: false, prefixRules: false });
    // アプリを開き直したあと（動いているセッションの記録が無い）でも、保存してある印と違えば続きにしない
    expect(planSend({ ...base, started: false, key, running: null })).toMatchObject({ restart: true, resume: false });
  });
  it("AI を変えたら、起動し直して前の続きにはしない", () => {
    expect(planSend({ ...base, key: "codex|D:/a", provider: "codex", running: { key: "claude|D:/a", rules: "r1" } })).toMatchObject({ restart: true, resume: false });
  });
  it("仕事のやり方だけ変えたら、続きから起動し直し、新しい決まりを伝言に付ける（続きでは決まりを読まない AI がある）", () => {
    expect(planSend({ ...base, rules: "r2", running: { key: "claude|D:/a", rules: "r1" } })).toEqual({ restart: true, resume: true, prefixRules: true });
  });
  it("起動のときに決まりを受け取らない AI には、起動のたびに伝言に付ける", () => {
    expect(planSend({ ...base, started: false, running: null, provider: "opencode", key: "opencode|D:/a", savedKey: "opencode|D:/a" })).toEqual({ restart: true, resume: true, prefixRules: true });
    expect(planSend({ ...base, started: false, running: null })).toEqual({ restart: true, resume: true, prefixRules: false });
  });
});

describe("保存の読み書き", () => {
  beforeEach(() => localStorage.clear());

  it("壊れた会社の一覧は、空で上書きされても元の文字が残る", () => {
    const raw = '[{"id":"oa","name":"A","staff":[],"departments":[]},';
    localStorage.setItem("unicrew.offices.v1", raw);
    expect(loadOffices()).toEqual([]);
    expect(localStorage.getItem("unicrew.offices.v1.broken")).toBe(raw);
    expect(brokenStores()).toContain("unicrew.offices.v1.broken");
  });

  it("形の違う社員が混ざった会社では落ちず、その会社を使わない（元の記録は残す）", () => {
    const o = office();
    localStorage.setItem("unicrew.offices.v1", JSON.stringify([{ id: "bad", name: "A", staff: [null], departments: [] }, o]));
    expect(loadOffices().map((x) => x.id)).toEqual([o.id]);
    expect(localStorage.getItem("unicrew.offices.v1.broken")).toContain('"bad"');
  });

  it("欠けた所のある「いま」は、既定の値で埋めて読む（落ちない）", () => {
    const o = office();
    const r = repairRun({ officeId: o.id, staff: {}, usage: null, busy: true }, o)!;
    expect(r.usage.activeSince).toBeNull();
    expect(Object.keys(r.staff)).toHaveLength(o.staff.length);
    localStorage.setItem(`unicrew.office.run.v1.${o.id}`, JSON.stringify({ officeId: o.id, staff: {}, usage: null, busy: true }));
    expect(() => loadRun(o)).not.toThrow();
    expect(loadRun(o).busy).toBe(false);
  });

  it("壊れた「いま」は、空から始めても元の文字が残る", () => {
    const o = office();
    localStorage.setItem(`unicrew.office.run.v1.${o.id}`, "{");
    const r = loadRun(o);
    expect(r.log).toEqual([]);
    saveRun(r);
    expect(localStorage.getItem(`unicrew.office.run.v1.${o.id}.broken`)).toBe("{");
  });
});
