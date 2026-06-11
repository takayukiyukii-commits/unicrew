/**
 * 日本語IME未確定文字（composition-view）の補正先＝入力挿入点の推定ロジック。
 *
 * claude(Ink) の画面バッファから「いまユーザーが文字を挿入する位置」を求める。
 * InteractiveTerminal はこの結果へ composition-view / textarea を移動させる。
 *
 * 【背景】xterm は未確定文字を実カーソル位置に描く。claude 旧バージョンは実カーソルを
 * ステータス行へ置いたため未確定文字がズレ、ヒューリスティック補正を導入した。
 *
 * 【2026-06 復活バグ】claude CLI 2.1.17x の UI 刷新で前提が2つ変わった：
 *  ① 過去のユーザー発言もトランスクリプトに「❯ 」付きで描画されるようになった。
 *     「上から最初の ❯」を入力行とみなす旧ロジックは、1回でも発言した後は
 *     過去発言の行を入力ボックスと誤認する（→ 未確定文字が過去発言の行末に出る）。
 *     入力ボックスは常に画面最下の ❯ なので「下から」走査する。
 *  ② 実カーソルが挿入点に正確に置かれるようになった（upstream 修正）。
 *     Ink の反転カーソルブロックは点滅して消えている瞬間があるため、反転セルが
 *     見つからないときは実カーソル位置を採る。
 *     （旧 claude では実カーソルはステータス行なので、反転セル優先は維持）
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
 * 入力挿入点（ビューポート相対の行・桁）を返す。入力ボックスが見つからなければ null。
 *
 * 優先順位:
 *  1. 入力領域（最下の ❯ 行以降）にある最下の反転セル＝Ink のカーソルブロック
 *  2. 実カーソル（入力領域内にある場合のみ。claude 2.1.17x+ は常に正確）
 *  3. ❯ 行のテキスト末尾（最終フォールバック）
 */
export function findPromptInsertPoint(
  s: TermSnapshot,
): { rowY: number; col: number } | null {
  const { rows, cols } = s;
  if (!rows || !cols) return null;

  // 入力ボックス開始行＝「最下」の ❯ 行（過去発言の「❯ 」を拾わない）
  let promptStartY: number | null = null;
  for (let y = rows - 1; y >= 0; y--) {
    if (s.lineText(y).includes("❯")) {
      promptStartY = y;
      break;
    }
  }
  if (promptStartY == null) return null;

  // 1) 入力領域を下から走査して最下の反転セル（＝Ink カーソル）を探す。
  //    入力が折り返すと ❯ 行より下の行に来るため下から。緑タグ等は反転でない。
  for (let y = rows - 1; y >= promptStartY; y--) {
    for (let x = cols - 1; x >= 0; x--) {
      if (s.isInverse(y, x)) {
        return { rowY: y, col: x };
      }
    }
  }

  // 2) 反転セルが点滅で消えている瞬間：実カーソルが入力領域内ならそれが挿入点
  if (
    typeof s.cursorY === "number" &&
    s.cursorY >= promptStartY &&
    s.cursorY < rows
  ) {
    return { rowY: s.cursorY, col: s.cursorX ?? 0 };
  }

  // 3) フォールバック：❯ 行のテキスト末尾
  const t = s.lineText(promptStartY);
  return { rowY: promptStartY, col: Math.max(2, t.length) };
}
