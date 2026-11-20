/** office-day.webp を開いて決めた足元の位置。左上が (0, 0)。 */
export interface ScenePoint { x: number; y: number }
const points: Record<string, ScenePoint> = {};
const links: [string, string][] = [];
const put = (id: string, x: number, y: number) => { points[id] = { x, y }; return id; };
const join = (a: string, b: string) => { links.push([a, b]); };
// 家具の横の縦通路と、机の前後の横通路。
const columns = [0.222, 0.412, 0.597, 0.779];
const rows = [0.198, 0.425, 0.666];
rows.forEach((y, r) => columns.forEach((x, c) => {
  const id = put(`hall-${r}-${c}`, x, y);
  if (c) join(id, `hall-${r}-${c - 1}`);
  if (r) join(id, `hall-${r - 1}-${c}`);
}));
const islands: string[][] = [];
for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
  const seats: string[] = [];
  for (let s = 0; s < 4; s++) {
    const x = (r === 0 ? [0.294, 0.476, 0.661] : [0.287, 0.476, 0.664])[c] + (s % 2) * 0.060;
    const back = s < 2;
    const y = r === 0 ? (back ? 0.230 : 0.403) : (back ? 0.458 : 0.638);
    const id = put(`seat-${r * 3 + c}-${s}`, x, y);
    const hallRow = back ? r : r + 1;
    const entry = put(`${id}-entry`, x, rows[hallRow]);
    join(id, entry);
    join(entry, `hall-${hallRow}-${c + (s % 2)}`);
    seats.push(id);
  }
  islands.push(seats);
}
// 会議室へはガラスを横切らず、手前の開いた入口を通る。
put("meeting-door", 0.145, 0.492); put("meeting-inside", 0.145, 0.475);
put("meeting-bottom-left", 0.040, 0.475); put("meeting-bottom-right", 0.182, 0.475);
put("meeting-approach", 0.222, 0.492);
join("meeting-approach", "hall-1-0"); join("meeting-approach", "hall-2-0"); join("meeting-approach", "meeting-door");
join("meeting-door", "meeting-inside");
join("meeting-inside", "meeting-bottom-left"); join("meeting-inside", "meeting-bottom-right");
const meeting: string[] = [];
for (let side = 0; side < 2; side++) for (let i = 0; i < 4; i++) {
  const y = 0.300 + i * 0.047;
  const id = put(`meeting-${side * 4 + i}`, side ? 0.154 - i * 0.002 : 0.077 - i * 0.004, y);
  const aisle = put(`${id}-aisle`, side ? 0.182 : 0.040, y);
  join(id, aisle);
  if (i) join(aisle, `meeting-${side * 4 + i - 1}-aisle`);
  if (i === 3) join(aisle, side ? "meeting-bottom-right" : "meeting-bottom-left");
  meeting.push(id);
}
put("lead", 0.507, 0.839); put("lead-side", 0.591, 0.839);
join("lead", "lead-side"); join("lead-side", "hall-2-2");
put("report", 0.569, 0.839); join("report", "lead-side");
put("boss", 0.472, 0.940); put("front-hall", 0.591, 0.940);
join("boss", "front-hall"); join("front-hall", "lead-side");
put("shelf", 0.682, 0.784); put("shelf-side", 0.779, 0.784);
join("shelf", "shelf-side"); join("shelf-side", "hall-2-3");
put("break", 0.860, 0.444); put("break-entry", 0.779, 0.444);
join("break", "break-entry"); join("break-entry", "hall-1-3");
// 入口の扉（左手前）。出社のときはここから入り、受付の手前を回って通路へ出る。
put("door", 0.297, 0.925); put("door-mat", 0.297, 0.972); put("front-low", 0.472, 0.988);
join("door", "door-mat"); join("door-mat", "front-low"); join("front-low", "boss");
// 資料の棚（奥の壁ぎわ）。調べもののときに見に行く。
const books: string[] = [];
[0.300, 0.497, 0.690].forEach((x, i) => {
  const id = put(`books-${i}`, x, 0.186);
  join(id, `hall-0-${i}`); join(id, `hall-0-${i + 1}`);
  books.push(id);
});
// 待つ社員が同じ足元に積み重ならないよう、手前の空いた床に並ぶ。
const waiting: string[] = [];
for (let i = 0; i < 24; i++) {
  const id = i < 12
    ? put(`waiting-${i}`, 0.465 + (i % 6) * 0.023, 0.880 + Math.floor(i / 6) * 0.080)
    : put(`waiting-${i}`, 0.270 + (i - 12) * 0.044, 0.666);
  if (i < 12) join(id, "boss");
  else {
    // 大人数の列は中央通路から入る。取りまとめ机を斜めに横切らない。
    const closest = columns.reduce((best, x, index) => Math.abs(x - points[id].x) < Math.abs(columns[best] - points[id].x) ? index : best, 0);
    join(id, `hall-2-${closest}`);
  }
  waiting.push(id);
}
export const SCENE = { width: 1920, height: 1080, points, links, islands, meeting, waiting, books };
export function sceneDistance(a: ScenePoint, b: ScenePoint): number {
  return Math.hypot((a.x - b.x) * SCENE.width, (a.y - b.y) * SCENE.height);
}
/** 通路だけをたどる最短経路。席間の直線移動は使わない。 */
export function sceneRoute(from: string, to: string): string[] {
  if (!points[from] || !points[to]) return [];
  const distance: Record<string, number> = { [from]: 0 };
  const previous: Record<string, string> = {};
  const pending = new Set(Object.keys(points));
  while (pending.size) {
    let current: string | undefined;
    for (const id of pending) if (distance[id] !== undefined && (current === undefined || distance[id] < distance[current])) current = id;
    if (current === undefined) break;
    if (current === to) {
      const path = [to];
      while (path[0] !== from) path.unshift(previous[path[0]]);
      return path;
    }
    pending.delete(current);
    for (const [a, b] of links) {
      const next = a === current ? b : b === current ? a : null;
      if (!next || !pending.has(next)) continue;
      const value = distance[current] + sceneDistance(points[current], points[next]);
      if (value < (distance[next] ?? Infinity)) { distance[next] = value; previous[next] = current; }
    }
  }
  return [];
}
