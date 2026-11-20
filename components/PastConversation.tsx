"use client";

import { Markdown } from "./Markdown";
import { useTranslation } from "@/lib/i18n";
import { PROVIDER_LABELS, type Thread } from "@/lib/types";

/** 過去の記録は読むだけ。入力欄や会話を再開する操作は置かない。 */
export function PastConversation({ thread, onOpenOffice }: { thread: Thread | null; onOpenOffice: () => void }) {
  const { t, locale } = useTranslation();
  const date = (at: number) => Number.isFinite(at) ? new Date(at).toLocaleString(locale) : "—";
  return (
    <main className="flex-1 min-w-0 overflow-y-auto p-6 unicrew-scroll">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-xl font-bold break-words">{thread?.title || t("sidebar.pastConversations")}</h1>
          {thread && <p className="text-xs text-[var(--color-muted)]">{date(thread.createdAt)} · {t("past.updated", { date: date(thread.updatedAt) })}</p>}
          <p className="text-sm">{t("past.continue")}</p>
          <button type="button" onClick={onOpenOffice} className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm text-white">{t("past.openOffice")}</button>
        </header>
        {!thread && <p>{t("past.choose")}</p>}
        {thread?.messages.map((message) => (
          <article key={message.id} className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
            <header className="flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
              <strong>{message.role === "user" ? t("past.you") : (message.provider && PROVIDER_LABELS[message.provider]) || t("past.assistant")}</strong>
              <time>{date(message.createdAt)}</time>
            </header>
            <div className="prose prose-sm max-w-none break-words whitespace-pre-wrap [&_pre]:overflow-x-auto">
              <Markdown>{message.content || message.blocks?.filter((b) => b.kind === "text").map((b) => b.text).join("\n\n") || ""}</Markdown>
            </div>
            {message.attachments?.map((attachment) => <p key={attachment.id} className="text-xs break-words">{t("past.attachment", { name: attachment.name })}</p>)}
          </article>
        ))}
      </div>
    </main>
  );
}
