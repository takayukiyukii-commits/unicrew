/**
 * 社員の見た目の見本。最初から入っているもの。利用者は自分の絵に差し替えられる（StaffLook.kind="image"）。
 *
 * 見本は絵のファイルではなく「形と色の組み合わせ」で持つ。3D でも平面でも同じ見本から描ける。
 * 絵を足したいときは、ここに1行足す（描くのは components/office/ 側）。
 */
export type HairStyle = "short" | "bob" | "bun" | "long" | "spiky" | "cap" | "curly" | "side";

export interface LookSample {
  id: string;
  label: string;
  /** 服の色 */
  body: string;
  /** 髪の色 */
  hair: string;
  hairStyle: HairStyle;
  /** 肌の色 */
  skin: string;
  /** 小物（めがね等）。無ければ null */
  accessory: "glasses" | "headset" | "ribbon" | null;
}

export const LOOK_SAMPLES: LookSample[] = [
  { id: "navy-short", label: "ネイビー・ショート", body: "#1e293b", hair: "#111827", hairStyle: "short", skin: "#f5d0b5", accessory: null },
  { id: "pink-bun", label: "ピンク・おだんご", body: "#f472b6", hair: "#3f2a1d", hairStyle: "bun", skin: "#f8d9c0", accessory: null },
  { id: "coral-cap", label: "コーラル・帽子", body: "#fb7185", hair: "#1f2937", hairStyle: "cap", skin: "#f1c7a8", accessory: null },
  { id: "magenta-bob", label: "マゼンタ・ボブ", body: "#d946ef", hair: "#5b3a29", hairStyle: "bob", skin: "#f5d0b5", accessory: "glasses" },
  { id: "sky-short", label: "スカイ・ショート", body: "#38bdf8", hair: "#1f2937", hairStyle: "side", skin: "#f8d9c0", accessory: null },
  { id: "blue-long", label: "ブルー・ロング", body: "#3b82f6", hair: "#111827", hairStyle: "long", skin: "#f1c7a8", accessory: "headset" },
  { id: "yellow-curly", label: "イエロー・くせ毛", body: "#fbbf24", hair: "#6b3f24", hairStyle: "curly", skin: "#f5d0b5", accessory: null },
  { id: "orange-spiky", label: "オレンジ・つんつん", body: "#fb923c", hair: "#0f172a", hairStyle: "spiky", skin: "#e9b995", accessory: null },
  { id: "green-bob", label: "グリーン・ボブ", body: "#34d399", hair: "#7c4a2d", hairStyle: "bob", skin: "#f8d9c0", accessory: "ribbon" },
  { id: "teal-short", label: "ティール・ショート", body: "#2dd4bf", hair: "#111827", hairStyle: "short", skin: "#e9b995", accessory: "glasses" },
  { id: "violet-long", label: "バイオレット・ロング", body: "#a78bfa", hair: "#2a1a3e", hairStyle: "long", skin: "#f5d0b5", accessory: null },
  { id: "gray-side", label: "グレー・横分け", body: "#94a3b8", hair: "#e5e7eb", hairStyle: "side", skin: "#f1c7a8", accessory: "glasses" },
];

export function lookSample(id: string): LookSample {
  return LOOK_SAMPLES.find((l) => l.id === id) ?? LOOK_SAMPLES[0];
}
