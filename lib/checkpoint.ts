import type { Message, Thread } from "./types";
import { changeTargets, type ChangeTarget } from "./changes";

/**
 * チェックポイント／巻き戻し（v0.4.0）の判定と Thread 更新。
 *
 * ユーザー送信のたびに Rust 側が「ターン開始時の作業ツリー」を
 * refs/unicrew/checkpoints/<thread8>/<seq> に固定し、その commit oid を
 * そのユーザー発言（Message.checkpoint: cwd → oid）に持たせる。
 * 復元は「ファイルだけ」。会話は消さない。
 */

/** 復元の対象1件（cwd と、その cwd で記録した commit oid）。 */
export interface RestoreTarget extends ChangeTarget {
  oid: string;
}

/** 指定メッセージに記録（cwd → oid）を書き込んだ Thread を返す。空なら何もしない。 */
export function withCheckpoint(
  thread: Thread,
  messageId: string,
  points: Record<string, string>,
): Thread {
  const entries = Object.entries(points).filter(([, v]) => typeof v === "string" && v.length > 0);
  if (entries.length === 0) return thread;
  return {
    ...thread,
    messages: thread.messages.map((m) =>
      m.id === messageId
        ? { ...m, checkpoint: { ...(m.checkpoint ?? {}), ...Object.fromEntries(entries) } }
        : m,
    ),
  };
}

/** このメッセージに戻せる記録があるか。 */
export function hasCheckpoint(message: Message): boolean {
  return message.role === "user" && !!message.checkpoint && Object.keys(message.checkpoint).length > 0;
}

/**
 * このメッセージの時点に戻す対象。今のスレッドの対象（作業フォルダ＋隔離中スロット）のうち、
 * 記録が残っている cwd だけ。記録した後に消えた worktree は対象から外れる。
 */
export function restoreTargets(thread: Thread, message: Message): RestoreTarget[] {
  const points = message.checkpoint ?? {};
  return changeTargets(thread)
    .filter((t) => typeof points[t.cwd] === "string" && points[t.cwd].length > 0)
    .map((t) => ({ ...t, oid: points[t.cwd] }));
}

/** 何ターン目のユーザー発言か（1始まり）。見つからなければ 0。 */
export function turnNumberOf(thread: Thread, messageId: string): number {
  let n = 0;
  for (const m of thread.messages) {
    if (m.role !== "user") continue;
    n += 1;
    if (m.id === messageId) return n;
  }
  return 0;
}

/** モーダル用：発言の冒頭（1行・最大 max 文字）。 */
export function excerpt(content: string, max = 60): string {
  const line = content.replace(/\r?\n+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
