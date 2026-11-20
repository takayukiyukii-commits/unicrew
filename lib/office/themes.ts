/** 同じ白いデッキを、昼光・月明かり・木漏れ日で照らす。操作面は常に白。 */
export interface OfficeTheme {
  id: "day" | "night" | "wood";
  sky: string; floor: string; wall: string; wallSide: string;
  desk: string; deskLeg: string; chair: string; ring: string;
  ambient: string; ambientIntensity: number; sun: string; sunIntensity: number;
  signText: string; signGlow: string; signBg: string; dark: boolean;
}
const base = {
  wall: "#FFFFFF", wallSide: "#E2E8F0", desk: "#FFFFFF", deskLeg: "#CBD5E1", chair: "#94A3B8",
  ring: "#6366F1", signText: "#475569", signGlow: "transparent", signBg: "#FFFFFF", dark: false,
};
export const OFFICE_THEMES: OfficeTheme[] = [
  { ...base, id: "day", sky: "#F8FAFC", floor: "#FFFFFF", ambient: "#FFFFFF", ambientIntensity: 1.6, sun: "#F1F5FF", sunIntensity: 1.4 },
  { ...base, id: "night", sky: "#E8ECF5", floor: "#F4F5FF", desk: "#F8FAFF", wallSide: "#B6C0DB", ambient: "#CAD4FF", ambientIntensity: 1.2, sun: "#E8EDFF", sunIntensity: 1.1 },
  { ...base, id: "wood", sky: "#F5F2EB", floor: "#FFFCF7", desk: "#F4E9D8", wallSide: "#D8C8B2", ambient: "#FFFAEF", ambientIntensity: 1.6, sun: "#FFE4B8", sunIntensity: 1.3 },
];
export function officeTheme(id: string): OfficeTheme { return OFFICE_THEMES.find((t) => t.id === id) ?? OFFICE_THEMES[0]; }
