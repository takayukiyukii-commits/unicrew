/**
 * 部屋の雰囲気（色の組み合わせ）。会社ごとに選べる。
 * 3D の部屋と、その上に重ねる札・看板の両方がここの色を使う。
 */
export interface OfficeTheme {
  id: string;
  label: string;
  /** 画面の背景（部屋の外） */
  sky: string;
  floor: string;
  wall: string;
  wallSide: string;
  desk: string;
  deskLeg: string;
  chair: string;
  /** 取りまとめ役のテーブルの縁 */
  ring: string;
  /** 光の色と強さ */
  ambient: string;
  ambientIntensity: number;
  sun: string;
  sunIntensity: number;
  /** 看板（会社名）の文字と光 */
  signText: string;
  signGlow: string;
  signBg: string;
  /** 札・吹き出しの地の色が暗い部屋向けか */
  dark: boolean;
}

export const OFFICE_THEMES: OfficeTheme[] = [
  {
    id: "day",
    label: "ひるま（明るい）",
    sky: "#eef2f7",
    floor: "#f4f6fa",
    wall: "#ffffff",
    wallSide: "#e9edf3",
    desk: "#ffffff",
    deskLeg: "#cbd5e1",
    chair: "#94a3b8",
    ring: "#f472b6",
    ambient: "#ffffff",
    ambientIntensity: 1.55,
    sun: "#fff7e8",
    sunIntensity: 1.5,
    signText: "#ff5fa2",
    signGlow: "rgba(255,95,162,.75)",
    signBg: "#151a2b",
    dark: false,
  },
  {
    id: "night",
    label: "よる（ネオン）",
    sky: "#0b1020",
    floor: "#161c33",
    wall: "#1c2340",
    wallSide: "#141a31",
    desk: "#2a3357",
    deskLeg: "#111629",
    chair: "#3b4675",
    ring: "#22d3ee",
    ambient: "#8ea2ff",
    ambientIntensity: 1.25,
    sun: "#b8c4ff",
    sunIntensity: 1.1,
    signText: "#5eead4",
    signGlow: "rgba(94,234,212,.8)",
    signBg: "#0a0e1c",
    dark: true,
  },
  {
    id: "wood",
    label: "木のへや（あたたかい）",
    sky: "#f3ebe0",
    floor: "#e7d3b5",
    wall: "#fbf6ee",
    wallSide: "#efe4d3",
    desk: "#f7ead7",
    deskLeg: "#b98f5e",
    chair: "#a47b4f",
    ring: "#f59e0b",
    ambient: "#fff3df",
    ambientIntensity: 1.5,
    sun: "#ffe2b0",
    sunIntensity: 1.6,
    signText: "#fbbf24",
    signGlow: "rgba(251,191,36,.7)",
    signBg: "#2b1d10",
    dark: false,
  },
];

export function officeTheme(id: string): OfficeTheme {
  return OFFICE_THEMES.find((t) => t.id === id) ?? OFFICE_THEMES[0];
}
