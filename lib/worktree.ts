import type { ParticipantSlot, Thread } from "./types";
import { toCliPermissionMode } from "./types";
import { effectiveParticipants, participantCount } from "./participants";

/**
 * worktree 隔離（v0.4.0）の判定と Thread 更新。
 *
 * 並列・議論モードは全スロットが同じ workspace を acceptEdits で共有していた。
 * 「いつ分けるか」をここに集約し、page.tsx の spawn 経路は cwd を差し替えるだけにする。
 */

/** このスロットの subprocess を worktree で隔離すべきか。 */
export function shouldIsolate(thread: Thread, slot: ParticipantSlot): boolean {
  if (!thread.workspace) return false;
  if (slot.role === "moderator") return false; // 審判は読むだけ
  if (participantCount(thread) < 2) return false; // 単独スレッドは何も変えない
  if (toCliPermissionMode(thread.permissionMode) === "plan") return false; // 読み取り専用
  return true;
}

/** subprocess に渡す cwd。隔離済みなら worktree、そうでなければ thread.workspace。 */
export function slotWorkspace(thread: Thread, slot: ParticipantSlot): string | null {
  return slot.worktreePath ?? thread.workspace;
}

/** スロットに worktree 情報を書き込んだ Thread を返す（null で解除）。 */
export function withSlotWorktree(
  thread: Thread,
  slotId: string,
  info: { path: string; branch: string } | null,
): Thread {
  const participants = effectiveParticipants(thread).map((p) => {
    if (p.id !== slotId) return p;
    if (info === null) {
      const rest = { ...p };
      delete rest.worktreePath;
      delete rest.worktreeBranch;
      return rest;
    }
    return { ...p, worktreePath: info.path, worktreeBranch: info.branch };
  });
  return { ...thread, participants, updatedAt: Date.now() };
}

/** 隔離中（worktree を持つ）スロット一覧。 */
export function isolatedSlots(thread: Thread): ParticipantSlot[] {
  return effectiveParticipants(thread).filter((p) => !!p.worktreePath);
}
