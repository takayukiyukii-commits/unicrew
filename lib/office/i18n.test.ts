import { afterEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "../i18n";
import { createDemoDriver } from "./demo";
import { emptyRun, reconcileRun, step } from "./engine";
import { officeMessages, officeT, type OfficeKey } from "./i18n";
import { parseLeadDirectives } from "./protocol";
import { buildOffice, OFFICE_TEMPLATES } from "./templates";
import { describeOfficeTool } from "./tool-text";
import type { OfficeAgentEvent, OfficeInput, OfficeEffect } from "./types";

function fixture(locale?: Locale) {
  const office = buildOffice({ template: OFFICE_TEMPLATES[0], name: "Test", workspace: "C:/test" });
  office.staff.forEach((s, i) => { s.name = i === 0 ? "Lead" : "Member"; s.role = i === 0 ? "Lead" : "Writer"; });
  let run = emptyRun(office);
  const effects: OfficeEffect[] = [];
  const dispatch = (input: OfficeInput) => {
    const r = step(run, office, input, locale);
    run = r.run;
    effects.push(...r.effects);
    return r;
  };
  const agent = (ev: OfficeAgentEvent, staffId = office.staff[0].id) => dispatch({ t: "agent", staffId, ev, at: 2 });
  const say = (text: string, staffId?: string) => {
    agent({ kind: "assistant_text", text }, staffId);
    return agent({ kind: "result", subtype: "success" }, staffId);
  };
  return { office, dispatch, agent, say, effects, get run() { return run; } };
}

describe("office languages", () => {
  it("has identical keys and placeholders in Japanese and English", () => {
    expect(Object.keys(officeMessages.en).sort()).toEqual(Object.keys(officeMessages.ja).sort());
    for (const key of Object.keys(officeMessages.ja) as OfficeKey[]) {
      const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(placeholders(officeMessages.en[key]), key).toEqual(placeholders(officeMessages.ja[key]));
      expect(officeT(key, "en"), key).not.toBe("");
    }
  });

  it("defaults to Japanese without changing the boss message", () => {
    const f = fixture();
    f.dispatch({ t: "boss", text: "Build a page", at: 1 });
    expect(f.run.staff[f.office.staff[0].id].bubble).toBe("考えています");
    expect(f.effects).toEqual([{ t: "send", staffId: f.office.staff[0].id, text: "【社長から】\nBuild a page" }]);
  });

  it.each([true, false])("localizes review, logs and completion (approval=%s), preserving AI instructions", (ok) => {
    const f = fixture("en");
    f.dispatch({ t: "boss", text: "Build a page", at: 1 });
    expect(f.run.staff[f.office.staff[0].id].bubble).toBe("Thinking");
    f.say("[[確認:Page]]\nPlease review.\nファイル: index.html\n[[/確認]]");
    expect(f.run.notices[0].text).toBe("Review requested: Page");
    expect(f.effects.at(-1)).toMatchObject({ t: "attention", title: "A review request arrived" });
    const before = f.run;
    const input = { t: "approve" as const, ok, comment: "Note", at: 3 };
    const r = f.dispatch(input);
    expect(r.run.log.at(-1)?.text).toBe(ok ? "Approved “Page”: Note" : "Sent back “Page”: Note");
    expect(r.effects).toEqual(step(before, f.office, input, "ja").effects);
    f.say("Finished.\n[[完了]]");
    expect(f.run.staff[f.office.staff[0].id].bubble).toBe("This job is finished");
    expect(f.run.notices[0].text).toBe("This job has finished");
  });

  it("localizes delegation, tools, deliveries and reports", () => {
    const f = fixture("en");
    const [lead, member] = f.office.staff;
    f.dispatch({ t: "boss", text: "Make a file", at: 1 });
    f.say("[[依頼:Member]]\nWrite the file.\n[[/依頼]]");
    expect(f.run.staff[member.id].bubble).toBe("Received work from Lead");
    expect(f.run.notices[0].text).toBe("Lead handed work to Member");
    f.agent({ kind: "tool_use", tool_use_id: "w", tool_name: "Write", tool_input: { file_path: "page.html" } }, member.id);
    expect(f.run.staff[member.id].bubble).toBe("Writing page.html");
    f.agent({ kind: "tool_result", tool_use_id: "w", content: "ok", is_error: false }, member.id);
    f.say("Done.", member.id);
    expect(f.run.notices.map((n) => n.text)).toContain("Member delivered page.html");
    expect(f.run.notices[0].text).toBe("Member reported to Lead");
    expect(f.run.staff[lead.id].bubble).toBe("Reading the reports");
    expect(f.effects.at(-1)).toMatchObject({ t: "send", text: expect.stringContaining("Memberさんからの報告") });
  });

  it("localizes permission descriptions and notifications", () => {
    const f = fixture("en");
    f.dispatch({ t: "boss", text: "Run tests", at: 1 });
    f.agent({ kind: "permission_request", request_id: "p", tool_name: "Bash", input: { command: "npm test" } });
    expect(f.run.permissions[0].text).toBe("Permission requested: Running a command (npm test)\nnpm test");
    expect(f.effects.at(-1)).toMatchObject({ t: "attention", title: "Lead is waiting for permission" });
    f.dispatch({ t: "permission", askId: f.run.permissions[0].id, allow: false, at: 3 });
    expect(f.run.staff[f.office.staff[0].id].bubble).toBe("Considering another approach");
  });

  it("localizes errors, inquiry and stop, and leaves saved logs alone", () => {
    const f = fixture("en");
    f.dispatch({ t: "inquiry", text: "Hello", at: 1 });
    expect(f.run.notices[0].text).toBe("A customer inquiry arrived");
    f.say("[[返事]]\nThank you.\n[[/返事]]");
    expect(f.run.notices[0].text).toBe("The inquiry reply draft is ready");
    f.dispatch({ t: "start_failed", staffId: f.office.staff[0].id, message: "missing", at: 3 });
    expect(f.run.log.at(-1)?.text).toContain("Could not start AI (missing)");
    expect(f.effects.at(-1)).toMatchObject({ t: "attention", title: "Work stopped" });
    f.dispatch({ t: "boss", text: "保存された日本語", at: 4 });
    const saved = f.run.log;
    const restored = reconcileRun(f.run, f.office, { afterRestart: true, locale: "en" });
    expect(restored.log.slice(0, -1)).toEqual(saved);
    expect(restored.log.at(-1)?.text).toContain("Work stopped when the app reopened");
    f.dispatch({ t: "stop", at: 5 });
    expect(f.run.log.at(-1)?.text).toBe("Work stopped. Send an instruction below to continue.");
  });

  it("keeps failure reports sent to AI identical in both languages", () => {
    const f = fixture("en");
    f.dispatch({ t: "boss", text: "Work", at: 1 });
    f.say("[[依頼:Member]]\nWork.\n[[/依頼]]");
    const input: OfficeInput = { t: "start_failed", staffId: f.office.staff[1].id, message: "missing", at: 3 };
    expect(step(f.run, f.office, input, "en").effects).toEqual(step(f.run, f.office, input, "ja").effects);
  });

  it.each(["Read", "Write", "Edit", "Bash", "Glob", "WebSearch", "WebFetch", "TodoWrite", "Task", "mcp__test__lookup", "Other"])("describes %s in English", (name) => {
    expect(describeOfficeTool(name, {}, "en")).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });
});

describe("sample language", () => {
  afterEach(() => vi.useRealTimers());
  it("uses English prose while preserving Japanese protocol markers and delegation instructions", () => {
    vi.useFakeTimers();
    const f = fixture("en");
    const texts: string[] = [];
    const demo = createDemoDriver((_, ev) => { if (ev.kind === "assistant_text") texts.push(ev.text); });
    const send = (text: string, staff = f.office.staff[0], locale: Locale = "en") => {
      demo.send(f.office, staff, text, locale);
      vi.runAllTimers();
      return texts.at(-1)!;
    };
    expect(parseLeadDirectives(send("【社長から】\nStart")).question).toContain("Which should we emphasize");
    const delegation = parseLeadDirectives(send("【社長から】\n1"));
    expect(delegation.plain).toBe("Got it. I'll ask Member.");
    expect(delegation.delegations[0].text).toContain("brief.md を読んで");
    expect(send("work", f.office.staff[1])).toContain("I read brief.md");
    const approval = parseLeadDirectives(send("Memberさんからの報告"));
    expect(approval.approval).toEqual({ title: "Finished work (version 1)", body: "The work is ready for your review.", file: "C:/test/index.html" });
    expect(parseLeadDirectives(send("差し戻し")).approval?.title).toBe("Finished work (version 2)");
    expect(parseLeadDirectives(send("は OK です")).done).toBe(true);
    expect(parseLeadDirectives(send("お客さんからの相談")).reply).toContain("Thank you for your inquiry");
    f.office.staff = [f.office.staff[0]];
    expect(parseLeadDirectives(send("Start")).plain).toContain("no other staff");
    demo.dispose();
  });

  it("defaults to Japanese", () => {
    vi.useFakeTimers();
    const f = fixture();
    const texts: string[] = [];
    const demo = createDemoDriver((_, ev) => { if (ev.kind === "assistant_text") texts.push(ev.text); });
    demo.send(f.office, f.office.staff[0], "Start");
    vi.runAllTimers();
    expect(parseLeadDirectives(texts[0]).question).toContain("いちばん前に出したい");
    demo.dispose();
  });
});
