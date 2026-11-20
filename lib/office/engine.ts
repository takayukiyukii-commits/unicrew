/**
 * AIオフィスの進行役。出来事（社長の指示・AI の実況）を受けて、会社の「いま」を次に進める。
 *
 * 画面にも Tauri にも触らない。`step(run, office, input)` が新しい状態と
 * 「外でやってほしいこと（effects）」を返すだけなので、録った実況を流して試験できる。
 */
import { describeTool } from "../progress-text";
import { collectArtifacts } from "../turn-artifacts";
import type { ToolUseBlock } from "../types";
import {
  delegationMessage,
  findStaffByName,
  inquiryMessage,
  parseLeadDirectives,
  reportsMessage,
  unknownStaffMessage,
} from "./protocol";
import type {
  Office,
  OfficeEffect,
  OfficeInput,
  OfficeRun,
  Staff,
  StaffRuntime,
} from "./types";

const MAX_LOG = 200;
const MAX_NOTICES = 60;
const MAX_DELIVERIES = 100;
/** 報告の束に添える連絡（社員の報告ではないもの）の印 */
const NOTE = "__note__";

let seq = 0;
function uid(prefix: string, at: number): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${at.toString(36)}-${seq.toString(36)}`;
}

export function emptyStaffRuntime(): StaffRuntime {
  return {
    status: "idle",
    bubble: null,
    task: null,
    draft: "",
    tools: {},
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cliSessionId: null,
    started: false,
    turnIn: 0,
    turnOut: 0,
  };
}

export function emptyRun(office: Office): OfficeRun {
  const staff: Record<string, StaffRuntime> = {};
  for (const s of office.staff) staff[s.id] = emptyStaffRuntime();
  return {
    officeId: office.id,
    staff,
    log: [],
    approval: null,
    permissions: [],
    deliveries: [],
    notices: [],
    inbox: [],
    cheerAt: 0,
    usage: { leadTurns: 0, staffTurns: 0, inputTokens: 0, outputTokens: 0, startedAt: null, activeMs: 0, activeSince: null },
    awaiting: [],
    reports: [],
    busy: false,
    briefed: false,
  };
}

/** 社員が増えた・減ったあとに、状態の持ち主をそろえる。開き直したときの「動いている」も戻す。 */
export function reconcileRun(run: OfficeRun, office: Office, opts: { afterRestart?: boolean } = {}): OfficeRun {
  const staff: Record<string, StaffRuntime> = {};
  for (const s of office.staff) {
    const cur = run.staff[s.id] ?? emptyStaffRuntime();
    staff[s.id] = opts.afterRestart
      ? {
          ...cur,
          started: false,
          draft: "",
          tools: {},
          bubble: null,
          turnIn: 0,
          turnOut: 0,
          // 開き直すと AI は止まっている。動いていた人は「止まった」ことが分かるよう待機に戻す
          status: cur.status === "working" ? "idle" : cur.status,
        }
      : cur;
  }
  const ids = new Set(office.staff.map((s) => s.id));
  const next: OfficeRun = {
    ...run,
    staff,
    awaiting: opts.afterRestart ? [] : run.awaiting.filter((id) => ids.has(id)),
    reports: opts.afterRestart ? [] : run.reports,
    permissions: opts.afterRestart ? [] : run.permissions.filter((p) => ids.has(p.staffId)),
  };
  if (opts.afterRestart && run.busy) {
    next.busy = false;
    next.usage = closeClock(next.usage, Date.now());
    next.log = [
      ...next.log,
      {
        id: uid("m", Date.now()),
        kind: "system",
        staffId: null,
        text: "アプリを開き直したので、進めていた仕事は止まっています。続きを頼むときは、下の欄から指示を送ってください（これまでの話は覚えています）。",
        at: Date.now(),
      },
    ];
  }
  return next;
}

function leadOf(office: Office): Staff | null {
  return office.staff.find((s) => s.lead) ?? office.staff[0] ?? null;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function openClock(u: OfficeRun["usage"], at: number): OfficeRun["usage"] {
  return u.activeSince === null ? { ...u, startedAt: u.startedAt ?? at, activeSince: at } : u;
}

function closeClock(u: OfficeRun["usage"], at: number): OfficeRun["usage"] {
  return u.activeSince === null ? u : { ...u, activeMs: u.activeMs + Math.max(0, at - u.activeSince), activeSince: null };
}

/** いまの「動いた時間」（動いている間も進む）。 */
export function activeMsOf(u: OfficeRun["usage"], now: number): number {
  return u.activeMs + (u.activeSince === null ? 0 : Math.max(0, now - u.activeSince));
}

function setStaff(run: OfficeRun, id: string, patch: Partial<StaffRuntime>): OfficeRun {
  const cur = run.staff[id] ?? emptyStaffRuntime();
  return { ...run, staff: { ...run.staff, [id]: { ...cur, ...patch } } };
}

function pushLog(run: OfficeRun, m: Omit<OfficeRun["log"][number], "id">): OfficeRun {
  return { ...run, log: [...run.log, { ...m, id: uid("m", m.at) }].slice(-MAX_LOG) };
}

function pushNotice(run: OfficeRun, staffId: string | null, text: string, at: number): OfficeRun {
  return { ...run, notices: [{ id: uid("n", at), staffId, text, at }, ...run.notices].slice(0, MAX_NOTICES) };
}

function toolBlocks(rt: StaffRuntime): ToolUseBlock[] {
  return Object.entries(rt.tools).map(([id, t]) => ({
    kind: "tool_use" as const,
    toolUseId: id,
    toolName: t.name,
    input: t.input,
    status: t.error ? ("errored" as const) : t.done ? ("completed" as const) : ("pending" as const),
    isError: t.error,
    result: t.result,
  }));
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .join("\n");
  }
  return "";
}

/** 道具の許可を求められたとき、何をしようとしているかを人の言葉にする。 */
function describeAsk(toolName: string, input: Record<string, unknown>): string {
  const doing = describeTool(
    { kind: "tool_use", toolUseId: "", toolName, input, status: "pending" },
    false,
  );
  const cmd = typeof input.command === "string" ? `\n${clip(input.command, 160)}` : "";
  return `${doing.replace(/(しています|ています)$/, (m) => (m === "しています" ? "しようとしています" : "ようとしています"))}${cmd}`;
}

/** 全員が手を止めたか（社長の番か）を見て busy と時計を合わせる。 */
function settle(run: OfficeRun, at: number): OfficeRun {
  const anyWorking = Object.values(run.staff).some((s) => s.status === "working");
  if (anyWorking) return run.busy ? run : { ...run, busy: true, usage: openClock(run.usage, at) };
  return { ...run, busy: false, usage: closeClock(run.usage, at) };
}

export interface StepResult {
  run: OfficeRun;
  effects: OfficeEffect[];
}

export function step(run0: OfficeRun, office: Office, input: OfficeInput): StepResult {
  const effects: OfficeEffect[] = [];
  const lead = leadOf(office);
  let run = run0;
  if (!lead) return { run, effects };

  const sendToLead = (text: string, at: number) => {
    run = setStaff(run, lead.id, { status: "working", bubble: "考えています", draft: "", tools: {} });
    run = { ...run, busy: true, usage: openClock(run.usage, at) };
    effects.push({ t: "send", staffId: lead.id, text });
  };

  switch (input.t) {
    case "started": {
      run = setStaff(run, input.staffId, { started: true });
      return { run, effects };
    }

    case "start_failed": {
      const who = office.staff.find((s) => s.id === input.staffId);
      run = pushNotice(run, input.staffId, `${who?.name ?? "社員"}さんの AI を起動できませんでした`, input.at);
      run = failStaff(run, office, input.staffId, `AI を起動できませんでした（${clip(input.message, 200)}）`, input.at, effects);
      return { run: settle(run, input.at), effects };
    }

    case "boss": {
      const text = input.text.trim();
      if (!text) return { run, effects };
      // 質問に答えた扱いにする（いちばん新しい未回答の質問）
      const lastQ = [...run.log].reverse().find((m) => m.kind === "question" && !m.answered);
      if (lastQ) run = { ...run, log: run.log.map((m) => (m.id === lastQ.id ? { ...m, answered: true } : m)) };
      // 「完了」と言われたあとの指示だけを新しい仕事として数え直す（途中の相談では数字を消さない）
      const fresh = !run.busy && run.awaiting.length === 0 && !run.approval && !lastQ && run.staff[lead.id]?.status === "done";
      if (fresh) {
        // 新しい仕事。前の仕事の印（完了・付箋）を片づけ、使った量を数え直す
        const staff: Record<string, StaffRuntime> = {};
        for (const [id, s] of Object.entries(run.staff)) {
          staff[id] = { ...s, status: "idle", bubble: null, task: null, turns: 0, inputTokens: 0, outputTokens: 0 };
        }
        run = {
          ...run,
          staff,
          usage: { leadTurns: 0, staffTurns: 0, inputTokens: 0, outputTokens: 0, startedAt: null, activeMs: 0, activeSince: null },
        };
      }
      run = pushLog(run, { kind: "boss", staffId: null, text, at: input.at });
      run = setStaff(run, lead.id, { task: fresh ? clip(text, 28) : run.staff[lead.id]?.task ?? clip(text, 28) });
      run = { ...run, briefed: true };
      sendToLead(`【社長から】\n${text}`, input.at);
      return { run, effects };
    }

    case "inquiry": {
      const text = input.text.trim();
      if (!text) return { run, effects };
      run = { ...run, inbox: [{ id: uid("q", input.at), text, at: input.at, reply: null, replyAt: null }, ...run.inbox].slice(0, 30) };
      run = pushNotice(run, null, "お客さんからの相談が届きました", input.at);
      if (!run.staff[lead.id]?.task) run = setStaff(run, lead.id, { task: clip(`相談への返事：${text}`, 28) });
      sendToLead(inquiryMessage(text), input.at);
      return { run, effects };
    }

    case "approve": {
      const ap = run.approval;
      if (!ap) return { run, effects };
      run = { ...run, approval: null, cheerAt: input.ok ? input.at : run.cheerAt };
      const comment = input.comment.trim();
      run = pushLog(run, {
        kind: "boss",
        staffId: null,
        text: input.ok ? `「${ap.title}」に OK を出しました${comment ? `：${comment}` : ""}` : `「${ap.title}」を差し戻しました${comment ? `：${comment}` : ""}`,
        at: input.at,
      });
      sendToLead(
        input.ok
          ? `【社長から】「${ap.title}」は OK です。${comment ? `\n${comment}` : ""}\n続きを進めてください。`
          : `【社長から】「${ap.title}」は差し戻しです。${comment ? `\n直してほしい点: ${comment}` : "\n直してほしい点は書かれていません。どこを直すかを質問してください。"}`,
        input.at,
      );
      return { run, effects };
    }

    case "permission": {
      const ask = run.permissions.find((p) => p.id === input.askId);
      if (!ask) return { run, effects };
      run = { ...run, permissions: run.permissions.filter((p) => p.id !== ask.id) };
      effects.push({ t: "permission", staffId: ask.staffId, requestId: ask.requestId, allow: input.allow });
      const stillAsked = run.permissions.some((p) => p.staffId === ask.staffId);
      if (!stillAsked) run = setStaff(run, ask.staffId, { status: "working", bubble: input.allow ? "続きを進めています" : "別のやり方を考えています" });
      return { run: settle(run, input.at), effects };
    }

    case "stop": {
      for (const s of office.staff) {
        const rt = run.staff[s.id];
        if (rt && (rt.status === "working" || rt.status === "waiting")) {
          effects.push({ t: "stop", staffId: s.id });
          // 止めた AI は起動し直しになる（続きは CLI 側の会話の続きから）
          run = setStaff(run, s.id, { status: "idle", bubble: null, draft: "", tools: {}, started: false });
        }
      }
      run = { ...run, awaiting: [], reports: [], permissions: [], approval: null };
      run = pushLog(run, { kind: "system", staffId: null, text: "仕事を止めました。続きを頼むときは、下の欄から指示を送ってください。", at: input.at });
      return { run: settle(run, input.at), effects };
    }

    case "agent": {
      const who = office.staff.find((s) => s.id === input.staffId);
      const rt = run.staff[input.staffId];
      if (!who || !rt) return { run, effects };
      const ev = input.ev;
      switch (ev.kind) {
        case "ready":
          return { run, effects };
        case "cli_session_id":
          run = setStaff(run, who.id, { cliSessionId: ev.cli_session_id });
          return { run, effects };
        case "assistant_text": {
          if (rt.status !== "working") return { run, effects };
          run = setStaff(run, who.id, { draft: rt.draft + ev.text, bubble: who.lead ? "返事をまとめています" : "報告を書いています" });
          return { run, effects };
        }
        case "tool_use": {
          if (rt.status !== "working" && rt.status !== "waiting") return { run, effects };
          const tools = { ...rt.tools, [ev.tool_use_id]: { name: ev.tool_name, input: ev.tool_input ?? {}, done: false, error: false } };
          const bubble = describeTool(
            { kind: "tool_use", toolUseId: ev.tool_use_id, toolName: ev.tool_name, input: ev.tool_input ?? {}, status: "pending" },
            false,
          );
          // 道具を使う前に書いた文は途中のつぶやき。報告・返事には、最後の道具のあとに書いた文だけを使う
          // （2026-11-21 本物の Claude Code で実測：途中の文が報告の頭に混ざった）
          run = setStaff(run, who.id, { tools, bubble, draft: "" });
          return { run, effects };
        }
        case "tool_result": {
          const t = rt.tools[ev.tool_use_id];
          if (!t) return { run, effects };
          const tools = { ...rt.tools, [ev.tool_use_id]: { ...t, done: true, error: ev.is_error, result: resultText(ev.content).slice(0, 4000) } };
          run = setStaff(run, who.id, { tools });
          return { run, effects };
        }
        case "usage_delta": {
          // 実況の途中の数字は同じターンの中で増えていく。大きいほうを採る
          const inTok = (ev.input_tokens ?? 0) + (ev.cache_read_tokens ?? 0) + (ev.cache_creation_tokens ?? 0);
          const outTok = ev.output_tokens ?? 0;
          const addIn = Math.max(0, inTok - rt.turnIn);
          const addOut = Math.max(0, outTok - rt.turnOut);
          run = setStaff(run, who.id, {
            inputTokens: rt.inputTokens + addIn,
            outputTokens: rt.outputTokens + addOut,
            turnIn: Math.max(rt.turnIn, inTok),
            turnOut: Math.max(rt.turnOut, outTok),
          });
          run = { ...run, usage: { ...run.usage, inputTokens: run.usage.inputTokens + addIn, outputTokens: run.usage.outputTokens + addOut } };
          return { run, effects };
        }
        case "permission_request": {
          const at = input.at;
          run = {
            ...run,
            permissions: [
              ...run.permissions,
              { id: uid("p", at), staffId: who.id, requestId: ev.request_id, toolName: ev.tool_name, text: describeAsk(ev.tool_name, ev.input ?? {}), at },
            ],
          };
          run = setStaff(run, who.id, { status: "waiting", bubble: "社長の許可を待っています" });
          run = pushNotice(run, who.id, `${who.name}さんが許可を待っています`, at);
          effects.push({ t: "attention", title: `${who.name}さんが許可を待っています`, body: clip(describeAsk(ev.tool_name, ev.input ?? {}), 80) });
          return { run: settle(run, at), effects };
        }
        case "error": {
          run = pushNotice(run, who.id, `${who.name}さんの作業が止まりました`, input.at);
          run = failStaff(run, office, who.id, clip(ev.message, 300), input.at, effects);
          return { run: settle(run, input.at), effects };
        }
        case "result": {
          if (rt.status !== "working") return { run, effects };
          run = finishTurn(run, office, who, input.at, effects);
          return { run: settle(run, input.at), effects };
        }
      }
      return { run, effects };
    }
  }
  return { run, effects };
}

/** 社員が途中で止まったときの後始末（取りまとめ役なら社長に知らせ、社員なら報告として返す）。 */
function failStaff(run0: OfficeRun, office: Office, staffId: string, message: string, at: number, effects: OfficeEffect[]): OfficeRun {
  let run = run0;
  const who = office.staff.find((s) => s.id === staffId);
  if (!who) return run;
  run = setStaff(run, staffId, { status: "idle", bubble: null, draft: "", tools: {}, started: false, turnIn: 0, turnOut: 0 });
  if (who.lead) {
    run = { ...run, awaiting: [], reports: [] };
    run = pushLog(run, {
      kind: "system",
      staffId: null,
      text: `${who.name}さんの作業が止まりました。\n起きたこと: ${message}\nもう一度 指示を送ると、続きから進めます。何度も止まるときは、設定で AI にログインできているかを確かめてください。`,
      at,
    });
    effects.push({ t: "attention", title: "仕事が止まりました", body: clip(message, 80) });
    return run;
  }
  if (run.awaiting.includes(staffId)) {
    run = { ...run, reports: [...run.reports, { staffId, text: `作業の途中で止まりました。起きたこと: ${message}`, files: [], failed: true }] };
    run = collectReports(run, office, at, effects);
  }
  return run;
}

/** 待っていた報告が全部そろったら、取りまとめ役に渡す。 */
function collectReports(run0: OfficeRun, office: Office, at: number, effects: OfficeEffect[]): OfficeRun {
  let run = run0;
  const lead = leadOf(office);
  if (!lead) return run;
  const got = new Set(run.reports.map((r) => r.staffId));
  const note = run.reports.filter((r) => r.staffId === NOTE).map((r) => r.text).join("\n\n");
  const remaining = run.awaiting.filter((id) => !got.has(id));
  if (remaining.length > 0) {
    const names = remaining.map((id) => office.staff.find((s) => s.id === id)?.name ?? "社員").join("・");
    run = setStaff(run, lead.id, { bubble: `${names}さんの報告を待っています` });
    return run;
  }
  if (run.reports.length === 0) return run;
  const text = reportsMessage(
    run.reports.filter((r) => r.staffId !== NOTE).map((r) => ({
      name: office.staff.find((s) => s.id === r.staffId)?.name ?? "社員",
      text: r.text,
      files: r.files,
      failed: r.failed,
    })),
    note,
  );
  run = { ...run, awaiting: [], reports: [] };
  run = setStaff(run, lead.id, { status: "working", bubble: "報告を読んでいます", draft: "", tools: {} });
  effects.push({ t: "send", staffId: lead.id, text });
  return run;
}

/** 1回の返事（ターン）が終わったとき。 */
function finishTurn(run0: OfficeRun, office: Office, who: Staff, at: number, effects: OfficeEffect[]): OfficeRun {
  let run = run0;
  const rt = run.staff[who.id];
  const lead = leadOf(office);
  if (!rt || !lead) return run;
  const arts = collectArtifacts(toolBlocks(rt), office.workspace);
  const draft = rt.draft;
  run = setStaff(run, who.id, { draft: "", tools: {}, turns: rt.turns + 1, turnIn: 0, turnOut: 0 });
  run = {
    ...run,
    usage: { ...run.usage, leadTurns: run.usage.leadTurns + (who.lead ? 1 : 0), staffTurns: run.usage.staffTurns + (who.lead ? 0 : 1) },
  };
  if (arts.length > 0) {
    run = {
      ...run,
      deliveries: [...arts.map((a) => ({ id: uid("d", at), staffId: who.id, artifact: a, at })).reverse(), ...run.deliveries].slice(0, MAX_DELIVERIES),
    };
    run = pushNotice(run, who.id, `${who.name}さんが ${arts[arts.length - 1].name} を${arts.length > 1 ? `ほか${arts.length - 1}件 ` : ""}納品しました`, at);
  }

  if (!who.lead) {
    // 社員：報告として預かる
    run = setStaff(run, who.id, { status: "done", bubble: "できました" });
    if (run.awaiting.includes(who.id)) {
      run = { ...run, reports: [...run.reports, { staffId: who.id, text: draft, files: arts.map((a) => a.target), failed: false }] };
      run = pushNotice(run, who.id, `${who.name}さんが${lead.name}さんに報告しました`, at);
      run = collectReports(run, office, at, effects);
    }
    return run;
  }

  // 取りまとめ役：合図を読む
  const d = parseLeadDirectives(draft);
  if (d.plain) run = pushLog(run, { kind: "lead", staffId: who.id, text: d.plain, at });
  if (d.reply) {
    // いちばん古い「まだ返事が無い相談」に付ける（無ければ新しい1件として残す）
    const open = [...run.inbox].reverse().find((q) => q.reply === null);
    run = {
      ...run,
      inbox: open
        ? run.inbox.map((q) => (q.id === open.id ? { ...q, reply: d.reply, replyAt: at } : q))
        : [{ id: uid("q", at), text: "", at, reply: d.reply, replyAt: at }, ...run.inbox].slice(0, 30),
    };
    run = pushNotice(run, who.id, "相談への返事の下書きができました", at);
    effects.push({ t: "attention", title: "返事の下書きができました", body: clip(d.reply, 80) });
  }

  if (d.delegations.length > 0) {
    const unknown: string[] = [];
    const targets: { staff: Staff; text: string }[] = [];
    for (const g of d.delegations) {
      const s = findStaffByName(office, g.to);
      if (!s) unknown.push(g.to);
      else {
        const dup = targets.find((x) => x.staff.id === s.id);
        if (dup) dup.text += `\n\n${g.text}`;
        else targets.push({ staff: s, text: g.text });
      }
    }
    if (targets.length > 0) {
      for (const x of targets) {
        run = setStaff(run, x.staff.id, { status: "working", bubble: `${lead.name}さんから仕事を受け取りました`, task: clip(x.text, 28), draft: "", tools: {} });
        run = pushNotice(run, x.staff.id, `${lead.name}さんが${x.staff.name}さんに仕事を渡しました`, at);
        effects.push({ t: "send", staffId: x.staff.id, text: delegationMessage(lead, x.text) });
      }
      run = { ...run, awaiting: targets.map((x) => x.staff.id), reports: [] };
      if (unknown.length > 0) {
        run = { ...run, reports: [{ staffId: NOTE, text: unknownStaffMessage(unknown, office), files: [], failed: true }] };
      }
      const names = targets.map((x) => x.staff.name).join("・");
      run = setStaff(run, lead.id, { status: "waiting", bubble: `${names}さんに仕事を渡しました` });
      return run;
    }
    // 全員見つからなかった：取りまとめ役に言い直してもらう
    run = setStaff(run, lead.id, { status: "working", bubble: "頼む相手を確かめています", draft: "", tools: {} });
    effects.push({ t: "send", staffId: lead.id, text: unknownStaffMessage(unknown, office) });
    return run;
  }

  if (d.approval) {
    run = { ...run, approval: { id: uid("a", at), staffId: who.id, title: d.approval.title, body: d.approval.body, file: d.approval.file, at } };
    run = setStaff(run, who.id, { status: "waiting", bubble: "社長の確認を待っています" });
    run = pushNotice(run, who.id, `確認のお願いが届きました：${d.approval.title}`, at);
    effects.push({ t: "attention", title: "確認のお願いが届きました", body: clip(d.approval.title, 80) });
    return run;
  }

  if (d.question) {
    run = pushLog(run, { kind: "question", staffId: who.id, text: d.question, at, answered: false });
    run = setStaff(run, who.id, { status: "waiting", bubble: "社長の返事を待っています" });
    run = pushNotice(run, who.id, `${who.name}さんから質問が届きました`, at);
    effects.push({ t: "attention", title: `${who.name}さんから質問が届きました`, body: clip(d.question, 80) });
    return run;
  }

  // 完了、または合図なしの返事（＝社長の番）
  run = setStaff(run, who.id, { status: d.done ? "done" : "idle", bubble: d.done ? "今回の仕事は終わりです" : null });
  if (d.done) {
    run = pushNotice(run, who.id, "今回の仕事が終わりました", at);
    effects.push({ t: "attention", title: "仕事が終わりました", body: clip(d.plain || run.staff[who.id]?.task || "", 80) });
    const all = run.deliveries.filter((x) => run.usage.startedAt !== null && x.at >= run.usage.startedAt).map((x) => x.artifact);
    if (all.length > 0) effects.push({ t: "preview", artifacts: all });
  } else if (d.plain) {
    effects.push({ t: "attention", title: `${who.name}さんから返事が届きました`, body: clip(d.plain, 80) });
  }
  return run;
}

/** 案件ボードの4列。 */
export type BoardColumn = "idle" | "working" | "waiting" | "done";

export function boardOf(run: OfficeRun, office: Office): Record<BoardColumn, { staff: Staff; note: string | null }[]> {
  const cols: Record<BoardColumn, { staff: Staff; note: string | null }[]> = { idle: [], working: [], waiting: [], done: [] };
  for (const s of office.staff) {
    const rt = run.staff[s.id];
    const status = rt?.status ?? "idle";
    // 取りまとめ役が社員の報告を待っている間は「作業中」に置く（社長の番ではない）
    const needsBoss = status === "waiting" && (run.approval?.staffId === s.id || run.permissions.some((p) => p.staffId === s.id) || run.log.some((m) => m.kind === "question" && !m.answered && m.staffId === s.id));
    const col: BoardColumn = status === "waiting" ? (needsBoss ? "waiting" : "working") : status;
    cols[col].push({ staff: s, note: col === "idle" ? null : rt?.bubble ?? rt?.task ?? null });
  }
  return cols;
}

/** 社長の確認・返事・許可を待っている件数。 */
export function waitingForBoss(run: OfficeRun): number {
  return (run.approval ? 1 : 0) + run.permissions.length + run.log.filter((m) => m.kind === "question" && !m.answered).length;
}
