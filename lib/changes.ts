import type { ParticipantSlot, Thread } from "./types";
import { isolatedSlots } from "./worktree";

/**
 * 変更の差分ビュー（v0.4.0）の判定と Thread 更新。
 *
 * 「どの cwd を見るか」「ターン開始時の基準（tree oid）をどこに持つか」をここに集約し、
 * RightPane は一覧を描くだけ、page.tsx は送信時に記録するだけにする。
 */

/** 差分を見られる対象。作業フォルダ＋worktree 隔離中のスロット。 */
export interface ChangeTarget {
  /** "workspace" か slot.id */
  key: string;
  cwd: string;
  /** 隔離中スロットの場合だけ入る（表示名の解決は呼び出し側） */
  slot?: ParticipantSlot;
}

/** このスレッドで差分を見られる対象一覧。workspace が無ければ空。 */
export function changeTargets(thread: Thread): ChangeTarget[] {
  if (!thread.workspace) return [];
  const out: ChangeTarget[] = [{ key: "workspace", cwd: thread.workspace }];
  for (const s of isolatedSlots(thread)) {
    if (s.worktreePath) out.push({ key: s.id, cwd: s.worktreePath, slot: s });
  }
  return out;
}

/** 送信時に記録すべき cwd の一覧（重複なし）。 */
export function snapshotCwds(thread: Thread): string[] {
  return Array.from(new Set(changeTargets(thread).map((t) => t.cwd)));
}

/** ターン開始時の tree を Thread に書き込む（cwd ごと・既存は上書き）。 */
export function withTurnBase(thread: Thread, trees: Record<string, string>): Thread {
  const entries = Object.entries(trees).filter(([, v]) => typeof v === "string" && v.length > 0);
  if (entries.length === 0) return thread;
  return { ...thread, turnBase: { ...(thread.turnBase ?? {}), ...Object.fromEntries(entries) } };
}

/** cwd の「このターン」基準（tree oid）。未記録なら undefined（→ HEAD 比較）。 */
export function turnBaseFor(thread: Thread, cwd: string): string | undefined {
  return thread.turnBase?.[cwd];
}

/** 一覧の見出し用：ステータス1文字を短い記号にする。 */
export function statusGlyph(status: string): string {
  switch (status) {
    case "A":
      return "+";
    case "D":
      return "−";
    case "R":
      return "→";
    default:
      return "±";
  }
}
