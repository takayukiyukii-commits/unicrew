/** 手渡しデッキ。上段に乗組員、手前中央に取りまとめ役と社長席を置く。 */
import type { Department, Office, Staff } from "./types";
export interface Seat { staff: Staff; x: number; z: number; facing: number }
export interface Island { dept: Department | null; cx: number; cz: number; w: number; d: number; seats: Seat[] }
export interface OfficeLayout { lead: Seat | null; islands: Island[]; width: number; depth: number }
export function layoutOffice(office: Office): OfficeLayout {
  const lead = office.staff.find((s) => s.lead);
  const members = office.staff.filter((s) => !s.lead);
  const ordered = [
    ...office.departments.flatMap((d) => members.filter((s) => s.deptId === d.id)),
    ...members.filter((s) => !office.departments.some((d) => d.id === s.deptId)),
  ];
  const islands: Island[] = [];
  const columns = Math.min(6, Math.max(1, Math.ceil(ordered.length / 2)));
  ordered.forEach((staff, index) => {
    const row = Math.floor(index / columns);
    const count = Math.min(columns, ordered.length - row * columns);
    const x = (index % columns - (count - 1) / 2) * (25 / columns);
    const dept = office.departments.find((d) => d.id === staff.deptId) ?? null;
    let island = islands[islands.length - 1];
    if (!island || island.cz !== row || island.dept?.id !== dept?.id) {
      island = { dept, cx: x, cz: row, w: 0, d: 1, seats: [] };
      islands.push(island);
    }
    island.seats.push({ staff, x, z: row, facing: 0 });
    island.cx = island.seats.reduce((sum, s) => sum + s.x, 0) / island.seats.length;
    island.w = (island.seats.length - 1) * (25 / columns) + 2.2;
  });
  return { lead: lead ? { staff: lead, x: 0, z: -1, facing: 0 } : null, islands, width: 26, depth: 14 };
}
export function allSeats(layout: OfficeLayout): Seat[] {
  return [...layout.islands.flatMap((i) => i.seats), ...(layout.lead ? [layout.lead] : [])];
}
export interface DeckPoint { x: number; y: number }
export function deckWorkHeight(height: number): number {
  return 146 + Math.max(98, Math.min(112, height * 0.6 - 228));
}
/** 立体・平面・書類が同じ位置を使う。下の左右は操作欄のために空ける。 */
export function deckPoint(layout: OfficeLayout, target: string, width: number, height: number): DeckPoint {
  const center = width / 2 + 36;
  const workHeight = deckWorkHeight(height);
  if (target === "boss") return { x: center - 30, y: height - 90 };
  if (target === "shelf") return { x: center + 160, y: height - 130 };
  let seat = layout.lead?.staff.id === target ? layout.lead : null;
  if (!seat) for (const island of layout.islands) {
    const match = island.seats.find((s) => s.staff.id === target);
    if (match) { seat = match; break; }
  }
  if (!seat || seat.staff.lead) return { x: center, y: workHeight + 62 };
  return { x: width / 2 + seat.x / layout.width * width, y: 64 + seat.z * (workHeight - 146) };
}

