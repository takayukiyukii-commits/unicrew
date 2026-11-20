/**
 * RUNner（UNIHUB のゴールを、このパソコンの AI が無人で進める仕組み）と AIオフィスをつなぐ。
 *
 * RUNner の受け取り役は、AI の作業の記録を「作業フォルダ/<ゴールの番号8桁>/.run-runner.log」に書き足している。
 * その末尾を読むだけで、いまどのゴールが動いているか・何をしているか・止まったかが分かる。
 * UNICREW は読むだけ（RUNner には何も送らない・記録を書き換えない）。指示や承認は、今までどおり UNIHUB の画面で行う。
 *
 * 見え方：ゴールを受け取る＝社員が扉から入って席に着く／調べる・読む＝資料の棚へ／
 *        承認や質問で止まる＝社長への受け渡し口で手を挙げて待つ／終わる＝ガッツポーズをして報告に行く
 */
import type { TerminalEvent } from "./terminal-link";

export const RUN_LOG_NAME = ".run-runner.log";
/** この時間、記録が書き足されなければ「動いていない」と見る */
export const RUN_LIVE_MS = 150_000;
/** 末尾から読む量 */
export const RUN_TAIL_BYTES = 64 * 1024;

export type RunState = "working" | "waiting" | "done";

export interface RunSnapshot {
  state: RunState;
  /** いま使っている道具（無ければ null） */
  tool: { key: string; name: string; detail: string } | null;
  /** AI が自分で書いた「いまやっていること」の一言（report_run_status の文） */
  message: string | null;
  /** ゴールの番号（全部）。記録から読めたときだけ */
  goalId: string | null;
}

interface Json {
  [key: string]: unknown;
}

function asObj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 道具の中身から、吹き出しに出す短い説明（ファイル名・コマンド・検索の言葉） */
function detailOf(input: Json | null): string {
  if (!input) return "";
  for (const k of ["file_path", "path", "command", "pattern", "query", "url", "title"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ").slice(0, 120);
  }
  return "";
}

const WAITING_STATUS = /waiting|approval|blocked|needs_/i;
const WAITING_TOOLS = /request_approval|ask_member/i;

/**
 * 記録の末尾（何行か）から、そのゴールの「いま」を読む。
 * Claude Code の記録（stream-json）と Codex の記録（--json）の両方を読む。読めない行は読み飛ばす。
 */
export function parseRunLog(tail: string): RunSnapshot {
  const snap: RunSnapshot = { state: "working", tool: null, message: null, goalId: null };
  let waiting = false;
  let ended = false;
  const lines = tail.split("\n");
  // 末尾だけを読むので、最初の行は途中から始まっていることがある（読めなければ捨てる）
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line[0] !== "{") return;
    let o: Json | null = null;
    try {
      o = asObj(JSON.parse(line));
    } catch {
      return;
    }
    if (!o) return;
    const type = str(o.type);

    const noteTool = (key: string, name: string, input: Json | null) => {
      ended = false; // 終わったあとにまた動いた（返事を受けて続きから）
      snap.state = "working";
      snap.tool = { key, name, detail: detailOf(input) };
      const goal = str(input?.goal_id);
      if (goal) snap.goalId = goal;
      const short = name.replace(/^mcp__run__/, "");
      if (short === "report_run_status") {
        const message = str(input?.message).trim();
        if (message) snap.message = message.replace(/\s+/g, " ").slice(0, 140);
        const status = str(input?.status);
        waiting = WAITING_STATUS.test(status);
      } else if (WAITING_TOOLS.test(short)) {
        waiting = true;
      } else {
        waiting = false;
      }
    };

    if (type === "assistant") {
      // Claude Code：{"type":"assistant","message":{"content":[{"type":"tool_use","id":…,"name":…,"input":{…}}]}}
      const content = asObj(o.message)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asObj(block);
          if (b && b.type === "tool_use") noteTool(str(b.id) || `l${index}`, str(b.name), asObj(b.input));
        }
      }
    } else if (type === "item.started" || type === "item.completed") {
      // Codex：{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"run","tool":"…","arguments":{…}}}
      const item = asObj(o.item);
      const kind = str(item?.type);
      if (item && kind === "mcp_tool_call") {
        const server = str(item.server);
        noteTool(str(item.id) || `l${index}`, server === "run" ? `mcp__run__${str(item.tool)}` : str(item.tool), asObj(item.arguments));
      } else if (item && (kind === "command_execution" || kind === "local_shell_call")) {
        noteTool(str(item.id) || `l${index}`, "Bash", { command: str(item.command) });
      } else if (item && (kind === "file_change" || kind === "patch")) {
        noteTool(str(item.id) || `l${index}`, "Edit", asObj(item));
      }
    } else if (type === "result" || type === "turn.completed" || type === "turn.failed") {
      ended = true;
    }
  });
  if (ended) {
    snap.state = waiting ? "waiting" : "done";
    snap.tool = null;
  }
  return snap;
}

interface Tracked {
  slot: number;
  state: RunState | "idle";
  toolKey: string | null;
  message: string | null;
  goalId: string | null;
  /** 最後に見た記録の更新時刻 */
  modified: number;
}

export interface RunLogReading {
  /** ゴールのフォルダ名（番号8桁） */
  key: string;
  modifiedMs: number;
  /** 末尾の文字。動いていないフォルダは読まずに null でよい */
  tail: string | null;
}

/**
 * 読んだ結果を前回と比べて、オフィスに流す知らせを作る（同じ知らせを何度も流さない）。
 * 画面にもファイルにも触らないので、記録を読んだ結果を渡して試験できる。
 */
export class RunWatcher {
  private tracked = new Map<string, Tracked>();
  private nextSlot = 0;

  /** いま追っているゴール（動いている・待っている）の数と、その番号 */
  active(): { key: string; goalId: string | null; state: RunState | "idle" }[] {
    return [...this.tracked.entries()].filter(([, t]) => t.state === "working" || t.state === "waiting").map(([key, t]) => ({ key, goalId: t.goalId, state: t.state }));
  }

  feed(readings: readonly RunLogReading[], now: number): TerminalEvent[] {
    const events: TerminalEvent[] = [];
    const seen = new Set<string>();
    for (const r of readings) {
      seen.add(r.key);
      let t = this.tracked.get(r.key);
      const live = now - r.modifiedMs < RUN_LIVE_MS;
      if (!t) {
        // 初めて見るフォルダ：いま動いているものだけ追い始める（昔の記録で社員を動かさない）
        if (!live || r.tail === null) continue;
        t = { slot: this.nextSlot++, state: "idle", toolKey: null, message: null, goalId: null, modified: 0 };
        this.tracked.set(r.key, t);
      }
      if (r.tail === null || r.modifiedMs === t.modified) {
        // 書き足されていない。動いていたのに長く止まったままなら、終わった扱いにする（受け取り役が落ちた等）
        if (t.state === "working" && !live) {
          t.state = "done";
          events.push(this.ev(r.key, t, "stop", now));
        }
        continue;
      }
      t.modified = r.modifiedMs;
      const snap = parseRunLog(r.tail);
      if (snap.goalId) t.goalId = snap.goalId;
      const label = snap.message ?? t.message;
      if (snap.state === "working") {
        if (t.state !== "working") {
          t.state = "working";
          t.toolKey = null;
          events.push({ ...this.ev(r.key, t, "start", now), instruction: label });
        }
        if (snap.tool && snap.tool.key !== t.toolKey) {
          t.toolKey = snap.tool.key;
          events.push({ ...this.ev(r.key, t, "activity", now), tool: snap.tool.name, detail: snap.tool.detail, instruction: label });
        } else if (snap.message && snap.message !== t.message) {
          events.push({ ...this.ev(r.key, t, "start", now), instruction: snap.message });
        }
      } else if (snap.state === "waiting") {
        if (t.state !== "waiting") {
          t.state = "waiting";
          events.push({ ...this.ev(r.key, t, "waiting", now), instruction: label });
        }
      } else if (t.state === "working" || t.state === "waiting") {
        t.state = "done";
        events.push({ ...this.ev(r.key, t, "stop", now), instruction: label });
      }
      t.message = label;
    }
    // フォルダが消えたゴールは追うのをやめる
    for (const key of [...this.tracked.keys()]) if (!seen.has(key)) this.tracked.delete(key);
    return events;
  }

  private ev(key: string, t: Tracked, kind: TerminalEvent["kind"], at: number): TerminalEvent {
    return { pane: RUN_PANE_BASE + t.slot, kind, source: "runner", key, at };
  }
}

/** RUNner の知らせに使う「ペインの番号」の始まり（ターミナルの番号と重ならないようにする） */
export const RUN_PANE_BASE = 1000;

/** UNIHUB の RUNner の画面（指示・承認はここで行う） */
export const RUN_SITE_URL = "https://hub.uni-core.jp/app/run";

/** RUNner の作業フォルダを探す候補（受け取り役の既定は ホーム/run-work） */
export const RUN_DIR_CANDIDATES = ["~/run-work", "D:/run-work"];
