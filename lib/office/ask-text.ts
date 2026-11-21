/**
 * 道具の許可を求められたときに見せる「道具に渡す中身」。
 *
 * 許可の札・通知・自動で通した操作の記録は、この文を元にする。守ること：
 * - コマンドだけでなく、道具に渡す項目を全部出す（書き込む中身・送り先などを隠したまま許可させない）
 * - 見えない文字・大量の空行・長い空白で、後ろの操作を画面の外へ追い出せないようにする（目に見える印に置き換える）
 * - 長すぎて切ったときは、切ったことと残りの長さを必ず書く
 */
import type { Locale } from "../i18n";

/** 許可の札に出す中身の上限（字）。超えた分は「出していません」と書く */
export const ASK_DETAIL_MAX = 4000;

const MARK = {
  ja: { blank: (n: number) => `［空行 ${n}行］`, spaces: (n: number) => `［空白 ${n}個］`, cut: (n: number) => `［長いので、ここから先の ${n}字は出していません］` },
  en: { blank: (n: number) => `[${n} blank lines]`, spaces: (n: number) => `[${n} spaces]`, cut: (n: number) => `[Too long: the remaining ${n} characters are not shown]` },
} as const;

/** 見えない文字・向きを変える文字・大量の空行と空白を、目に見える印に置き換える。 */
export function visibleText(s: string, locale: Locale = "ja"): string {
  const m = MARK[locale === "en" ? "en" : "ja"];
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "→")
    // 制御文字・幅の無い文字・文字の向きを変える文字・ふつうの空白と改行以外の空白・空白にしか見えない文字（表示をだませる）。
    // 種類で指定する（個別の番号を並べると、並べ忘れた空白で後ろを隠せる）
    .replace(/(?![ \n\u3000])[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\u2800\u3164\u115f\u1160\uffa0]/gu, "\ufffd")
    .replace(/[ \u3000]{9,}/g, (run) => m.spaces(run.length))
    .replace(/\n(?:[ \u3000\ufffd→]*\n){2,}/g, (run) => `\n${m.blank(run.split("\n").length - 2)}\n`);
}

function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * 道具に渡す中身を、人が読める文にする。
 * コマンドは先頭にそのまま、ほかの項目は「名前: 値」で1行ずつ。max 字を超えた分は切り、切ったことを書く。
 */
export function askDetail(input: Record<string, unknown>, locale: Locale = "ja", max = ASK_DETAIL_MAX): { text: string; cut: number } {
  const m = MARK[locale === "en" ? "en" : "ja"];
  const lines: string[] = [];
  const cmd = input.command;
  if (typeof cmd === "string") lines.push(cmd.trim());
  else if (Array.isArray(cmd)) lines.push(cmd.map(valueText).join(" "));
  for (const key of Object.keys(input)) {
    if (key === "command" && (typeof cmd === "string" || Array.isArray(cmd))) continue;
    lines.push(`${key}: ${valueText(input[key])}`);
  }
  const full = visibleText(lines.join("\n"), locale).trim();
  if (full.length <= max) return { text: full, cut: 0 };
  // 文字の途中（2つで1文字になる組の前半）では切らない
  const end = /[\ud800-\udbff]/.test(full[max - 1] ?? "") ? max - 1 : max;
  const cut = full.length - end;
  return { text: `${full.slice(0, end)}\n${m.cut(cut)}`, cut };
}
