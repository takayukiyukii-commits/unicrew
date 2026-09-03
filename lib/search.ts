import type { Message, Thread } from "./types";

/**
 * 会話検索（v0.4.0）。索引は持たず、その場で全スレッドを走査する（ローカル完結・外に出さない）。
 * 小文字化した部分一致。上位 limit 件・ヒット箇所の前後 context 文字を snippet で返す。
 */

export interface SearchHit {
  threadId: string;
  threadTitle: string;
  /** 題名ヒットのときは null */
  messageId: string | null;
  role: Message["role"] | "title";
  /** ヒット前後の抜粋（改行は空白に潰す） */
  snippet: string;
  /** snippet 内でのヒット位置（強調表示用） */
  hitStart: number;
  hitLength: number;
  updatedAt: number;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ");
}

function snippetOf(text: string, index: number, qLen: number, context: number): { snippet: string; hitStart: number } {
  const start = Math.max(0, index - context);
  const end = Math.min(text.length, index + qLen + context);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const body = collapse(text.slice(start, end));
  return { snippet: `${head}${body}${tail}`, hitStart: head.length + collapse(text.slice(start, index)).length };
}

export function searchConversations(threads: Thread[], query: string, limit = 20, context = 30): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchHit[] = [];
  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of sorted) {
    const ti = t.title.toLowerCase().indexOf(q);
    if (ti >= 0) {
      out.push({
        threadId: t.id,
        threadTitle: t.title,
        messageId: null,
        role: "title",
        snippet: collapse(t.title),
        hitStart: ti,
        hitLength: q.length,
        updatedAt: t.updatedAt,
      });
      if (out.length >= limit) return out;
    }
    for (const m of t.messages) {
      const i = m.content.toLowerCase().indexOf(q);
      if (i < 0) continue;
      const { snippet, hitStart } = snippetOf(m.content, i, q.length, context);
      out.push({
        threadId: t.id,
        threadTitle: t.title,
        messageId: m.id,
        role: m.role,
        snippet,
        hitStart,
        hitLength: q.length,
        updatedAt: t.updatedAt,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** スレッド内検索（Ctrl+F）：本文に query を含むメッセージ ID を順番どおりに返す。 */
export function matchingMessageIds(messages: Message[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return messages.filter((m) => m.content.toLowerCase().includes(q)).map((m) => m.id);
}
