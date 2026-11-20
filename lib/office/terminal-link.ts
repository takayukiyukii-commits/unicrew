/**
 * ターミナル（6分割）と AIオフィスをつなぐ。
 *
 * ターミナルで AI に指示すると、オフィスの社員も同じように動く：
 *   指示して AI が動き出す → 席で作業を始める（吹き出しに指示の出だし）
 *   AI がファイルを読む・探す → 資料の棚へ見に行く
 *   AI が許可を求めて止まる → 社長への受け渡し口で手を挙げて待つ
 *   AI の作業が終わる → ガッツポーズをして、取りまとめ役に報告に行く
 *
 * どのペインがどの社員かは、ペインの番号と席の順番で決める（取りまとめ役を除いた社員の、1番のペイン＝1人目）。
 * ここは「知らせを運ぶ」だけ。オフィスの仕事の進行（engine.ts）には一切書き込まない。
 */

export type TerminalEventKind = "start" | "activity" | "waiting" | "stop";

export interface TerminalEvent {
  /** ペインの番号（1から）。RUNner の知らせは 1000 番台を使う */
  pane: number;
  kind: TerminalEventKind;
  /** どこから来た知らせか（無ければターミナル） */
  source?: "terminal" | "runner";
  /** 持ち主を見分ける印：ターミナルはペインごとの名前（別のページの同じ番号と混ぜない）、RUNner はゴールの番号（8桁） */
  key?: string;
  /** 最後に送った指示（分かるときだけ） */
  instruction?: string | null;
  /** いま使っている道具の名前と中身（画面の「● Read(…)」の行から読む） */
  tool?: string;
  detail?: string;
  at: number;
}

type Listener = (ev: TerminalEvent) => void;
const listeners = new Set<Listener>();

export function subscribeTerminal(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function publishTerminal(ev: TerminalEvent): void {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      /* オフィス側の不具合でターミナルを止めない */
    }
  }
}

/** ペインの名前（例: "2. Claude Code"）から番号を取る。取れなければ null */
export function paneNumberOf(label: string | undefined): number | null {
  const m = /^(\d+)\./.exec(label ?? "");
  return m ? Number(m[1]) : null;
}

// 色や移動の制御文字（画面の文字に混ざっている）
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// 道具の行：「● Read(src/app.ts)」「⏺ Bash(npm test)」など
const TOOL_LINE = /[●⏺]\s*([A-Za-z][A-Za-z0-9_]{1,40})\(([^)\n]{0,200})\)?/g;

/** ターミナルの出力から、いちばん新しい「道具を使った行」を読む。無ければ null */
export function parseToolLine(output: string): { tool: string; detail: string } | null {
  const text = output.replace(ANSI, "");
  let last: { tool: string; detail: string } | null = null;
  TOOL_LINE.lastIndex = 0;
  for (let m = TOOL_LINE.exec(text); m; m = TOOL_LINE.exec(text)) last = { tool: m[1], detail: m[2].trim() };
  return last;
}

/** 道具の行を、何度も同じ物で知らせないための見張り（ペインごと）。 */
export class ToolLineWatcher {
  private lastKey = new Map<number, string>();
  private lastAt = new Map<number, number>();

  /** 新しい道具の行なら、その中身を返す（同じ行の描き直し・短い間隔の連続は返さない） */
  feed(pane: number, output: string, now: number): { tool: string; detail: string } | null {
    if (!output.includes("(")) return null;
    const hit = parseToolLine(output);
    if (!hit) return null;
    const key = `${hit.tool}(${hit.detail}`;
    if (this.lastKey.get(pane) === key) return null;
    if (now - (this.lastAt.get(pane) ?? 0) < 400) return null;
    this.lastKey.set(pane, key);
    this.lastAt.set(pane, now);
    return hit;
  }

  forget(pane: number): void {
    this.lastKey.delete(pane);
    this.lastAt.delete(pane);
  }
}

/** ターミナルの作業を、社員ごとの「いま」に直したもの（表示用）。 */
export interface TerminalActivity {
  pane: number;
  source: "terminal" | "runner";
  key: string | null;
  /** 始まった時刻（RUNner の仕事で、社員が扉から入ってくるきっかけ） */
  startedAt: number;
  status: "working" | "waiting" | "done";
  instruction: string | null;
  /** いま使っている道具（無ければ null） */
  tool: { id: string; name: string; detail: string } | null;
  /** 直前に使い終えた道具（書き終えたら手を挙げる、のきっかけ） */
  finished: { id: string; name: string } | null;
  at: number;
}

let toolSeq = 0;

/** 知らせを1つ受けて、そのペインの「いま」を次に進める。stop のあとは呼び出し側が数秒後に消す。 */
export function nextTerminalActivity(prev: TerminalActivity | undefined, ev: TerminalEvent): TerminalActivity {
  const base: TerminalActivity = prev ?? { pane: ev.pane, source: ev.source ?? "terminal", key: ev.key ?? null, startedAt: ev.at, status: "working", instruction: null, tool: null, finished: null, at: ev.at };
  switch (ev.kind) {
    case "start":
      // 止まっていた・終わっていた所から動き出したら、始まりの時刻を新しくする（同じ作業の途中の知らせでは変えない）
      return { ...base, status: "working", startedAt: prev && prev.status === "working" ? base.startedAt : ev.at, instruction: ev.instruction ?? base.instruction, tool: prev && prev.status === "working" ? base.tool : null, finished: prev && prev.status === "working" ? base.finished : null, at: ev.at };
    case "activity": {
      toolSeq += 1;
      return {
        ...base,
        status: "working",
        instruction: ev.instruction ?? base.instruction,
        finished: base.tool ? { id: base.tool.id, name: base.tool.name } : base.finished,
        tool: ev.tool ? { id: `term-${ev.pane}-${toolSeq}`, name: ev.tool, detail: ev.detail ?? "" } : base.tool,
        at: ev.at,
      };
    }
    case "waiting":
      return { ...base, status: "waiting", instruction: ev.instruction ?? base.instruction, at: ev.at };
    case "stop":
      return { ...base, status: "done", instruction: ev.instruction ?? base.instruction, finished: base.tool ? { id: base.tool.id, name: base.tool.name } : base.finished, tool: null, at: ev.at };
  }
}
