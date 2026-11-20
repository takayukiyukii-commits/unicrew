/**
 * 社員を、家具の重ね絵（scene-front.ts）のどこに挟んで描くか（重なりの順番＝z-index）を決める。
 *
 * 基本は「足元の y が大きいほど手前」。ただし、家具の**横**を通るときは別：
 * 足元がその家具の幅の外にある（＝家具の向こう側ではなく、横にいる）のに、体の幅だけが家具の絵に掛かることがある。
 * そのまま y だけで比べると、机の横を歩く人の体が半分、机に隠れてしまう（2026-11-21 利用者の指摘）。
 * 横にいる家具よりは上に描き、本当に向こう側にいる家具よりは下に描く。
 */
import type { SceneFront } from "./scene-front";

/** 社員の絵の、足元から見た大きさ（部屋の幅・高さを 1 とした割合） */
const HALF_W = 0.02;
const BODY_H = 0.092;

export function depthFor(x: number, y: number, pieces: readonly SceneFront[]): number {
  const own = Math.round(y * 1000);
  let raise = own;
  let ceiling = Infinity;
  for (const p of pieces) {
    const base = Math.round(p.base * 1000);
    if (base <= own) continue; // もともと社員のほうが手前
    // 体の絵がこの家具の絵に掛かっているか
    const overlaps = x + HALF_W > p.x && x - HALF_W < p.x + p.w && y > p.y && y - BODY_H < p.y + p.h;
    if (!overlaps) continue;
    const behind = x >= p.x && x <= p.x + p.w; // 足元が家具の幅の中＝向こう側にいる
    if (behind) ceiling = Math.min(ceiling, base - 1);
    else raise = Math.max(raise, base + 1);
  }
  return Math.min(raise, ceiling);
}
