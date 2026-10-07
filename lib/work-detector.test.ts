import { describe, expect, it } from "vitest";
import { WorkDetector } from "./work-detector";

const opts = { minWorkMs: 8_000, quietMs: 4_000 };

/** start から end まで every ms ごとに出力が来たことにする。 */
function stream(d: WorkDetector, start: number, end: number, every = 100) {
  for (let t = start; t <= end; t += every) d.output(t);
}

describe("ターミナルの作業終わりの見分け", () => {
  it("10秒働いて静かになったら、1回だけ終わりを知らせる", () => {
    const d = new WorkDetector(opts);
    stream(d, 0, 10_000);
    expect(d.tick(12_000)).toBeNull(); // まだ静かになって2秒
    expect(d.tick(14_100)).toBe(10_000);
    expect(d.tick(20_000)).toBeNull(); // 二重に知らせない
  });

  it("文字を打っただけ（短い出力）は作業と数えない", () => {
    const d = new WorkDetector(opts);
    stream(d, 0, 1_500);
    expect(d.tick(10_000)).toBeNull();
  });

  it("途中で数秒止まっても、4秒未満なら同じ作業として続ける", () => {
    const d = new WorkDetector(opts);
    stream(d, 0, 5_000);
    stream(d, 8_000, 12_000); // 3秒の間
    expect(d.tick(9_000)).toBeNull();
    expect(d.tick(16_500)).toBe(12_000);
  });

  it("長い指示を打っている間の表示は作業と数えない（打ち終えて手を止めても鳴らない）", () => {
    const d = new WorkDetector(opts);
    for (let t = 0; t <= 12_000; t += 200) {
      d.input(t);
      d.output(t + 30); // 打った文字がすぐ表示される
    }
    expect(d.tick(20_000)).toBeNull();
  });

  it("Enter のあと AI が働けば、ちゃんと終わりを知らせる", () => {
    const d = new WorkDetector(opts);
    d.input(0);
    d.output(30);
    stream(d, 1_000, 11_000);
    expect(d.tick(15_500)).toBe(10_000);
  });

  it("AI が終わった直後に打ち始めても、完了の知らせは消えない", () => {
    const d = new WorkDetector(opts);
    stream(d, 0, 10_000);
    d.input(12_000); // 終わって2秒後に打ち始めた
    d.output(12_030);
    expect(d.tick(16_100)).not.toBeNull();
  });

  it("AI の作業中に次の指示を打ち込んでも、作業の終わりを知らせる", () => {
    const d = new WorkDetector(opts);
    stream(d, 0, 4_000);
    for (let t = 4_100; t <= 6_000; t += 150) d.input(t); // 作業中に打鍵
    stream(d, 4_100, 11_000);
    expect(d.tick(15_100)).not.toBeNull();
  });

  it("出力が一度も無ければ何も言わない", () => {
    expect(new WorkDetector(opts).tick(100_000)).toBeNull();
  });
});
