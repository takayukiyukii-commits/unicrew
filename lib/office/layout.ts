/**
 * 部屋の中の配置を決める（誰の机がどこか）。3D でも平面でも同じ配置を使う。
 *
 * 座標は床の上の x（右が＋）・z（手前が＋）。単位は「机1つぶんがおよそ 1.6」。
 * 部署は島ごとにまとめて奥に並べ（多いときは2列）、取りまとめ役の丸テーブルはいちばん手前の中央に置く。
 * 画面の下の左右には札（指示の欄・納品）が重なるので、手前は中央だけを使う。
 */
import type { Department, Office, Staff } from "./types";

export interface Seat {
  staff: Staff;
  x: number;
  z: number;
  /** 机の向き（ラジアン。0＝手前を向いて座る） */
  facing: number;
}

export interface Island {
  dept: Department | null;
  /** 島の中心と大きさ（敷物を描く） */
  cx: number;
  cz: number;
  w: number;
  d: number;
  seats: Seat[];
}

export interface OfficeLayout {
  lead: Seat | null;
  islands: Island[];
  /** 部屋の大きさ（床を描く） */
  width: number;
  depth: number;
}

const DESK_W = 2.35;
const ISLAND_PAD = 0.7;
const ISLAND_D = 2.6;
const ROW_GAP = 4.1;
const COL_GAP = 0.9;
const MAX_PER_ISLAND_ROW = 4;

export function layoutOffice(office: Office): OfficeLayout {
  const leadStaff = office.staff.find((s) => s.lead) ?? null;
  const members = office.staff.filter((s) => !s.lead);

  // 部署ごとに分ける（部署なしの人は最後の島にまとめる）
  const groups: { dept: Department | null; staff: Staff[] }[] = [];
  for (const d of office.departments) {
    const list = members.filter((s) => s.deptId === d.id);
    if (list.length > 0) groups.push({ dept: d, staff: list });
  }
  const loose = members.filter((s) => !office.departments.some((d) => d.id === s.deptId));
  if (loose.length > 0) groups.push({ dept: null, staff: loose });

  // 人数が多い島は2つに割る（横に長くなりすぎない）
  const blocks: { dept: Department | null; staff: Staff[] }[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.staff.length; i += MAX_PER_ISLAND_ROW) blocks.push({ dept: g.dept, staff: g.staff.slice(i, i + MAX_PER_ISLAND_ROW) });
  }

  // 奥の列と手前の列に、幅がなるべく揃うように振り分ける
  const rows: (typeof blocks)[] = [[], []];
  const rowW = [0, 0];
  const widthOf = (n: number) => n * DESK_W + ISLAND_PAD * 2;
  for (const b of blocks) {
    const r = blocks.length <= 2 ? 0 : rowW[0] <= rowW[1] ? 0 : 1;
    rows[r].push(b);
    rowW[r] += widthOf(b.staff.length) + COL_GAP;
  }
  if (blocks.length <= 2 && blocks.length > 0) {
    // 島が1〜2個のときは、奥に横並び
    rowW[0] = rows[0].reduce((a, b) => a + widthOf(b.staff.length) + COL_GAP, 0);
  }

  const islands: Island[] = [];
  const usedRows = rows.filter((r) => r.length > 0).length;
  // 島は奥から並べる。取りまとめ役のテーブルはその手前
  const backZ = usedRows >= 2 ? -ROW_GAP : -ROW_GAP * 0.55;
  const frontZ = 0;
  rows.forEach((row, ri) => {
    if (row.length === 0) return;
    const total = row.reduce((a, b) => a + widthOf(b.staff.length), 0) + COL_GAP * (row.length - 1);
    let x = -total / 2;
    const cz = ri === 0 ? backZ : frontZ;
    for (const b of row) {
      const w = widthOf(b.staff.length);
      const cx = x + w / 2;
      const seats: Seat[] = b.staff.map((s, i) => ({
        staff: s,
        x: x + ISLAND_PAD + DESK_W / 2 + i * DESK_W,
        z: cz,
        facing: 0,
      }));
      islands.push({ dept: b.dept, cx, cz, w, d: ISLAND_D, seats });
      x += w + COL_GAP;
    }
  });

  const maxRowW = Math.max(8, ...rowW.map((w) => w));
  return {
    lead: leadStaff ? { staff: leadStaff, x: 0, z: usedRows >= 2 ? ROW_GAP * 0.95 : ROW_GAP * 0.5, facing: 0 } : null,
    islands,
    width: Math.max(14, maxRowW + 4),
    depth: usedRows >= 2 ? 13.5 : 9.5,
  };
}

/** 全員の席（取りまとめ役を含む）。 */
export function allSeats(layout: OfficeLayout): Seat[] {
  return [...(layout.lead ? [layout.lead] : []), ...layout.islands.flatMap((i) => i.seats)];
}
