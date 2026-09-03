import type { Thread } from "./types";
import { createThread } from "./storage";

/**
 * サイドチャット（v0.4.0・Cursor の side chat の輸入）。
 *
 * 本線（親スレッド）の文脈を持ったまま、脇で短い相談をする。
 * - 親の直近会話を system prompt に注入して起動（読み取り専用 plan）
 * - 入れ子は不可（サイドのサイドは作らない）
 * - 閉じる＝アーカイブ（削除しない）。「親に戻す」でサイドの結論を親の次の送信に前置きする
 * ここは純関数だけ（判定・作成・並べ替え・`/side` の解釈）。
 */

export function isSideThread(thread: Thread | null | undefined): boolean {
  return !!thread && thread.kind === "side";
}

/** `/side 質問` を解釈する。質問は無くてもよい（空なら作るだけ）。サイドコマンドでなければ null。 */
export function parseSideCommand(text: string): { question: string } | null {
  const m = /^\/side(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  return { question: (m[1] ?? "").trim() };
}

/** 親から派生したサイドスレッドを作る（キャラ・作業フォルダ・モデルを引き継ぎ、plan 固定）。 */
export function createSideThread(parent: Thread, question: string): Thread {
  const base = createThread({
    characterId: parent.participants?.[0]?.characterId ?? parent.characterId,
    workspace: parent.workspace,
    splitMode: false,
    conferenceMode: false,
  });
  const head = question.replace(/\s+/g, " ").trim();
  return {
    ...base,
    model: parent.model,
    kind: "side",
    parentId: parent.id,
    permissionMode: "plan",
    title: `↳ ${head ? (head.length > 24 ? `${head.slice(0, 24)}…` : head) : parent.title}`,
    titleEdited: true,
  };
}

/** サイドの結論＝最後の AI 発言（無ければ null）。 */
export function sideConclusion(side: Thread): string | null {
  for (let i = side.messages.length - 1; i >= 0; i--) {
    const m = side.messages[i];
    if (m.role === "assistant" && !m.audit && m.content.trim()) return m.content.trim();
  }
  return null;
}

/** 親の「次の送信に前置きする結論」に追加する。 */
export function withPendingConclusion(parent: Thread, conclusion: string): Thread {
  return {
    ...parent,
    pendingSideConclusions: [...(parent.pendingSideConclusions ?? []), conclusion],
  };
}

/**
 * 送信本文に前置きする。結論を消した Thread と本文を返す。
 *
 * `only` を渡すと **その結論だけ**を前置きし、残りは pending に残す。
 * 🚨 2026-09-04 監査: 応答中にキューへ積んだ送信は、実行時に「そのとき pending にある全部」を
 * 拾っていた。積んだ後に戻ってきた別のサイドの結論まで、無関係な古い指示に混ざる。
 * キューは積んだ時点の結論を控えて `only` で渡す。
 */
export function prependConclusions(
  thread: Thread,
  text: string,
  only?: string[],
): { thread: Thread; text: string } {
  const pending = thread.pendingSideConclusions ?? [];
  if (pending.length === 0) return { thread, text };
  const use = only ? pending.filter((c) => only.includes(c)) : pending;
  if (use.length === 0) return { thread, text };
  const rest = pending.filter((c) => !use.includes(c));
  const block = use.map((c) => c.trim()).join("\n\n---\n\n");
  return {
    thread: { ...thread, pendingSideConclusions: rest.length > 0 ? rest : undefined },
    text: `## サイドチャットの結論\n\n${block}\n\n---\n\n[ユーザーからのメッセージ]\n${text}`,
  };
}

export interface SidebarEntry {
  thread: Thread;
  /** 0=本線 / 1=サイド（親の直下にインデント表示） */
  depth: number;
}

/**
 * サイドバーの並び：更新順に本線を並べ、各本線の直下にそのサイド（更新順）を置く。
 * 親が無い（消えた）サイドは本線として扱う。archived は showArchived でだけ出す。
 */
export function orderThreadsForSidebar(threads: Thread[], showArchived = false): SidebarEntry[] {
  const visible = threads.filter((t) => showArchived || !t.archived);
  const byUpdated = [...visible].sort((a, b) => b.updatedAt - a.updatedAt);
  const ids = new Set(visible.map((t) => t.id));
  const roots = byUpdated.filter((t) => !(t.kind === "side" && t.parentId && ids.has(t.parentId)));
  const out: SidebarEntry[] = [];
  for (const r of roots) {
    out.push({ thread: r, depth: 0 });
    for (const s of byUpdated) {
      if (s.kind === "side" && s.parentId === r.id) out.push({ thread: s, depth: 1 });
    }
  }
  return out;
}

/** アーカイブ済みの件数。 */
export function archivedCount(threads: Thread[]): number {
  return threads.filter((t) => t.archived).length;
}
