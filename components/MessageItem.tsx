"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, LifeBuoy, Play } from "lucide-react";
import type { Character, Message, MessageStats } from "@/lib/types";
import { ToolUseBubble } from "./ToolUseBubble";
import { CharacterAvatar } from "./CharacterAvatar";
import { formatElapsed, formatThinking, formatTokens } from "@/lib/format";
import clsx from "clsx";

interface Props {
  message: Message;
  character: Character | undefined;
  onExecute?: (command: string, lang: string) => void;
  /**
   * アイデア10: エラー文言検知時に表示する「AIに助けてもらう」ボタンの押下ハンドラ。
   * エラー本文を渡し、page.tsx 側で対処プロンプトに整形して送り直す。
   */
  onSosForError?: (errorText: string) => void;
}

const ERROR_PATTERNS = ["**エラー**", "**起動エラー**"];

function looksLikeError(content: string): boolean {
  const t = content.trim();
  return ERROR_PATTERNS.some((p) => t.startsWith(p));
}

const EXECUTABLE_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "powershell",
  "pwsh",
  "cmd",
  "console",
  "terminal",
]);

export function MessageItem({
  message,
  character,
  onExecute,
  onSosForError,
}: Props) {
  const isUser = message.role === "user";
  const showSos = !isUser && onSosForError && looksLikeError(message.content);
  const renderers = {
    code: (props: {
      inline?: boolean;
      className?: string;
      children?: React.ReactNode;
    }) => (
      <CodeRenderer
        inline={props.inline}
        className={props.className}
        onExecute={isUser ? undefined : onExecute}
      >
        {props.children}
      </CodeRenderer>
    ),
  };

  return (
    <div
      className={clsx(
        "flex gap-3 px-6 py-4",
        isUser ? "" : "bg-[var(--color-surface)]/60",
      )}
    >
      {isUser ? (
        <div
          className="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-base shadow-sm border border-[var(--color-border)] bg-[#111827] text-white"
          title="あなた"
        >
          あ
        </div>
      ) : (
        <CharacterAvatar character={character} size={36} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold">
            {isUser ? "あなた" : character?.name ?? "Claude"}
          </span>
          {!isUser && character && (
            <span className="text-[11px] text-[var(--color-muted)]">
              {character.roleTag}
            </span>
          )}
        </div>
        <div className="md-body text-[14.5px] leading-relaxed">
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">
              {message.content}
            </div>
          ) : message.blocks && message.blocks.length > 0 ? (
            message.blocks.map((b, i) =>
              b.kind === "text" ? (
                <ReactMarkdown
                  key={i}
                  remarkPlugins={[remarkGfm]}
                  components={renderers}
                >
                  {b.text}
                </ReactMarkdown>
              ) : (
                <ToolUseBubble key={i} block={b} />
              ),
            )
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={renderers}
            >
              {message.content || "…"}
            </ReactMarkdown>
          )}
        </div>
        {showSos && (
          <button
            type="button"
            onClick={() => onSosForError?.(message.content)}
            className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-amber-100 border border-amber-300 text-amber-900 text-[11.5px] font-medium hover:bg-amber-200 transition"
            title="このエラーをAIに診断・修復してもらう"
          >
            <LifeBuoy size={12} />
            このエラーをAIに助けてもらう
          </button>
        )}
        {!isUser && message.stats && <StatsLine stats={message.stats} />}
      </div>
    </div>
  );
}

function CodeRenderer({
  inline,
  className,
  children,
  onExecute,
}: {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  onExecute?: (command: string, lang: string) => void;
}) {
  const lang = (className ?? "")
    .replace("language-", "")
    .toLowerCase()
    .trim();
  const text = String(children ?? "").replace(/\n$/, "");
  if (inline || !text.includes("\n") && !lang) {
    return <code className={className}>{children}</code>;
  }
  const executable = EXECUTABLE_LANGS.has(lang);
  return (
    <CodeBlockShell
      lang={lang}
      text={text}
      className={className}
      executable={executable}
      onExecute={onExecute}
    >
      {children}
    </CodeBlockShell>
  );
}

function CodeBlockShell({
  lang,
  text,
  className,
  executable,
  onExecute,
  children,
}: {
  lang: string;
  text: string;
  className?: string;
  executable: boolean;
  onExecute?: (command: string, lang: string) => void;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <div className="relative group my-2">
      {(lang || executable) && (
        <div className="absolute top-1.5 left-3 text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
          {lang || "code"}
        </div>
      )}
      <div className="absolute top-1.5 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
        <button
          onClick={copy}
          className="px-1.5 py-1 rounded text-[11px] bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 inline-flex items-center gap-1"
          title="クリップボードにコピー"
        >
          {copied ? (
            <>
              <Check size={11} />
              コピー済
            </>
          ) : (
            <>
              <Copy size={11} />
              コピー
            </>
          )}
        </button>
        {executable && onExecute && (
          <button
            onClick={() => onExecute(text, lang || "bash")}
            className="px-2 py-1 rounded text-[11px] bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 font-medium"
            title="このコマンドを UNICREW で実行する（AI が Bash ツールで自動実行）"
          >
            <Play size={11} fill="currentColor" />
            実行
          </button>
        )}
      </div>
      <pre className={className}>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

function StatsLine({ stats }: { stats: MessageStats }) {
  if (
    stats.outputTokens <= 0 &&
    stats.inputTokens <= 0 &&
    stats.durationMs <= 0
  ) {
    return null;
  }
  const segments: string[] = [];
  if (stats.outputTokens > 0) {
    segments.push(`↓ ${formatTokens(stats.outputTokens)} tokens`);
  }
  if (stats.inputTokens > 0) {
    segments.push(`↑ ${formatTokens(stats.inputTokens)} tokens`);
  }
  if (stats.cacheReadTokens > 0) {
    segments.push(`cached ${formatTokens(stats.cacheReadTokens)}`);
  }
  if (stats.durationMs > 0) {
    segments.push(formatElapsed(stats.durationMs));
  }
  if (stats.thinkingMs !== null && stats.thinkingMs > 0) {
    segments.push(`thought for ${formatThinking(stats.thinkingMs)}`);
  }
  if (segments.length === 0) return null;
  return (
    <div className="mt-2 text-[10.5px] text-[var(--color-muted)] font-mono tabular-nums">
      {segments.join(" · ")}
    </div>
  );
}
