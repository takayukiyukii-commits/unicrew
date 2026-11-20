/** 背景の6つの島に部署を順番に割り当てる。保存データには触れない。 */
import type { Department, Office, Staff } from "./types";
import { SCENE, type ScenePoint } from "./scene-map";
export interface Seat extends ScenePoint { staff: Staff; node: string }
export interface Island { index: number; departments: Department[]; seats: Seat[] }
export interface OfficeLayout { lead: Seat | null; islands: Island[] }
export function layoutOffice(office: Office): OfficeLayout {
  const islands: Island[] = SCENE.islands.map((_, index) => ({ index, departments: [], seats: [] }));
  office.departments.forEach((dept, i) => islands[i % 6].departments.push(dept));
  const members = office.staff.filter((s) => !s.lead);
  const place = (staff: Staff, preferred: number) => {
    const island = islands[preferred].seats.length < 4 ? islands[preferred] : islands.find((i) => i.seats.length < 4);
    if (!island) return;
    // 2人なら前後の席を使い、札の間に余白を取る。
    const slot = [2, 0, 3, 1][island.seats.length];
    const node = SCENE.islands[island.index][slot];
    island.seats.push({ staff, node, ...SCENE.points[node] });
    const dept = office.departments.find((d) => d.id === staff.deptId);
    if (dept && !island.departments.some((d) => d.id === dept.id)) island.departments.push(dept);
  };
  for (const staff of members.filter((s) => office.departments.some((d) => d.id === s.deptId))) {
    place(staff, office.departments.findIndex((d) => d.id === staff.deptId) % 6);
  }
  for (const staff of members.filter((s) => !office.departments.some((d) => d.id === s.deptId))) {
    const free = islands.find((i) => i.seats.length === 0 && i.departments.length === 0) ?? islands.reduce((a, b) => a.seats.length <= b.seats.length ? a : b);
    place(staff, free.index);
  }
  const lead = office.staff.find((s) => s.lead);
  return { islands, lead: lead ? { staff: lead, node: "lead", ...SCENE.points.lead } : null };
}
export function allSeats(layout: OfficeLayout): Seat[] {
  return [...layout.islands.flatMap((i) => i.seats), ...(layout.lead ? [layout.lead] : [])];
}

