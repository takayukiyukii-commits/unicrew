/**
 * 日本語IME未確定文字（composition-view）の配置方針の決定ロジック。
 *
 * 【設計原則（v0.2.30〜）：VS Code 方式＝実カーソル信頼が第一】
 * VS Code 統合ターミナルが絶対にズレないのは、xterm.js の CompositionHelper が
 * 「実カーソル位置(buffer.x/y) × 実セル寸法」で未確定文字を置くだけで、
 * 画面内容を一切解釈しないから。「実カーソル＝挿入点」は端末業界の標準契約で、
 * claude CLI 側も upstream で継続的に保守している
 * （2.1.84: IME composition renders inline / 2.1.140: フォーカス喪失時の追従 等）。
 *
 * よって本モジュールは：
 *  - 実カーソルが入力領域内にある（＝契約が守られている）→ null を返し
 *    **何もしない**（xterm ネイティブ配置を信頼。これが基本経路）
 *  - 実カーソルが入力領域の外にある異常時のみ、ヒューリスティック
 *    （反転カーソルブロック→❯行末尾）で上書き位置を返す（保険）
 *
 * 【歴史】旧 claude は実カーソルをステータス行へ置く不具合があり、UNICREW は
 * 「上から最初の❯＋反転セル」スクレイピング補正で回避していた（v0.2.22-25）。
 * しかし claude 2.1.17x の UI 刷新（過去発言にも「❯ 」が付く）で補正自体が
 * ズレの原因と化した（2026-06-11 復活バグ）。スクレイピングを主経路にする限り
 * claude の UI 変更の度に壊れるため、ネイティブ信頼を主経路へ転換した。
 */

/** xterm の active buffer をビューポート相対で読むための最小スナップショット */
export interface TermSnapshot {
  rows: number;
  cols: number;
  /** ビューポート y 行のテキスト（translateToString(true) 相当） */
  lineText(y: number): string;
  /** ビューポート (y, x) セルが反転(reverse-video)か */
  isInverse(y: number, x: number): boolean;
  /** 実カーソル位置（ビューポート相対。0..rows-1 / 0..cols-1） */
  cursorY: number;
  cursorX: number;
}

/**
 * composition-view を上書き移動すべき位置を返す。
 * **null は「上書きせず xterm ネイティブ配置（実カーソル）を信頼せよ」**の意味。
 *
 * null を返すケース（＝基本経路）:
 *  - 入力ボックス（❯ 行）が見つからない（ダイアログ等。実カーソル追従は
 *    claude 側が保守している）
 *  - 実カーソルが入力領域（最下の ❯ 行以降）内にある（契約どおり）
 *
 * 上書きするケース（＝保険。実カーソルが入力領域より上にある異常時のみ）:
 *  1. 入力領域内の最下の反転セル＝Ink のカーソルブロック
 *  2. ❯ 行のテキスト末尾（最終フォールバック）
 */
export function findCompositionOverride(
  s: TermSnapshot,
): { rowY: number; col: number } | null {
  const { rows, cols } = s;
  if (!rows || !cols) return null;

  // 入力ボックス開始行＝「最下」の ❯ 行。
  // claude 2.1.17x+ は過去のユーザー発言もトランスクリプトに「❯ 」付きで
  // 描画するため、「上から最初の ❯」だと過去発言を誤認する。入力ボックスは
  // 常に画面最下の ❯。
  let promptStartY: number | null = null;
  for (let y = rows - 1; y >= 0; y--) {
    if (s.lineText(y).includes("❯")) {
      promptStartY = y;
      break;
    }
  }
  if (promptStartY == null) return null; // 入力ボックス不明 → ネイティブ信頼

  // 実カーソルが入力領域内（❯ 行以降。折り返し行・直下フッターを含む）なら
  // 契約どおり＝xterm ネイティブ配置が正しいので何もしない。
  // ※ 実セル寸法で換算するネイティブの方がピクセル精度も高い。
  if (
    typeof s.cursorY === "number" &&
    s.cursorY >= promptStartY &&
    s.cursorY < rows
  ) {
    return null;
  }

  // ── 以下は保険（実カーソルが入力領域より上＝契約が破れている異常時のみ）──

  // 1) 入力領域を下から走査して最下の反転セル（＝Ink カーソルブロック）。
  //    入力が折り返すと ❯ 行より下の行に来るため下から。緑タグ等は反転でない。
  for (let y = rows - 1; y >= promptStartY; y--) {
    for (let x = cols - 1; x >= 0; x--) {
      if (s.isInverse(y, x)) {
        return { rowY: y, col: x };
      }
    }
  }

  // 2) 最終フォールバック：❯ 行のテキスト末尾
  const t = s.lineText(promptStartY);
  return { rowY: promptStartY, col: Math.max(2, t.length) };
}
