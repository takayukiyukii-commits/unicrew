/**
 * Dependency-free ANSI → styled-segment renderer.
 *
 * Goal: render captured command output (stdout+stderr) so it looks EXACTLY
 * like it would in VSCode's integrated terminal — colors, bold/dim, tabs,
 * and carriage-return overwrites (progress bars) behaving correctly.
 *
 * We implement a tiny terminal cell-buffer: characters are written into a
 * per-line array of cells at a cursor column. `\r` moves the cursor to
 * column 0 (so later chars overwrite earlier ones, exactly how a real
 * terminal shows `npm`/`vite`/`tsc` progress bars). The final visible
 * state is what we render — correct for a read-only transcript.
 *
 * No dependencies, no dangerouslySetInnerHTML (segments are rendered as
 * React spans by the caller).
 */

const ESC = "\x1b";

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

export type AnsiLine = AnsiSegment[];

// VSCode Dark+ terminal ANSI palette.
const FG_BASIC = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
];
const FG_BRIGHT = [
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function xterm256(n: number): string {
  if (n < 16) return n < 8 ? FG_BASIC[n] : FG_BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    const h = v.toString(16).padStart(2, "0");
    return `#${h}${h}${h}`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const conv = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  const hx = (c: number) => conv(c).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

interface Cell {
  ch: string;
  style: AnsiStyle;
}

const TAB = 8;
const MAX_LINES = 5000;

/**
 * Parse a raw output string into styled lines, emulating a terminal
 * cell-buffer (so `\r`, `\t`, `\b`, and ANSI SGR all render faithfully).
 */
export function ansiToLines(input: string): AnsiLine[] {
  // Strip OSC (window-title etc.): ESC ] ... (BEL | ST).
  const text = input.replace(
    new RegExp(`${ESC}\\][^]*?(?:\\x07|${ESC}\\\\)`, "g"),
    "",
  );

  const lines: Cell[][] = [];
  let line: Cell[] = [];
  let col = 0;
  let st: AnsiStyle = {};
  let inverse = false;

  const styleNow = (): AnsiStyle => {
    if (!inverse) return { ...st };
    // Swap fg/bg for inverse video.
    return { ...st, fg: st.bg ?? "#1e1e1e", bg: st.fg ?? "#cccccc" };
  };

  const pushChar = (ch: string) => {
    while (line.length < col) line.push({ ch: " ", style: {} });
    line[col] = { ch, style: styleNow() };
    col += 1;
  };

  const applySgr = (params: number[]) => {
    if (params.length === 0) params = [0];
    for (let k = 0; k < params.length; k++) {
      const p = params[k];
      if (p === 0) {
        st = {};
        inverse = false;
      } else if (p === 1) st.bold = true;
      else if (p === 2) st.dim = true;
      else if (p === 3) st.italic = true;
      else if (p === 4) st.underline = true;
      else if (p === 7) inverse = true;
      else if (p === 22) {
        st.bold = false;
        st.dim = false;
      } else if (p === 23) st.italic = false;
      else if (p === 24) st.underline = false;
      else if (p === 27) inverse = false;
      else if (p >= 30 && p <= 37) st.fg = FG_BASIC[p - 30];
      else if (p === 38 || p === 48) {
        const mode = params[k + 1];
        if (mode === 5) {
          const c = xterm256(params[k + 2] ?? 0);
          if (p === 38) st.fg = c;
          else st.bg = c;
          k += 2;
        } else if (mode === 2) {
          const c = `rgb(${params[k + 2] ?? 0},${params[k + 3] ?? 0},${params[k + 4] ?? 0})`;
          if (p === 38) st.fg = c;
          else st.bg = c;
          k += 4;
        }
      } else if (p === 39) st.fg = undefined;
      else if (p >= 40 && p <= 47) st.bg = FG_BASIC[p - 40];
      else if (p === 49) st.bg = undefined;
      else if (p >= 90 && p <= 97) st.fg = FG_BRIGHT[p - 90];
      else if (p >= 100 && p <= 107) st.bg = FG_BRIGHT[p - 100];
    }
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ESC) {
      if (text[i + 1] === "[") {
        // CSI sequence: read params until final byte 0x40-0x7E.
        let j = i + 2;
        let raw = "";
        while (j < text.length && !(text[j] >= "@" && text[j] <= "~")) {
          raw += text[j];
          j++;
        }
        const final = text[j];
        if (final === "m") {
          const params =
            raw === ""
              ? [0]
              : raw.split(";").map((x) => parseInt(x || "0", 10) || 0);
          applySgr(params);
        } else if (final === "K") {
          // Erase line: 0/none = cursor→end, 1 = start→cursor, 2 = whole.
          const n = parseInt(raw || "0", 10);
          if (n === 0) line = line.slice(0, col);
          else if (n === 1)
            for (let x = 0; x < col && x < line.length; x++)
              line[x] = { ch: " ", style: {} };
          else line = [];
        }
        // Other CSI (cursor moves etc.) ignored — we keep final visible state.
        i = j;
        continue;
      }
      // Lone ESC or ESC-x (charset etc.): skip ESC + next char.
      i += 1;
      continue;
    }
    if (c === "\n") {
      lines.push(line);
      line = [];
      col = 0;
      if (lines.length > MAX_LINES) lines.shift();
      continue;
    }
    if (c === "\r") {
      col = 0;
      continue;
    }
    if (c === "\t") {
      const next = Math.floor(col / TAB) * TAB + TAB;
      while (col < next) pushChar(" ");
      continue;
    }
    if (c === "\b") {
      if (col > 0) col -= 1;
      continue;
    }
    if (c < " ") continue; // bell / form-feed / NUL / other controls
    pushChar(c);
  }
  lines.push(line);

  // Coalesce cells into same-style segments per line.
  const key = (s: AnsiStyle) =>
    `${s.fg ?? ""}|${s.bg ?? ""}|${s.bold ? 1 : 0}${s.dim ? 1 : 0}${s.italic ? 1 : 0}${s.underline ? 1 : 0}`;
  return lines.map((cells) => {
    const segs: AnsiSegment[] = [];
    let cur: AnsiSegment | null = null;
    for (const cell of cells) {
      if (cur && key(cur.style) === key(cell.style)) {
        cur.text += cell.ch;
      } else {
        cur = { text: cell.ch, style: cell.style };
        segs.push(cur);
      }
    }
    return segs;
  });
}
