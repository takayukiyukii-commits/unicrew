/** 足元と名札を分け、12人が集まっても札を重ねない。単位は表示上のpx。 */
export interface LabelBox { id: string; x: number; y: number; w: number; h: number }
export function placeOfficeLabels(items: LabelBox[], width: number, height: number): LabelBox[] {
  const placed: LabelBox[] = [];
  const reserved = [
    { x: 0, y: height * .44, w: width * .26, h: height * .56 },
    { x: width * .79, y: height * .5, w: width * .21, h: height * .5 },
    // 隣の社員が札の裏に隠れないよう、全員の絵の範囲も避ける。
    ...items.map((item) => ({ x: item.x - 28, y: item.y - 74, w: 56, h: 74 })),
  ];
  const overlaps = (a: LabelBox, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w + 4 && a.x + a.w + 4 > b.x && a.y < b.y + b.h + 4 && a.y + a.h + 4 > b.y;
  for (const item of items) {
    const candidates: LabelBox[] = [];
    for (let row = -12; row <= 12; row++) for (let col = -3; col <= 3; col++) {
      candidates.push({ ...item, x: item.x - item.w / 2 + col * (item.w + 6), y: item.y + 6 + row * (item.h + 6) });
    }
    candidates.sort((a, b) => Math.hypot(a.x + a.w / 2 - item.x, a.y - item.y) - Math.hypot(b.x + b.w / 2 - item.x, b.y - item.y));
    const chosen = candidates.find((box) =>
      box.x >= 4 && box.x + box.w <= width - 4 && box.y >= 4 && box.y + box.h <= height - 4 &&
      [...reserved, ...placed].every((other) => !overlaps(box, other)));
    // 通常の最大24席を超える名簿は、場面の下に別途表示する。
    placed.push(chosen ?? { ...item, x: Math.max(4, Math.min(width - item.w - 4, item.x)), y: 4 });
  }
  return placed;
}
