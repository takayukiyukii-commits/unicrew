/**
 * ターミナルリンク（Ctrl/Cmd+Click）用：xterm バッファの「論理行」読み取りと
 * 文字列インデックス→セル座標の変換。
 *
 * 【背景：部分クリックバグ（2026-06-12）】
 * 旧実装は translateToString() の文字列インデックスをそのまま xterm のリンク範囲
 * （セル座標）に渡していた。しかし全角文字（日本語）は文字列上は1文字でも
 * 端末上は2セルを占めるため：
 *  - パス内に日本語が n 文字あるとクリック領域が n セル短くなる（部分クリック）
 *  - パスの手前に日本語の地の文があると開始位置が手前にズレる
 * また視覚行1行ずつしか見ていなかったため、長いパスが折り返されると断片しか
 * リンクにならなかった。
 *
 * 本モジュールは
 *  1. 折り返し（isWrapped）を遡って論理行全体のテキストを組み立て、
 *  2. テキストの各文字（コードユニット）がどの行・どのセルにあるかの対応表を作り、
 *  3. 正規表現マッチ（文字列インデックス）を正確なセル範囲（複数行可）へ変換する。
 * VS Code / xterm 公式 WebLinksAddon と同じアプローチ。
 */

/** xterm IBufferCell の必要最小インターフェース */
export interface CellLike {
  getChars(): string;
  getWidth(): number;
}

/** xterm IBufferLine の必要最小インターフェース */
export interface LineLike {
  isWrapped: boolean;
  length: number;
  getCell(x: number): CellLike | undefined;
}

/** text[i]（コードユニット）→ セル位置の対応 */
export interface CellRef {
  /** バッファ絶対行（0-based） */
  row: number;
  /** セル桁（0-based。全角はこのセルと次のセルを占める） */
  x: number;
  /** セル幅（1 or 2） */
  width: number;
}

export interface LogicalLineInfo {
  /** 論理行の先頭バッファ行（0-based） */
  startRow: number;
  /** 論理行の末尾バッファ行（0-based） */
  endRow: number;
  /** 折り返しを連結した論理行テキスト（末尾空白はトリム済み） */
  text: string;
  /** text の各コードユニットに対応するセル位置（text と同じ長さ） */
  map: CellRef[];
}

/** 論理行の最大行数（暴走防止。これを超える折り返しは打ち切り） */
const MAX_LOGICAL_ROWS = 40;

/**
 * パス構成文字（lib/file-link.ts の PATH_TOKEN と揃える）。
 * ConPTY ハードラップ連結（下記 isHardWrapContinuation）の誤爆を抑えるために使う。
 */
const PATH_EDGE_CHAR = /[\p{L}\p{N}_.:+（）()【】「」§※・〜＆＃＠&#@/\\~-]/u;

/** ハードラップ継続行の先頭で許容するインデント幅（Ink 等の折り返しインデント吸収）。 */
const MAX_HARD_WRAP_INDENT = 8;
/** 行末側で許容する未使用セル数（Ink は幅-1〜-2 で折り返すことがある）。 */
const MAX_TAIL_SLACK = 2;

/**
 * 行末側の「最後の実文字セル」を返す。末尾の空セル/空白は MAX_TAIL_SLACK 個まで
 * 許容し、それより空いている行は「幅いっぱいまで埋まっていない＝折り返しではない」
 * として null を返す（誤連結防止の要）。
 */
function lastContentChar(line: LineLike): { chars: string; x: number } | null {
  let skipped = 0;
  for (let x = line.length - 1; x >= 0; x--) {
    const cell = line.getCell(x);
    if (!cell) continue;
    if (cell.getWidth() === 0) continue; // 全角の後半セル
    const ch = cell.getChars();
    if (ch === "" || ch === " ") {
      skipped++;
      if (skipped > MAX_TAIL_SLACK) return null;
      continue;
    }
    return { chars: ch, x };
  }
  return null;
}

/**
 * 継続行の先頭インデント（空白/空セル、MAX_HARD_WRAP_INDENT 個まで）をスキップした
 * 最初の実文字セルを返す。claude(Ink) は折り返し継続行に 2 スペースのインデントを
 * 付けるため、先頭セル固定の判定だと連結できない。
 */
function firstContentChar(line: LineLike): { chars: string; x: number } | null {
  const limit = Math.min(line.length, MAX_HARD_WRAP_INDENT + 1);
  for (let x = 0; x < limit; x++) {
    const cell = line.getCell(x);
    if (!cell) continue;
    if (cell.getWidth() === 0) continue;
    const ch = cell.getChars();
    if (ch === "" || ch === " ") continue;
    return { chars: ch, x };
  }
  return null;
}

/**
 * ConPTY のハードラップ（設計書④ B-1）を「論理行の継続」とみなすか判定する。
 *
 * Windows の ConPTY は reflow を持たず、端末幅で出力を物理的に折り返して
 * 「実改行」として寄越すため、xterm の isWrapped フラグが立たない。
 * その場合でも「前行が端末幅いっぱいまで埋まっていて、行末がパス構成文字」かつ
 * 「当該行の先頭もパス構成文字」なら、折り返された1本のパスとみなして連結する。
 * （罫線・空白終わりの行は PATH_EDGE_CHAR に落ちるので連結されない）
 */
function isHardWrapContinuation(
  prev: LineLike | undefined,
  cur: LineLike | undefined,
): boolean {
  if (!prev || !cur) return false;
  const tail = lastContentChar(prev);
  if (!tail || !PATH_EDGE_CHAR.test(tail.chars)) return false;
  const head = firstContentChar(cur);
  return head != null && PATH_EDGE_CHAR.test(head.chars);
}

/** cur 行が prev 行の続き（ソフトラップ or ConPTY ハードラップ）か。 */
function continuesFrom(
  prev: LineLike | undefined,
  cur: LineLike | undefined,
): boolean {
  if (!cur) return false;
  if (cur.isWrapped) return true;
  return isHardWrapContinuation(prev, cur);
}

/**
 * 指定バッファ行を含む「論理行」（折り返し連結）を読み取る。
 * @param getLine バッファ絶対行(0-based) → 行。範囲外は undefined。
 * @param row 起点のバッファ絶対行（0-based）
 */
export function readLogicalLine(
  getLine: (row: number) => LineLike | undefined,
  row: number,
): LogicalLineInfo | null {
  if (!getLine(row)) return null;

  // 折り返しの先頭まで遡る（isWrapped = この行が前行の続き。
  // ConPTY ハードラップは isWrapped が立たないため continuesFrom で吸収する）
  let startRow = row;
  while (
    row - startRow < MAX_LOGICAL_ROWS &&
    getLine(startRow - 1) &&
    continuesFrom(getLine(startRow - 1), getLine(startRow))
  ) {
    startRow--;
  }

  let text = "";
  const map: CellRef[] = [];
  let endRow = startRow;
  for (let r = startRow; r - startRow < MAX_LOGICAL_ROWS; r++) {
    const line = getLine(r);
    if (!line) break;
    // 次の論理行に入った（ソフトラップでも ConPTY ハードラップ継続でもない）
    if (r !== startRow && !continuesFrom(getLine(r - 1), line)) break;
    endRow = r;
    const rowText: string[] = [];
    const rowMap: CellRef[] = [];
    const rowIsNull: boolean[] = [];
    // ConPTY/Ink ハードラップの継続行は先頭インデント（空白）をスキップして接合する
    // （インデント込みだと空白がパスを分断する）。ソフトラップ行はそのまま。
    let skipIndent =
      r !== startRow && !line.isWrapped ? MAX_HARD_WRAP_INDENT : 0;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      // width 0 = 全角文字の後半セル（実体は前のセル）→ スキップ
      if (width === 0) continue;
      const raw = cell.getChars();
      if (skipIndent > 0) {
        if (raw === "" || raw === " ") {
          skipIndent--;
          continue;
        }
        skipIndent = 0;
      }
      const chars = raw || " "; // 空(null)セルはスペース扱い
      for (let i = 0; i < chars.length; i++) {
        rowText.push(chars[i]);
        rowMap.push({ row: r, x, width });
        rowIsNull.push(raw === "");
      }
    }
    // 全角文字が行末1セルに収まらず折り返したとき、xterm は行末に null セルを
    // 残す。次行へ続く行（=最終行以外）の末尾 null セルはこのパディングなので
    // 取り除く（残すと論理行テキストに幽霊スペースが入りパスが分断される）。
    const nextLine = getLine(r + 1);
    const nextWrapped = nextLine?.isWrapped === true;
    if (nextWrapped) {
      while (rowIsNull.length > 0 && rowIsNull[rowIsNull.length - 1]) {
        rowText.pop();
        rowMap.pop();
        rowIsNull.pop();
      }
    } else if (isHardWrapContinuation(line, nextLine)) {
      // ハードラップ継続前の行末の空白/空セル（slack 分）も除去して密着させる
      while (rowText.length > 0 && rowText[rowText.length - 1] === " ") {
        rowText.pop();
        rowMap.pop();
        rowIsNull.pop();
      }
    }
    text += rowText.join("");
    map.push(...rowMap);
  }

  // 末尾の空白をトリム（map も同期）
  let end = text.length;
  while (end > 0 && text[end - 1] === " ") end--;
  return {
    startRow,
    endRow,
    text: text.slice(0, end),
    map: map.slice(0, end),
  };
}

/** xterm IBufferRange（1-based・end は最終セルを含む） */
export interface BufferRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * 論理行テキスト上のマッチ範囲 [start, end)（文字列インデックス）を
 * xterm のセル範囲（1-based、複数行可、全角の後半セルも含む）へ変換する。
 */
export function matchToBufferRange(
  info: LogicalLineInfo,
  start: number,
  end: number,
): BufferRange | null {
  if (start < 0 || end <= start) return null;
  const s = info.map[start];
  const e = info.map[end - 1];
  if (!s || !e) return null;
  return {
    start: { x: s.x + 1, y: s.row + 1 },
    // end は inclusive。全角末尾文字は2セル目まで含める（x + width - 1 + 1 = x + width）
    end: { x: e.x + e.width, y: e.row + 1 },
  };
}
