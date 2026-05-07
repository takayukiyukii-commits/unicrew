"use client";

import { useEffect, useRef, useState } from "react";
import {
  Send,
  Square,
  FolderOpen,
  Split,
  Loader2,
  Columns2,
  X,
  MessageCircle,
} from "lucide-react";
import type { Block, Message, Provider, Thread } from "@/lib/types";
import { characterFor, getCharacter } from "@/lib/characters";
import { MessageItem } from "./MessageItem";
import { VoiceInputButton } from "./VoiceInputButton";
import { ToolUseBubble } from "./ToolUseBubble";
import { CharacterAvatar } from "./CharacterAvatar";
import { ActivityPanel } from "./ActivityPanel";
import { useShowActivity } from "./ActivityContext";
import { formatElapsed, formatThinking, formatTokens } from "@/lib/format";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ActiveDraftLite {
  threadId: string;
  provider: Provider;
  blocks: Block[];
  startedAt: number;
  firstTextAt: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface Props {
  thread: Thread | null;
  isStreaming: boolean;
  threadDrafts: Record<Provider, ActiveDraftLite | null>;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** "single" = 単一表示 / "primary" = 並列の左 / "split" = 並列の右 */
  paneRole?: "single" | "primary" | "split";
  /** 主ペイン側にだけ渡す。クリックで右ペインに新スレッドを開く（VSCode のSplit Editor相当）。 */
  onSplit?: () => void;
  /** 並列ペインを閉じる（splitペインだけに渡す）。 */
  onCloseSplit?: () => void;
  /** 会議モードで議論を1ラウンド延長する（[合意]に至っていない場合）。 */
  onContinueConference?: () => void;
  /** メッセージ内のコマンドを「UNICREWで実行」する。AI に Bash 実行を依頼する。 */
  onExecuteCommand?: (command: string, lang: string) => void;
}

const PROVIDER_BADGE: Record<Provider, { emoji: string; label: string; color: string }> = {
  claude: { emoji: "🟠", label: "Claude", color: "#dd6b20" },
  codex: { emoji: "🟢", label: "Codex", color: "#10a37f" },
};

export function ChatPane({
  thread,
  isStreaming,
  threadDrafts,
  onSend,
  onAbort,
  paneRole = "single",
  onSplit,
  onCloseSplit,
  onContinueConference,
  onExecuteCommand,
}: Props) {
  const showActivity = useShowActivity();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // 単独モードでは characterId そのまま、並列モードでは provider 別に解決。
  const character = thread ? getCharacter(thread.characterId) : undefined;
  const claudeCharacter = thread ? characterFor(thread, "claude") : undefined;
  const codexCharacter = thread ? characterFor(thread, "codex") : undefined;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // ユーザーが上にスクロールして過去のやり取りを読んでいる時は邪魔しない。
    // 末尾から 100px 以内にいる時だけ自動で追従する（一般的なチャットUIの挙動）。
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 100) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thread?.messages.length, threadDrafts]);

  const send = () => {
    const value = input.trim();
    if (!value || isStreaming || !thread) return;
    onSend(value);
    setInput("");
  };

  const isSplitPane = paneRole === "split";
  const paneBorderClass = isSplitPane
    ? "border-l border-[var(--color-border)]"
    : "";

  if (!thread) {
    return (
      <main
        className={`flex-1 flex items-center justify-center text-center p-8 ${paneBorderClass}`}
      >
        <div>
          <div className="text-5xl mb-4">🤖</div>
          <h2 className="text-xl font-bold mb-2">UNICREW へようこそ</h2>
          <p className="text-sm text-[var(--color-muted)] max-w-md">
            左の「新しい会話」から始めましょう。
            <br />
            キャラクターを選んでフォルダを開くと、ローカルで開発・編集ができます。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className={`flex-1 flex flex-col min-w-0 min-h-0 ${paneBorderClass}`}>
      <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-1.5 flex items-center gap-2 bg-white">
        {character && (
          <CharacterAvatar character={character} size={20} />
        )}
        <span className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
          {thread.title}
        </span>
        {character && (
          <span className="text-[11px] text-[var(--color-muted)] truncate">
            {character.name}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          {onSplit && (
            <button
              onClick={onSplit}
              className="p-1.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
              title="右に新しいスレッドを開く（並列ペイン）"
              aria-label="右に新しいスレッドを開く"
            >
              <Columns2 size={14} />
            </button>
          )}
          {onCloseSplit && (
            <button
              onClick={onCloseSplit}
              className="p-1.5 rounded hover:bg-red-50 text-[var(--color-muted)] hover:text-red-500 transition"
              title="このペインを閉じる"
              aria-label="このペインを閉じる"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {(thread.workspace || thread.splitMode) && (
        <div className="shrink-0 border-b border-[var(--color-border)] px-5 py-1.5 flex items-center gap-3 text-[11.5px] text-[var(--color-muted)] bg-[var(--color-surface)]">
          {thread.workspace && (
            <span className="flex items-center gap-1.5 truncate">
              <FolderOpen size={12} />
              <span className="truncate font-mono" title={thread.workspace}>
                {thread.workspace}
              </span>
            </span>
          )}
          {thread.splitMode && (
            <span className="flex items-center gap-1 ml-auto px-1.5 py-0.5 bg-[var(--color-accent-soft)] text-[var(--color-accent)] rounded font-medium">
              <Split size={11} />
              並列モード（🟠 Claude × 🟢 Codex）
            </span>
          )}
          {thread.conferenceMode && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded font-medium border border-amber-200">
              💬 会議モード（最大{thread.conferenceMaxRounds}ラウンド）
            </span>
          )}
        </div>
      )}

      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto min-h-0 unicrew-scroll"
      >
        {thread.messages.length === 0 && !isStreaming && (
          <div className="px-8 py-16 text-center text-[var(--color-muted)] text-sm">
            <div className="text-3xl mb-3">{character?.emoji ?? "💬"}</div>
            <div className="font-medium text-[var(--color-text)] mb-1">
              {character?.name ?? "Claude"} と話せます
            </div>
            <div>{character?.description ?? ""}</div>
          </div>
        )}

        {thread.splitMode ? (
          <SplitView
            messages={thread.messages}
            claudeCharacter={claudeCharacter}
            codexCharacter={codexCharacter}
            drafts={threadDrafts}
            conferenceMode={thread.conferenceMode}
            onExecuteCommand={onExecuteCommand}
          />
        ) : (
          <SingleView
            messages={thread.messages}
            character={character}
            draft={
              threadDrafts.claude ?? threadDrafts.codex ?? null
            }
            onExecuteCommand={onExecuteCommand}
          />
        )}
      </div>

      {showActivity && (
        <div className="shrink-0">
          <ActivityPanel
            messages={thread.messages}
            draftBlocks={[
              ...(threadDrafts.claude?.blocks ?? []),
              ...(threadDrafts.codex?.blocks ?? []),
            ]}
          />
        </div>
      )}

      {/* 議論継続ボタン: 会議モードで [合意] に至らず終了したときだけ表示 */}
      {(() => {
        if (!onContinueConference) return null;
        if (!thread.conferenceMode || !thread.splitMode) return null;
        if (isStreaming) return null;
        const lastTwo = thread.messages
          .filter((m) => m.role === "assistant")
          .slice(-2);
        if (lastTwo.length !== 2) return null;
        if (lastTwo.some((m) => m.conferenceRound === undefined)) return null;
        if (
          lastTwo[0].content.trim().startsWith("[合意]") ||
          lastTwo[1].content.trim().startsWith("[合意]")
        )
          return null;
        return (
          <div className="shrink-0 border-t border-[var(--color-border)] px-4 py-2 bg-amber-50/60 flex items-center gap-2 text-[12px]">
            <MessageCircle size={13} className="text-amber-600 shrink-0" />
            <span className="text-amber-900">
              議論が中途半端のまま終わっています。もう1ラウンド続けますか？
            </span>
            <button
              onClick={onContinueConference}
              className="ml-auto px-3 py-1.5 rounded-md bg-amber-600 text-white text-[11.5px] font-medium hover:opacity-90 shrink-0"
            >
              議論を続ける
            </button>
          </div>
        );
      })()}

      <div className="shrink-0 border-t border-[var(--color-border)] p-4 bg-white">
        <div className="max-w-4xl mx-auto flex items-end gap-2 rounded-xl border border-[var(--color-border)] bg-white px-3 py-2 focus-within:border-[var(--color-accent)] transition">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`${character?.name ?? "Claude"} にメッセージ…  (⌘/Ctrl + Enter で送信)`}
            rows={1}
            className="flex-1 resize-none bg-transparent outline-none text-sm py-2 leading-relaxed max-h-[200px]"
          />
          <VoiceInputButton
            disabled={isStreaming}
            onTranscribed={(text) => {
              setInput((prev) => (prev ? `${prev} ${text}` : text));
              setTimeout(() => textareaRef.current?.focus(), 0);
            }}
          />
          {isStreaming ? (
            <button
              onClick={onAbort}
              title="Esc または Ctrl+C で停止"
              className="shrink-0 px-3 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:opacity-90 transition flex items-center gap-1.5"
            >
              <Square size={14} fill="currentColor" />
              停止
              <span className="hidden md:inline text-[10px] opacity-80 font-mono">
                Esc
              </span>
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className="shrink-0 px-3 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition flex items-center gap-1.5"
            >
              <Send size={14} />
              送信
            </button>
          )}
        </div>
        <div className="max-w-4xl mx-auto mt-2 text-[11px] text-[var(--color-muted)] text-center">
          UNICREW は β 版です。AI の応答とツール実行は誤りを含むことがあります。
        </div>
      </div>
    </main>
  );
}

// ----- Single view (1プロバイダ・縦表示) -----

function SingleView({
  messages,
  character,
  draft,
  onExecuteCommand,
}: {
  messages: Message[];
  character: ReturnType<typeof getCharacter>;
  draft: ActiveDraftLite | null;
  onExecuteCommand?: (command: string, lang: string) => void;
}) {
  return (
    <>
      {messages.map((m) => (
        <MessageItem
          key={m.id}
          message={m}
          character={character}
          onExecute={onExecuteCommand}
        />
      ))}
      {draft && <DraftBubble draft={draft} character={character} />}
    </>
  );
}

// ----- Split view (Claude × Codex 横並び) -----

interface RoundData {
  round: number;
  claude: Message | null;
  codex: Message | null;
}
interface RoundsGroup {
  kind: "rounds";
  rounds: RoundData[];
}
interface UserGroup {
  kind: "user";
  message: Message;
}
type Group = UserGroup | RoundsGroup;

function groupMessagesForSplit(messages: Message[]): Group[] {
  const groups: Group[] = [];
  let pending: Map<number, RoundData> = new Map();
  const flushPending = () => {
    if (pending.size > 0) {
      const rounds = Array.from(pending.values()).sort(
        (a, b) => a.round - b.round,
      );
      groups.push({ kind: "rounds", rounds });
      pending = new Map();
    }
  };
  for (const m of messages) {
    if (m.role === "user") {
      flushPending();
      groups.push({ kind: "user", message: m });
    } else {
      const round = m.conferenceRound ?? 0;
      const existing =
        pending.get(round) ?? { round, claude: null, codex: null };
      if (m.provider === "codex") existing.codex = m;
      else existing.claude = m;
      pending.set(round, existing);
    }
  }
  flushPending();
  return groups;
}

function SplitView({
  messages,
  claudeCharacter,
  codexCharacter,
  drafts,
  conferenceMode,
  onExecuteCommand,
}: {
  messages: Message[];
  claudeCharacter: ReturnType<typeof getCharacter>;
  codexCharacter: ReturnType<typeof getCharacter>;
  drafts: Record<Provider, ActiveDraftLite | null>;
  conferenceMode: boolean;
  onExecuteCommand?: (command: string, lang: string) => void;
}) {
  const groups = groupMessagesForSplit(messages);
  const hasDrafts = !!(drafts.claude || drafts.codex);
  const lastGroup = groups[groups.length - 1];

  return (
    <>
      {groups.map((g, gi) => {
        if (g.kind === "user") {
          // user メッセージはどちらの provider のキャラでも表示は同じ（"あなた"）。
          // 念のため Claude 側を渡しておく。
          return (
            <MessageItem
              key={g.message.id}
              message={g.message}
              character={claudeCharacter}
              onExecute={onExecuteCommand}
            />
          );
        }
        const isLastGroup = gi === groups.length - 1;
        return (
          <div key={`g-${gi}`}>
            {g.rounds.map((r, ri) => {
              const isLastRound =
                isLastGroup && ri === g.rounds.length - 1;
              const claudeDraft =
                isLastRound && drafts.claude && !r.claude ? drafts.claude : null;
              const codexDraft =
                isLastRound && drafts.codex && !r.codex ? drafts.codex : null;
              return (
                <SplitResponsesRow
                  key={`r-${gi}-${ri}`}
                  claudeCharacter={claudeCharacter}
                  codexCharacter={codexCharacter}
                  round={r.round}
                  showRoundLabel={conferenceMode}
                  claudeMsg={r.claude}
                  codexMsg={r.codex}
                  claudeDraft={claudeDraft}
                  codexDraft={codexDraft}
                />
              );
            })}
          </div>
        );
      })}
      {hasDrafts && (!lastGroup || lastGroup.kind === "user") && (
        <SplitResponsesRow
          claudeCharacter={claudeCharacter}
          codexCharacter={codexCharacter}
          round={0}
          showRoundLabel={conferenceMode}
          claudeMsg={null}
          codexMsg={null}
          claudeDraft={drafts.claude}
          codexDraft={drafts.codex}
        />
      )}
    </>
  );
}

function SplitResponsesRow({
  claudeCharacter,
  codexCharacter,
  round,
  showRoundLabel,
  claudeMsg,
  codexMsg,
  claudeDraft,
  codexDraft,
}: {
  claudeCharacter: ReturnType<typeof getCharacter>;
  codexCharacter: ReturnType<typeof getCharacter>;
  round: number;
  showRoundLabel: boolean;
  claudeMsg: Message | null;
  codexMsg: Message | null;
  claudeDraft: ActiveDraftLite | null;
  codexDraft: ActiveDraftLite | null;
}) {
  return (
    <div className="border-b border-[var(--color-border)]">
      {showRoundLabel && (
        <div className="px-4 py-1 text-[10.5px] uppercase tracking-wide text-[var(--color-muted)] bg-[var(--color-surface)]/40 border-b border-[var(--color-border)]">
          {round === 0
            ? "ラウンド 1：初回回答"
            : `ラウンド ${round + 1}：相互レビュー`}
        </div>
      )}
      <div className="grid grid-cols-2 gap-0">
        <ProviderColumn
          provider="claude"
          character={claudeCharacter}
          message={claudeMsg}
          draft={claudeDraft}
        />
        <ProviderColumn
          provider="codex"
          character={codexCharacter}
          message={codexMsg}
          draft={codexDraft}
          leftBorder
        />
      </div>
    </div>
  );
}

function ProviderColumn({
  provider,
  character,
  message,
  draft,
  leftBorder = false,
}: {
  provider: Provider;
  character: ReturnType<typeof getCharacter>;
  message: Message | null;
  draft: ActiveDraftLite | null;
  leftBorder?: boolean;
}) {
  const badge = PROVIDER_BADGE[provider];
  return (
    <div
      className={`min-w-0 ${leftBorder ? "border-l border-[var(--color-border)]" : ""}`}
    >
      <div className="px-4 py-1.5 flex items-center gap-2 text-[11px] font-medium bg-[var(--color-surface)]/40 border-b border-[var(--color-border)] sticky top-0">
        <span style={{ color: badge.color }} className="shrink-0">
          {badge.emoji}
        </span>
        <span style={{ color: badge.color }} className="shrink-0">
          {badge.label}
        </span>
        {character && (
          <>
            <span className="text-[var(--color-muted)] shrink-0">/</span>
            <CharacterAvatar character={character} size={16} />
            <span
              className="truncate text-[var(--color-text)] font-semibold"
              title={`${character.name}（${character.roleTag ?? ""}）`}
            >
              {character.name}
            </span>
          </>
        )}
        {draft && <StreamingStatus draft={draft} variant="row" />}
      </div>
      <div className="p-3 min-h-[60px]">
        {message ? (
          <ColumnContent blocks={message.blocks ?? []} fallback={message.content} />
        ) : draft ? (
          <ColumnContent blocks={draft.blocks} fallback="…" />
        ) : (
          <div className="text-[12px] text-[var(--color-muted)] italic">
            {character?.name ?? "—"} はまだ応答していません
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ストリーミング中の状況を表示する共通インジケータ。
 * - 常に回り続ける Loader2 アイコン
 * - 「考え中…」/「応答中…」（最初のテキストが返ってきたら切替）
 * - 経過時間（500ms ごと再描画）
 * - 出力トークン累計
 * - 思考時間（最初のテキスト到達後）
 */
function StreamingStatus({
  draft,
  variant = "inline",
}: {
  draft: ActiveDraftLite;
  variant?: "inline" | "row";
}) {
  // 経過時間ライブ更新用ティック
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => (x + 1) & 0xffff), 500);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const elapsedMs = Math.max(0, now - draft.startedAt);
  const hasFirstText = draft.firstTextAt !== null;
  const label = hasFirstText ? "応答中" : "考え中";
  const thinkingMs =
    draft.firstTextAt !== null
      ? Math.max(0, draft.firstTextAt - draft.startedAt)
      : null;

  const segments: string[] = [formatElapsed(elapsedMs)];
  if (draft.outputTokens > 0) {
    segments.push(`↓ ${formatTokens(draft.outputTokens)} tokens`);
  }
  if (thinkingMs !== null) {
    segments.push(`thought for ${formatThinking(thinkingMs)}`);
  }

  const isRow = variant === "row";
  return (
    <span
      className={
        isRow
          ? "ml-auto flex items-center gap-1.5 text-[11px] text-[var(--color-accent)] font-mono tabular-nums"
          : "inline-flex items-center gap-1.5 text-[11px] text-[var(--color-accent)] font-mono tabular-nums"
      }
      aria-live="polite"
      aria-busy="true"
    >
      <Loader2 size={12} className="animate-spin shrink-0" />
      <span className="font-medium">{label}…</span>
      <span className="text-[var(--color-muted)] font-normal">
        ({segments.join(" · ")})
      </span>
    </span>
  );
}

function ColumnContent({
  blocks,
  fallback,
}: {
  blocks: Block[];
  fallback: string;
}) {
  if (blocks.length === 0) {
    if (!fallback || fallback === "…") {
      return <div className="text-[12px] text-[var(--color-muted)]">…</div>;
    }
    return (
      <div className="md-body text-[13.5px] leading-relaxed">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{fallback}</ReactMarkdown>
      </div>
    );
  }
  return (
    <div className="md-body text-[13.5px] leading-relaxed">
      {blocks.map((b, i) =>
        b.kind === "text" ? (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
            {b.text}
          </ReactMarkdown>
        ) : (
          <ToolUseBubble key={i} block={b} />
        ),
      )}
    </div>
  );
}

// ----- Single mode draft bubble -----

function DraftBubble({
  draft,
  character,
}: {
  draft: ActiveDraftLite;
  character: ReturnType<typeof getCharacter>;
}) {
  const { blocks } = draft;
  return (
    <div className="flex gap-3 px-6 py-4 bg-[var(--color-surface)]/60">
      <CharacterAvatar character={character} size={36} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-sm font-semibold">
            {character?.name ?? "Claude"}
          </span>
          <StreamingStatus draft={draft} />
        </div>
        <div className="md-body text-[14.5px] leading-relaxed">
          {blocks.length === 0 && (
            <span className="text-[var(--color-muted)]">…</span>
          )}
          {blocks.map((b, i) =>
            b.kind === "text" ? (
              <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
                {b.text}
              </ReactMarkdown>
            ) : (
              <ToolUseBubble key={i} block={b} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
