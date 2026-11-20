/** 仕事の状態は変えず、画面上の移動予定だけを作る。 */
import type { Office, OfficeRun } from "@/lib/office/types";
import type { OfficeLayout } from "@/lib/office/layout";
import { allSeats } from "@/lib/office/layout";
import { SCENE } from "@/lib/office/scene-map";
/** 着いてから出す会話（誰が・何を・何ミリ秒後に） */
export interface WalkTalk { id: string; text: string; delay: number }
export interface WalkStep { targets: Record<string, string>; hold: number; kind: "meeting" | "report" | "delivery" | "review" | "home" | "break" | "enter" | "research"; talk?: WalkTalk[] }
/** 会話の決まり文句（画面の言語で渡す）。頼む内容・報告の中身は、実際の仕事の文から取る */
export interface WalkLines { ask: (task: string) => string; ok: string; report: string; thanks: string }
export function bossStaff(run: OfficeRun): Set<string> {
  return new Set([
    ...(run.approval ? [run.approval.staffId] : []),
    ...run.permissions.map((p) => p.staffId),
    ...run.log.filter((m) => m.kind === "question" && !m.answered && m.staffId).map((m) => m.staffId!),
  ]);
}
export function restingNodes(run: OfficeRun, layout: OfficeLayout): Record<string, string> {
  const waiting = bossStaff(run);
  let index = 0;
  return Object.fromEntries(allSeats(layout).map((s) => [s.staff.id, waiting.has(s.staff.id) ? SCENE.waiting[index++ % SCENE.waiting.length] : s.node]));
}
export function walkChanges(before: OfficeRun, after: OfficeRun, office: Office, layout: OfficeLayout, lines?: WalkLines): WalkStep[] {
  if (before.officeId !== after.officeId) return [];
  const steps: WalkStep[] = [];
  const homes = Object.fromEntries(allSeats(layout).map((s) => [s.staff.id, s.node]));
  const waiting = bossStaff(after), wasWaiting = bossStaff(before);
  const resting = restingNodes(after, layout);
  const add = (kind: WalkStep["kind"], targets: Record<string, string>, hold = 0, talk?: WalkTalk[]) => steps.push({ kind, targets, hold, talk });
  for (const id of wasWaiting) if (!waiting.has(id) && homes[id]) add("home", { [id]: homes[id] });
  // 同時に歩くのは取りまとめ役と社員2人まで。大人数の依頼は打ち合わせを分ける。
  const lead = office.staff.find((s) => s.lead)?.id;
  const requested = office.staff.filter((s) => !s.lead && homes[s.id] && !waiting.has(s.id) && !wasWaiting.has(s.id) &&
    ((!before.awaiting.includes(s.id) && after.awaiting.includes(s.id)) ||
      (before.staff[s.id]?.status !== "working" && after.staff[s.id]?.status === "working")));
  if (lead && homes[lead] && !waiting.has(lead)) for (let i = 0; i < requested.length; i += 2) {
    const group = requested.slice(i, i + 2);
    const targets = { [lead]: SCENE.meeting[3], ...Object.fromEntries(group.map((s, j) => [s.id, SCENE.meeting[6 - j * 2]])) };
    // 会議室での会話：取りまとめ役が頼み、社員が返事をする（頼む内容は実際の依頼文の出だし）
    const talk: WalkTalk[] = lines ? [
      ...group.map((s, j) => ({ id: lead, text: lines.ask(after.staff[s.id]?.task ?? ""), delay: 200 + j * 1700 })),
      ...group.map((s, j) => ({ id: s.id, text: lines.ok, delay: 1300 + j * 1700 })),
    ] : [];
    add("meeting", targets, lines ? 1900 + group.length * 1700 : 2500, talk);
    add("home", Object.fromEntries(Object.keys(targets).map((id) => [id, homes[id]])));
  }
  for (const staff of office.staff) {
    const id = staff.id;
    if (!homes[id]) continue;
    const delivered = after.deliveries.some((d) => d.staffId === id && !before.deliveries.some((old) => old.id === d.id));
    const reported = !staff.lead && before.staff[id]?.status !== "done" && after.staff[id]?.status === "done";
    if (delivered) add("delivery", { [id]: "shelf" }, 700);
    if (reported) add("report", { [id]: "report" }, lines ? 2600 : 900, lines && lead ? [
      { id, text: after.staff[id]?.said || lines.report, delay: 150 },
      { id: lead, text: lines.thanks, delay: 1500 },
    ] : undefined);
    if ((delivered || reported) && !waiting.has(id)) add("home", { [id]: homes[id] });
  }
  for (const id of waiting) {
    const broughtDelivery = after.deliveries.some((d) => d.staffId === id && !before.deliveries.some((old) => old.id === d.id));
    if ((!wasWaiting.has(id) || broughtDelivery) && resting[id]) add("review", { [id]: resting[id] });
  }
  return steps;
}
