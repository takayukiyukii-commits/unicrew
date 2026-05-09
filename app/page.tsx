"use client";

import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { Sidebar, type MainView } from "@/components/Sidebar";
import { AddonsSection } from "@/components/AddonsSection";
import { AppMenuBar, type MenuDef } from "@/components/AppMenuBar";
import { ChatPane } from "@/components/ChatPane";
import { TaskQueuePanel } from "@/components/TaskQueuePanel";
import { UniMcpModal } from "@/components/UniMcpModal";
import { RoutinesModal } from "@/components/RoutinesModal";
import { MobileBridgeModal } from "@/components/MobileBridgeModal";
import {
  loadRoutines,
  markFired,
  saveRoutines,
  shouldFire,
} from "@/lib/routines";
import {
  generateMobileToken,
  MOBILE_TOKEN_LS_KEY,
  type MobileStateSnapshot,
} from "@/lib/mobile-bridge";
import {
  isCloudConfigured,
  joinPairChannel,
  sendCloudEvent,
  type CloudEvent,
} from "@/lib/cloud-bridge";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { FeedbackCard } from "@/components/FeedbackCard";
import {
  countUserMessages,
  shouldShowFeedback,
  markFeedbackShown,
} from "@/lib/feedback";
import { RightPane } from "@/components/RightPane";
import { SettingsModal } from "@/components/SettingsModal";
import { CharacterPickerModal } from "@/components/CharacterPickerModal";
import { CharacterEditModal } from "@/components/CharacterEditModal";
import { PermissionPromptModal } from "@/components/PermissionPromptModal";
import { WelcomeLanding } from "@/components/WelcomeLanding";
import { ActivityVisibilityContext } from "@/components/ActivityContext";
import { PaneResizer } from "@/components/PaneResizer";
import {
  appendMessage,
  createThread,
  loadSettings,
  loadThreads,
  saveSettings,
  saveThreads,
} from "@/lib/storage";
import {
  agentPermissionResponse,
  agentSend,
  agentStart,
  agentStop,
  claudeStatus,
  codexStatus,
  defaultWorkspacePath,
  getApiKey,
  graphifyUpdate,
  isTauri,
  listenAgentEvents,
  pickWorkspace,
  type AgentEvent,
} from "@/lib/tauri";
import {
  cloneFromTemplate,
  getCharacter,
  loadUserCharacters,
  saveUserCharacters,
} from "@/lib/characters";
import {
  effectiveParticipants,
  findSlot,
  isParallel as isThreadParallel,
  makeSlotSid,
  parseSlotSid,
  removeParticipant,
  updateParticipant,
  addParticipant,
} from "@/lib/participants";
import {
  TEMPLATE_TEAMS,
  cloneFromTemplateTeam,
  exportTeamToJson,
  importTeamFromJson,
  loadUserTeams,
  newTeamId,
  saveUserTeams,
  teamToParticipants,
} from "@/lib/teams";
import { buildEffectiveSystemPrompt } from "@/lib/personalities";
import type {
  AppSettings,
  Block,
  Character,
  ModelId,
  ParticipantSlot,
  PendingPermission,
  Provider,
  TextBlock,
  Thread,
  ToolUseBlock,
} from "@/lib/types";

interface ActiveDraft {
  threadId: string;
  /** どのスロットか。同じproviderが複数並ぶN-wayケースに対応するため必須。 */
  slotId: string;
  provider: Provider;
  /** moderator 役の場合 true。判定結果は通常列でなくラウンド下部に表示される。 */
  isModerator: boolean;
  blocks: Block[];
  toolMap: Map<string, number>;
  startedAt: number;
  /** 最初のテキストブロックが到着した時刻。null なら未到達（ツール実行中の場合あり） */
  firstTextAt: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const FRESH_DRAFT = (
  threadId: string,
  slot: ParticipantSlot,
): ActiveDraft => ({
  threadId,
  slotId: slot.id,
  provider: slot.provider,
  isModerator: slot.role === "moderator",
  blocks: [],
  toolMap: new Map(),
  startedAt: Date.now(),
  firstTextAt: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

/**
 * sid から thread と slot を引く。
 * 旧2way構造では slotId が "claude"/"codex" のままなので、effectiveParticipants の
 * 結果と一致する（同じID）。
 */
function lookupSlot(
  sid: string,
  threadById: Map<string, Thread>,
): { thread: Thread | null; slot: ParticipantSlot | null } {
  const { threadId, slotId } = parseSlotSid(sid);
  const thread = threadById.get(threadId) ?? null;
  if (!thread) return { thread: null, slot: null };
  return { thread, slot: findSlot(thread, slotId) };
}

/**
 * N-way対応の議論ラウンドプロンプト。
 *
 * 自分以外の参加者の発言を全部見せて、各員の良い点・改善点・統合案を求める。
 */
function buildConferencePromptNway(
  others: { name: string; text: string }[],
): string {
  const blocks = others
    .map((o, i) => `## ${i + 1}. ${o.name}\n${o.text}`)
    .join("\n\n");
  return `# 会議モード（議論ラウンド）
他の参加者は次のように回答しました：

${blocks}

---
これを踏まえて、あなたの立場で：
1. 各参加者の良い点を1〜2行で評価
2. 改善・補足できる点があれば具体的に提示
3. 統合的な改善案を簡潔に提示

完全に同意してそれ以上改善する必要がないと判断した場合は、回答の冒頭に「[合意]」と書いてください。`;
}

/**
 * 中立審判（moderator）への入力プロンプト。
 *
 * 各ラウンド終了時に、参加者の発言を全部見せて合意度・残論点・推奨アクションを
 * JSONで返してもらう。Phase 2機能。
 */
function buildModeratorPrompt(
  round: number,
  participantTexts: { name: string; text: string }[],
): string {
  const blocks = participantTexts
    .map((p, i) => `## ${i + 1}. ${p.name}\n${p.text}`)
    .join("\n\n");
  return `# 中立審判ラウンド ${round + 1}
あなたはこの議論の中立審判です。各参加者に肩入れせず、第三者として議論を評価してください。

各参加者の最新発言:

${blocks}

---
以下のJSONフォーマット**のみ**で返答してください（前置き・説明・コードフェンス禁止）：

\`\`\`
{
  "agreementScore": <0-100の整数。100=完全合意>,
  "openIssues": [<まだ解決していない論点の配列。string[]>],
  "recommendedActions": [<次のラウンドで議論すべき推奨アクション。string[]>],
  "summary": "<2-3行でこのラウンドの総括>"
}
\`\`\``;
}

/**
 * 議論終了時の議事録生成プロンプト（中立審判向け）。
 * タスク・決定・保留事項に分離させる。
 */
function buildModeratorMinutesPrompt(
  participantTexts: { name: string; text: string }[],
): string {
  const blocks = participantTexts
    .map((p, i) => `## ${i + 1}. ${p.name}\n${p.text}`)
    .join("\n\n");
  return `# 議論クロージング：議事録
議論が終了しました。以下を踏まえて議事録を作成してください。

最終ラウンドの各参加者発言:

${blocks}

---
以下のJSONフォーマット**のみ**で返答してください（前置き・説明・コードフェンス禁止）：

\`\`\`
{
  "agreementScore": 100,
  "openIssues": [],
  "recommendedActions": [],
  "summary": "<議論全体の総括3-5行>",
  "minutes": {
    "decisions": [<合意事項の配列>],
    "tasks": [<具体的タスクの配列。担当者が明確ならカッコで>],
    "parking": [<保留事項の配列>]
  }
}
\`\`\``;
}

type PaneSlot = "primary" | "split";

export default function Page() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 並列ペイン（主ペインの右）に表示するスレッドID。null なら単一ペイン。 */
  const [splitId, setSplitId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>({
    defaultCharacterId: "tmpl-claude-normal",
    authMode: "subscription",
    showActivity: false,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** フィードバック・サーベイ表示フラグ。たまに会話末尾に差し込む。 */
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSplitMode, setPickerSplitMode] = useState(false);
  const [pickerConferenceMode, setPickerConferenceMode] = useState(false);
  /** Picker で作る新スレッドをどのペインに割り当てるか。 */
  const [pickerSlot, setPickerSlot] = useState<PaneSlot>("primary");
  /** 並列ペイン時の左側の幅（%）。ドラッグで変更可。 */
  const [splitWidthPct, setSplitWidthPct] = useState<number>(50);
  /** タスクキューパネルの表示フラグ。 */
  const [taskQueueOpen, setTaskQueueOpen] = useState(false);
  /** UNI製品MCP一括接続モーダル（アイデア5） */
  const [uniMcpOpen, setUniMcpOpen] = useState(false);
  /** ルーティーン管理モーダル（アイデア14） */
  const [routinesOpen, setRoutinesOpen] = useState(false);
  /** スマホ連携モーダル（モバイルA案） */
  const [mobileOpen, setMobileOpen] = useState(false);
  /** Mobile bridge: auth POST 完了後に true。snapshot push を 401 させないため。 */
  const [mobileBridgeReady, setMobileBridgeReady] = useState(false);
  /** クラウドリレー（Phase 2）の現在のペアリングコード。null なら未起動。 */
  const [cloudPairCode, setCloudPairCode] = useState<string | null>(null);
  const cloudChannelRef = useRef<RealtimeChannel | null>(null);
  /** graphify ナレッジグラフ自動更新（アイデア6）の進捗表示。 */
  const [graphifyStatus, setGraphifyStatus] = useState<{
    state: "updating" | "done" | "error";
    message?: string;
  } | null>(null);
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [characterRevision, setCharacterRevision] = useState(0);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  /** session_id -> ActiveDraft（split時は2つ、single時は1つ） */
  const [drafts, setDrafts] = useState<Record<string, ActiveDraft>>({});
  const [streamingSids, setStreamingSids] = useState<Set<string>>(new Set());
  /** heartbeat 等の closure 内で最新値を参照するため */
  const streamingSidsRef = useRef<Set<string>>(new Set());
  streamingSidsRef.current = streamingSids;
  const [hydrated, setHydrated] = useState(false);

  const sessionsStartedRef = useRef<Set<string>>(new Set());
  const paneAreaRef = useRef<HTMLDivElement>(null);
  const draftsRef = useRef<Record<string, ActiveDraft>>({});
  draftsRef.current = drafts;
  const threadsRef = useRef<Thread[]>([]);
  threadsRef.current = threads;
  /** モバイルA案: activeId をスマホブリッジから参照する用の ref */
  const activeIdRef = useRef<string | null>(null);
  /**
   * 会議モード進行状態（threadId → state）。
   * N-way対応：各 slot の最新応答を保持する。null なら未到達。
   */
  const conferenceRef = useRef<
    Map<
      string,
      { round: number; responses: Record<string, string | null> }
    >
  >(new Map());

  // hydrate
  useEffect(() => {
    const t = loadThreads();
    const s = loadSettings();
    setThreads(t);
    setSettings(s);
    setHydrated(true);

    (async () => {
      if (!isTauri()) return;
      if (s.authMode === "apikey") {
        const key = await getApiKey();
        if (!key) setSettingsOpen(true);
      } else {
        const status = await claudeStatus();
        if (!status.installed || !status.logged_in) {
          setSettingsOpen(true);
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (hydrated) saveThreads(threads);
  }, [threads, hydrated]);

  useEffect(() => {
    if (threads.length > 0 && !activeId) setActiveId(threads[0].id);
  }, [threads, activeId]);

  // splitId が消えたスレッドを指していたらクリア
  useEffect(() => {
    if (splitId && !threads.some((t) => t.id === splitId)) setSplitId(null);
  }, [threads, splitId]);

  // フィードバック表示判定。hydrate完了後、ストリーミング中ではない時に再評価する。
  // 表示中（feedbackVisible=true）の間は再判定しない（パッと消えないように）。
  const userMsgCount = countUserMessages(threads);
  useEffect(() => {
    if (!hydrated) return;
    if (feedbackVisible) return;
    if (mainView !== "chat") return;
    if (!shouldShowFeedback(userMsgCount)) return;
    setFeedbackVisible(true);
    markFeedbackShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, userMsgCount, mainView]);

  // ESC ショートカット用に最新値を保持する ref（useEffect が再 attach されないように）
  const abortContextRef = useRef<{
    primaryThread: Thread | null;
    splitThread: Thread | null;
    primaryStreaming: boolean;
    splitStreaming: boolean;
    abortThread: (t: Thread) => void;
    abortAll: () => void;
  } | null>(null);

  // Esc で停止 / Ctrl+Shift+C で全停止 のキーボードショートカット
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ctx = abortContextRef.current;
      if (!ctx) return;
      const isInput =
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      const hasSelection = !!(sel && sel.toString().length > 0);

      // Ctrl/⌘+Shift+C: 全停止
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (e.key === "c" || e.key === "C")
      ) {
        e.preventDefault();
        ctx.abortAll();
        return;
      }
      // Esc: アクティブ thread の停止（input にフォーカス中でも反応）
      if (e.key === "Escape") {
        if (isInput) (e.target as HTMLElement).blur();
        if (ctx.primaryThread && ctx.primaryStreaming) {
          e.preventDefault();
          ctx.abortThread(ctx.primaryThread);
        } else if (ctx.splitThread && ctx.splitStreaming) {
          e.preventDefault();
          ctx.abortThread(ctx.splitThread);
        }
        return;
      }
      // Ctrl/⌘+C: input/選択中じゃない時のみ停止に流す（コピー優先）
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        if (isInput || hasSelection) return;
        if (ctx.primaryThread && ctx.primaryStreaming) {
          e.preventDefault();
          ctx.abortThread(ctx.primaryThread);
        } else if (ctx.splitThread && ctx.splitStreaming) {
          e.preventDefault();
          ctx.abortThread(ctx.splitThread);
        }
        return;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Agent events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listenAgentEvents(handleAgentEvent).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Phase 2 クラウドリレー：ペアリングコード起動/停止 ハンドラ。
   * 開始すると Supabase Realtime channel に subscribe し、スマホからの
   * `from_mobile` イベントを `handleSendForThread` に流す。
   */
  const startCloudPairing = (code: string) => {
    if (cloudChannelRef.current) {
      void cloudChannelRef.current.unsubscribe();
      cloudChannelRef.current = null;
    }
    const ch = joinPairChannel(code, (ev: CloudEvent) => {
      if (ev.kind === "from_mobile") {
        const target =
          ev.threadId === "active"
            ? threadsRef.current.find((t) => t.id === activeIdRef.current)
            : threadsRef.current.find((t) => t.id === ev.threadId);
        if (target) void handleSendForThread(ev.text, target);
      } else if (ev.kind === "from_mobile_switch") {
        // スマホからアクティブスレッド切替依頼
        const target = threadsRef.current.find((t) => t.id === ev.threadId);
        if (target) {
          setActiveId(target.id);
          if (splitId === target.id) setSplitId(null);
        }
      }
    });
    cloudChannelRef.current = ch;
    setCloudPairCode(code);
  };
  const stopCloudPairing = () => {
    if (cloudHeartbeatRef.current) {
      clearInterval(cloudHeartbeatRef.current);
      cloudHeartbeatRef.current = null;
    }
    if (cloudChannelRef.current) {
      void cloudChannelRef.current.unsubscribe();
      cloudChannelRef.current = null;
    }
    setCloudPairCode(null);
  };

  // Heartbeat 用 setInterval ID
  const cloudHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Phase 2: クラウドリレー heartbeat。
   * Supabase Realtime channel の subscribe は非同期で、初回 send は破棄される
   * 可能性がある。2秒ごとに snapshot push する setInterval を立て、
   * 接続状態とPC側の現スレッド情報をスマホへ常時流す。
   */
  useEffect(() => {
    if (!cloudPairCode) return;
    const tick = () => {
      const ch = cloudChannelRef.current;
      if (!ch) return;
      const t = threadsRef.current.find((x) => x.id === activeIdRef.current) ?? null;
      const lastAssistant = t
        ? [...t.messages].reverse().find((m) => m.role === "assistant")
        : null;

      // スレッド情報（プロバイダ・キャラ）を整形
      const summarize = (th: typeof t) => {
        if (!th) return { providerLabel: "", characterName: "" };
        const slots = effectiveParticipants(th);
        if (slots.length === 1) {
          const c = getCharacter(slots[0].characterId);
          const pl =
            slots[0].provider === "claude"
              ? "🟠 Claude"
              : slots[0].provider === "codex"
              ? "🟢 Codex"
              : "🔵 Gemini";
          return { providerLabel: pl, characterName: c?.name ?? "—" };
        }
        const hasMod = slots.some((s) => s.role === "moderator");
        const participantCount = slots.filter((s) => s.role !== "moderator").length;
        return {
          providerLabel: hasMod
            ? `👥 ${participantCount}-way＋審判`
            : `👥 ${participantCount}-way 並列`,
          characterName: "複数キャラ",
        };
      };
      const activeSummary = summarize(t);
      const threadSummaries = [...threadsRef.current]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 15)
        .map((th) => {
          const s = summarize(th);
          return {
            id: th.id,
            title: th.title,
            providerLabel: s.providerLabel,
            characterName: s.characterName,
          };
        });

      void sendCloudEvent(ch, {
        kind: "from_pc",
        activeThreadId: t?.id ?? null,
        activeThreadTitle: t?.title ?? null,
        activeProviderLabel: t ? activeSummary.providerLabel : null,
        activeCharacterName: t ? activeSummary.characterName : null,
        lastAssistantPreview:
          lastAssistant?.content?.slice(0, 2000) ?? null,
        isStreaming: streamingSidsRef.current.size > 0,
        threads: threadSummaries,
      }).catch(() => {});
    };
    // 1秒後に最初のpush（subscribe完了見込み時刻）、以降は2秒ごと
    const initial = setTimeout(tick, 1000);
    const id = setInterval(tick, 2000);
    cloudHeartbeatRef.current = id;
    return () => {
      clearTimeout(initial);
      clearInterval(id);
      cloudHeartbeatRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudPairCode]);

  // Phase 2 クラウドリレーの状態 snapshot push は、
  // primaryStreaming/activeThread が render scope で計算された後の場所で別途配置する。

  /**
   * モバイルA案: PC側React のmobile bridge ループ。
   *
   * 1. 起動時に localStorage から token を取り出し（無ければ生成）→ サーバ側 _store にも登録
   * 2. 5秒ごとに `/api/mobile/inbox` をポーリングしてスマホ投稿を取り出し、
   *    アクティブスレッドに `handleSendForThread` で流す
   * 3. 状態変化があれば `/api/mobile/state` に snapshot を push
   *
   * Next.js dev モード前提（Tauri export build では API Route 無効）。
   */
  useEffect(() => {
    if (!hydrated) return;
    let token = localStorage.getItem(MOBILE_TOKEN_LS_KEY);
    if (!token) {
      token = generateMobileToken();
      localStorage.setItem(MOBILE_TOKEN_LS_KEY, token);
    }
    void fetch("/api/mobile/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(() => setMobileBridgeReady(true))
      .catch(() => {});

    const pollInbox = async () => {
      try {
        const r = await fetch(`/api/mobile/inbox?t=${token}`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = (await r.json()) as {
          ok: boolean;
          items: { threadId: string; text: string }[];
        };
        if (!j.ok || !j.items || j.items.length === 0) return;
        const active = threadsRef.current.find(
          (t) => t.id === activeIdRef.current,
        );
        for (const item of j.items) {
          const target =
            item.threadId === "active"
              ? active
              : threadsRef.current.find((t) => t.id === item.threadId);
          if (!target) continue;
          void handleSendForThread(item.text, target);
        }
      } catch {
        // ignore
      }
    };
    const inboxId = setInterval(pollInbox, 5000);
    void pollInbox();
    return () => clearInterval(inboxId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  /**
   * アイデア14: ルーティーン自動発火ループ。
   * 60秒ごとに登録ルーティーンをチェックし、発火条件を満たすものがあれば送信する。
   * 同日中の重複発火は lastFiredDay で防止。
   */
  useEffect(() => {
    if (!hydrated) return;
    const tick = () => {
      const all = loadRoutines();
      if (all.length === 0) return;
      const now = new Date();
      const fireTargets = all.filter((r) => shouldFire(r, now));
      if (fireTargets.length === 0) return;
      let next = all;
      for (const r of fireTargets) {
        const t = threadsRef.current.find((x) => x.id === r.threadId);
        if (!t) {
          // スレッド削除済みなら lastFiredDay は更新しない（復活する可能性あり）
          continue;
        }
        next = markFired(next, r.id, now);
        void handleSendForThread(`🤖 [ルーティーン: ${r.label}]\n${r.prompt}`, t);
      }
      saveRoutines(next);
    };
    // 起動直後にも1回チェック（過去時刻の回収）
    const initial = setTimeout(tick, 5000);
    const id = setInterval(tick, 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const activeThread = threads.find((t) => t.id === activeId) ?? null;

  const updateThread = (id: string, mut: (t: Thread) => Thread) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? mut(t) : t)));
  };

  const updateDraft = (sid: string, mut: (d: ActiveDraft) => ActiveDraft) => {
    setDrafts((prev) => {
      const existing = prev[sid];
      if (!existing) return prev;
      return { ...prev, [sid]: mut(existing) };
    });
  };

  function handleAgentEvent(event: AgentEvent) {
    if (event.kind === "ready") return;

    if (event.kind === "permission_request") {
      setPendingPermission({
        sessionId: event.session_id,
        requestId: event.request_id,
        toolName: event.tool_name,
        input: event.input,
      });
      return;
    }

    const sid = "session_id" in event ? event.session_id : null;
    if (!sid) return;

    const threadById = new Map(threadsRef.current.map((t) => [t.id, t]));
    const { thread, slot } = lookupSlot(sid, threadById);
    if (!thread || !slot) return;

    // Ensure draft exists for this sid
    if (!draftsRef.current[sid]) {
      const fresh = FRESH_DRAFT(thread.id, slot);
      draftsRef.current = { ...draftsRef.current, [sid]: fresh };
      setDrafts(draftsRef.current);
      setStreamingSids((prev) => new Set([...prev, sid]));
    }

    if (event.kind === "assistant_text") {
      updateDraft(sid, (d) => {
        const firstTextAt = d.firstTextAt ?? Date.now();
        const last = d.blocks[d.blocks.length - 1];
        if (last && last.kind === "text") {
          const updated: TextBlock = {
            kind: "text",
            text: last.text + event.text,
          };
          return {
            ...d,
            firstTextAt,
            blocks: [...d.blocks.slice(0, -1), updated],
          };
        }
        return {
          ...d,
          firstTextAt,
          blocks: [...d.blocks, { kind: "text", text: event.text }],
        };
      });
      return;
    }

    if (event.kind === "usage_delta") {
      updateDraft(sid, (d) => ({
        ...d,
        // 各フィールドは「より大きい新しい値」が来たら採用（途中ロールバック防止）。
        // sidecar からは累積値で送るため max が正しい。
        inputTokens: Math.max(d.inputTokens, event.input_tokens ?? 0),
        outputTokens: Math.max(d.outputTokens, event.output_tokens ?? 0),
        cacheReadTokens: Math.max(
          d.cacheReadTokens,
          event.cache_read_tokens ?? 0,
        ),
        cacheCreationTokens: Math.max(
          d.cacheCreationTokens,
          event.cache_creation_tokens ?? 0,
        ),
      }));
      return;
    }

    if (event.kind === "tool_use") {
      updateDraft(sid, (d) => {
        const block: ToolUseBlock = {
          kind: "tool_use",
          toolUseId: event.tool_use_id,
          toolName: event.tool_name,
          input: event.tool_input,
          status: "approved",
        };
        const newBlocks = [...d.blocks, block];
        const newMap = new Map(d.toolMap);
        newMap.set(event.tool_use_id, newBlocks.length - 1);
        return { ...d, blocks: newBlocks, toolMap: newMap };
      });
      return;
    }

    if (event.kind === "tool_result") {
      updateDraft(sid, (d) => {
        const idx = d.toolMap.get(event.tool_use_id);
        if (idx === undefined) return d;
        const target = d.blocks[idx];
        if (target.kind !== "tool_use") return d;
        const updated: ToolUseBlock = {
          ...target,
          status: event.is_error ? "errored" : "completed",
          isError: event.is_error,
          result:
            typeof event.content === "string"
              ? event.content
              : JSON.stringify(event.content),
        };
        const newBlocks = [...d.blocks];
        newBlocks[idx] = updated;
        return { ...d, blocks: newBlocks };
      });
      return;
    }

    if (event.kind === "result") {
      finalizeDraft(sid);
      return;
    }

    if (event.kind === "error") {
      updateDraft(sid, (d) => ({
        ...d,
        blocks: [
          ...d.blocks,
          {
            kind: "text",
            text: `**エラー**: ${event.message}\n\n認証状態とネットワーク接続を確認してください。`,
          } as TextBlock,
        ],
      }));
      finalizeDraft(sid);
    }
  }

  const finalizeDraft = (sid: string) => {
    const d = draftsRef.current[sid];
    if (!d) return;
    // 未解決の tool_use（pending / approved のまま）は最終的に確定させる。
    // WebSearch / WebFetch などサーバーサイドツールは tool_result を返さないため、
    // そのままだと UI に永久に「実行中」のバブルが残ってしまう。
    // turn 完了 or stop 時点で動いていなければ「完了」扱いに。
    const reconciledBlocks = d.blocks.map((b) => {
      if (
        b.kind === "tool_use" &&
        (b.status === "pending" || b.status === "approved")
      ) {
        return { ...b, status: "completed" as const };
      }
      return b;
    });
    d.blocks = reconciledBlocks;
    const textParts: string[] = [];
    for (const b of d.blocks) {
      if (b.kind === "text") textParts.push(b.text);
    }
    const finalText = textParts.join("\n").trim();
    const thread = threadsRef.current.find((t) => t.id === d.threadId);
    const conferenceRound = thread?.conferenceMode
      ? conferenceRef.current.get(d.threadId)?.round ?? 0
      : undefined;
    const finishedAt = Date.now();
    const assistantMsg = {
      id: nanoid(8),
      role: "assistant" as const,
      content: finalText,
      blocks: d.blocks,
      createdAt: finishedAt,
      provider: d.provider,
      participantSlotId: d.slotId,
      participantRole: d.isModerator
        ? ("moderator" as const)
        : ("participant" as const),
      conferenceRound,
      stats: {
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        cacheReadTokens: d.cacheReadTokens,
        cacheCreationTokens: d.cacheCreationTokens,
        durationMs: Math.max(0, finishedAt - d.startedAt),
        thinkingMs:
          d.firstTextAt !== null
            ? Math.max(0, d.firstTextAt - d.startedAt)
            : null,
      },
    };
    updateThread(d.threadId, (t) => appendMessage(t, assistantMsg));
    const next = { ...draftsRef.current };
    delete next[sid];
    draftsRef.current = next;
    setDrafts(next);
    setStreamingSids((prev) => {
      const n = new Set(prev);
      n.delete(sid);
      return n;
    });

    // アイデア6: ファイル編集系ツールが使われていれば graphify 自動更新
    if (thread?.workspace) {
      const FILE_EDIT_TOOLS = new Set([
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
      ]);
      const touchedFiles = d.blocks.some(
        (b) => b.kind === "tool_use" && FILE_EDIT_TOOLS.has(b.toolName),
      );
      if (touchedFiles) {
        const ws = thread.workspace;
        setGraphifyStatus({ state: "updating" });
        void graphifyUpdate(ws)
          .then(() => {
            setGraphifyStatus({ state: "done" });
            setTimeout(() => setGraphifyStatus(null), 3000);
          })
          .catch((err) => {
            setGraphifyStatus({
              state: "error",
              message: err instanceof Error ? err.message : String(err),
            });
            setTimeout(() => setGraphifyStatus(null), 6000);
          });
      }
    }

    // Conference mode: N-way対応のラウンド進行
    if (thread?.conferenceMode && isThreadParallel(thread)) {
      const allSlots = effectiveParticipants(thread);
      const participantSlots = allSlots.filter(
        (s) => s.role !== "moderator",
      );
      const moderatorSlot = allSlots.find((s) => s.role === "moderator");

      // moderator の応答完了は議論進行ロジックに巻き込まない（独立したサイドチャネル）
      if (d.isModerator) return;

      const state =
        conferenceRef.current.get(d.threadId) ??
        ({
          round: 0,
          responses: Object.fromEntries(
            participantSlots.map((s) => [s.id, null as string | null]),
          ),
        } as { round: number; responses: Record<string, string | null> });
      state.responses[d.slotId] = finalText;
      conferenceRef.current.set(d.threadId, state);

      const allDone = participantSlots.every(
        (s) => state.responses[s.id] !== null,
      );
      if (!allDone) return;

      const allAgreed = participantSlots.every((s) =>
        (state.responses[s.id] ?? "").trim().startsWith("[合意]"),
      );
      const reachedMax = state.round + 1 >= thread.conferenceMaxRounds;
      const isFinal = allAgreed || reachedMax;

      // moderator がいれば総括を依頼（合意/上限到達時は議事録モード）
      if (moderatorSlot) {
        const participantTexts = participantSlots.map((s) => {
          const c = getCharacter(s.characterId);
          return {
            name: c?.name ?? s.id,
            text: state.responses[s.id] ?? "",
          };
        });
        const prompt = isFinal
          ? buildModeratorMinutesPrompt(participantTexts)
          : buildModeratorPrompt(state.round, participantTexts);
        void runModeratorTurn(thread, moderatorSlot, prompt);
      }

      if (isFinal) {
        conferenceRef.current.delete(d.threadId);
      } else {
        // 次ラウンド発射：各 slot に「自分以外の最新発言」を渡す
        const nextRound = state.round + 1;
        conferenceRef.current.set(d.threadId, {
          round: nextRound,
          responses: Object.fromEntries(
            participantSlots.map((s) => [s.id, null as string | null]),
          ),
        });
        void runConferenceRoundNway(thread, state.responses);
      }
    }
  };

  /**
   * 会議モードで [合意] に至らずラウンド上限まで行ってしまった時に、
   * もう1ラウンドだけ議論を延長する。N-way対応：参加者全員に他のN-1人の発言を渡す。
   */
  const handleContinueConference = async (thread: Thread) => {
    if (!thread.conferenceMode || !isThreadParallel(thread)) return;
    const participantSlots = effectiveParticipants(thread).filter(
      (s) => s.role !== "moderator",
    );
    // 各 slot の最後の発言を集める
    const lastBySlot: Record<string, string> = {};
    for (const slot of participantSlots) {
      const last = [...thread.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "assistant" &&
            (m.participantSlotId === slot.id ||
              (!m.participantSlotId && m.provider === slot.provider)),
        );
      if (!last) return;
      lastBySlot[slot.id] = last.content;
    }

    // 既存ラウンド+1 を内部 state に登録
    const prevRound =
      Math.max(
        ...participantSlots.map((s) => {
          const last = [...thread.messages]
            .reverse()
            .find(
              (m) =>
                m.role === "assistant" && m.participantSlotId === s.id,
            );
          return last?.conferenceRound ?? 0;
        }),
      ) + 1;
    conferenceRef.current.set(thread.id, {
      round: prevRound,
      responses: Object.fromEntries(
        participantSlots.map((s) => [s.id, null as string | null]),
      ),
    });
    if (prevRound + 1 > thread.conferenceMaxRounds) {
      updateThread(thread.id, (t) => ({
        ...t,
        conferenceMaxRounds: prevRound + 1,
        updatedAt: Date.now(),
      }));
    }
    await runConferenceRoundNway(thread, lastBySlot);
  };

  /**
   * N-way 議論ラウンドを発射する。
   * 各 slot に「自分以外の参加者の発言」を渡してクロスレビューさせる。
   */
  const runConferenceRoundNway = async (
    thread: Thread,
    responses: Record<string, string | null>,
  ) => {
    const slots = effectiveParticipants(thread).filter(
      (s) => s.role !== "moderator",
    );
    const parallel = isThreadParallel(thread);
    const newDrafts = { ...draftsRef.current };
    const newStreaming = new Set(streamingSids);
    const sends: { sid: string; prompt: string; slot: ParticipantSlot }[] = [];

    for (const slot of slots) {
      const sid = makeSlotSid(thread.id, slot.id, parallel);
      const others = slots
        .filter((s) => s.id !== slot.id)
        .map((s) => {
          const c = getCharacter(s.characterId);
          return { name: c?.name ?? s.id, text: responses[s.id] ?? "" };
        });
      const prompt = buildConferencePromptNway(others);
      newDrafts[sid] = FRESH_DRAFT(thread.id, slot);
      newStreaming.add(sid);
      sends.push({ sid, prompt, slot });
    }
    draftsRef.current = newDrafts;
    setDrafts(newDrafts);
    setStreamingSids(newStreaming);

    for (const { sid, prompt, slot } of sends) {
      try {
        await ensureSlotSession(thread, slot);
        await agentSend(sid, prompt);
      } catch (err) {
        console.error("conference round send failed", err);
      }
    }
  };

  /**
   * 中立審判（moderator）に総括/議事録を依頼する。
   * 参加者のラウンドとは独立して動くサブセッション。
   */
  const runModeratorTurn = async (
    thread: Thread,
    moderator: ParticipantSlot,
    prompt: string,
  ) => {
    const parallel = isThreadParallel(thread);
    const sid = makeSlotSid(thread.id, moderator.id, parallel);
    const newDrafts = {
      ...draftsRef.current,
      [sid]: FRESH_DRAFT(thread.id, moderator),
    };
    draftsRef.current = newDrafts;
    setDrafts(newDrafts);
    setStreamingSids((prev) => new Set([...prev, sid]));
    try {
      await ensureSlotSession(thread, moderator);
      await agentSend(sid, prompt);
    } catch (err) {
      console.error("moderator turn send failed", err);
    }
  };

  // ----- thread / character actions -----

  const handleCreate = async () => {
    if (!isTauri()) {
      alert(
        "ローカル機能（ファイル編集・コマンド実行）を使うには npm run tauri:dev でデスクトップアプリ起動が必要です。",
      );
      return;
    }
    if (settings.authMode === "subscription") {
      const status = await claudeStatus();
      if (!status.installed || !status.logged_in) {
        alert("Claude のセットアップが未完了です。設定から進めてください。");
        setSettingsOpen(true);
        return;
      }
    } else {
      const key = await getApiKey();
      if (!key) {
        alert("API キーが未設定です。設定から登録してください。");
        setSettingsOpen(true);
        return;
      }
    }
    setPickerSplitMode(false);
    setPickerConferenceMode(false);
    setPickerSlot("primary");
    setPickerOpen(true);
  };

  /** 主ペインの右に新規スレッドを開く（Picker は split スロットに割り当てる）。 */
  const handleOpenSplitPane = () => {
    if (!isTauri()) {
      alert("ローカル機能を使うには Tauri デスクトップ起動が必要です。");
      return;
    }
    setPickerSplitMode(false);
    setPickerConferenceMode(false);
    setPickerSlot("split");
    setPickerOpen(true);
  };

  const handleCloseSplitPane = () => setSplitId(null);

  /**
   * チームテンプレートから新スレッドを作成する。
   * participants に複数キャラ＋（任意で）moderator が一気にセットされる。
   */
  const handleCreateFromTeam = async (teamId: string) => {
    if (!isTauri()) {
      alert(
        "ローカル機能（ファイル編集・コマンド実行）を使うには npm run tauri:dev でデスクトップアプリ起動が必要です。",
      );
      return;
    }
    const allTeams = [...loadUserTeams(), ...TEMPLATE_TEAMS];
    const team = allTeams.find((t) => t.id === teamId);
    if (!team) return;

    // チームに含まれる provider の認証チェック
    const usedProviders = new Set([
      ...team.participants.map((p) => p.provider),
      ...(team.moderator ? [team.moderator.provider] : []),
    ]);
    if (settings.authMode === "subscription") {
      const status = await claudeStatus();
      if (!status.installed || !status.logged_in) {
        alert("Claude のセットアップが未完了です。設定から進めてください。");
        setSettingsOpen(true);
        return;
      }
      if (usedProviders.has("codex")) {
        const cx = await codexStatus();
        if (!cx.installed || !cx.logged_in) {
          alert(
            "このチームには Codex も必要です。設定から Codex のインストール／ログインを完了してください。",
          );
          setSettingsOpen(true);
          return;
        }
      }
    } else {
      const key = await getApiKey();
      if (!key) {
        alert("API キーが未設定です。設定から登録してください。");
        setSettingsOpen(true);
        return;
      }
    }

    const ws = await defaultWorkspacePath();
    const cloned = cloneFromTemplateTeam(team);
    const participants = teamToParticipants(cloned);
    // 1人目を characterId のフォールバックに採用（旧UIで参照される）
    const lead = participants.find((p) => p.role !== "moderator") ?? participants[0];
    const t = createThread({
      characterId: lead?.characterId ?? "tmpl-claude-normal",
      workspace: ws,
      splitMode: true,
      conferenceMode: team.defaultConference,
    });
    const enriched = {
      ...t,
      participants,
      conferenceMaxRounds: team.defaultMaxRounds,
      title: team.name,
    };
    setThreads((prev) => [enriched, ...prev]);
    setActiveId(enriched.id);
    setMainView("chat");
  };

  /**
   * @param claudeOrSingleCharacterId 単独モード時のキャラID、または並列モード時の Claude 側キャラ ID
   * @param codexCharacterId 並列モード時の Codex 側キャラ ID（単独モードは null）
   */
  const startThreadWith = async (
    claudeOrSingleCharacterId: string,
    codexCharacterId: string | null,
    splitMode: boolean,
    conferenceMode: boolean,
    slot: PaneSlot,
  ) => {
    if (splitMode) {
      const cx = await codexStatus();
      if (!cx.installed || !cx.logged_in) {
        alert(
          "並列モードには Codex のセットアップも必要です。設定からインストール／ログインしてください。",
        );
        setSettingsOpen(true);
        return;
      }
    }
    const ws = await defaultWorkspacePath();
    const t = createThread({
      // 単独モードは Claude 側のキャラがそのまま単独キャラに。
      // 並列モードは Claude 側を main characterId に、別途 split マッピングも持つ。
      characterId: claudeOrSingleCharacterId,
      splitCharacterIds:
        splitMode && codexCharacterId
          ? { claude: claudeOrSingleCharacterId, codex: codexCharacterId }
          : undefined,
      workspace: ws,
      splitMode,
      conferenceMode: splitMode && conferenceMode,
    });
    setThreads((prev) => [t, ...prev]);
    if (slot === "split") {
      setSplitId(t.id);
    } else {
      setActiveId(t.id);
    }
  };

  const handlePickCharacter = async (characterId: string) => {
    setPickerOpen(false);
    await startThreadWith(
      characterId,
      null,
      pickerSplitMode,
      pickerConferenceMode,
      pickerSlot,
    );
  };

  const handlePickCharacterPair = async (
    claudeId: string,
    codexId: string,
  ) => {
    setPickerOpen(false);
    await startThreadWith(
      claudeId,
      codexId,
      pickerSplitMode,
      pickerConferenceMode,
      pickerSlot,
    );
  };

  const handleCreateNewCharacter = () => {
    setPickerOpen(false);
    setEditingCharacter(null);
    setEditorOpen(true);
  };

  const handleCloneTemplate = (tmpl: Character) => {
    setPickerOpen(false);
    setEditingCharacter(cloneFromTemplate(tmpl));
    setEditorOpen(true);
  };

  const handleSaveCharacter = async (c: Character) => {
    const userChars = loadUserCharacters();
    const next = userChars.find((x) => x.id === c.id)
      ? userChars.map((x) => (x.id === c.id ? c : x))
      : [...userChars, c];
    saveUserCharacters(next);
    setCharacterRevision((r) => r + 1);
    setEditorOpen(false);
    // ゼロから作るフローは単独モード扱い（並列モード時は CharacterPickerModal 内で
    // ゼロから作るボタンを隠してあるので、ここに来るのは単独モードのみ）
    await startThreadWith(
      c.id,
      null,
      pickerSplitMode,
      pickerConferenceMode,
      pickerSlot,
    );
  };

  const handleDelete = async (id: string) => {
    // 全sidをstop
    const t = threads.find((x) => x.id === id);
    if (t) {
      const slots = effectiveParticipants(t);
      const parallel = slots.length >= 2;
      if (parallel) {
        for (const slot of slots) {
          const sid = makeSlotSid(id, slot.id, parallel);
          await agentStop(sid).catch(() => {});
          sessionsStartedRef.current.delete(sid);
        }
      } else {
        await agentStop(id).catch(() => {});
        sessionsStartedRef.current.delete(id);
      }
    }
    setThreads((prev) => prev.filter((tt) => tt.id !== id));
    if (splitId === id) setSplitId(null);
    if (activeId === id) {
      const remaining = threads.filter((tt) => tt.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
  };

  const handleChangeCharacter = async (characterId: string) => {
    if (!activeThread) return;
    const newChar = getCharacter(characterId);
    // 既存セッションを止めて、次の send で新しい systemPrompt が反映されるようにする
    const slots = effectiveParticipants(activeThread);
    const parallel = slots.length >= 2;
    if (parallel) {
      await Promise.all(
        slots.map((slot) => {
          const sid = makeSlotSid(activeThread.id, slot.id, parallel);
          sessionsStartedRef.current.delete(sid);
          return agentStop(sid).catch(() => {});
        }),
      );
    } else {
      await agentStop(activeThread.id).catch(() => {});
      sessionsStartedRef.current.delete(activeThread.id);
    }
    updateThread(activeThread.id, (t) => ({
      ...t,
      characterId,
      model: newChar?.defaultModel ?? t.model,
      updatedAt: Date.now(),
    }));
  };

  /**
   * 並列モード時、片側だけキャラを差し替える。
   * 旧2way（splitCharacterIds）でも N-way（participants）でも動く統一エントリ。
   *
   * @param slotIdOrProvider participants がある場合は slotId、ない場合は "claude"/"codex"（旧2way互換）
   */
  const handleChangeSplitCharacter = async (
    slotIdOrProvider: string,
    characterId: string,
  ) => {
    if (!activeThread) return;
    const slots = effectiveParticipants(activeThread);
    const parallel = slots.length >= 2;
    const sid = makeSlotSid(activeThread.id, slotIdOrProvider, parallel);
    await agentStop(sid).catch(() => {});
    sessionsStartedRef.current.delete(sid);
    const newChar = getCharacter(characterId);

    updateThread(activeThread.id, (t) => {
      // participants がある場合はそちらを更新
      if (t.participants && t.participants.length > 0) {
        const updated = updateParticipant(t, slotIdOrProvider, { characterId });
        // Claude 側のキャラ変更時のみ thread.model 追従
        const targetSlot = t.participants.find(
          (p) => p.id === slotIdOrProvider,
        );
        if (targetSlot?.provider === "claude" && newChar?.defaultModel) {
          return { ...updated, model: newChar.defaultModel };
        }
        return updated;
      }
      // 旧2way構造：provider名がslotIdとして渡ってきている前提
      const provider = slotIdOrProvider as Provider;
      const prev = t.splitCharacterIds ?? {
        claude: t.characterId,
        codex: t.characterId,
      };
      return {
        ...t,
        splitCharacterIds: { ...prev, [provider]: characterId },
        ...(provider === "claude" && newChar?.defaultModel
          ? { model: newChar.defaultModel }
          : {}),
        updatedAt: Date.now(),
      };
    });
  };

  /** 参加者を追加する（N-way拡張）。 */
  const handleAddParticipant = async (slot: Omit<ParticipantSlot, "id">) => {
    if (!activeThread) return;
    // 既存セッションは生かしておいて新規 slot だけ起動。
    updateThread(activeThread.id, (t) => addParticipant(t, slot));
  };

  /**
   * 現在のスレッドの participants 構成を JSON でクリップボードにコピーする。
   * 共有された JSON は「ファイル」メニュー →「JSONからチームをインポート…」で取り込める。
   */
  const handleExportTeamJson = async () => {
    if (!activeThread) return;
    const slots = effectiveParticipants(activeThread);
    const participantSlots = slots.filter((s) => s.role !== "moderator");
    const moderatorSlot = slots.find((s) => s.role === "moderator");
    const team = {
      id: "tmp",
      name: activeThread.title || "（無題チーム）",
      description: "",
      emoji: "✨",
      defaultConference: activeThread.conferenceMode,
      defaultMaxRounds: activeThread.conferenceMaxRounds,
      participants: participantSlots,
      moderator: moderatorSlot,
      defaultModel: activeThread.model,
      isTemplate: false,
      createdAt: 0,
      updatedAt: 0,
    };
    const json = exportTeamToJson(team);
    try {
      await navigator.clipboard.writeText(json);
      alert(
        "チームJSONをクリップボードにコピーしました。\n他のUNICREWユーザーに共有すると「JSONからチームをインポート…」で取り込めます。",
      );
    } catch {
      // フォールバック：プロンプトでJSONを表示
      window.prompt(
        "クリップボードにコピーできませんでした。下記JSONを手動でコピーしてください：",
        json,
      );
    }
  };

  /**
   * JSON 文字列からチームをインポートする。
   * 取り込み後はファイルメニューに即時反映。
   */
  const handleImportTeamJson = () => {
    const json = window.prompt(
      "共有されたチームJSONを貼り付けてください：",
      "",
    );
    if (!json) return;
    try {
      const team = importTeamFromJson(json);
      const existing = loadUserTeams();
      saveUserTeams([team, ...existing]);
      alert(
        `チーム「${team.emoji} ${team.name}」をインポートしました。\nファイルメニューから新しい会話を開始できます。`,
      );
    } catch (e) {
      alert(
        `インポートに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  /**
   * 現在のスレッドの participants 構成をユーザーチームとして保存する。
   * 「ファイル」メニューに即時反映される。
   */
  const handleSaveAsTeam = (meta: {
    name: string;
    description: string;
    emoji: string;
  }) => {
    if (!activeThread) return;
    const slots = effectiveParticipants(activeThread);
    const participantSlots = slots.filter((s) => s.role !== "moderator");
    const moderatorSlot = slots.find((s) => s.role === "moderator");
    const now = Date.now();
    const newTeam = {
      id: newTeamId(),
      name: meta.name,
      description: meta.description,
      emoji: meta.emoji || "✨",
      defaultConference: activeThread.conferenceMode,
      defaultMaxRounds: activeThread.conferenceMaxRounds,
      participants: participantSlots,
      moderator: moderatorSlot,
      defaultModel: activeThread.model,
      isTemplate: false,
      createdAt: now,
      updatedAt: now,
    };
    const existing = loadUserTeams();
    saveUserTeams([newTeam, ...existing]);
  };

  /** 参加者を削除する。 */
  const handleRemoveParticipant = async (slotId: string) => {
    if (!activeThread) return;
    const sid = makeSlotSid(
      activeThread.id,
      slotId,
      isThreadParallel(activeThread),
    );
    await agentStop(sid).catch(() => {});
    sessionsStartedRef.current.delete(sid);
    updateThread(activeThread.id, (t) => removeParticipant(t, slotId));
  };

  const handleChangeModel = (model: ModelId) => {
    if (!activeThread) return;
    updateThread(activeThread.id, (t) => ({ ...t, model, updatedAt: Date.now() }));
  };

  const handleChangeWorkspace = async () => {
    if (!activeThread) return;
    const ws = await pickWorkspace();
    if (!ws) return;
    const slots = effectiveParticipants(activeThread);
    const parallel = slots.length >= 2;
    if (parallel) {
      await Promise.all(
        slots.map((slot) => {
          const sid = makeSlotSid(activeThread.id, slot.id, parallel);
          sessionsStartedRef.current.delete(sid);
          return agentStop(sid).catch(() => {});
        }),
      );
    } else {
      await agentStop(activeThread.id);
      sessionsStartedRef.current.delete(activeThread.id);
    }
    updateThread(activeThread.id, (t) => ({
      ...t,
      workspace: ws,
      updatedAt: Date.now(),
    }));
  };

  /**
   * slot 単位で subprocess セッションを起動する。
   *
   * 同じproviderが複数いるN-wayケースでも、slotIdをsessionIdに混ぜているので衝突しない。
   * moderator slot は systemPrompt を中立審判用に上書きする。
   */
  const ensureSlotSession = async (thread: Thread, slot: ParticipantSlot) => {
    const parallel = isThreadParallel(thread);
    const sid = makeSlotSid(thread.id, slot.id, parallel);
    if (sessionsStartedRef.current.has(sid)) return;
    const character = getCharacter(slot.characterId);
    const apiKey = settings.authMode === "apikey" ? await getApiKey() : null;
    const baseSystem =
      slot.role === "moderator"
        ? `あなたは AI 議論の中立審判です。
- どの参加者の肩も持たず、第三者として論理性・実現可能性・コストの3軸で評価する
- 返答は常に指示されたJSONフォーマット **のみ** で返す（前置き・コードフェンス・説明文は禁止）
- 数字（合意度0-100）は厳密に判定し、安易に高得点を出さない`
        : character?.systemPrompt ?? "";
    const effectivePrompt = buildEffectiveSystemPrompt(
      baseSystem,
      slot.role === "moderator" ? null : character?.personalityId ?? null,
      slot.role === "moderator" ? false : settings.beginnerMode ?? true,
    );
    await agentStart({
      sessionId: sid,
      workspace: thread.workspace,
      systemPrompt: effectivePrompt,
      model: thread.model,
      authMode: settings.authMode,
      apiKey,
      provider: slot.provider,
    });
    sessionsStartedRef.current.add(sid);
  };

  /**
   * メッセージ内のコマンドを「UNICREW で実行」する。
   * AI に対して「直前のコマンドを Bash ツールで実行してください」と再投げする。
   * systemPrompt の UNICREW_RUNTIME_RULES と組み合わせて、
   * AI が自分で実行→結果を会話に注入してくれる挙動になる。
   */
  /**
   * アイデア10: エラー文言を AI に渡して原因診断・修復案を出してもらう。
   * 別 subprocess を立てるフル実装は将来。最小実装として、現スレッドに
   * 「このエラーを直してほしい」プロンプトを送り直す。
   */
  const handleSosForError = async (errorText: string, thread: Thread) => {
    const text = `🆘 直前のエラーを助けてほしいです。

\`\`\`
${errorText}
\`\`\`

以下を順に実施してください：
1. **エラーの根本原因**を、技術用語を最低限にして説明（初心者向け）
2. **再発防止策**を1〜2行で
3. **今すぐ実行できる修復手順**を、コマンドや設定変更まで含めて step-by-step で
4. 自動修復が可能なものは Bash ツールで実行してから報告（破壊的なものは確認してから）`;
    await handleSendForThread(text, thread);
  };

  const handleExecuteCommand = (
    command: string,
    lang: string,
    thread: Thread,
  ) => {
    const text = `▶️ 上のコマンドを UNICREW で実行してください。

\`\`\`${lang}
${command}
\`\`\`

このコマンドをあなた自身が Bash ツールで実行し、出力を要約して報告してください。エラーが出たら原因と次の一手も教えてください。`;
    void handleSendForThread(text, thread);
  };

  const handleSendForThread = async (text: string, thread: Thread) => {
    const allSlots = effectiveParticipants(thread);
    const participantSlots = allSlots.filter((s) => s.role !== "moderator");
    // moderator は初回ターンには発火させない（各ラウンド完了後に総括する）
    const slots = participantSlots;
    const parallel = isThreadParallel(thread);

    // 会議モード：新しいユーザー発言が来たら、進行中の議論ラウンド状態をリセット
    if (thread.conferenceMode) {
      conferenceRef.current.set(thread.id, {
        round: 0,
        responses: Object.fromEntries(
          slots.map((s) => [s.id, null as string | null]),
        ),
      });
    }

    const userMsg = {
      id: nanoid(8),
      role: "user" as const,
      content: text,
      createdAt: Date.now(),
    };
    const next = appendMessage(thread, userMsg);
    updateThread(thread.id, () => next);

    // 各 slot で draft 初期化＋送信
    const newDrafts = { ...draftsRef.current };
    const newStreaming = new Set(streamingSids);
    for (const slot of slots) {
      const sid = makeSlotSid(thread.id, slot.id, parallel);
      newDrafts[sid] = FRESH_DRAFT(thread.id, slot);
      newStreaming.add(sid);
    }
    draftsRef.current = newDrafts;
    setDrafts(newDrafts);
    setStreamingSids(newStreaming);

    for (const slot of slots) {
      const sid = makeSlotSid(thread.id, slot.id, parallel);
      try {
        await ensureSlotSession(thread, slot);
        await agentSend(sid, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errMsg = {
          id: nanoid(8),
          role: "assistant" as const,
          content: `**起動エラー (${slot.provider})**: ${message}\n\n設定から認証状態を確認してください。`,
          createdAt: Date.now(),
          provider: slot.provider,
          participantSlotId: slot.id,
        };
        updateThread(thread.id, (t) => appendMessage(t, errMsg));
        const cleared = { ...draftsRef.current };
        delete cleared[sid];
        draftsRef.current = cleared;
        setDrafts(cleared);
        setStreamingSids((prev) => {
          const n = new Set(prev);
          n.delete(sid);
          return n;
        });
      }
    }
  };

  const handleAbortForThread = async (thread: Thread) => {
    // UI は楽観的に即時 finalize（agentStop の await でハングする可能性に備える）。
    // Rust 側で hard kill するので、awaitせず投げっぱなしでも安全。
    const slots = effectiveParticipants(thread);
    const parallel = isThreadParallel(thread);
    if (parallel) {
      for (const slot of slots) {
        const sid = makeSlotSid(thread.id, slot.id, parallel);
        finalizeDraft(sid);
        sessionsStartedRef.current.delete(sid);
        void agentStop(sid).catch(() => {});
      }
    } else {
      finalizeDraft(thread.id);
      sessionsStartedRef.current.delete(thread.id);
      void agentStop(thread.id).catch(() => {});
    }
  };

  /** 全スレッドのストリーミングを止める（Ctrl+Shift+C ショートカット用）。 */
  const handleAbortAll = () => {
    for (const sid of streamingSids) {
      finalizeDraft(sid);
      sessionsStartedRef.current.delete(sid);
      void agentStop(sid).catch(() => {});
    }
  };

  const handlePermissionDecision = async (
    decision: "allow" | "deny" | "allow_once",
  ) => {
    if (!pendingPermission) return;
    await agentPermissionResponse(
      pendingPermission.sessionId,
      pendingPermission.requestId,
      decision,
    );
    setPendingPermission(null);
  };

  // ペイン単位で drafts と isStreaming を計算する（slotIdキー）
  const buildThreadDrafts = (
    thread: Thread | null,
  ): Record<string, ActiveDraft | null> => {
    const r: Record<string, ActiveDraft | null> = {};
    if (!thread) return r;
    const slots = effectiveParticipants(thread);
    const parallel = slots.length >= 2;
    for (const slot of slots) {
      const sid = makeSlotSid(thread.id, slot.id, parallel);
      r[slot.id] = drafts[sid] ?? null;
    }
    if (!parallel) {
      // 単独モード時は thread.id がそのまま sid なので拾い直す
      const single = drafts[thread.id] ?? null;
      if (single) r[single.slotId] = single;
    }
    return r;
  };

  const isThreadStreaming = (thread: Thread | null): boolean => {
    if (!thread) return false;
    const slots = effectiveParticipants(thread);
    const parallel = slots.length >= 2;
    return slots.some((s) =>
      streamingSids.has(makeSlotSid(thread.id, s.id, parallel)),
    );
  };

  const splitThread = threads.find((t) => t.id === splitId) ?? null;

  const primaryDrafts = buildThreadDrafts(activeThread);
  const splitDrafts = buildThreadDrafts(splitThread);
  const primaryStreaming = isThreadStreaming(activeThread);
  const splitStreaming = isThreadStreaming(splitThread);

  // Sidebar 用：ストリーミング中のスレッド ID 集合
  const streamingThreadIds = new Set<string>();
  for (const sid of streamingSids) {
    const idx = sid.lastIndexOf("::");
    streamingThreadIds.add(idx === -1 ? sid : sid.slice(0, idx));
  }

  const handleSidebarSelect = (
    id: string,
    mods?: { intoSplit?: boolean },
  ) => {
    if (mods?.intoSplit) {
      // 主ペインと同じスレッドを並列ペインに開いても意味がないので無視
      if (id === activeId) return;
      setSplitId(id);
      return;
    }
    // 主ペインに開く時、それが現在 split として表示中なら split を閉じる
    if (id === splitId) setSplitId(null);
    setActiveId(id);
  };

  const showSplit = splitThread !== null;
  const isEmpty = threads.length === 0;

  // ESC ショートカット用に最新値を ref に流し込む
  abortContextRef.current = {
    primaryThread: activeThread,
    splitThread,
    primaryStreaming,
    splitStreaming,
    abortThread: handleAbortForThread,
    abortAll: handleAbortAll,
  };
  // モバイルA案: 状態 ref と /api/mobile/state push（render毎に最新化）
  activeIdRef.current = activeId;
  // クラウドリレーは別の useEffect 内 setInterval で heartbeat する（subscribe 非同期対応）
  if (typeof window !== "undefined" && hydrated && mobileBridgeReady) {
    const token = localStorage.getItem(MOBILE_TOKEN_LS_KEY);
    if (token) {
      const lastAssistant = activeThread
        ? [...activeThread.messages]
            .reverse()
            .find((m) => m.role === "assistant")
        : null;
      const snap: MobileStateSnapshot = {
        updatedAt: Date.now(),
        activeThreadId: activeThread?.id ?? null,
        activeThreadTitle: activeThread?.title ?? null,
        threads: threads
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 15)
          .map((t) => ({
            id: t.id,
            title: t.title,
            updatedAt: t.updatedAt,
          })),
        lastAssistantPreview: lastAssistant?.content?.slice(0, 2000) ?? null,
        isStreaming: primaryStreaming,
      };
      // 連投を抑えるため簡易 throttle（1秒以内の連続呼び出しは無視）
      const last = (window as unknown as { __unicrew_mobile_last?: number })
        .__unicrew_mobile_last;
      if (!last || Date.now() - last > 1000) {
        (window as unknown as { __unicrew_mobile_last?: number })
          .__unicrew_mobile_last = Date.now();
        void fetch(`/api/mobile/state?t=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snap),
        }).catch(() => {});
      }
    }
  }
  const menuDefs: MenuDef[] = [
    {
      id: "file",
      label: "ファイル",
      items: [
        {
          label: "新しい会話",
          shortcut: "Ctrl+N",
          onSelect: () => {
            setMainView("chat");
            handleCreate();
          },
        },
        {
          label: "ワークスペースを開く…",
          onSelect: () => {
            void handleChangeWorkspace();
          },
        },
        { divider: true },
        // チームスナップ：登録済みチーム + プリセットを並べる
        ...[...loadUserTeams(), ...TEMPLATE_TEAMS].map((team) => ({
          label: `${team.emoji} ${team.name}`,
          onSelect: () => {
            setMainView("chat");
            void handleCreateFromTeam(team.id);
          },
        })),
        { divider: true },
        {
          label: "JSONからチームをインポート…",
          onSelect: () => handleImportTeamJson(),
        },
        { divider: true },
        {
          label: "🔌 UNI 製品 MCP 一括接続…",
          onSelect: () => setUniMcpOpen(true),
        },
        {
          label: "📅 ルーティーン（毎日定期実行）…",
          onSelect: () => setRoutinesOpen(true),
        },
        {
          label: "📱 スマホ連携（リモコン）…",
          onSelect: () => setMobileOpen(true),
        },
        { divider: true },
        {
          label: "設定…",
          shortcut: "Ctrl+,",
          onSelect: () => setSettingsOpen(true),
        },
      ],
    },
    {
      id: "edit",
      label: "編集",
      items: [
        {
          label: "コピー",
          shortcut: "Ctrl+C",
          onSelect: () => document.execCommand("copy"),
        },
        {
          label: "貼り付け",
          shortcut: "Ctrl+V",
          onSelect: () => document.execCommand("paste"),
        },
        {
          label: "すべて選択",
          shortcut: "Ctrl+A",
          onSelect: () => document.execCommand("selectAll"),
        },
      ],
    },
    {
      id: "view",
      label: "表示",
      items: [
        {
          label: mainView === "chat" ? "会話表示（現在）" : "会話表示に切替",
          onSelect: () => setMainView("chat"),
        },
        {
          label:
            mainView === "addons" ? "機能の追加（現在）" : "機能の追加を開く",
          onSelect: () => setMainView("addons"),
        },
        { divider: true },
        {
          label: settings.beginnerMode
            ? "初心者モード ON（クリックで OFF）"
            : "初心者モード OFF（クリックで ON）",
          onSelect: () => {
            const next = !(settings.beginnerMode ?? true);
            const updated = {
              ...settings,
              beginnerMode: next,
              showActivity: next ? false : settings.showActivity,
            };
            setSettings(updated);
            saveSettings(updated);
          },
        },
      ],
    },
    {
      id: "window",
      label: "ウィンドウ",
      items: [
        {
          label: splitId
            ? "並列ペインを閉じる"
            : "右側に並列ペインを開く",
          onSelect: () => {
            if (splitId) handleCloseSplitPane();
            else handleOpenSplitPane();
          },
        },
        {
          label: taskQueueOpen
            ? "タスクキューを隠す"
            : "タスクキューを表示",
          onSelect: () => setTaskQueueOpen((v) => !v),
        },
        { divider: true },
        {
          label: "全スレッドを停止",
          shortcut: "Ctrl+Shift+C",
          onSelect: () => handleAbortAll(),
        },
      ],
    },
    {
      id: "help",
      label: "ヘルプ",
      items: [
        {
          label: "フィードバックを送る…",
          onSelect: () => {
            setFeedbackVisible(true);
            markFeedbackShown();
            setMainView("chat");
          },
        },
        { divider: true },
        {
          label: "GitHub リポジトリを開く",
          onSelect: () =>
            window.open(
              "https://github.com/takayukiyukii-commits/unicrew",
              "_blank",
            ),
        },
        {
          label: "問題を報告（Issues）",
          onSelect: () =>
            window.open(
              "https://github.com/takayukiyukii-commits/unicrew/issues",
              "_blank",
            ),
        },
        { divider: true },
        {
          label: "バージョン情報",
          onSelect: () => {
            alert(
              "UNICREW v0.1.0\nあなた専属のAIチームを、5分で。\n\nClaude / Codex / スキル / MCP をターミナルなしで使える AI デスクトップ。\n\n© 2026 ZUBOLAND / uniLinks",
            );
          },
        },
      ],
    },
  ];

  return (
    <ActivityVisibilityContext.Provider value={settings.showActivity}>
      <div className="h-screen w-screen flex flex-col bg-white overflow-hidden">
        <AppMenuBar menus={menuDefs} />
        <div className="flex-1 min-h-0 flex">
        <Sidebar
          threads={threads}
          activeThreadId={activeId}
          splitThreadId={splitId}
          streamingThreadIds={streamingThreadIds}
          onSelect={(id, mods) => {
            setMainView("chat");
            handleSidebarSelect(id, mods);
          }}
          onCreate={() => {
            setMainView("chat");
            handleCreate();
          }}
          onDelete={handleDelete}
          onOpenSettings={() => setSettingsOpen(true)}
          mainView={mainView}
          onOpenAddons={() => setMainView("addons")}
        />
        {mainView === "addons" ? (
          <main className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-white">
            <div className="max-w-5xl mx-auto px-6 py-8">
              <header className="mb-6">
                <h1 className="text-[22px] font-bold tracking-tight">
                  機能の追加
                </h1>
                <p className="text-[13px] text-[var(--color-muted)] mt-1 leading-relaxed">
                  Claude / Codex のプラグイン・スキル・MCP を一覧して、1クリックで追加できます。
                  <br />
                  ローカルにある実物（installed_plugins.json / ~/.claude/skills/ / ~/.codex/config.toml）と marketplace 全件を表示します。
                </p>
              </header>
              <AddonsSection
                workspace={activeThread?.workspace ?? null}
                advancedMode={settings.advancedMode ?? false}
                onAdvancedModeChange={(next) => {
                  const updated = { ...settings, advancedMode: next };
                  setSettings(updated);
                  saveSettings(updated);
                }}
              />
            </div>
          </main>
        ) : isEmpty ? (
          <WelcomeLanding
            onCreate={handleCreate}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <div ref={paneAreaRef} className="flex-1 flex min-w-0 min-h-0">
            <div
              className="flex flex-col min-w-0 min-h-0"
              style={
                showSplit
                  ? { flex: `0 0 calc(${splitWidthPct}% - 2px)` }
                  : { flex: 1 }
              }
            >
              <ChatPane
                thread={activeThread}
                paneRole={showSplit ? "primary" : "single"}
                isStreaming={primaryStreaming}
                threadDrafts={primaryDrafts}
                onSend={(text) =>
                  activeThread && handleSendForThread(text, activeThread)
                }
                onAbort={() =>
                  activeThread && handleAbortForThread(activeThread)
                }
                onSplit={handleOpenSplitPane}
                onContinueConference={
                  activeThread
                    ? () => handleContinueConference(activeThread)
                    : undefined
                }
                onExecuteCommand={
                  activeThread
                    ? (cmd, lang) =>
                        handleExecuteCommand(cmd, lang, activeThread)
                    : undefined
                }
                onSosForError={
                  activeThread
                    ? (err) => handleSosForError(err, activeThread)
                    : undefined
                }
                feedbackSlot={
                  feedbackVisible ? (
                    <FeedbackCard
                      appVersion="0.1.0"
                      userMessageCount={userMsgCount}
                      onClose={() => setFeedbackVisible(false)}
                    />
                  ) : null
                }
              />
              {taskQueueOpen && activeThread && (
                <TaskQueuePanel
                  threadId={activeThread.id}
                  isStreaming={primaryStreaming}
                  onRunTask={(text) => handleSendForThread(text, activeThread)}
                  lastAssistantText={
                    [...activeThread.messages]
                      .reverse()
                      .find((m) => m.role === "assistant")?.content ?? null
                  }
                  onClose={() => setTaskQueueOpen(false)}
                />
              )}
            </div>
            {splitThread && (
              <>
                <PaneResizer
                  widthPct={splitWidthPct}
                  onChange={setSplitWidthPct}
                  containerRef={paneAreaRef}
                />
                <div className="flex flex-col min-w-0 min-h-0 flex-1">
                  <ChatPane
                    thread={splitThread}
                    paneRole="split"
                    isStreaming={splitStreaming}
                    threadDrafts={splitDrafts}
                    onSend={(text) =>
                      handleSendForThread(text, splitThread)
                    }
                    onAbort={() => handleAbortForThread(splitThread)}
                    onCloseSplit={handleCloseSplitPane}
                    onContinueConference={() =>
                      handleContinueConference(splitThread)
                    }
                    onExecuteCommand={(cmd, lang) =>
                      handleExecuteCommand(cmd, lang, splitThread)
                    }
                    onSosForError={(err) =>
                      handleSosForError(err, splitThread)
                    }
                  />
                </div>
              </>
            )}
          </div>
        )}
        {mainView === "chat" && (
          <RightPane
            thread={activeThread}
            onChangeCharacter={handleChangeCharacter}
            onChangeSplitCharacter={handleChangeSplitCharacter}
            onAddParticipant={handleAddParticipant}
            onRemoveParticipant={handleRemoveParticipant}
            onSaveAsTeam={handleSaveAsTeam}
            onExportTeamJson={handleExportTeamJson}
            onChangeModel={handleChangeModel}
            onChangeWorkspace={handleChangeWorkspace}
          />
        )}
        </div>
      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(s) => {
          setSettings(s);
          saveSettings(s);
        }}
        onCharactersChanged={() => setCharacterRevision((r) => r + 1)}
      />
      <UniMcpModal open={uniMcpOpen} onClose={() => setUniMcpOpen(false)} />
      <RoutinesModal
        open={routinesOpen}
        threads={threads}
        onRunNow={(threadId, prompt) => {
          const t = threads.find((x) => x.id === threadId);
          if (t) void handleSendForThread(prompt, t);
        }}
        onClose={() => setRoutinesOpen(false)}
      />
      <MobileBridgeModal
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        cloudPairCode={cloudPairCode}
        onStartCloudPairing={startCloudPairing}
        onStopCloudPairing={stopCloudPairing}
      />
      {graphifyStatus && (
        <div
          className={`fixed bottom-4 right-4 z-50 rounded-lg shadow-lg px-3 py-2 text-[12px] flex items-center gap-2 ${
            graphifyStatus.state === "updating"
              ? "bg-sky-50 border border-sky-200 text-sky-800"
              : graphifyStatus.state === "done"
              ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
              : "bg-red-50 border border-red-200 text-red-700"
          }`}
        >
          <span className="font-semibold">
            {graphifyStatus.state === "updating"
              ? "🌐 ナレッジ更新中…"
              : graphifyStatus.state === "done"
              ? "✓ ナレッジ更新完了"
              : "⚠ graphify 失敗"}
          </span>
          {graphifyStatus.message && (
            <span className="text-[10.5px] opacity-80 truncate max-w-[300px]">
              {graphifyStatus.message}
            </span>
          )}
        </div>
      )}
      <CharacterPickerModal
        key={`picker-${characterRevision}`}
        open={pickerOpen}
        splitMode={pickerSplitMode}
        onSplitModeChange={setPickerSplitMode}
        conferenceMode={pickerConferenceMode}
        onConferenceModeChange={setPickerConferenceMode}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickCharacter}
        onPickPair={handlePickCharacterPair}
        onCreateNew={handleCreateNewCharacter}
        onCloneTemplate={handleCloneTemplate}
      />
      <CharacterEditModal
        open={editorOpen}
        initial={editingCharacter}
        onClose={() => setEditorOpen(false)}
        onSave={handleSaveCharacter}
      />
      <PermissionPromptModal
        pending={pendingPermission}
        onDecide={handlePermissionDecision}
      />
      </div>
    </ActivityVisibilityContext.Provider>
  );
}
