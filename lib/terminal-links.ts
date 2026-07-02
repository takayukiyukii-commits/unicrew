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
const PATH_EDGE_CHAR = /[\p{L}\p{N}_.:（）()【】「」§※・〜＆＃＠&#@/\\~-]/u;

/** 行の「最後の実セル」の文字を返す（全角の後半セルはスキップ。空行なら ""）。 */
function lastCellChars(line: LineLike): string {
  for (let x = line.length - 1; x >= 0; x--) {
    const cell = line.getCell(x);
    if (!cell) continue;
    if (cell.getWidth() === 0) continue; // 全角の後半セル
    return cell.getChars(); // null セルは "" が返る＝行末まで埋まっていない
  }
  return "";
}

/** 行の先頭セルの文字を返す（空なら ""）。 */
function firstCellChars(line: LineLike): string {
  const cell = line.getCell(0);
  if (!cell || cell.getWidth() === 0) return "";
  return cell.getChars();
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
  const tail = lastCellChars(prev);
  if (!tail || !PATH_EDGE_CHAR.test(tail)) return false;
  const head = firstCellChars(cur);
  return Boolean(head) && PATH_EDGE_CHAR.test(head);
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
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      // width 0 = 全角文字の後半セル（実体は前のセル）→ スキップ
      if (width === 0) continue;
      const raw = cell.getChars();
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
    const nextWrapped = getLine(r + 1)?.isWrapped === true;
    if (nextWrapped) {
      while (rowIsNull.length > 0 && rowIsNull[rowIsNull.length - 1]) {
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
