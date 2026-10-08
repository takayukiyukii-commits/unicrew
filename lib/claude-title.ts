/**
 * Claude Code が作業を終えた瞬間を、ターミナルのタイトル（OSC 0）で見分ける（2026-10-08）。
 *
 * 実測（Claude Code 2.1.292・PTY で記録）:
 * - 作業中: タイトルの先頭が「◐」「◑」で約1秒ごとに入れ替わる
 * - 止まった瞬間: 先頭が「✳」に変わる
 * - 🚨 許可の確認（Do you want to proceed?）で止まったときも「✳」になる
 *   → 「終わった」か「確認待ち」かは、そのときの画面を見て呼び出し側が分ける
 * - タイトルの後ろの題名は指示の中身と関係なく同じになることがあり、作業の説明には使えない
 *
 * 以前は「出力が8秒続いて4秒止まったら終わり」と推測していた。確認待ちの間も
 * 印の点滅で出力が続くなど、出力の量では終わりを正しく取れず、誤報の元だった。
 */

export type ClaudeTitleState = "working" | "idle" | "other";

export function classifyClaudeTitle(title: string): ClaudeTitleState {
  const c = Array.from(title.trimStart())[0] ?? "";
  if (c === "✳") return "idle";
  if (/[◐◑◒◓]/.test(c)) return "working";
  // 点字の回転表示（版によってはこちら）
  if (c >= "⠁" && c <= "⣿") return "working";
  return "other";
}

/** 止まってからこの時間、作業中に戻らなければ「止まった」と確定する。 */
export const CLAUDE_IDLE_GRACE_MS = 700;
/** これより短い作業は知らせない（打鍵への短い反応など）。 */
export const CLAUDE_MIN_WORK_MS = 3_000;

export class ClaudeTitleTracker {
  private workStart: number | null = null;
  private idleAt: number | null = null;
  /** 一度でも作業中のタイトルを見たか（＝このペインはタイトルで判定できる） */
  seen = false;

  /** タイトルが変わったとき。 */
  feed(title: string, now: number): void {
    const s = classifyClaudeTitle(title);
    if (s === "working") {
      this.seen = true;
      if (this.workStart === null) this.workStart = now;
      this.idleAt = null; // 一瞬止まってまた動いた＝同じ作業の続き
    } else if (s === "idle") {
      if (this.workStart !== null && this.idleAt === null) this.idleAt = now;
    }
  }

  /** いま作業中か（止まったあと、また動き出したか） */
  isWorking(): boolean {
    return this.workStart !== null && this.idleAt === null;
  }

  /**
   * 止まってから猶予が過ぎていれば、作業時間（ms）を1回だけ返す。それ以外は null。
   * 短すぎる作業は数えずに捨てる。
   */
  settle(now: number): number | null {
    if (this.workStart === null || this.idleAt === null) return null;
    if (now - this.idleAt < CLAUDE_IDLE_GRACE_MS) return null;
    const worked = this.idleAt - this.workStart;
    this.workStart = null;
    this.idleAt = null;
    return worked >= CLAUDE_MIN_WORK_MS ? worked : null;
  }
}

/** 通知の本文に出す指示の要約（1行・長ければ切る）。 */
export function summarizeInstruction(line: string | null, max = 60): string | null {
  if (!line) return null;
  const s = line.replace(/\s+/g, " ").trim();
  if (!s) return null;
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : s;
}

/**
 * 止まった後の出力で「許可の確認待ち」を見分ける（2026-10-08 実測）。
 * - 確認待ち: 道具の印「●」が点滅し続け、約0.6秒ごとに出力が来る（16秒で約30回）
 * - 普通に終わった: 止まった後の出力はほぼ無い（16秒で1回）
 * 猶予のあと、この時間に来た出力の回数で判断する。
 */
export const CLAUDE_BLINK_WINDOW_MS = 1_300;

export function looksLikeWaiting(outputsInWindow: number): boolean {
  return outputsInWindow >= 2;
}
