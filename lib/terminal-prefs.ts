"use client";

/**
 * ターミナルの表示設定（いまはフォントサイズだけ）。
 *
 * スレッドや設定（AppSettings）とは別に localStorage へ持つ。理由は
 * 「ターミナルの文字の大きさ」は端末ごとの見え方の調整であって、
 * 会話データや同期対象の設定と一緒に運ぶ性質のものではないため。
 * 読めない・書けない環境（SSR・プライベートモード）でも既定値で動く。
 */

const FONT_SIZE_KEY = "unicrew.terminal.fontSize.v1";

/** 従来の固定値。これが既定＝設定していない人の見た目は変わらない。 */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 9;
export const MAX_TERMINAL_FONT_SIZE = 24;

/**
 * 範囲内に丸める（整数）。壊れた値は**既定へ**倒す。
 * 🚨 null / undefined / "" を Number() に通すと 0 になり、最小サイズ（9px）へ
 * 丸められてしまう。「値が無い」は「小さい」ではないので既定に戻す。
 */
export function clampFontSize(n: unknown): number {
  if (n === null || n === undefined || n === "") {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return DEFAULT_TERMINAL_FONT_SIZE;
  const r = Math.round(v);
  if (r < MIN_TERMINAL_FONT_SIZE) return MIN_TERMINAL_FONT_SIZE;
  if (r > MAX_TERMINAL_FONT_SIZE) return MAX_TERMINAL_FONT_SIZE;
  return r;
}

export function loadTerminalFontSize(): number {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_FONT_SIZE;
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY);
    if (raw === null) return DEFAULT_TERMINAL_FONT_SIZE;
    return clampFontSize(raw);
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

export function saveTerminalFontSize(size: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(clampFontSize(size)));
  } catch {
    /* 保存できなくても表示は続ける */
  }
}

/**
 * 文字サイズの購読。
 * ターミナルは最大 24 ペイン同時に開くので、1 つで拡大したら全部に効かないと
 * 「ペインごとに文字の大きさが違う」状態になる（VS Code は全体に効く）。
 * localStorage の storage イベントは同一タブでは飛ばないため、ここで配る。
 */
const listeners = new Set<(size: number) => void>();

/** 文字サイズを変更し、保存し、開いている全ターミナルへ伝える。 */
export function setTerminalFontSize(size: number): void {
  const v = clampFontSize(size);
  saveTerminalFontSize(v);
  for (const cb of [...listeners]) {
    try {
      cb(v);
    } catch {
      /* 1 つの購読者の失敗で他を止めない */
    }
  }
}

export function subscribeTerminalFontSize(
  cb: (size: number) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
