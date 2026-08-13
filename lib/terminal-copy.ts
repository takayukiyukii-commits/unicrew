/**
 * ターミナルからのコピー整形（2026-07-16 ユーザー報告のコピペ改行崩れ対策）。
 *
 * 【問題】claude CLI（Ink）は本文を端末幅で折り返す際に“実際の改行”を挿入して
 * 描画する（真の折返し isWrapped ではない）。そのままコピーすると、画面上の
 * 折返し位置の改行が混入し、別アプリへペーストした時に文が細切れになる。
 * ※ xterm 由来の真の折返し（isWrapped）は getSelection() が既に連結済みなので、
 *   ここに来る時点で残っているのは「行末まで文字が詰まった行のハード改行」だけ。
 *
 * 【方針】表示幅が端末幅いっぱい（cols-1 以上）の行は折返しとみなして次行と連結する。
 *  - 連結境界の両側が ASCII 単語文字なら空白 1 個を挟む（英文の単語分断を戻す）
 *  - 日本語等はそのまま連結（和文に空白を入れない）
 *  - 連結する次行の先頭インデントは除去（Ink の継続行インデント対策）
 *  - 罫線・枠線（Box Drawing）で終わる行は連結しない（枠のコピーを壊さない）
 *  - 次行が空行なら連結しない（段落は保持）
 *
 * 純関数・単体テストあり（terminal-copy.test.ts）。
 */

/** 東アジア全角（ターミナルで2セル）とみなす簡易判定。xterm/Unicode11 の近似で十分。 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK部首・記号
    (cp >= 0x3041 && cp <= 0x33ff) || // かな・カタカナ・CJK記号
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK拡張A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK統合漢字
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul音節
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK互換漢字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK互換形
    (cp >= 0xff00 && cp <= 0xff60) || // 全角英数
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角記号
    (cp >= 0x1f300 && cp <= 0x1faff) || // 絵文字（多くが2セル）
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK拡張B〜
  );
}

/** 文字列の表示セル幅（近似）。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWideChar(cp) ? 2 : 1;
  }
  return w;
}

/** 行末が罫線・枠線類なら連結しない（claude のボックスUIを壊さない）。 */
function endsWithBoxDrawing(line: string): boolean {
  const last = line.trimEnd().slice(-1);
  if (!last) return false;
  const cp = last.codePointAt(0) ?? 0;
  // Box Drawing / Block Elements / 一部の罫線風記号
  return (cp >= 0x2500 && cp <= 0x259f) || last === "═" || last === "║";
}

const ASCII_WORD_RE = /[A-Za-z0-9]/;

/**
 * ハード折返し行を連結してコピー文面を復元する。
 * @param text  getSelection() の結果（真の折返しは連結済み）
 * @param cols  ターミナル桁数
 */
export function joinHardWrappedLines(text: string, cols: number): string {
  if (!text || cols <= 4) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let cur = lines[i];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      const nextTrimmed = next.replace(/^\s+/, "");
      // 連結条件: 行が端末幅いっぱい（全角は最終セルに収まらないため cols-1 も満杯扱い）
      // かつ 次行が空でなく、罫線終わりでもない
      if (
        displayWidth(cur) < cols - 1 ||
        nextTrimmed.length === 0 ||
        endsWithBoxDrawing(cur)
      ) {
        break;
      }
      const lastCh = cur.slice(-1);
      const firstCh = nextTrimmed.charAt(0);
      const glue =
        ASCII_WORD_RE.test(lastCh) && ASCII_WORD_RE.test(firstCh) ? " " : "";
      cur = cur + glue + nextTrimmed;
      i++;
    }
    out.push(cur);
    i++;
  }
  return out.join("\n");
}
