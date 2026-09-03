import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { t } from "../lib/i18n";
import { EFFORT_SUPPORT } from "../lib/terminal-effort";

/**
 * ターミナル関連の翻訳キーが ja / en の**両方に**実在するかを機械で確かめる。
 *
 * 【なぜ要るか】
 * i18n の t() は未知キーを「キー文字列そのもの」で返す。打ち間違えても例外は出ず、
 * 画面に `terminal.findNoMatch` と英数字が出るだけ。tsc も lint も通るので、
 * 人が気づくのは出荷後になる。
 *
 * 🚨【この検査が一度、偽PASS だったこと】
 * 最初は「t(key, "ja") がキー自身を返すか」で判定していた。しかし t() には
 * **反対言語へのフォールバック**がある（ja が無ければ en を返す）。そのため
 * ja のキーをわざと壊す毒味をしても、en の文字列が返って検査は通ってしまった。
 * ＝「日本語が抜けている」を検出できない検査だった。
 * よって判定は t() ではなく **i18n.ts の辞書ブロックを直接読む**方式にしてある。
 * t() を使う判定に戻さないこと。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const I18N_PATH = join(root, "lib", "i18n.ts");

/** 走査対象（ターミナルのキーを書いている場所）。 */
const SCAN_DIRS = [join(root, "components"), join(root, "app")];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 画面側のソースに書かれている "terminal.*" キーを集める。 */
function usedTerminalKeys(): string[] {
  const keys = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const file of collectSourceFiles(dir)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/"(terminal\.[A-Za-z0-9_]+)"/g)) {
        keys.add(m[1]);
      }
    }
  }
  return [...keys].sort();
}

/**
 * i18n.ts の該当辞書ブロックだけを切り出して、キー → 文字列 を読む。
 * t() を通さない（フォールバックで欠落が隠れるため）。
 */
function dictEntries(locale: "ja" | "en"): Map<string, string> {
  const src = readFileSync(I18N_PATH, "utf8");
  const start = src.indexOf(`const ${locale}: Dict = {`);
  if (start < 0) throw new Error(`辞書ブロックが見つかりません: ${locale}`);
  const end = src.indexOf("\n};", start);
  if (end < 0) throw new Error(`辞書ブロックの終端が見つかりません: ${locale}`);
  const block = src.slice(start, end);
  const map = new Map<string, string>();
  for (const m of block.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) {
    map.set(m[1], m[2]);
  }
  return map;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(",");

describe("ターミナルの翻訳キー", () => {
  it("走査が空振りしていない（画面側のキーを拾えている）", () => {
    const keys = usedTerminalKeys();
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain("terminal.findPlaceholder");
    expect(keys).toContain("terminal.exitedWithCode");
    expect(keys).toContain("terminal.sendSelectionToAi");
  });

  it("辞書ブロックを読めている（ja / en とも十分な件数がある）", () => {
    expect(dictEntries("ja").size).toBeGreaterThan(100);
    expect(dictEntries("en").size).toBeGreaterThan(100);
  });

  it("使っているキーが ja / en の両方に実在する", () => {
    const ja = dictEntries("ja");
    const en = dictEntries("en");
    const missing: string[] = [];
    for (const key of usedTerminalKeys()) {
      if (!ja.has(key)) missing.push(`ja: ${key}`);
      if (!en.has(key)) missing.push(`en: ${key}`);
    }
    expect(missing).toEqual([]);
  });

  it("プレースホルダ（{code} 等）が ja / en で一致する", () => {
    const ja = dictEntries("ja");
    const en = dictEntries("en");
    const mismatched: string[] = [];
    for (const key of usedTerminalKeys()) {
      const a = ja.get(key);
      const b = en.get(key);
      if (a === undefined || b === undefined) continue; // 欠落は上のテストが見る
      if (placeholders(a) !== placeholders(b)) {
        mismatched.push(`${key}: ja[${placeholders(a)}] en[${placeholders(b)}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("🚨 エフォートの説明文は動的キー（走査で拾えない）なので、明示的に全部確かめる", () => {
    // t(`terminal.effortHint.${lv}`) はテンプレート文字列なので、
    // ソース走査では検出できない＝欠けても気づけない。ここで固定する。
    const ja = dictEntries("ja");
    const en = dictEntries("en");
    const missing: string[] = [];
    for (const [cli, sup] of Object.entries(EFFORT_SUPPORT)) {
      for (const lv of sup.levels) {
        const key = `terminal.effortHint.${lv}`;
        if (!ja.has(key)) missing.push(`ja: ${key} (${cli})`);
        if (!en.has(key)) missing.push(`en: ${key} (${cli})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("毒味：t() は反対言語へフォールバックするので、欠落判定には使えない", () => {
    // この性質が「t() で判定すると偽PASS になる」理由そのもの。
    // 仕様が変わってフォールバックが無くなったら、このテストが落ちて気づける。
    const jaOnlyKey = "terminal.exitedWithCode";
    expect(t(jaOnlyKey, "ja")).not.toBe(jaOnlyKey);
    const bogus = "terminal.__key_that_does_not_exist__";
    expect(t(bogus, "ja")).toBe(bogus);
    expect(t(bogus, "en")).toBe(bogus);
  });
});
