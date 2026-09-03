"use client";

/**
 * ターミナルの配色を、アプリの外観プリセット（lib/appearance.ts）に追従させる。
 *
 * 【直した事故】
 * 外観プリセットには「ダーク」「ミッドナイト」があるのに、ターミナルだけは
 * `#faf9f6` のオフホワイト固定で書かれていた。暗い画面の中でターミナルだけが
 * 白く光る（しかも文字色は濃いまま）状態で、実質使えなかった。
 *
 * 【壊さないための約束】
 * - 明るいテーマのときは **今までと 1 バイトも同じ配色**を返す（LIGHT_TERMINAL_THEME）。
 *   セピア・ミント・スレートを選んでいる人の見た目も変えない。
 * - 変わるのは「背景が暗いと判定されたとき」だけ。つまり今まで壊れていた場合のみ。
 * この約束は単体テストで固定してある（値を変えるとテストが落ちる）。
 */

import { useEffect, useState } from "react";

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * 従来の白基調テーマ（v0.4.0 までの固定値そのもの）。
 * 🚨 ここの値は「既存ユーザーの見た目」なので、勝手に変えない。
 */
export const LIGHT_TERMINAL_THEME: TerminalTheme = {
  background: "#faf9f6",
  foreground: "#1f2328",
  cursor: "#1f2328",
  cursorAccent: "#faf9f6",
  selectionBackground: "#d0d7de",
  selectionForeground: "#1f2328",
  black: "#1f2328",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#7d4e00",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#3192aa",
  brightWhite: "#1f2328",
};

/** 暗い背景用の ANSI 16 色（明るい方の対になる色を選んである）。 */
const DARK_ANSI = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
} as const;

/** 16進色（#rgb / #rrggbb）を暗いと判定するか。appearance.ts の isDark と同じ式。 */
export function isDarkHex(hex: string | undefined | null): boolean {
  if (!hex) return false;
  const m = hex.trim().replace("#", "");
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(m)) return false;
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
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

export interface AppearanceVars {
  /** --color-bg */
  bg?: string | null;
  /** --color-text */
  text?: string | null;
  /** --color-surface（カーソルの縁取りに使う） */
  surface?: string | null;
}

/**
 * 画面の CSS 変数から xterm のテーマを決める。
 * 明るい背景なら従来値をそのまま返す（＝見た目を変えない）。
 */
export function terminalThemeFor(vars: AppearanceVars): TerminalTheme {
  const bg = (vars.bg ?? "").trim();
  if (!isDarkHex(bg)) return LIGHT_TERMINAL_THEME;
  const fg = (vars.text ?? "").trim() || "#e7eaf0";
  const surface = (vars.surface ?? "").trim() || bg;
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: surface,
    // 暗い画面では明るい選択色（文字色は変えない＝色付きログの意味を保つ）
    selectionBackground: "#264f78",
    ...DARK_ANSI,
  };
}

/** documentElement から現在の外観 CSS 変数を読む（SSR 安全）。 */
export function readAppearanceVars(): AppearanceVars {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {};
  }
  try {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue("--color-bg"),
      text: cs.getPropertyValue("--color-text"),
      surface: cs.getPropertyValue("--color-surface"),
    };
  } catch {
    return {};
  }
}

/**
 * 現在のターミナル配色を返し、外観が変わったら更新する React フック。
 *
 * 外観の適用は applyAppearance が documentElement の style を書き換えることで行われる
 * （設定画面のプレビューも同じ経路）。そのため購読の仕組みを別に足さず、
 * style 属性の変化を MutationObserver で見るだけで追従できる。
 */
export function useTerminalTheme(): TerminalTheme {
  const [theme, setTheme] = useState<TerminalTheme>(() =>
    terminalThemeFor(readAppearanceVars()),
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => {
      const next = terminalThemeFor(readAppearanceVars());
      setTheme((prev) =>
        prev.background === next.background && prev.foreground === next.foreground
          ? prev
          : next,
      );
    };
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => mo.disconnect();
  }, []);
  return theme;
}
