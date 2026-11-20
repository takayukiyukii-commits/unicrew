import { describe, expect, it } from "vitest";
import { depthFor } from "./scene-depth";
import { SCENE_FRONT } from "./scene-front";
import { SCENE } from "./scene-map";

const base = (name: string) => Math.round(SCENE_FRONT.find((p) => p.name === name)!.base * 1000);

describe("社員と家具の重なりの順番", () => {
  it("机の島の横の通路を下へ歩く人は、その島の机・椅子に隠れない（体が半分切れない）", () => {
    const x = SCENE.points["hall-1-0"].x;
    // 机の絵に体が掛かる高さ（机の上の端〜手前の椅子の下の端）を通るあいだ
    let checked = 0;
    for (let y = 0.48; y <= 0.645; y += 0.015) {
      const z = depthFor(x, y, SCENE_FRONT);
      expect(z, `y=${y.toFixed(3)}`).toBeGreaterThan(base("island3-desk"));
      if (y > 0.58) expect(z, `y=${y.toFixed(3)}`).toBeGreaterThan(base("island3-front"));
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
  });

  it("どの通路（縦4本）を歩いても、通路の両側の島に隠れない", () => {
    for (let c = 0; c < 4; c++) {
      const x = SCENE.points[`hall-0-${c}`].x;
      for (let y = 0.21; y <= 0.66; y += 0.015) {
        const z = depthFor(x, y, SCENE_FRONT);
        for (const p of SCENE_FRONT.filter((q) => q.name.startsWith("island"))) {
          const touches = x + 0.02 > p.x && x - 0.02 < p.x + p.w && y > p.y && y - 0.092 < p.y + p.h;
          if (touches) expect(z, `${p.name} x=${x} y=${y.toFixed(3)}`).toBeGreaterThan(Math.round(p.base * 1000));
        }
      }
    }
  });

  it("席に座る人は、いままでどおり椅子と机に挟まれる（奥の椅子＜人＜机、机＜人＜手前の椅子）", () => {
    for (let i = 0; i < 6; i++) {
      const back = SCENE.points[`seat-${i}-0`], front = SCENE.points[`seat-${i}-2`];
      const zb = depthFor(back.x, back.y, SCENE_FRONT), zf = depthFor(front.x, front.y, SCENE_FRONT);
      expect(zb).toBeGreaterThan(base(`island${i}-back`));
      expect(zb).toBeLessThan(base(`island${i}-desk`));
      expect(zf).toBeGreaterThan(base(`island${i}-desk`));
      expect(zf).toBeLessThan(base(`island${i}-front`));
    }
  });

  it("棚の向こう側に立つ人は棚に隠れ、取りまとめ役は自分の椅子の向こうに座る", () => {
    const shelf = SCENE.points.shelf, lead = SCENE.points.lead;
    expect(depthFor(shelf.x, shelf.y, SCENE_FRONT)).toBeLessThan(base("shelf"));
    const z = depthFor(lead.x, lead.y, SCENE_FRONT);
    expect(z).toBeLessThan(base("lead-chair"));
    expect(z).toBeGreaterThan(base("lead-desk"));
  });

  it("家具に掛からない所では、足元の y がそのまま順番になる", () => {
    expect(depthFor(0.9, 0.7, SCENE_FRONT)).toBe(700);
    expect(depthFor(0.9, 0.9, SCENE_FRONT)).toBeGreaterThan(depthFor(0.9, 0.7, SCENE_FRONT));
  });
});
