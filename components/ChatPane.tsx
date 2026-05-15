"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Send,
  Square,
  FolderOpen,
  Split,
  Loader2,
  Columns2,
  X,
  MessageCircle,
  Sparkles,
} from "lucide-react";

/**
 * 「新スレッド推奨」バナーを出すメッセージ件数の閾値。
 * Claude Code では turn 30 を超えると context window 圧迫が顕著になる経験則から 30 を採用。
 */
const LONG_CHAT_THRESHOLD = 30;
import type {
  Block,
  Message,
  ParticipantSlot,
  PermissionMode,
  Provider,
  Thread,
} from "@/lib/types";
import {
  PERMISSION_MODE_LABELS,
  PROVIDER_COLORS,
  PROVIDER_LABELS,
} from "@/lib/types";
import { CategoryDot } from "@/lib/providerVisuals";
import { getCharacter } from "@/lib/characters";
import { getPersonality } from "@/lib/personalities";
import { effectiveParticipants } from "@/lib/participants";
import { MessageItem } from "./MessageItem";
import { VoiceInputButton } from "./VoiceInputButton";
import { ToolUseBubble } from "./ToolUseBubble";
import { CharacterAvatar } from "./CharacterAvatar";
import { SlashCommandPicker } from "./SlashCommandPicker";
import type { SlashCommandDef } from "@/lib/slash-commands";
import { formatElapsed, formatThinking, formatTokens } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
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
  /**
   * 直近のイベント到着時刻。inactivity watchdog 用。
   * 応答が長時間止まったままだった時に「応答止まってる？停止」ヒントを出す根拠。
   * provider 側（OpenCode 等）が StopReason を返さず spinner が止まらないケースの保険。
   */
  lastEventAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * 「応答止まってるかも」ヒントを出すまでの無反応許容時間 (ms)。
 * 通常の AI 応答は秒〜10秒台で連続でトークン or tool event を吐くため、
 * 45 秒以上沈黙していたら何か詰まっているとみなす。長すぎず短すぎず。
 */
const INACTIVITY_HINT_MS = 45_000;

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
  /** true なら「他ペインの会話も渡して送信」モードがONになっている。 */
  peekActive?: boolean;
  /** 他ペイン参照モードを toggle する。null/未指定の時はチップを表示しない（並列ペインが無い等）。 */
  onTogglePeek?: () => void;
  /**
   * Shift+Tab でパーミッションモードをトグルするコールバック。
   * バッジクリックでも呼ばれる。未指定なら表示はするがクリック不可。
   */
  onTogglePermissionMode?: () => void;
  /**
   * メッセージ数が閾値（既定 30）を超えたら表示する「新スレッド推奨バナー」のクリックハンドラ。
   * 長い会話を畳んで token 消費を抑える導線。未指定ならバナー自体を出さない。
   */
  onSuggestNewThread?: () => void;
  /**
   * 「あなた」アバター用の設定。AppSettings から流し込む。
   * 各メッセージの user 側アバター・表示名に使う。
   */
  userProfile?: {
    displayName?: string;
    avatarPath?: string | null;
    emoji?: string;
    accentColor?: string;
  };
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
  peekActive = false,
  onTogglePeek,
  onTogglePermissionMode,
  onSuggestNewThread,
  userProfile,
}: Props) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // 「新スレッド推奨」バナーを当該スレッドで一度閉じたかどうか（per thread, セッション単位）。
  const [longChatDismissedFor, setLongChatDismissedFor] = useState<string | null>(null);
  // 沈黙検知用ティック（500ms ごとに inactivity 状況を再評価して停止ボタンの強調を切替）
  const [, setStuckTick] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setStuckTick((x) => (x + 1) & 0xffff), 500);
    return () => clearInterval(id);
  }, [isStreaming]);
  // ストリーミング中の draft が 45 秒以上イベントを受け取っていなければ「沈黙中」とみなす。
  // 1つでも沈黙してたら停止ボタンを強調表示する根拠にする。
  const anyDraftStuck = (() => {
    if (!isStreaming) return false;
    const now = Date.now();
    return Object.values(threadDrafts).some(
      (d) => d != null && now - d.lastEventAt > INACTIVITY_HINT_MS,
    );
  })();

  // 参加者リスト（N-way対応）。単独モードでも1要素配列が返る。
  const slots: ParticipantSlot[] = thread ? effectiveParticipants(thread) : [];
  const isParallel = slots.length >= 2;
  const character = thread ? getCharacter(thread.characterId) : undefined;
  // 単独モード時のヘッダ表示用：人格（CEO/丁寧 等）が一目で分かるように
  const personality = !isParallel && character
    ? getPersonality(character.personalityId ?? "")
    : null;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 200) + "px";
    }
  }, [input]);

  // 新メッセージ追加（ユーザー送信 / AI 返信開始）時は無条件で最下部へ。
  // requestAnimationFrame で DOM 反映後に走らせて、追加直後の scrollHeight を確実に拾う。
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [thread?.id, thread?.messages.length]);

  // ストリーミング中（ドラフト更新）は末尾付近にいる時だけ追従する。
  // ユーザーが上に戻って過去を読んでいる時に強制スクロールすると邪魔になるため。
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 200) {
      el.scrollTop = el.scrollHeight;
    }
  }, [threadDrafts]);

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
          <div className="flex justify-center mb-4">
            <div className="w-14 h-14 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-center">
              <Bot size={28} strokeWidth={1.5} className="text-[var(--color-muted)]" />
            </div>
          </div>
          <h2 className="text-xl font-bold mb-2">{t("chat.welcomeTitle")}</h2>
          <p className="text-sm text-[var(--color-muted)] max-w-md whitespace-pre-line">
            {t("chat.welcomeBody")}
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
        {!isParallel && character && (
          <span className="flex items-center gap-1 text-[11px] text-[var(--color-muted)] truncate">
            <span className="truncate">
              {character.name}
              <span aria-hidden="true">{t("chat.parallelOpenParen")}</span>
              <CategoryDot provider={character.provider} size={7} className="mr-0.5" />
              <span>{PROVIDER_LABELS[character.provider]}</span>
              <span aria-hidden="true">{t("chat.parallelCloseParen")}</span>
            </span>
            {personality && (
              <>
                <span className="text-[var(--color-border)]">{t("chat.personalitySep")}</span>
                <span>{personality.label}</span>
              </>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          {onTogglePeek && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTogglePeek();
              }}
              className={`px-2 py-1 rounded text-[10.5px] font-medium transition border ${
                peekActive
                  ? "bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]"
                  : "bg-white border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
              }`}
              title={
                peekActive
                  ? t("chat.peekActiveTitle")
                  : t("chat.peekInactiveTitle")
              }
              aria-pressed={peekActive}
            >
              {peekActive ? t("chat.peekActive") : t("chat.peekInactive")}
            </button>
          )}
          {onSplit && (
            <button
              onClick={onSplit}
              className="p-1.5 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
              title={t("chat.splitOpenTitle")}
              aria-label={t("chat.splitOpenAria")}
            >
              <Columns2 size={14} />
            </button>
          )}
          {onCloseSplit && (
            <button
              onClick={onCloseSplit}
              className="p-1.5 rounded hover:bg-red-50 text-[var(--color-muted)] hover:text-red-500 transition"
              title={t("chat.closePaneTitle")}
              aria-label={t("chat.closePaneAria")}
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
              {t("chat.parallelMode")}{t("chat.parallelOpenParen")}{t("chat.parallelWay").replace("{count}", String(slots.length))}{t("chat.parallelColon")}
              {slots.map((s, idx) => (
                <span key={s.id} className="inline-flex items-center gap-1">
                  {idx > 0 && <span className="mx-1 text-[var(--color-muted)]">{t("chat.parallelSep")}</span>}
                  <CategoryDot provider={s.provider} size={7} />
                  <span>{PROVIDER_LABELS[s.provider]}</span>
                </span>
              ))}
              {t("chat.parallelCloseParen")}
            </span>
          )}
          {thread.conferenceMode && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded font-medium border border-amber-200">
              {t("chat.conferenceMode").replace("{count}", String(thread.conferenceMaxRounds))}
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
            <div className="flex justify-center mb-3">
              <CharacterAvatar character={character} size={56} />
            </div>
            <div className="font-medium text-[var(--color-text)] mb-1">
              {character?.name
                ? t("chat.canTalkWith").replace("{name}", character.name)
                : t("chat.canTalkWithDefault")}
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
            isStreaming={isStreaming}
            workspace={thread.workspace ?? null}
            userProfile={userProfile}
            onExecuteCommand={onExecuteCommand}
          />
        ) : (
          <SingleView
            messages={thread.messages}
            character={character}
            workspace={thread.workspace ?? null}
            userProfile={userProfile}
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

      {/* 応答中の固定インジケータ。スクロール位置に関係なく常に入力欄の真上に出す。
          「今なにをしているか」をコード断片ではなく日本語の行為ラベルで示す。 */}
      <LiveActivityBar threadDrafts={threadDrafts} />

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
              {t("chat.continueConferenceQuestion")}
            </span>
            <button
              onClick={onContinueConference}
              className="ml-auto px-3 py-1.5 rounded-md bg-amber-600 text-white text-[11.5px] font-medium hover:opacity-90 shrink-0"
            >
              {t("chat.continueConference")}
            </button>
          </div>
        );
      })()}

      {/* 長い会話で token 消費が膨らむ前に新スレッドを切る案内。
          閾値（LONG_CHAT_THRESHOLD）以上 & per-thread で未 dismiss の時だけ表示。 */}
      {thread &&
        onSuggestNewThread &&
        thread.messages.length >= LONG_CHAT_THRESHOLD &&
        longChatDismissedFor !== thread.id && (
          <div className="shrink-0 border-t border-[var(--color-border)] px-4 py-2 bg-sky-50/70 flex items-center gap-2 text-[12px]">
            <Sparkles size={13} className="text-sky-600 shrink-0" />
            <span className="text-sky-900 leading-snug">
              {t("chat.longChatTurnsPrefix")}<span className="font-mono font-semibold">
                {thread.messages.length}
              </span>{t("chat.longChatTurnsSuffix")}
            </span>
            <button
              onClick={onSuggestNewThread}
              className="ml-auto px-3 py-1.5 rounded-md bg-sky-600 text-white text-[11.5px] font-medium hover:opacity-90 shrink-0"
            >
              {t("chat.openNewThread")}
            </button>
            <button
              onClick={() => setLongChatDismissedFor(thread.id)}
              title={t("chat.dontShowAgainHere")}
              className="shrink-0 p-1 rounded text-sky-700 hover:bg-sky-100"
              aria-label={t("chat.close")}
            >
              <X size={12} />
            </button>
          </div>
        )}

      <div className="shrink-0 border-t border-[var(--color-border)] p-4 bg-white">
        {thread && (
          <div className="max-w-4xl mx-auto mb-2 flex items-center justify-end">
            <PermissionModeBadge
              mode={thread.permissionMode ?? "acceptEdits"}
              onToggle={onTogglePermissionMode}
            />
          </div>
        )}
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
            placeholder={
              character?.name
                ? t("chat.inputPlaceholder").replace("{name}", character.name)
                : t("chat.inputPlaceholderDefault")
            }
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
              title={
                anyDraftStuck
                  ? t("chat.abortStuckTitle")
                  : t("chat.abortNormalTitle")
              }
              className={`shrink-0 px-3 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition flex items-center gap-1.5 ${
                anyDraftStuck
                  ? "bg-amber-500 ring-2 ring-amber-300 unicrew-pulse-attention"
                  : "bg-red-500"
              }`}
            >
              <Square size={14} fill="currentColor" />
              {anyDraftStuck ? t("chat.abortStuckLabel") : t("chat.abortNormalLabel")}
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
              {t("chat.send")}
            </button>
          )}
        </div>
        <div className="max-w-4xl mx-auto mt-2 text-[11px] text-[var(--color-muted)] text-center">
          {t("chat.betaNotice")}
        </div>
      </div>
    </main>
  );
}

// ----- パーミッションモードバッジ（Shift+Tab トグル） -----

function PermissionModeBadge({
  mode,
  onToggle,
}: {
  mode: PermissionMode;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const isPlan = mode === "plan";
  // Plan モードは「読み取り専用で動作中」の注意喚起として色を強める。
  const tone = isPlan
    ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
    : "border-[var(--color-border)] bg-white text-[var(--color-muted)] hover:bg-gray-50";
  const label = PERMISSION_MODE_LABELS[mode];
  const Component = onToggle ? "button" : "div";
  return (
    <Component
      onClick={onToggle}
      type={onToggle ? "button" : undefined}
      title={
        isPlan
          ? t("chat.permissionPlanTitle")
          : t("chat.permissionAcceptTitle")
      }
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition ${tone} ${
        onToggle ? "cursor-pointer" : "cursor-default"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          isPlan ? "bg-amber-500" : "bg-emerald-500"
        }`}
        aria-hidden
      />
      <span>{label}</span>
      <span className="hidden md:inline text-[10px] opacity-70 font-mono">
        Shift+Tab
      </span>
    </Component>
  );
}

// ----- Single view (1プロバイダ・縦表示) -----

function SingleView({
  messages,
  character,
  draft,
  workspace,
  userProfile,
  onExecuteCommand,
  onSosForError,
}: {
  messages: Message[];
  character: ReturnType<typeof getCharacter>;
  draft: ActiveDraftLite | null;
  workspace?: string | null;
  userProfile?: Props["userProfile"];
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
          workspace={workspace}
          userProfile={userProfile}
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
  isStreaming,
  workspace,
  userProfile,
  onExecuteCommand,
}: {
  messages: Message[];
  slots: ParticipantSlot[];
  drafts: Record<string, ActiveDraftLite | null>;
  conferenceMode: boolean;
  isStreaming: boolean;
  workspace?: string | null;
  userProfile?: Props["userProfile"];
  onExecuteCommand?: (command: string, lang: string) => void;
}) {
  const groups = groupMessagesForNway(messages, slots);
  const hasDrafts = Object.values(drafts).some((d) => d != null);
  const lastGroup = groups[groups.length - 1];
  const slotsForView = slots.filter((s) => s.role !== "moderator");

  // moderator (中立審判) の発言は通常列ではなく、ラウンド下部に独立して表示する。
  const moderatorSlotId = slots.find((s) => s.role === "moderator")?.id;

  // 議論モードで「直前のラウンドが全スロット埋まった ＆ まだストリーム中」のとき、
  // 次ラウンドの応答が来るまでの空白時間が UI 上「フリーズしてる？」に見える。
  // 次ラウンド用の空行（スピナー入り）を1行先出しして、進行中であることを伝える。
  const lastCompletedRound =
    lastGroup?.kind === "rounds"
      ? lastGroup.rounds[lastGroup.rounds.length - 1] ?? null
      : null;
  const lastRoundAllFilled =
    lastCompletedRound != null &&
    slotsForView.length > 0 &&
    slotsForView.every((s) => lastCompletedRound.bySlot.has(s.id));
  const showPendingNextRound =
    conferenceMode &&
    isStreaming &&
    lastCompletedRound != null &&
    lastRoundAllFilled;

  return (
    <>
      {groups.map((g, gi) => {
        if (g.kind === "user") {
          return (
            <MessageItem
              key={g.message.id}
              message={g.message}
              character={getCharacter(slotsForView[0]?.characterId ?? "")}
              workspace={workspace}
              userProfile={userProfile}
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
              // 次ラウンドの空行を出す場合、drafts はその行に渡したいので
              // 直前ラウンドの行には流さない（行を跨いで draft が混在するのを防ぐ）。
              const draftsForRow =
                isLastRound && !showPendingNextRound ? drafts : {};
              return (
                <NwayResponsesRow
                  key={`r-${gi}-${ri}`}
                  slots={slotsForView}
                  round={r.round}
                  showRoundLabel={conferenceMode}
                  bySlot={r.bySlot}
                  drafts={draftsForRow}
                  moderatorSlotId={moderatorSlotId}
                  isStreaming={isLastRound && isStreaming}
                />
              );
            })}
          </div>
        );
      })}
      {showPendingNextRound && (
        <NwayResponsesRow
          slots={slotsForView}
          round={lastCompletedRound!.round + 1}
          showRoundLabel={conferenceMode}
          bySlot={new Map()}
          drafts={drafts}
          moderatorSlotId={moderatorSlotId}
          isStreaming={true}
          pendingNextRound={true}
        />
      )}
      {hasDrafts && (!lastGroup || lastGroup.kind === "user") && (
        <NwayResponsesRow
          slots={slotsForView}
          round={0}
          showRoundLabel={conferenceMode}
          bySlot={new Map()}
          drafts={drafts}
          moderatorSlotId={moderatorSlotId}
          isStreaming={isStreaming}
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
  isStreaming = false,
  pendingNextRound = false,
}: {
  slots: ParticipantSlot[];
  round: number;
  showRoundLabel: boolean;
  bySlot: Map<string, Message>;
  drafts: Record<string, ActiveDraftLite | null>;
  moderatorSlotId?: string;
  /** この行が「現在ストリーミング中」のラウンドか。空のスロットにスピナーを出すか判断する。 */
  isStreaming?: boolean;
  /** この行が「次ラウンド先出し」の空行か。ヘッダにスピナー＋"応答待ち" を表示する。 */
  pendingNextRound?: boolean;
}) {
  const { t } = useTranslation();
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
        <div className="px-4 py-1 text-[10.5px] uppercase tracking-wide text-[var(--color-muted)] bg-[var(--color-surface)]/40 border-b border-[var(--color-border)] flex items-center gap-1.5">
          <span>
            {round === 0
              ? t("chat.roundFirst")
              : t("chat.roundReview").replace("{n}", String(round + 1))}
          </span>
          {pendingNextRound && (
            <span className="flex items-center gap-1 text-[var(--color-accent)] normal-case tracking-normal">
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              <span>{t("chat.waitingResponse")}</span>
            </span>
          )}
        </div>
      )}
      <div className={`grid ${GRID_COLS_BY_N[cols] ?? "grid-cols-2"} gap-0`}>
        {slots.map((slot, i) => {
          const slotMessage = bySlot.get(slot.id) ?? null;
          const slotDraft = drafts[slot.id] ?? null;
          // この行の「ストリーミング中だが、まだこのスロットには message も draft も来ていない」
          // という空白状態のときに、スピナー入りプレースホルダを出す。
          const slotPending =
            isStreaming && slotMessage == null && slotDraft == null;
          return (
            <SlotColumn
              key={slot.id}
              slot={slot}
              character={getCharacter(slot.characterId)}
              message={slotMessage}
              draft={slotDraft}
              leftBorder={i > 0}
              isPending={slotPending}
            />
          );
        })}
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
  isPending = false,
}: {
  slot: ParticipantSlot;
  character: ReturnType<typeof getCharacter>;
  message: Message | null;
  draft: ActiveDraftLite | null;
  leftBorder?: boolean;
  /** message/draft とも null だが、このラウンドはストリーミング中で「待機中」のとき true */
  isPending?: boolean;
}) {
  const { t } = useTranslation();
  const color = PROVIDER_COLORS[slot.provider];
  const label = PROVIDER_LABELS[slot.provider];
  return (
    <div
      className={`min-w-0 ${leftBorder ? "border-l border-[var(--color-border)]" : ""}`}
    >
      <div className="px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-medium bg-[var(--color-surface)]/40 border-b border-[var(--color-border)] sticky top-0">
        {character ? (
          <>
            <CharacterAvatar character={character} size={16} />
            <span
              className="truncate text-[var(--color-text)] font-semibold"
              title={`${character.name}${t("chat.parallelOpenParen")}${label}${t("chat.parallelCloseParen")}${character.roleTag ? t("chat.providerCharSep") + character.roleTag : ""}`}
            >
              {character.name}
              <span className="text-[var(--color-muted)] font-normal">
                {t("chat.parallelOpenParen")}
              </span>
              <CategoryDot provider={slot.provider} size={7} className="mr-0.5" />
              <span style={{ color }}>{label}</span>
              <span className="text-[var(--color-muted)] font-normal">
                {t("chat.parallelCloseParen")}
              </span>
            </span>
          </>
        ) : (
          <span style={{ color }} className="shrink-0 inline-flex items-center gap-1">
            <CategoryDot provider={slot.provider} size={7} />
            <span>{label}</span>
          </span>
        )}
        {draft && <StreamingStatus draft={draft} variant="row" />}
      </div>
      <div className="p-3 min-h-[60px]">
        {message ? (
          <ColumnContent blocks={message.blocks ?? []} fallback={message.content} />
        ) : draft ? (
          <ColumnContent blocks={draft.blocks} fallback="…" />
        ) : isPending ? (
          <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
            <Loader2
              size={12}
              className="animate-spin text-[var(--color-accent)] shrink-0"
              aria-hidden="true"
            />
            <span>{t("chat.slotWaiting").replace("{name}", character?.name ?? t("chat.slotPlaceholder"))}</span>
          </div>
        ) : (
          <div className="text-[12px] text-[var(--color-muted)] italic">
            {t("chat.slotNotReplied").replace("{name}", character?.name ?? t("chat.slotPlaceholder"))}
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
  const { t } = useTranslation();
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
        {hasMinutes ? t("chat.moderatorMinutesTitle") : t("chat.moderatorSummaryTitle")}
        {draft && <StreamingStatus draft={draft} variant="row" />}
        {parsed && hasMinutes && message && (
          <MinutesActions parsed={parsed} createdAt={message.createdAt} />
        )}
      </div>
      {parsed ? (
        <div className="space-y-1.5 text-amber-950">
          {typeof parsed.agreementScore === "number" && (
            <div>
              <span className="text-amber-700 font-semibold">{t("chat.agreementScore")}</span>
              <span className="font-mono">{parsed.agreementScore}/100</span>
            </div>
          )}
          {parsed.openIssues && parsed.openIssues.length > 0 && (
            <div>
              <span className="text-amber-700 font-semibold">{t("chat.openIssues")}</span>
              <ul className="list-disc pl-5 mt-0.5">
                {parsed.openIssues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
          {parsed.recommendedActions && parsed.recommendedActions.length > 0 && (
            <div>
              <span className="text-amber-700 font-semibold">{t("chat.recommendedActions")}</span>
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
  const { t } = useTranslation();
  return (
    <div className="mt-2 pt-2 border-t border-amber-200/70 space-y-2">
      {minutes.decisions && minutes.decisions.length > 0 && (
        <MinutesSection title={t("chat.minutesDecisions")} items={minutes.decisions} />
      )}
      {minutes.tasks && minutes.tasks.length > 0 && (
        <MinutesSection title={t("chat.minutesTasks")} items={minutes.tasks} />
      )}
      {minutes.parking && minutes.parking.length > 0 && (
        <MinutesSection title={t("chat.minutesParking")} items={minutes.parking} />
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
  const { t } = useTranslation();
  const buildMarkdown = (): string => {
    const date = new Date(createdAt);
    const ts = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(date.getDate()).padStart(2, "0")} ${String(
      date.getHours(),
    ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const lines: string[] = [];
    lines.push(t("chat.minutesMdHeading"));
    lines.push(``);
    lines.push(t("chat.minutesMdCreated").replace("{ts}", ts));
    if (typeof parsed.agreementScore === "number") {
      lines.push(t("chat.minutesMdAgreement").replace("{score}", String(parsed.agreementScore)));
    }
    lines.push(``);
    if (parsed.summary) {
      lines.push(t("chat.minutesMdSummary"));
      lines.push(``);
      lines.push(parsed.summary);
      lines.push(``);
    }
    if (parsed.minutes?.decisions && parsed.minutes.decisions.length > 0) {
      lines.push(t("chat.minutesMdDecisions"));
      lines.push(``);
      for (const d of parsed.minutes.decisions) lines.push(`- ${d}`);
      lines.push(``);
    }
    if (parsed.minutes?.tasks && parsed.minutes.tasks.length > 0) {
      lines.push(t("chat.minutesMdTasks"));
      lines.push(``);
      for (const task of parsed.minutes.tasks) lines.push(`- [ ] ${task}`);
      lines.push(``);
    }
    if (parsed.minutes?.parking && parsed.minutes.parking.length > 0) {
      lines.push(t("chat.minutesMdParking"));
      lines.push(``);
      for (const p of parsed.minutes.parking) lines.push(`- ${p}`);
      lines.push(``);
    }
    if (parsed.openIssues && parsed.openIssues.length > 0) {
      lines.push(t("chat.minutesMdOpenIssues"));
      lines.push(``);
      for (const i of parsed.openIssues) lines.push(`- ${i}`);
      lines.push(``);
    }
    if (
      parsed.recommendedActions &&
      parsed.recommendedActions.length > 0
    ) {
      lines.push(t("chat.minutesMdActions"));
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
    const fname = `${t("chat.minutesFileNamePrefix")}_${date.getFullYear()}${String(
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
        title={t("chat.minutesCopyTitle")}
      >
        {t("chat.minutesCopy")}
      </button>
      <button
        type="button"
        onClick={handleDownload}
        className="text-[10.5px] px-1.5 py-0.5 rounded bg-amber-600 text-white hover:opacity-90"
        title={t("chat.minutesDownloadTitle")}
      >
        {t("chat.minutesDownload")}
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
 * draft の blocks 末尾を見て「今まさに何をしているか」を人間可読の i18n キーで返す。
 * - 末尾の tool_use が実行中（pending/approved）ならツール種別に応じたラベル
 * - 末尾の tool が完了済み（= 今はテキスト生成中）なら null（呼び出し側で考え中/応答中にフォールバック）
 * コード断片やコマンド文字列は出さず、行為の種類だけを日本語/英語で示すのが狙い。
 */
function currentActivityKey(blocks: Block[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind !== "tool_use") continue;
    if (
      b.status === "completed" ||
      b.status === "errored" ||
      b.status === "denied"
    ) {
      return null;
    }
    const n = b.toolName;
    if (n === "Bash") return "chat.activityBash";
    if (n === "Read" || n === "NotebookRead") return "chat.activityRead";
    if (n === "Edit" || n === "Write" || n === "MultiEdit" || n === "NotebookEdit")
      return "chat.activityEdit";
    if (n === "Grep" || n === "Glob" || n === "LS") return "chat.activitySearch";
    if (n === "TodoWrite") return "chat.activityTodo";
    if (n === "WebFetch" || n === "WebSearch") return "chat.activityWeb";
    return "chat.activityTool";
  }
  return null;
}

/**
 * メッセージ領域の下・入力欄の上に常時固定で出すアクティビティバー。
 * スクロール位置に関係なく「今 AI が動いているか・何をしているか」が分かる。
 * - 単独モード: 1 行（活動ラベル + 経過メトリクス）
 * - 並列モード: 参加者ごとに 1 行
 */
function LiveActivityBar({
  threadDrafts,
}: {
  threadDrafts: Record<string, ActiveDraftLite | null>;
}) {
  const { t } = useTranslation();
  const active = Object.values(threadDrafts).filter(
    (d): d is ActiveDraftLite => d != null,
  );
  if (active.length === 0) return null;

  const lineFor = (d: ActiveDraftLite, key: string | number) => {
    const actKey = currentActivityKey(d.blocks);
    const now = Date.now();
    const stuck = now - d.lastEventAt > INACTIVITY_HINT_MS;
    const label = stuck
      ? t("chat.streamingStuck")
      : actKey
        ? t(actKey)
        : d.firstTextAt !== null
          ? t("chat.streamingResponding")
          : t("chat.streamingThinking");
    return (
      <div key={key} className="flex items-center gap-2 min-w-0">
        <Loader2
          size={13}
          className={`animate-spin shrink-0 ${stuck ? "text-amber-600" : "text-[var(--color-accent)]"}`}
        />
        <span
          className={`text-[12.5px] font-medium truncate ${stuck ? "text-amber-700" : "text-[var(--color-text)]"}`}
        >
          {label}
        </span>
        <span className="ml-auto shrink-0">
          <StreamingStatus draft={d} variant="row" showLabel={false} />
        </span>
      </div>
    );
  };

  return (
    <div
      className="shrink-0 border-t border-[var(--color-border)] px-4 py-2 bg-[var(--color-accent)]/[0.06] flex flex-col gap-1"
      aria-live="polite"
      aria-busy="true"
    >
      {active.length === 1
        ? lineFor(active[0], "single")
        : active.map((d, i) => lineFor(d, d.slotId ?? i))}
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
  showLabel = true,
}: {
  draft: ActiveDraftLite;
  variant?: "inline" | "row";
  /** false なら「考え中…/応答中…」ラベルを省略し経過メトリクスのみ表示（stuck 警告時は強制表示）。 */
  showLabel?: boolean;
}) {
  const { t } = useTranslation();
  // 経過時間ライブ更新用ティック
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => (x + 1) & 0xffff), 500);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const elapsedMs = Math.max(0, now - draft.startedAt);
  const hasFirstText = draft.firstTextAt !== null;
  const inactiveMs = Math.max(0, now - draft.lastEventAt);
  const stuck = inactiveMs > INACTIVITY_HINT_MS;
  const label = stuck
    ? t("chat.streamingStuck")
    : hasFirstText
      ? t("chat.streamingResponding")
      : t("chat.streamingThinking");
  const thinkingMs =
    draft.firstTextAt !== null
      ? Math.max(0, draft.firstTextAt - draft.startedAt)
      : null;

  const segments: string[] = [formatElapsed(elapsedMs)];
  if (draft.outputTokens > 0) {
    segments.push(t("chat.streamingTokens").replace("{tokens}", formatTokens(draft.outputTokens)));
  }
  if (thinkingMs !== null) {
    segments.push(t("chat.streamingThought").replace("{dur}", formatThinking(thinkingMs)));
  }
  if (stuck) {
    // 「最後の反応から何秒沈黙してるか」を表示。下の停止ボタンの存在に
    // ユーザーが気付くための、控えめな注意喚起。
    const sec = Math.round(inactiveMs / 1000);
    segments.push(t("chat.streamingSilentSec").replace("{sec}", String(sec)));
  }

  const isRow = variant === "row";
  const toneClass = stuck
    ? "text-amber-700"
    : "text-[var(--color-accent)]";
  const subClass = stuck ? "text-amber-700/70" : "text-[var(--color-muted)]";
  return (
    <span
      className={
        isRow
          ? `ml-auto flex items-center gap-1.5 text-[11px] ${toneClass} font-mono tabular-nums`
          : `inline-flex items-center gap-1.5 text-[11px] ${toneClass} font-mono tabular-nums`
      }
      aria-live="polite"
      aria-busy="true"
      title={
        stuck
          ? t("chat.streamingStuckTitle")
          : undefined
      }
    >
      <Loader2 size={12} className="animate-spin shrink-0" />
      {(showLabel || stuck) && (
        <span className="font-medium">{label}…</span>
      )}
      <span className={`${subClass} font-normal`}>
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
  const { t } = useTranslation();
  const { blocks } = draft;
  return (
    <div className="flex gap-3 px-6 py-4 bg-[var(--color-surface)]/60">
      <CharacterAvatar character={character} size={36} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-sm font-semibold">
            {character?.name ?? t("chat.defaultAssistant")}
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
