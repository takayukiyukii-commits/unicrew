/** 仕事の状態は変えず、画面上の移動予定だけを作る。 */
import type { Office, OfficeRun } from "@/lib/office/types";
import type { OfficeLayout } from "@/lib/office/layout";
import { allSeats } from "@/lib/office/layout";
import { SCENE } from "@/lib/office/scene-map";
export interface WalkStep { targets: Record<string, string>; hold: number; kind: "meeting" | "report" | "delivery" | "review" | "home" | "break" }
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
export function walkChanges(before: OfficeRun, after: OfficeRun, office: Office, layout: OfficeLayout): WalkStep[] {
  if (before.officeId !== after.officeId) return [];
  const steps: WalkStep[] = [];
  const homes = Object.fromEntries(allSeats(layout).map((s) => [s.staff.id, s.node]));
  const waiting = bossStaff(after), wasWaiting = bossStaff(before);
  const resting = restingNodes(after, layout);
  const add = (kind: WalkStep["kind"], targets: Record<string, string>, hold = 0) => steps.push({ kind, targets, hold });
  for (const id of wasWaiting) if (!waiting.has(id) && homes[id]) add("home", { [id]: homes[id] });
  // 同時に歩くのは取りまとめ役と社員2人まで。大人数の依頼は打ち合わせを分ける。
  const lead = office.staff.find((s) => s.lead)?.id;
  const requested = office.staff.filter((s) => !s.lead && homes[s.id] && !waiting.has(s.id) && !wasWaiting.has(s.id) &&
    ((!before.awaiting.includes(s.id) && after.awaiting.includes(s.id)) ||
      (before.staff[s.id]?.status !== "working" && after.staff[s.id]?.status === "working")));
  if (lead && homes[lead] && !waiting.has(lead)) for (let i = 0; i < requested.length; i += 2) {
    const group = requested.slice(i, i + 2);
    const targets = { [lead]: SCENE.meeting[3], ...Object.fromEntries(group.map((s, j) => [s.id, SCENE.meeting[6 - j * 2]])) };
    add("meeting", targets, 2500);
    add("home", Object.fromEntries(Object.keys(targets).map((id) => [id, homes[id]])));
  }
  for (const staff of office.staff) {
    const id = staff.id;
    if (!homes[id]) continue;
    const delivered = after.deliveries.some((d) => d.staffId === id && !before.deliveries.some((old) => old.id === d.id));
    const reported = !staff.lead && before.staff[id]?.status !== "done" && after.staff[id]?.status === "done";
    if (delivered) add("delivery", { [id]: "shelf" }, 700);
    if (reported) add("report", { [id]: "report" }, 900);
    if ((delivered || reported) && !waiting.has(id)) add("home", { [id]: homes[id] });
  }
  for (const id of waiting) {
    const broughtDelivery = after.deliveries.some((d) => d.staffId === id && !before.deliveries.some((old) => old.id === d.id));
    if ((!wasWaiting.has(id) || broughtDelivery) && resting[id]) add("review", { [id]: resting[id] });
  }
  return steps;
}
