/** 背景は1枚。部屋の色だけ変え、操作面は白を保つ。 */
export interface OfficeTheme {
  id: "day" | "night" | "wood";
  sky: string; floor: string; ring: string; signBg: string; dark: boolean;
  filter: string; overlay: string;
}
const base = { ring: "#6366F1", signBg: "#FFFFFF", dark: false };
export const OFFICE_THEMES: OfficeTheme[] = [
  { ...base, id: "day", sky: "#F7F2E9", floor: "#EACCA9", filter: "none", overlay: "transparent" },
  { ...base, id: "night", sky: "#E3E5F1", floor: "#BCB4D1", filter: "brightness(.70) saturate(.75)", overlay: "rgba(55,65,120,.18)" },
  { ...base, id: "wood", sky: "#F4EDDD", floor: "#D5B184", filter: "sepia(.20) saturate(.95)", overlay: "rgba(231,181,95,.08)" },
];
export function officeTheme(id: string): OfficeTheme { return OFFICE_THEMES.find((t) => t.id === id) ?? OFFICE_THEMES[0]; }
