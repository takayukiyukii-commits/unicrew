import type {
  ParticipantSlot,
  Provider,
  Thread,
} from "./types";
import { getCharacter } from "./characters";

/**
 * Thread から「現在の参加者リスト」を返す統一関数。
 *
 * 優先順位:
 *   1. thread.participants が定義されていればそれを返す（N-way並列）
 *   2. thread.splitMode なら splitCharacterIds から claude/codex の2人ぶんを生成（旧2way後方互換）
 *   3. それ以外は characterId で1人ぶん（単独モード）
 *
 * 単独モードでも常に1要素配列で返るため、UI/送信ロジックの分岐が単純化される。
 */
export function effectiveParticipants(thread: Thread): ParticipantSlot[] {
  if (thread.participants && thread.participants.length > 0) {
    return thread.participants;
  }
  if (thread.splitMode) {
    const claudeId = thread.splitCharacterIds?.claude ?? thread.characterId;
    const codexId = thread.splitCharacterIds?.codex ?? thread.characterId;
    return [
      { id: "claude", provider: "claude", characterId: claudeId },
      { id: "codex", provider: "codex", characterId: codexId },
    ];
  }
  const c = getCharacter(thread.characterId);
  return [
    {
      id: "single",
      provider: c?.provider ?? "claude",
      characterId: thread.characterId,
    },
  ];
}

/** 参加者数。1なら単独モード、2以上なら並列。 */
export function participantCount(thread: Thread): number {
  return effectiveParticipants(thread).length;
}

/** 並列モード（参加者2人以上）か。 */
export function isParallel(thread: Thread): boolean {
  return participantCount(thread) >= 2;
}

/**
 * session_id 文字列を生成する。
 *
 * 並列時は `${threadId}::${slotId}` 形式。
 * 単独時はthreadIdそのまま。
 *
 * 旧2way構造の slotId は "claude"/"codex" でこれは Provider と一致するので、
 * 既存の parseSid 互換コードでもそのまま動く。
 */
export function makeSlotSid(
  threadId: string,
  slotId: string,
  parallel: boolean,
): string {
  return parallel ? `${threadId}::${slotId}` : threadId;
}

/**
 * session_id 文字列を分解。
 *
 * 戻り値の slotId が null の場合は単独モード扱い。
 */
export function parseSlotSid(sid: string): {
  threadId: string;
  slotId: string | null;
} {
  const idx = sid.lastIndexOf("::");
  if (idx === -1) {
    return { threadId: sid, slotId: null };
  }
  return {
    threadId: sid.slice(0, idx),
    slotId: sid.slice(idx + 2),
  };
}

/** Thread + sid から参加者スロットを引く。 */
export function findSlot(
  thread: Thread,
  slotId: string | null,
): ParticipantSlot | null {
  const list = effectiveParticipants(thread);
  if (slotId === null) return list[0] ?? null;
  return list.find((p) => p.id === slotId) ?? null;
}

/**
 * 旧API互換：provider 指定で参加者を1つ返す。
 * 同じproviderが複数あった場合は先頭を返す。
 */
export function findSlotByProvider(
  thread: Thread,
  provider: Provider,
): ParticipantSlot | null {
  const list = effectiveParticipants(thread);
  return list.find((p) => p.provider === provider) ?? null;
}

/**
 * Thread を更新するヘルパー。participants を直接編集して
 * splitMode/splitCharacterIds との整合性を取る。
 */
export function withParticipants(
  thread: Thread,
  next: ParticipantSlot[],
): Thread {
  return {
    ...thread,
    participants: next,
    splitMode: next.length >= 2,
    // splitCharacterIds は旧UI互換のため、最初に見つかった claude / codex を反映
    splitCharacterIds: deriveSplitCharacterIds(next),
    updatedAt: Date.now(),
  };
}

function deriveSplitCharacterIds(
  participants: ParticipantSlot[],
): { claude: string; codex: string } | undefined {
  const claude = participants.find((p) => p.provider === "claude");
  const codex = participants.find((p) => p.provider === "codex");
  if (!claude && !codex) return undefined;
  return {
    claude: claude?.characterId ?? participants[0]?.characterId ?? "",
    codex: codex?.characterId ?? participants[0]?.characterId ?? "",
  };
}

/**
 * 新規参加者を加える。slot id は重複しないように自動採番。
 */
export function addParticipant(
  thread: Thread,
  slot: Omit<ParticipantSlot, "id"> & { id?: string },
): Thread {
  const current = effectiveParticipants(thread);
  const id = slot.id ?? nextSlotId(current);
  const next: ParticipantSlot[] = [...current, { ...slot, id }];
  return withParticipants(thread, next);
}

/**
 * 指定 slot を取り除く。残り1人になったら splitMode を OFF にして単独に戻す。
 */
export function removeParticipant(thread: Thread, slotId: string): Thread {
  const current = effectiveParticipants(thread);
  const next = current.filter((p) => p.id !== slotId);
  if (next.length <= 1) {
    return {
      ...thread,
      participants: undefined,
      splitMode: false,
      splitCharacterIds: undefined,
      characterId: next[0]?.characterId ?? thread.characterId,
      updatedAt: Date.now(),
    };
  }
  return withParticipants(thread, next);
}

/**
 * slot の characterId / provider を変更する。
 */
export function updateParticipant(
  thread: Thread,
  slotId: string,
  patch: Partial<Omit<ParticipantSlot, "id">>,
): Thread {
  const current = effectiveParticipants(thread);
  const next = current.map((p) =>
    p.id === slotId ? { ...p, ...patch } : p,
  );
  return withParticipants(thread, next);
}

function nextSlotId(existing: ParticipantSlot[]): string {
  const used = new Set(existing.map((p) => p.id));
  for (let i = 1; i <= 99; i++) {
    const id = `p${i}`;
    if (!used.has(id)) return id;
  }
  return `p${Date.now().toString(36)}`;
}
