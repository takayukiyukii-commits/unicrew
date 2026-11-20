/** 表示専用の差分。仕事の進行・保存データには一切書き込まない。 */
import type { Office, OfficeRun } from "@/lib/office/types";

export type HandoffKind = "request" | "report" | "delivery" | "review" | "approved" | "returned" | "reply";
export interface Handoff { id: string; kind: HandoffKind; from: string; to: string }

export function handoffsBetween(before: OfficeRun, after: OfficeRun, office: Office): Handoff[] {
  if (before.officeId !== after.officeId) return [];
  const lead = office.staff.find((s) => s.lead)?.id;
  if (!lead) return [];
  const events: Handoff[] = [];
  const add = (id: string, kind: HandoffKind, from: string, to: string) => events.push({ id, kind, from, to });
  const newNotices = after.notices.filter((n) => !before.notices.some((old) => old.id === n.id));
  const delegated = new Set<string>();
  for (const id of after.awaiting) {
    if (!before.awaiting.includes(id) || (before.staff[id]?.status !== "working" && after.staff[id]?.status === "working")) {
      delegated.add(id);
      add(`request:${id}:${after.notices[0]?.id ?? after.staff[id]?.turns}`, "request", lead, id);
    }
  }
  for (const s of office.staff) {
    if (s.lead || delegated.has(s.id)) continue;
    // 最後の報告は engine 内で直ちに回収されるため、reports 配列だけに依存しない。
    const finished = (after.staff[s.id]?.turns ?? 0) > (before.staff[s.id]?.turns ?? 0);
    const reported = after.reports.some((r) => r.staffId === s.id && !before.reports.some((old) => old.staffId === r.staffId));
    const notice = newNotices.find((n) => n.staffId === s.id);
    if (before.awaiting.includes(s.id) && (reported || finished || (notice && after.staff[s.id]?.status === "done"))) {
      add(`report:${s.id}:${notice?.id ?? after.staff[s.id]?.turns}`, "report", s.id, lead);
    }
  }
  for (const d of after.deliveries) if (!before.deliveries.some((old) => old.id === d.id)) add(d.id, "delivery", d.staffId, "shelf");
  if (after.approval && after.approval.id !== before.approval?.id) add(after.approval.id, "review", after.approval.staffId, "boss");
  for (const p of after.permissions) if (!before.permissions.some((old) => old.id === p.id)) add(p.id, "review", p.staffId, "boss");
  for (const m of after.log) {
    if (before.log.some((old) => old.id === m.id)) continue;
    if (m.kind === "question" && !m.answered) add(m.id, "review", m.staffId ?? lead, "boss");
    if (m.kind === "boss" && !before.approval) {
      add(m.id, before.log.some((q) => q.kind === "question" && !q.answered) ? "reply" : "request", "boss", lead);
    }
  }
  const bossReplied = after.log.some((m) => m.kind === "boss" && !before.log.some((old) => old.id === m.id));
  // 停止で確認が消えた場合は、差し戻しと取り違えない。
  if (before.approval && after.approval?.id !== before.approval.id && bossReplied) {
    const ok = after.cheerAt > before.cheerAt;
    add(`review:${before.approval.id}`, ok ? "approved" : "returned", "boss", ok ? "boss" : before.approval.staffId);
  }
  for (const p of before.permissions) {
    if (!after.permissions.some((next) => next.id === p.id) && after.staff[p.staffId]?.status === "working") add(`reply:${p.id}`, "reply", "boss", p.staffId);
  }
  for (const inquiry of after.inbox) {
    if (inquiry.text && !before.inbox.some((old) => old.id === inquiry.id)) add(`inquiry:${inquiry.id}`, "request", "boss", lead);
  }
  return events;
}
