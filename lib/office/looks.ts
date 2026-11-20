/** 人間を模さない乗組員。立体と平面は同じ筐体・画面・小物を使う。 */
export interface LookSample {
  id: string;
  body: string;
  accent: string;
  shape: "square" | "wide" | "tall";
  accessory: "antenna" | "ears" | "fins" | "handle";
}
export const LOOK_SAMPLES: LookSample[] = [
  { id: "relay", body: "#6366F1", accent: "#C7D2FE", shape: "square", accessory: "antenna" },
  { id: "echo", body: "#0F766E", accent: "#99F6E4", shape: "wide", accessory: "ears" },
  { id: "folio", body: "#475569", accent: "#CBD5E1", shape: "tall", accessory: "handle" },
  { id: "kite", body: "#0369A1", accent: "#BAE6FD", shape: "square", accessory: "fins" },
  { id: "amber", body: "#B45309", accent: "#FDE68A", shape: "wide", accessory: "antenna" },
  { id: "mint", body: "#047857", accent: "#A7F3D0", shape: "tall", accessory: "ears" },
  { id: "orbit", body: "#7C3AED", accent: "#DDD6FE", shape: "square", accessory: "handle" },
  { id: "tide", body: "#0E7490", accent: "#A5F3FC", shape: "wide", accessory: "fins" },
  { id: "clay", body: "#9A3412", accent: "#FED7AA", shape: "tall", accessory: "antenna" },
  { id: "leaf", body: "#4D7C0F", accent: "#D9F99D", shape: "square", accessory: "ears" },
  { id: "pearl", body: "#64748B", accent: "#E2E8F0", shape: "wide", accessory: "handle" },
  { id: "dusk", body: "#4338CA", accent: "#A5B4FC", shape: "tall", accessory: "fins" },
];
// 保存済みの見本とテンプレートの指定を、新しい乗組員に対応させる。
const legacy = ["navy-short", "pink-bun", "coral-cap", "magenta-bob", "sky-short", "blue-long", "yellow-curly", "orange-spiky", "green-bob", "teal-short", "violet-long", "gray-side"];
export function lookSample(id: string): LookSample {
  return LOOK_SAMPLES.find((look) => look.id === id) ?? LOOK_SAMPLES[legacy.indexOf(id)] ?? LOOK_SAMPLES[0];
}
