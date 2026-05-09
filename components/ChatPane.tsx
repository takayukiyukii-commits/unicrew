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
import type {
  Block,
  Message,
  ParticipantSlot,
  Provider,
  Thread,
} from "@/lib/types";
import { PROVIDER_BADGES, PROVIDER_COLORS, PROVIDER_LABELS } from "@/lib/types";
import { getCharacter } from "@/lib/characters";
import { effectiveParticipants } from "@/lib/participants";
import { MessageItem } from "./MessageItem";
import { VoiceInputButton } from "./VoiceInputButton";
import { ToolUseBubble } from "./ToolUseBubble";
import { CharacterAvatar } from "./CharacterAvatar";
import { ActivityPanel } from "./ActivityPanel";
import { useShowActivity } from "./ActivityContext";
import { SlashCommandPicker } from "./SlashCommandPicker";
import type { SlashCommandDef } from "@/lib/slash-commands";
import { formatElapsed, formatThinking, formatTokens } from "@/lib/format";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ActiveDraftLite {
  threadId: string;
  /** どのスロットの draft か。N-way並列で同じproviderが複数いるケースに対応。 */
  slotId: string;
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
  /** スロットID → draft。単独モード時は単一エントリ（"single"）、並列時はN個。 */
  threadDrafts: Record<string, ActiveDraftLite | null>;
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
  /** アイデア10: エラーメッセージ用の「AIに助けてもらう」ボタン押下時のハンドラ。 */
  onSosForError?: (errorText: string) => void;
  /**
   * メッセージ末尾に差し込むカード。フィードバックアンケート等の単発UIをここから注入する。
   * 主ペインだけに渡し、split側には出さない（重複表示防止）。
   */
  feedbackSlot?: React.ReactNode;
}

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
  onSosForError,
  feedbackSlot,
}: Props) {
  const showActivity = useShowActivity();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // 参加者リスト（N-way対応）。単独モードでも1要素配列が返る。
  const slots: ParticipantSlot[] = thread ? effectiveParticipants(thread) : [];
  const isParallel = slots.length >= 2;
  const character = thread ? getCharacter(thread.characterId) : undefined;

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

  // スラッシュコマンドピッカーから選ばれたら、textarea にコマンド文字列を反映する。
  // 末尾スペース付き（引数を要するもの）はそのまま挿入し、ユーザーが続きを書ける状態にする。
  // 既に入力中ならスペース区切りで追記、空ならそのまま設定。
  const handlePickCommand = (cmd: SlashCommandDef) => {
    setInput((prev) => {
      const trimmed = prev.trimEnd();
      if (trimmed.length === 0) return cmd.command;
      return `${trimmed} ${cmd.command}`;
    });
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    }, 0);
  };

  // 並列モード時は両プロバイダのコマンドを表示する
  const activeProviders: Provider[] = thread?.splitMode
    ? ["claude", "codex"]
    : ["claude"];

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
          {isParallel && (
            <span className="flex items-center gap-1 ml-auto px-1.5 py-0.5 bg-[var(--color-accent-soft)] text-[var(--color-accent)] rounded font-medium">
              <Split size={11} />
              並列モード（{slots.length}-way：
              {slots
                .map((s) => `${PROVIDER_BADGES[s.provider]} ${PROVIDER_LABELS[s.provider]}`)
                .join(" × ")}
              ）
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

        {isParallel ? (
          <NwayView
            messages={thread.messages}
            slots={slots}
            drafts={threadDrafts}
            conferenceMode={thread.conferenceMode}
            onExecuteCommand={onExecuteCommand}
          />
        ) : (
          <SingleView
            messages={thread.messages}
            character={character}
            draft={
              // 単独モード時はキー何でも先頭1個を採用
              Object.values(threadDrafts).find((d) => d) ?? null
            }
            onExecuteCommand={onExecuteCommand}
            onSosForError={onSosForError}
          />
        )}
        {feedbackSlot}
      </div>

      {showActivity && (
        <div className="shrink-0">
          <ActivityPanel
            messages={thread.messages}
            draftBlocks={Object.values(threadDrafts).flatMap((d) =>
              d ? d.blocks : [],
            )}
          />
        </div>
      )}

      {/* 議論継続ボタン: 会議モードで [合意] に至らず終了したときだけ表示。N-way対応。 */}
      {(() => {
        if (!onContinueConference) return null;
        if (!thread.conferenceMode || !isParallel) return null;
        if (isStreaming) return null;
        const participantCount = slots.filter(
          (s) => s.role !== "moderator",
        ).length;
        // 末尾から participantCount 件の assistant メッセージを取り、
        // 全員が同じラウンドで揃っているか + [合意] が出ていないかチェック。
        const lastN = thread.messages
          .filter((m) => m.role === "assistant" && m.participantRole !== "moderator")
          .slice(-participantCount);
        if (lastN.length !== participantCount) return null;
        if (lastN.some((m) => m.conferenceRound === undefined)) return null;
        const round = lastN[0].conferenceRound;
        if (lastN.some((m) => m.conferenceRound !== round)) return null;
        if (lastN.some((m) => m.content.trim().startsWith("[合意]"))) return null;
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
          <SlashCommandPicker
            activeProviders={activeProviders}
            onPick={handlePickCommand}
            disabled={isStreaming}
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
  onSosForError,
}: {
  messages: Message[];
  character: ReturnType<typeof getCharacter>;
  draft: ActiveDraftLite | null;
  onExecuteCommand?: (command: string, lang: string) => void;
  onSosForError?: (errorText: string) => void;
}) {
  return (
    <>
      {messages.map((m) => (
        <MessageItem
          key={m.id}
          message={m}
          character={character}
          onExecute={onExecuteCommand}
          onSosForError={onSosForError}
        />
      ))}
      {draft && <DraftBubble draft={draft} character={character} />}
    </>
  );
}

// ----- N-way view (参加者2人以上を横並び表示) -----

/** 同じラウンド内の各参加者の応答をまとめる構造。 */
interface RoundData {
  round: number;
  /** slotId → Message。moderator も含めて格納（表示時にフィルタ可能）。 */
  bySlot: Map<string, Message>;
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

/**
 * N-way対応のラウンド集約。
 *
 * provider と participantSlotId の両方で slot を引く（後方互換）。
 * - participantSlotId があればそれを使う
 * - 無ければ provider 名を slotId として扱う（旧2way構造のメッセージ）
 */
function resolveSlotId(m: Message, slots: ParticipantSlot[]): string {
  if (m.participantSlotId) return m.participantSlotId;
  if (!m.provider) return slots[0]?.id ?? "single";
  // 同じproviderが複数いる場合は先頭を採用（旧データの近似）
  const found = slots.find((s) => s.provider === m.provider);
  return found?.id ?? m.provider;
}

function groupMessagesForNway(
  messages: Message[],
  slots: ParticipantSlot[],
): Group[] {
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
        pending.get(round) ?? { round, bySlot: new Map<string, Message>() };
      const slotId = resolveSlotId(m, slots);
      existing.bySlot.set(slotId, m);
      pending.set(round, existing);
    }
  }
  flushPending();
  return groups;
}

function NwayView({
  messages,
  slots,
  drafts,
  conferenceMode,
  onExecuteCommand,
}: {
  messages: Message[];
  slots: ParticipantSlot[];
  drafts: Record<string, ActiveDraftLite | null>;
  conferenceMode: boolean;
  onExecuteCommand?: (command: string, lang: string) => void;
}) {
  const groups = groupMessagesForNway(messages, slots);
  const hasDrafts = Object.values(drafts).some((d) => d != null);
  const lastGroup = groups[groups.length - 1];
  const slotsForView = slots.filter((s) => s.role !== "moderator");

  // moderator (中立審判) の発言は通常列ではなく、ラウンド下部に独立して表示する。
  const moderatorSlotId = slots.find((s) => s.role === "moderator")?.id;

  return (
    <>
      {groups.map((g, gi) => {
        if (g.kind === "user") {
          return (
            <MessageItem
              key={g.message.id}
              message={g.message}
              character={getCharacter(slotsForView[0]?.characterId ?? "")}
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
              return (
                <NwayResponsesRow
                  key={`r-${gi}-${ri}`}
                  slots={slotsForView}
                  round={r.round}
                  showRoundLabel={conferenceMode}
                  bySlot={r.bySlot}
                  drafts={isLastRound ? drafts : {}}
                  moderatorSlotId={moderatorSlotId}
                />
              );
            })}
          </div>
        );
      })}
      {hasDrafts && (!lastGroup || lastGroup.kind === "user") && (
        <NwayResponsesRow
          slots={slotsForView}
          round={0}
          showRoundLabel={conferenceMode}
          bySlot={new Map()}
          drafts={drafts}
          moderatorSlotId={moderatorSlotId}
        />
      )}
    </>
  );
}

/** Tailwindのgrid-cols-{N}は動的生成だとパージされるため、固定値で持つ。 */
const GRID_COLS_BY_N: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
  6: "grid-cols-6",
};

function NwayResponsesRow({
  slots,
  round,
  showRoundLabel,
  bySlot,
  drafts,
  moderatorSlotId,
}: {
  slots: ParticipantSlot[];
  round: number;
  showRoundLabel: boolean;
  bySlot: Map<string, Message>;
  drafts: Record<string, ActiveDraftLite | null>;
  moderatorSlotId?: string;
}) {
  const cols = Math.min(Math.max(slots.length, 1), 6);
  const moderatorMsg = moderatorSlotId
    ? bySlot.get(moderatorSlotId)
    : undefined;
  const moderatorDraft = moderatorSlotId
    ? drafts[moderatorSlotId] ?? null
    : null;
  return (
    <div className="border-b border-[var(--color-border)]">
      {showRoundLabel && (
        <div className="px-4 py-1 text-[10.5px] uppercase tracking-wide text-[var(--color-muted)] bg-[var(--color-surface)]/40 border-b border-[var(--color-border)]">
          {round === 0
            ? "ラウンド 1：初回回答"
            : `ラウンド ${round + 1}：相互レビュー`}
        </div>
      )}
      <div className={`grid ${GRID_COLS_BY_N[cols] ?? "grid-cols-2"} gap-0`}>
        {slots.map((slot, i) => (
          <SlotColumn
            key={slot.id}
            slot={slot}
            character={getCharacter(slot.characterId)}
            message={bySlot.get(slot.id) ?? null}
            draft={drafts[slot.id] ?? null}
            leftBorder={i > 0}
          />
        ))}
      </div>
      {(moderatorMsg || moderatorDraft) && (
        <ModeratorPanel message={moderatorMsg ?? null} draft={moderatorDraft} />
      )}
    </div>
  );
}

function SlotColumn({
  slot,
  character,
  message,
  draft,
  leftBorder = false,
}: {
  slot: ParticipantSlot;
  character: ReturnType<typeof getCharacter>;
  message: Message | null;
  draft: ActiveDraftLite | null;
  leftBorder?: boolean;
}) {
  const color = PROVIDER_COLORS[slot.provider];
  const badge = PROVIDER_BADGES[slot.provider];
  const label = PROVIDER_LABELS[slot.provider];
  return (
    <div
      className={`min-w-0 ${leftBorder ? "border-l border-[var(--color-border)]" : ""}`}
    >
      <div className="px-3 py-1.5 flex items-center gap-2 text-[11px] font-medium bg-[var(--color-surface)]/40 border-b border-[var(--color-border)] sticky top-0">
        <span style={{ color }} className="shrink-0">
          {badge}
        </span>
        <span style={{ color }} className="shrink-0">
          {label}
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
 * 中立審判（moderator）のラウンド総括パネル。
 *
 * Phase 2機能：JSONで返ってきた評価を整形表示する。
 * - 通常ラウンド: 合意度・残論点・推奨アクション
 * - 議論終了時: 上記＋議事録（decisions / tasks / parking）→ コピー/ダウンロード可能
 */
function ModeratorPanel({
  message,
  draft,
}: {
  message: Message | null;
  draft: ActiveDraftLite | null;
}) {
  const text =
    message?.content ??
    draft?.blocks
      ?.filter((b) => b.kind === "text")
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("") ??
    "";

  // JSONで返ってきていれば整形表示、テキストならそのまま
  let parsed: ModeratorJudgement | null = null;
  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const slice = text.slice(jsonStart, jsonEnd + 1);
      parsed = JSON.parse(slice);
    }
  } catch {
    parsed = null;
  }

  const hasMinutes =
    parsed?.minutes &&
    ((parsed.minutes.decisions?.length ?? 0) > 0 ||
      (parsed.minutes.tasks?.length ?? 0) > 0 ||
      (parsed.minutes.parking?.length ?? 0) > 0);

  return (
    <div className="border-t border-amber-200 bg-amber-50/50 px-4 py-2.5 text-[12.5px]">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 mb-1.5">
        <MessageCircle size={11} />
        {hasMinutes ? "議論クロージング・議事録" : "中立審判の総括"}
        {draft && <StreamingStatus draft={draft} variant="row" />}
        {parsed && hasMinutes && message && (
          <MinutesActions parsed={parsed} createdAt={message.createdAt} />
        )}
      </div>
      {parsed ? (
        <div className="space-y-1.5 text-amber-950">
          {typeof parsed.agreementScore === "number" && (
            <div>
              <span className="text-amber-700 font-semibold">合意度: </span>
              <span className="font-mono">{parsed.agreementScore}/100</span>
            </div>
          )}
          {parsed.openIssues && parsed.openIssues.length > 0 && (
            <div>
              <span className="text-amber-700 font-semibold">残論点: </span>
              <ul className="list-disc pl-5 mt-0.5">
                {parsed.openIssues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
          {parsed.recommendedActions && parsed.recommendedActions.length > 0 && (
            <div>
              <span className="text-amber-700 font-semibold">推奨アクション: </span>
              <ul className="list-disc pl-5 mt-0.5">
                {parsed.recommendedActions.map((act, i) => (
                  <li key={i}>{act}</li>
                ))}
              </ul>
            </div>
          )}
          {parsed.summary && (
            <div className="mt-1 text-[11.5px] text-amber-900/80 italic">
              {parsed.summary}
            </div>
          )}
          {hasMinutes && parsed.minutes && (
            <MinutesView minutes={parsed.minutes} />
          )}
        </div>
      ) : (
        <div className="md-body text-[12.5px] leading-relaxed text-amber-950">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || "…"}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function MinutesView({ minutes }: { minutes: ModeratorMinutes }) {
  return (
    <div className="mt-2 pt-2 border-t border-amber-200/70 space-y-2">
      {minutes.decisions && minutes.decisions.length > 0 && (
        <MinutesSection title="✅ 決定事項" items={minutes.decisions} />
      )}
      {minutes.tasks && minutes.tasks.length > 0 && (
        <MinutesSection title="📋 タスク" items={minutes.tasks} />
      )}
      {minutes.parking && minutes.parking.length > 0 && (
        <MinutesSection title="🅿️ 保留事項" items={minutes.parking} />
      )}
    </div>
  );
}

function MinutesSection({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <div>
      <div className="text-amber-700 font-semibold text-[11.5px]">{title}</div>
      <ul className="list-disc pl-5 mt-0.5 space-y-0.5">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 議事録のコピー/ダウンロード操作。
 * - クリップボードに Markdown でコピー
 * - .md ファイルとしてブラウザダウンロード（OS標準保存ダイアログ経由）
 */
function MinutesActions({
  parsed,
  createdAt,
}: {
  parsed: ModeratorJudgement;
  createdAt: number;
}) {
  const buildMarkdown = (): string => {
    const date = new Date(createdAt);
    const ts = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(date.getDate()).padStart(2, "0")} ${String(
      date.getHours(),
    ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const lines: string[] = [];
    lines.push(`# 議事録（UNICREW）`);
    lines.push(``);
    lines.push(`- 作成日時: ${ts}`);
    if (typeof parsed.agreementScore === "number") {
      lines.push(`- 最終合意度: ${parsed.agreementScore}/100`);
    }
    lines.push(``);
    if (parsed.summary) {
      lines.push(`## 総括`);
      lines.push(``);
      lines.push(parsed.summary);
      lines.push(``);
    }
    if (parsed.minutes?.decisions && parsed.minutes.decisions.length > 0) {
      lines.push(`## 決定事項`);
      lines.push(``);
      for (const d of parsed.minutes.decisions) lines.push(`- ${d}`);
      lines.push(``);
    }
    if (parsed.minutes?.tasks && parsed.minutes.tasks.length > 0) {
      lines.push(`## タスク`);
      lines.push(``);
      for (const t of parsed.minutes.tasks) lines.push(`- [ ] ${t}`);
      lines.push(``);
    }
    if (parsed.minutes?.parking && parsed.minutes.parking.length > 0) {
      lines.push(`## 保留事項`);
      lines.push(``);
      for (const p of parsed.minutes.parking) lines.push(`- ${p}`);
      lines.push(``);
    }
    if (parsed.openIssues && parsed.openIssues.length > 0) {
      lines.push(`## 残論点`);
      lines.push(``);
      for (const i of parsed.openIssues) lines.push(`- ${i}`);
      lines.push(``);
    }
    if (
      parsed.recommendedActions &&
      parsed.recommendedActions.length > 0
    ) {
      lines.push(`## 推奨アクション`);
      lines.push(``);
      for (const a of parsed.recommendedActions) lines.push(`- ${a}`);
      lines.push(``);
    }
    return lines.join("\n");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
    } catch {
      // クリップボード権限が無い環境のフォールバック
      const ta = document.createElement("textarea");
      ta.value = buildMarkdown();
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const handleDownload = () => {
    const md = buildMarkdown();
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const date = new Date(createdAt);
    const fname = `議事録_${date.getFullYear()}${String(
      date.getMonth() + 1,
    ).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}_${String(
      date.getHours(),
    ).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}.md`;
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <span className="ml-auto flex items-center gap-1">
      <button
        type="button"
        onClick={handleCopy}
        className="text-[10.5px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 hover:bg-amber-200"
        title="議事録をMarkdownでコピー"
      >
        コピー
      </button>
      <button
        type="button"
        onClick={handleDownload}
        className="text-[10.5px] px-1.5 py-0.5 rounded bg-amber-600 text-white hover:opacity-90"
        title="議事録を.mdファイルでダウンロード"
      >
        .md保存
      </button>
    </span>
  );
}

interface ModeratorJudgement {
  agreementScore?: number;
  openIssues?: string[];
  recommendedActions?: string[];
  summary?: string;
  /** 議論終了時のみ存在する議事録ブロック（buildModeratorMinutesPrompt が要求） */
  minutes?: ModeratorMinutes;
}

interface ModeratorMinutes {
  decisions?: string[];
  tasks?: string[];
  parking?: string[];
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
