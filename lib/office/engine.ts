/**
 * AIオフィスの進行役。出来事（社長の指示・AI の実況）を受けて、会社の「いま」を次に進める。
 *
 * 画面にも Tauri にも触らない。`step(run, office, input, locale)` が新しい状態と
 * 「外でやってほしいこと（effects）」を返すだけなので、録った実況を流して試験できる。
 */
import type { Locale } from "../i18n";
import { officeT, type OfficeKey } from "./i18n";
import { describeOfficeTool } from "./tool-text";
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
/** 自動で通した許可の記録の上限（これより古いものは消える） */
export const MAX_AUTO_LOG = 300;
/** 通知の本文に出す長さ（これより長い説明は切って出す） */
const NOTIFY_BODY = 80;
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
export function reconcileRun(run: OfficeRun, office: Office, opts: { afterRestart?: boolean; locale?: Locale } = {}): OfficeRun {
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
          // 確認・質問で社長を待っている人だけ「待ち」のまま（報告待ち・許可待ちは、相手の AI がもういない）
          status: cur.status === "working" || (cur.status === "waiting" && !waitsForBoss(run, s.id)) ? "idle" : cur.status,
        }
      : cur;
  }
  const ids = new Set(office.staff.map((s) => s.id));
  const next: OfficeRun = {
    ...run,
    staff,
    awaiting: opts.afterRestart ? [] : run.awaiting.filter((id) => ids.has(id)),
    pending: run.pending ?? [],
    reports: opts.afterRestart ? [] : run.reports,
    permissions: opts.afterRestart ? [] : run.permissions.filter((p) => ids.has(p.staffId)),
  };
  // 開き直す前に預かっていて渡せなかった指示は、記録に残してから捨てる
  if (opts.afterRestart) Object.assign(next, dropPending(next, Date.now(), opts.locale ?? "ja"));
  if (opts.afterRestart && run.busy) {
    next.busy = false;
    // 閉じていた間は働いていない。時計は足さずに止める
    next.usage = { ...next.usage, activeSince: null };
    next.log = [
      ...next.log,
      {
        id: uid("m", Date.now()),
        kind: "system",
        staffId: null,
        text: officeT("engine.restarted", opts.locale ?? "ja"),
        at: Date.now(),
      },
    ];
  }
  return next;
}

/** その社員が、社長の確認か返事を待っているか。 */
function waitsForBoss(run: OfficeRun, staffId: string): boolean {
  return run.approval?.staffId === staffId || run.log.some((m) => m.kind === "question" && !m.answered && m.staffId === staffId);
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
function describeAsk(toolName: string, input: Record<string, unknown>, locale: Locale): string {
  const doing = describeOfficeTool(toolName, input, locale);
  // コマンドは省略しない（後ろに危ない操作が続いていても、許可の札で全部読めるように）。とても長いものだけ端を切る
  const cmd = typeof input.command === "string" ? `\n${input.command.trim().slice(0, 4000)}` : "";
  const action = locale === "en" ? officeT("engine.askTool", locale, { action: doing })
    : doing.replace(/(しています|ています)$/, (m) => (m === "しています" ? "しようとしています" : "ようとしています"));
  return `${action}${cmd}`;
}

/** 通知の本文に入りきるか（入りきらない説明には、通知から直接「許可する」を出さない）。 */
function fitsNotification(text: string): boolean {
  return text.replace(/\s+/g, " ").trim().length <= NOTIFY_BODY;
}

/** 自動で通した許可を、省略せずに記録に残す。 */
function pushAutoLog(run: OfficeRun, staffId: string, text: string, at: number): OfficeRun {
  return { ...run, autoLog: [{ id: uid("g", at), staffId, text, at }, ...(run.autoLog ?? [])].slice(0, MAX_AUTO_LOG) };
}

/** 確認を待たずに OK にしたとき、記録に残す中身（題だけでなく、書かれていた内容と見せるはずだったファイルも）。 */
function approvalDetail(body: string, file: string | null, locale: Locale): string {
  const parts: string[] = [];
  if (body.trim()) parts.push(officeT("engine.autoApprovedBody", locale, { body: body.trim().slice(0, 1200) }));
  if (file) parts.push(officeT("engine.autoApprovedFile", locale, { file }));
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
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

/** 失敗で終わった返事の印（AI の種類ごとに書き方が違う） */
const FAILED_RESULT = /error|fail|cancel|interrupt/i;

/** 自動で進める設定のとき、1つの仕事で質問に自動で返す回数の上限（同じ質問の繰り返しで回り続けないように。超えたら社長に聞く） */
export const MAX_AUTO_ANSWERS = 8;
/** 自動で進める設定のとき、1つの仕事で確認を待たずに OK にする回数の上限（確認→OK→また確認…で回り続けないように） */
export const MAX_AUTO_APPROVALS = 8;

const AUTO_OK = (title: string) => `【社長から】「${title}」は OK です（社長は「最後まで自動で進める」設定にしています。中身はあとで見ます）。\n続きを進めてください。`;
const AUTO_ANSWER = "【社長から】いまは「最後まで自動で進める」設定で、質問にすぐ答えられません。あなたのおすすめの案で進めてください。あとで戻せるやり方を選び、決めたことと理由を報告に書いてください。外への公開・送信・支払い・消す操作だけは、進めずに報告に「社長の判断待ち」と書いてください。";

/** 預かれる指示の数（これを超えたら受け付けない。黙って古い物を捨てない） */
const MAX_PENDING = 30;

/** 取りまとめ役が、新しい指示を受け取れる状態か（作業中・報告待ち・確認待ち・許可待ちの間は受け取らない）。 */
function leadFree(run: OfficeRun, leadId: string): boolean {
  return run.staff[leadId]?.status !== "working" && run.awaiting.length === 0 && !run.approval && !run.permissions.some((p) => p.staffId === leadId);
}

/** いま指示を受け取れるか（すぐ渡せる、または預かれる）。受け取れないときは、送り手の側で持っていてもらう。 */
export function canTakeInstruction(run: OfficeRun, office: Office): boolean {
  const lead = leadOf(office);
  if (!lead) return false;
  return leadFree(run, lead.id) || (run.pending ?? []).length < MAX_PENDING;
}

/** 前の仕事の印（完了・付箋）を片づけ、使った量を数え直す。 */
function beginFreshJob(run: OfficeRun): OfficeRun {
  const staff: Record<string, StaffRuntime> = {};
  for (const [id, s] of Object.entries(run.staff)) {
    staff[id] = { ...s, status: "idle", bubble: null, task: null, turns: 0, inputTokens: 0, outputTokens: 0 };
  }
  return { ...run, staff, autoAnswers: 0, autoApprovals: 0, usage: { leadTurns: 0, staffTurns: 0, inputTokens: 0, outputTokens: 0, startedAt: null, activeMs: 0, activeSince: null } };
}

const BOSS_PREFIX = "【社長から】\n";

/** 渡せなかった指示を、記録に残してから捨てる（黙って消さない）。 */
function dropPending(run: OfficeRun, at: number, locale: Locale): OfficeRun {
  const pending = run.pending ?? [];
  if (pending.length === 0) return run;
  const list = pending.map((p) => `・${clip(p.startsWith(BOSS_PREFIX) ? p.slice(BOSS_PREFIX.length) : p, 80)}`).join("\n");
  return pushLog({ ...run, pending: [] }, { kind: "system", staffId: null, text: officeT("engine.pendingDropped", locale, { list }), at });
}

export function step(run0: OfficeRun, office: Office, input: OfficeInput, locale: Locale = "ja"): StepResult {
  const r = stepInner(run0, office, input, locale);
  const lead = leadOf(office);
  const pending = r.run.pending ?? [];
  // 預かっていた指示：取りまとめ役の返事が普通に終わって手が空いたら、まとめて渡す。
  // 失敗で止まった直後には渡さない（同じ返事の「失敗」の知らせが続けて届き、次の仕事まで止めてしまうため。次に指示を送ったとき一緒に渡す）
  // （社員の返事では渡さない。取りまとめ役が失敗で止まったあとに、まだ動いていた社員の返事が届くことがある）
  const turnEnded = (input.t === "agent" && input.ev.kind === "result" && input.staffId === lead?.id && !FAILED_RESULT.test(input.ev.subtype ?? "")) || input.t === "sync";
  const leadRt = lead ? r.run.staff[lead.id] : undefined;
  if (lead && leadRt && turnEnded && pending.length > 0 && leadFree(r.run, lead.id) && !waitsForBoss(r.run, lead.id) && (leadRt.status === "done" || leadRt.status === "idle")) {
    const at = "at" in input ? input.at : Date.now();
    let run: OfficeRun = { ...r.run, pending: [] };
    if (leadRt.status === "done") {
      // 「完了」のあとの指示は、新しい仕事として数え直す
      run = beginFreshJob(run);
      const first = pending[0];
      run = setStaff(run, lead.id, { task: clip(first.startsWith(BOSS_PREFIX) ? first.slice(BOSS_PREFIX.length) : first, 28) });
    }
    run = setStaff(run, lead.id, { status: "working", bubble: officeT("engine.thinking", locale), draft: "", tools: {} });
    run = { ...run, busy: true, usage: openClock(run.usage, at) };
    return { run, effects: [...r.effects, { t: "send", staffId: lead.id, text: pending.join("\n\n") }] };
  }
  return r;
}

function stepInner(run0: OfficeRun, office: Office, input: OfficeInput, locale: Locale): StepResult {
  const t = (key: OfficeKey, vars?: Record<string, string | number>) => officeT(key, locale, vars);
  const effects: OfficeEffect[] = [];
  const lead = leadOf(office);
  let run = run0;
  if (!lead) return { run, effects };

  /** 取りまとめ役に渡す。手が空いていなければ預かっておき、空いたときに渡す（返事の途中に割り込まない）。 */
  const sendOrHold = (text: string, at: number, answersQuestion = false) => {
    const held = run.pending ?? [];
    if (leadFree(run, lead.id)) {
      // 預かったままの指示があれば一緒に渡す（質問への返事は先に、ほかは届いた順に）
      run = { ...run, pending: [] };
      return sendToLead((answersQuestion ? [text, ...held] : [...held, text]).join("\n\n"), at);
    }
    if (held.length >= MAX_PENDING) {
      run = pushLog(run, { kind: "system", staffId: null, text: t("engine.queueFull", { n: MAX_PENDING }), at });
      return;
    }
    run = { ...run, pending: [...held, text] };
    run = pushLog(run, { kind: "system", staffId: null, text: t("engine.queued", { name: lead.name }), at });
  };
  const sendToLead = (text: string, at: number) => {
    run = setStaff(run, lead.id, { status: "working", bubble: t("engine.thinking"), draft: "", tools: {} });
    run = { ...run, busy: true, usage: openClock(run.usage, at) };
    effects.push({ t: "send", staffId: lead.id, text });
  };

  switch (input.t) {
    case "started": {
      const prev = run.staff[input.staffId];
      // 前の会話の続きでない起動なら、前の会話の番号は捨てる（別の AI・別のフォルダの番号で続きから始めない）
      run = setStaff(run, input.staffId, { started: true, sessionKey: input.sessionKey ?? prev?.sessionKey, cliSessionId: input.fresh ? null : prev?.cliSessionId ?? null });
      return { run, effects };
    }

    case "start_failed": {
      const who = office.staff.find((s) => s.id === input.staffId);
      run = pushNotice(run, input.staffId, t("engine.startFailed", { name: who?.name ?? t("engine.staff") }), input.at);
      // 入っていない AI を選んでいるときは、直し方が分かる文にする（生のエラー文だけを出さない）
      const missing = !/session/i.test(input.message) && /program not found|command not found|no such file|cannot find the (file|path)|見つかりません|os error 2\b/i.test(input.message);
      run = failStaff(run, office, input.staffId, `AI を起動できませんでした（${clip(input.message, 200)}）`, input.at, effects, locale, t(missing ? "engine.cliMissing" : "engine.startError", { message: clip(input.message, 200), name: who?.name ?? t("engine.staff") }));
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
      if (fresh) run = beginFreshJob(run);
      run = pushLog(run, { kind: "boss", staffId: null, text, at: input.at });
      run = setStaff(run, lead.id, { task: fresh ? clip(text, 28) : run.staff[lead.id]?.task ?? clip(text, 28) });
      run = { ...run, briefed: true };
      sendOrHold(`${BOSS_PREFIX}${text}`, input.at, !!lastQ);
      return { run, effects };
    }

    case "inquiry": {
      const text = input.text.trim();
      if (!text) return { run, effects };
      run = { ...run, inbox: [{ id: uid("q", input.at), text, at: input.at, reply: null, replyAt: null }, ...run.inbox].slice(0, 30) };
      run = pushNotice(run, null, t("engine.inquiry"), input.at);
      if (!run.staff[lead.id]?.task) run = setStaff(run, lead.id, { task: clip(t("engine.inquiryTask", { text }), 28) });
      sendOrHold(inquiryMessage(text), input.at);
      return { run, effects };
    }

    case "approve": {
      const ap = run.approval;
      if (!ap) return { run, effects };
      // 通知のボタンからの答え：もう別の確認に変わっていたら何もしない（古い通知で新しい確認を通さない）
      if (input.approvalId !== undefined && input.approvalId !== ap.id) return { run, effects };
      run = { ...run, approval: null, cheerAt: input.ok ? input.at : run.cheerAt };
      const comment = input.comment.trim();
      run = pushLog(run, {
        kind: "boss",
        staffId: null,
        text: t(input.ok ? "engine.approved" : "engine.rejected", { title: ap.title, comment: comment ? t("engine.comment", { comment }) : "" }),
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
      if (!stillAsked) run = setStaff(run, ask.staffId, { status: "working", bubble: input.allow ? t("engine.continuing") : t("engine.alternative") });
      return { run: settle(run, input.at), effects };
    }

    case "auto": {
      // 切り替えたことを記録に残す（いつから自動で進めたかが、あとで分かるように）
      run = pushLog(run, { kind: "system", staffId: null, text: t(office.autoMode ? "auto.turnedOn" : "auto.turnedOff"), at: input.at });
      if (!office.autoMode) return { run, effects };
      // いま待っている許可は全部通す
      for (const ask of run.permissions) {
        effects.push({ t: "permission", staffId: ask.staffId, requestId: ask.requestId, allow: true });
        run = setStaff(run, ask.staffId, { status: "working", bubble: t("engine.continuing") });
        run = pushAutoLog(run, ask.staffId, ask.text, input.at);
      }
      if (run.permissions.length > 0) run = pushLog(run, { kind: "system", staffId: null, text: t("engine.autoAllowedAll", { n: run.permissions.length }), at: input.at });
      run = { ...run, permissions: [] };
      const ap = run.approval;
      const openQ = [...run.log].reverse().find((m) => m.kind === "question" && !m.answered);
      if (ap) {
        run = { ...run, approval: null, cheerAt: input.at, autoApprovals: (run.autoApprovals ?? 0) + 1 };
        run = pushLog(run, { kind: "system", staffId: null, text: t("engine.autoApproved", { title: ap.title, detail: approvalDetail(ap.body, ap.file, locale) }), at: input.at });
        sendToLead(AUTO_OK(ap.title), input.at);
      } else if (openQ && run.staff[lead.id]?.status === "waiting" && (run.autoAnswers ?? 0) < MAX_AUTO_ANSWERS) {
        run = { ...run, autoAnswers: (run.autoAnswers ?? 0) + 1, log: run.log.map((m) => (m.id === openQ.id ? { ...m, answered: true } : m)) };
        run = pushLog(run, { kind: "system", staffId: null, text: t("engine.autoAnswered"), at: input.at });
        sendToLead(AUTO_ANSWER, input.at);
      }
      return { run: settle(run, input.at), effects };
    }

    case "sync": {
      // 社員を消した・入れ替えたあと：いない人の報告は待たない。そろっていれば取りまとめ役に渡す
      run = reconcileRun(run, office, { locale });
      const leadRt = run.staff[lead.id];
      if (leadRt?.status === "waiting" && !waitsForBoss(run, lead.id) && !run.permissions.some((p) => p.staffId === lead.id)) {
        if (run.awaiting.length === 0 && run.reports.length === 0) run = setStaff(run, lead.id, { status: "idle", bubble: null });
        else run = collectReports(run, office, input.at, effects, locale);
      }
      return { run: settle(run, input.at), effects };
    }

    case "suspend": {
      // 会社を切り替える・消す：起動している AI を全部止める。確認・質問の札は残す（戻ってきたら続けられる）
      for (const s of office.staff) {
        const rt = run.staff[s.id];
        if (!rt) continue;
        if (rt.started || rt.status === "working" || rt.status === "waiting") effects.push({ t: "stop", staffId: s.id });
        run = setStaff(run, s.id, { started: false, draft: "", tools: {}, turnIn: 0, turnOut: 0, status: rt.status === "working" || (rt.status === "waiting" && !waitsForBoss(run, s.id)) ? "idle" : rt.status, bubble: rt.status === "working" ? null : rt.bubble });
      }
      run = { ...run, awaiting: [], reports: [], permissions: [] };
      run = dropPending(run, input.at, locale);
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
      run = dropPending(run, input.at, locale);
      run = pushLog(run, { kind: "system", staffId: null, text: t("engine.stopped"), at: input.at });
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
          run = setStaff(run, who.id, { draft: rt.draft + ev.text, bubble: who.lead ? t("engine.replying") : t("engine.reporting") });
          return { run, effects };
        }
        case "tool_use": {
          if (rt.status !== "working" && rt.status !== "waiting") return { run, effects };
          const tools = { ...rt.tools, [ev.tool_use_id]: { name: ev.tool_name, input: ev.tool_input ?? {}, done: false, error: false } };
          const bubble = describeOfficeTool(ev.tool_name, ev.tool_input ?? {}, locale);
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
          // 止めたあと・終わったあとに遅れて届いた許可の求めは受けない（答える相手がもういない）
          if (rt.status !== "working" && rt.status !== "waiting") return { run, effects };
          const at = input.at;
          if (office.autoMode) {
            // 最後まで自動で進める設定：聞かずに通す（何を通したかは記録に残す）
            const what = describeAsk(ev.tool_name, ev.input ?? {}, locale);
            effects.push({ t: "permission", staffId: who.id, requestId: ev.request_id, allow: true });
            run = pushAutoLog(run, who.id, what, at);
            run = pushNotice(run, who.id, t("engine.autoAllowed", { name: who.name, text: clip(what, NOTIFY_BODY) }), at);
            return { run, effects };
          }
          const askId = uid("p", at);
          run = {
            ...run,
            permissions: [
              ...run.permissions,
              { id: askId, staffId: who.id, requestId: ev.request_id, toolName: ev.tool_name, text: describeAsk(ev.tool_name, ev.input ?? {}, locale), at },
            ],
          };
          run = setStaff(run, who.id, { status: "waiting", bubble: t("engine.permission") });
          run = pushNotice(run, who.id, t("engine.permissionNotice", { name: who.name }), at);
          const askText = describeAsk(ev.tool_name, ev.input ?? {}, locale);
          effects.push({
            t: "attention",
            title: t("engine.permissionNotice", { name: who.name }),
            body: clip(askText, NOTIFY_BODY),
            // 通知に入りきらない長い操作は、通知から直接は許可させない（見えていない後ろの部分まで通してしまうため）。開いて全部読んでもらう
            ask: { tag: `perm:${askId}`, actions: fitsNotification(askText) ? [{ id: "allow", label: t("perm.allow") }, { id: "deny", label: t("perm.deny") }] : [{ id: "open", label: t("notify.openFull") }] },
          });
          return { run: settle(run, at), effects };
        }
        case "error": {
          run = pushNotice(run, who.id, t("engine.staffStopped", { name: who.name }), input.at);
          run = failStaff(run, office, who.id, clip(ev.message, 300), input.at, effects, locale);
          return { run: settle(run, input.at), effects };
        }
        case "result": {
          if (rt.status !== "working") return { run, effects };
          // 失敗で終わった返事は、できあがった報告として扱わない（途中の文に書かれた合図も実行しない）
          if (FAILED_RESULT.test(ev.subtype ?? "")) {
            run = pushNotice(run, who.id, t("engine.staffStopped", { name: who.name }), input.at);
            run = failStaff(run, office, who.id, `AI が失敗を返して止まりました（${clip(ev.subtype, 60)}）`, input.at, effects, locale, t("engine.resultError", { detail: clip(ev.subtype, 60) }));
            return { run: settle(run, input.at), effects };
          }
          run = finishTurn(run, office, who, input.at, effects, locale);
          return { run: settle(run, input.at), effects };
        }
      }
      return { run, effects };
    }
  }
  return { run, effects };
}

/** 社員が途中で止まったときの後始末（取りまとめ役なら社長に知らせ、社員なら報告として返す）。 */
function failStaff(run0: OfficeRun, office: Office, staffId: string, message: string, at: number, effects: OfficeEffect[], locale: Locale, displayMessage = message): OfficeRun {
  const t = (key: OfficeKey, vars?: Record<string, string | number>) => officeT(key, locale, vars);
  let run = run0;
  const who = office.staff.find((s) => s.id === staffId);
  if (!who) return run;
  run = setStaff(run, staffId, { status: "idle", bubble: null, draft: "", tools: {}, started: false, turnIn: 0, turnOut: 0 });
  // 止まった AI が出していた許可の求めは、もう答えられない
  run = { ...run, permissions: run.permissions.filter((p) => p.staffId !== staffId) };
  if (who.lead) {
    run = { ...run, awaiting: [], reports: [] };
    run = pushLog(run, {
      kind: "system",
      staffId: null,
      text: t("engine.failureDetail", { name: who.name, message: displayMessage }),
      at,
    });
    effects.push({ t: "attention", title: t("engine.failed"), body: clip(displayMessage, 80) });
    return run;
  }
  // 同じ人の失敗を2回数えない
  if (run.awaiting.includes(staffId) && !run.reports.some((r) => r.staffId === staffId)) {
    run = { ...run, reports: [...run.reports, { staffId, text: `作業の途中で止まりました。起きたこと: ${message}`, files: [], failed: true }] };
    run = collectReports(run, office, at, effects, locale);
  }
  return run;
}

/** 待っていた報告が全部そろったら、取りまとめ役に渡す。 */
function collectReports(run0: OfficeRun, office: Office, at: number, effects: OfficeEffect[], locale: Locale): OfficeRun {
  const t = (key: OfficeKey, vars?: Record<string, string | number>) => officeT(key, locale, vars);
  let run = run0;
  const lead = leadOf(office);
  if (!lead) return run;
  const got = new Set(run.reports.map((r) => r.staffId));
  const note = run.reports.filter((r) => r.staffId === NOTE).map((r) => r.text).join("\n\n");
  const remaining = run.awaiting.filter((id) => !got.has(id));
  if (remaining.length > 0) {
    const names = remaining.map((id) => office.staff.find((s) => s.id === id)?.name ?? t("engine.staff")).join(locale === "en" ? ", " : "・");
    run = setStaff(run, lead.id, { bubble: t("engine.waitingReports", { names }) });
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
  run = setStaff(run, lead.id, { status: "working", bubble: t("engine.readingReports"), draft: "", tools: {} });
  effects.push({ t: "send", staffId: lead.id, text });
  return run;
}

/** 1回の返事（ターン）が終わったとき。 */
function finishTurn(run0: OfficeRun, office: Office, who: Staff, at: number, effects: OfficeEffect[], locale: Locale): OfficeRun {
  const t = (key: OfficeKey, vars?: Record<string, string | number>) => officeT(key, locale, vars);
  let run = run0;
  const rt = run.staff[who.id];
  const lead = leadOf(office);
  if (!rt || !lead) return run;
  const arts = collectArtifacts(toolBlocks(rt), office.workspace);
  const draft = rt.draft;
  run = setStaff(run, who.id, { draft: "", tools: {}, turns: rt.turns + 1, turnIn: 0, turnOut: 0, said: clip(parseLeadDirectives(draft).plain.replace(/[#*`>|_]/g, "").replace(/^[①-⑩\d.．、\s]+/, ""), 38) || null });
  run = {
    ...run,
    usage: { ...run.usage, leadTurns: run.usage.leadTurns + (who.lead ? 1 : 0), staffTurns: run.usage.staffTurns + (who.lead ? 0 : 1) },
  };
  if (arts.length > 0) {
    run = {
      ...run,
      deliveries: [...arts.map((a) => ({ id: uid("d", at), staffId: who.id, artifact: a, at })).reverse(), ...run.deliveries].slice(0, MAX_DELIVERIES),
    };
    run = pushNotice(run, who.id, t("engine.delivered", { name: who.name, file: arts[arts.length - 1].name, more: arts.length > 1 ? t("engine.moreFiles", { n: arts.length - 1 }) : "" }), at);
  }

  if (!who.lead) {
    // 社員：報告として預かる
    run = setStaff(run, who.id, { status: "done", bubble: t("engine.done") });
    if (run.awaiting.includes(who.id)) {
      run = { ...run, reports: [...run.reports, { staffId: who.id, text: draft, files: arts.map((a) => a.target), failed: false }] };
      run = pushNotice(run, who.id, t("engine.reported", { name: who.name, lead: lead.name }), at);
      run = collectReports(run, office, at, effects, locale);
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
    run = pushNotice(run, who.id, t("engine.inquiryDraft"), at);
    effects.push({ t: "attention", title: t("engine.draftReady"), body: clip(d.reply, 80) });
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
        run = setStaff(run, x.staff.id, { status: "working", bubble: t("engine.received", { lead: lead.name }), task: clip(x.text, 28), draft: "", tools: {} });
        run = pushNotice(run, x.staff.id, t("engine.delegated", { lead: lead.name, name: x.staff.name }), at);
        effects.push({ t: "send", staffId: x.staff.id, text: delegationMessage(lead, x.text) });
      }
      run = { ...run, awaiting: targets.map((x) => x.staff.id), reports: [] };
      if (unknown.length > 0) {
        run = { ...run, reports: [{ staffId: NOTE, text: unknownStaffMessage(unknown, office), files: [], failed: true }] };
      }
      const names = targets.map((x) => x.staff.name).join(locale === "en" ? ", " : "・");
      run = setStaff(run, lead.id, { status: "waiting", bubble: t("engine.handedOff", { names }) });
      return run;
    }
    // 全員見つからなかった：取りまとめ役に言い直してもらう
    run = setStaff(run, lead.id, { status: "working", bubble: t("engine.checkingStaff"), draft: "", tools: {} });
    effects.push({ t: "send", staffId: lead.id, text: unknownStaffMessage(unknown, office) });
    return run;
  }

  if (d.approval) {
    if (office.autoMode && (run.autoApprovals ?? 0) >= MAX_AUTO_APPROVALS) run = pushLog(run, { kind: "system", staffId: null, text: t("engine.autoLimit"), at });
    else if (office.autoMode) {
      // 最後まで自動で進める設定：確認を待たずに OK として続ける（題・書かれていた内容・見せるはずだったファイルを記録に残す）
      run = { ...run, cheerAt: at, autoApprovals: (run.autoApprovals ?? 0) + 1 };
      run = pushLog(run, { kind: "system", staffId: null, text: t("engine.autoApproved", { title: d.approval.title, detail: approvalDetail(d.approval.body, d.approval.file, locale) }), at });
      run = setStaff(run, who.id, { status: "working", bubble: t("engine.thinking"), draft: "", tools: {} });
      effects.push({ t: "send", staffId: who.id, text: AUTO_OK(d.approval.title) });
      return run;
    }
    const approvalId = uid("a", at);
    run = { ...run, approval: { id: approvalId, staffId: who.id, title: d.approval.title, body: d.approval.body, file: d.approval.file, at } };
    run = setStaff(run, who.id, { status: "waiting", bubble: t("engine.review") });
    run = pushNotice(run, who.id, t("engine.reviewNotice", { title: d.approval.title }), at);
    effects.push({
      t: "attention",
      title: t("engine.reviewReady"),
      body: clip(d.approval.title, 80),
      ask: { tag: `approval:${approvalId}`, actions: [{ id: "ok", label: t("approval.ok") }, { id: "open", label: t("notify.open") }] },
    });
    return run;
  }

  if (d.question) {
    if (office.autoMode && (run.autoAnswers ?? 0) < MAX_AUTO_ANSWERS) {
      // 最後まで自動で進める設定：質問は記録に残し、おすすめの案で進めてもらう
      run = pushLog(run, { kind: "question", staffId: who.id, text: d.question, at, answered: true });
      run = pushLog(run, { kind: "system", staffId: null, text: t("engine.autoAnswered"), at });
      run = { ...run, autoAnswers: (run.autoAnswers ?? 0) + 1 };
      run = setStaff(run, who.id, { status: "working", bubble: t("engine.thinking"), draft: "", tools: {} });
      effects.push({ t: "send", staffId: who.id, text: AUTO_ANSWER });
      return run;
    }
    if (office.autoMode) run = pushLog(run, { kind: "system", staffId: null, text: t("engine.autoLimit"), at });
    run = pushLog(run, { kind: "question", staffId: who.id, text: d.question, at, answered: false });
    run = setStaff(run, who.id, { status: "waiting", bubble: t("engine.answer") });
    run = pushNotice(run, who.id, t("engine.question", { name: who.name }), at);
    effects.push({ t: "attention", title: t("engine.question", { name: who.name }), body: clip(d.question, 80) });
    return run;
  }

  // 完了、または合図なしの返事（＝社長の番）
  run = setStaff(run, who.id, { status: d.done ? "done" : "idle", bubble: d.done ? t("engine.jobDone") : null });
  if (d.done) {
    run = pushNotice(run, who.id, t("engine.jobFinished"), at);
    effects.push({ t: "attention", title: t("engine.finished"), body: clip(d.plain || run.staff[who.id]?.task || "", 80) });
    const all = run.deliveries.filter((x) => run.usage.startedAt !== null && x.at >= run.usage.startedAt).map((x) => x.artifact);
    if (all.length > 0) effects.push({ t: "preview", artifacts: all });
  } else if (d.plain) {
    effects.push({ t: "attention", title: t("engine.reply", { name: who.name }), body: clip(d.plain, 80) });
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
