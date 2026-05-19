"use client";

/**
 * 外観カスタマイズ（UNI デザイン哲学：使う人のユニークさを反映）。
 *
 * app/globals.css の `@theme` で定義された CSS 変数
 * (--color-bg / surface / border / text / muted / accent / accent-soft)
 * を実行時に documentElement へ上書きするだけの薄い仕組み。
 * - プリセット（複数）から選ぶ
 * - さらに背景色・アクセント色を任意の色で個別上書き可能
 * 未設定なら globals.css の既定がそのまま効く（＝既存ユーザーは無変化）。
 */

export interface AppearanceSettings {
  /** プリセット名。未設定 or "default" は globals.css 既定 */
  preset?: string;
  /** 背景色の個別上書き（#rrggbb）。空/未設定でプリセット値 */
  bg?: string;
  /** アクセント色の個別上書き（#rrggbb） */
  accent?: string;
}

type Vars = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
};

/** globals.css の既定値（preset=default の実体） */
const DEFAULT_VARS: Vars = {
  bg: "#ffffff",
  surface: "#fafafa",
  border: "#e5e7eb",
  text: "#111827",
  muted: "#6b7280",
  accent: "#3b82f6",
  accentSoft: "#eff6ff",
};

export interface PresetDef {
  id: string;
  label: string;
  vars: Vars;
}

/** 選べるプリセット（背景カラー“いろいろ”の実体） */
export const APPEARANCE_PRESETS: PresetDef[] = [
  { id: "default", label: "ライト（標準）", vars: DEFAULT_VARS },
  {
    id: "warm",
    label: "セピア（暖色・目に優しい）",
    vars: {
      bg: "#f7f3ec",
      surface: "#efe8db",
      border: "#e0d6c3",
      text: "#3b352b",
      muted: "#8a7f6b",
      accent: "#b4763a",
      accentSoft: "#efe1cf",
    },
  },
  {
    id: "mint",
    label: "ミント（淡い緑）",
    vars: {
      bg: "#f3faf7",
      surface: "#e8f4ef",
      border: "#cfe6dc",
      text: "#15302a",
      muted: "#5d7d72",
      accent: "#0f9d72",
      accentSoft: "#d6f0e6",
    },
  },
  {
    id: "slate",
    label: "スレート（落ち着いた灰青）",
    vars: {
      bg: "#f4f6f8",
      surface: "#e9edf2",
      border: "#d4dbe3",
      text: "#1f2a37",
      muted: "#64748b",
      accent: "#2563eb",
      accentSoft: "#dde8fb",
    },
  },
  {
    id: "dark",
    label: "ダーク",
    vars: {
      bg: "#0f1117",
      surface: "#171a21",
      border: "#2a2f3a",
      text: "#e7eaf0",
      muted: "#9aa3b2",
      accent: "#60a5fa",
      accentSoft: "#1e2a45",
    },
  },
  {
    id: "midnight",
    label: "ミッドナイト（濃紺）",
    vars: {
      bg: "#0b1020",
      surface: "#121830",
      border: "#26304f",
      text: "#e6e9f5",
      muted: "#8b95b5",
      accent: "#7c9cff",
      accentSoft: "#1c2647",
    },
  },
];

export const DEFAULT_APPEARANCE: AppearanceSettings = { preset: "default" };

function presetVars(id: string | undefined): Vars {
  const p = APPEARANCE_PRESETS.find((x) => x.id === (id || "default"));
  return p ? p.vars : DEFAULT_VARS;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * 外観設定を実画面に反映する。a 未指定なら既定（globals.css）に戻す。
 * SSR 安全（document が無ければ何もしない）。
 */
export function applyAppearance(a: AppearanceSettings | undefined): void {
  if (typeof document === "undefined") return;
  const base = presetVars(a?.preset);
  const v: Vars = { ...base };
  if (a?.bg && HEX.test(a.bg)) v.bg = a.bg;
  if (a?.accent && HEX.test(a.accent)) v.accent = a.accent;

  const root = document.documentElement;
  const set = (k: string, val: string) => root.style.setProperty(k, val);
  set("--color-bg", v.bg);
  set("--color-surface", v.surface);
  set("--color-border", v.border);
  set("--color-text", v.text);
  set("--color-muted", v.muted);
  set("--color-accent", v.accent);
  set("--color-accent-soft", v.accentSoft);
  // body 直書きの背景/文字色も追従させる
  set("color-scheme", isDark(v.bg) ? "dark" : "light");
}

function isDark(hex: string): boolean {
  const m = hex.replace("#", "");
  const n =
    m.length === 3
      ? m
          .split("")
          .map((c) => c + c)
          .join("")
      : m;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  // 相対輝度ざっくり
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
