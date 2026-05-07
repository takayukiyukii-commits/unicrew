"use client";

import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { Sidebar, type MainView } from "@/components/Sidebar";
import { AddonsSection } from "@/components/AddonsSection";
import { AppMenuBar, type MenuDef } from "@/components/AppMenuBar";
import { ChatPane } from "@/components/ChatPane";
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
  isTauri,
  listenAgentEvents,
  pickWorkspace,
  type AgentEvent,
} from "@/lib/tauri";
import {
  characterIdFor,
  cloneFromTemplate,
  getCharacter,
  loadUserCharacters,
  saveUserCharacters,
} from "@/lib/characters";
import { buildEffectiveSystemPrompt } from "@/lib/personalities";
import type {
  AppSettings,
  Block,
  Character,
  ModelId,
  PendingPermission,
  Provider,
  TextBlock,
  Thread,
  ToolUseBlock,
} from "@/lib/types";

interface ActiveDraft {
  threadId: string;
  provider: Provider;
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
  provider: Provider,
): ActiveDraft => ({
  threadId,
  provider,
  blocks: [],
  toolMap: new Map(),
  startedAt: Date.now(),
  firstTextAt: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

function makeSid(threadId: string, provider: Provider, split: boolean): string {
  return split ? `${threadId}::${provider}` : threadId;
}

function parseSid(
  sid: string,
  threadById: Map<string, Thread>,
): { thread: Thread | null; provider: Provider } {
  const idx = sid.lastIndexOf("::");
  if (idx === -1) {
    const t = threadById.get(sid) ?? null;
    return { thread: t, provider: t ? characterProvider(t) : "claude" };
  }
  const tid = sid.slice(0, idx);
  return {
    thread: threadById.get(tid) ?? null,
    provider: sid.slice(idx + 2) as Provider,
  };
}

function characterProvider(thread: Thread): Provider {
  return getCharacter(thread.characterId)?.provider ?? "claude";
}

function buildConferencePrompt(otherText: string, otherName: string): string {
  return `# 会議モード（議論ラウンド）
別のAI「${otherName}」は次のように回答しました：

---
${otherText}
---

これを踏まえて、あなたの立場で：
1. 良い点を1〜2行で評価
2. 改善・補足できる点があれば具体的に提示
3. 統合的な改善案を簡潔に提示

完全に同意してそれ以上改善する必要がないと判断した場合は、回答の冒頭に「[合意]」と書いてください。`;
}

type PaneSlot = "primary" | "split";

export default function Page() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 並列ペイン（主ペインの右）に表示するスレッドID。null なら単一ペイン。 */
  const [splitId, setSplitId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>({
    defaultCharacterId: "tmpl-secretary",
    authMode: "subscription",
    showActivity: true,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSplitMode, setPickerSplitMode] = useState(false);
  const [pickerConferenceMode, setPickerConferenceMode] = useState(false);
  /** Picker で作る新スレッドをどのペインに割り当てるか。 */
  const [pickerSlot, setPickerSlot] = useState<PaneSlot>("primary");
  /** 並列ペイン時の左側の幅（%）。ドラッグで変更可。 */
  const [splitWidthPct, setSplitWidthPct] = useState<number>(50);
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [characterRevision, setCharacterRevision] = useState(0);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  /** session_id -> ActiveDraft（split時は2つ、single時は1つ） */
  const [drafts, setDrafts] = useState<Record<string, ActiveDraft>>({});
  const [streamingSids, setStreamingSids] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  const sessionsStartedRef = useRef<Set<string>>(new Set());
  const paneAreaRef = useRef<HTMLDivElement>(null);
  const draftsRef = useRef<Record<string, ActiveDraft>>({});
  draftsRef.current = drafts;
  const threadsRef = useRef<Thread[]>([]);
  threadsRef.current = threads;
  /** 会議モード進行状態（threadId → state）。両AIの最新応答テキストとラウンドを保持。 */
  const conferenceRef = useRef<
    Map<
      string,
      { round: number; claudeText: string | null; codexText: string | null }
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
    const { thread, provider } = parseSid(sid, threadById);
    if (!thread) return;

    // Ensure draft exists for this sid
    if (!draftsRef.current[sid]) {
      const fresh = FRESH_DRAFT(thread.id, provider);
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

    // Conference mode: track round completion and trigger next round if needed
    if (thread?.conferenceMode && thread.splitMode) {
      const state = conferenceRef.current.get(d.threadId) ?? {
        round: 0,
        claudeText: null,
        codexText: null,
      };
      if (d.provider === "claude") state.claudeText = finalText;
      else state.codexText = finalText;
      conferenceRef.current.set(d.threadId, state);

      // 両プロバイダ完了？
      if (state.claudeText !== null && state.codexText !== null) {
        const claudeAgreed = state.claudeText.startsWith("[合意]");
        const codexAgreed = state.codexText.startsWith("[合意]");
        const reachedMax = state.round + 1 >= thread.conferenceMaxRounds;
        if ((claudeAgreed && codexAgreed) || reachedMax) {
          conferenceRef.current.delete(d.threadId);
        } else {
          // 次ラウンドを発射
          const nextRound = state.round + 1;
          conferenceRef.current.set(d.threadId, {
            round: nextRound,
            claudeText: null,
            codexText: null,
          });
          // 各AIへ「相手の発言をどう評価するか」を送る
          const claudeNext = buildConferencePrompt(state.codexText, "Codex");
          const codexNext = buildConferencePrompt(state.claudeText, "Claude");
          void runConferenceRound(thread, claudeNext, codexNext);
        }
      }
    }
  };

  /**
   * 会議モードで [合意] に至らずラウンド上限まで行ってしまった時に、
   * もう1ラウンドだけ議論を延長する。両AIに「相手の最後の発言」を渡して再考させる。
   */
  const handleContinueConference = async (thread: Thread) => {
    if (!thread.conferenceMode || !thread.splitMode) return;
    const lastClaude = [...thread.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.provider === "claude");
    const lastCodex = [...thread.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.provider === "codex");
    if (!lastClaude || !lastCodex) return;

    // 既存ラウンド+1 を内部 state に登録（次の finalize でカウントが進む）
    const prevRound =
      Math.max(
        lastClaude.conferenceRound ?? 0,
        lastCodex.conferenceRound ?? 0,
      ) + 1;
    conferenceRef.current.set(thread.id, {
      round: prevRound,
      claudeText: null,
      codexText: null,
    });
    // maxRounds も合わせて引き上げる（次回さらに延長したい場合に備える）
    if (prevRound + 1 > thread.conferenceMaxRounds) {
      updateThread(thread.id, (t) => ({
        ...t,
        conferenceMaxRounds: prevRound + 1,
        updatedAt: Date.now(),
      }));
    }
    const claudeNext = buildConferencePrompt(lastCodex.content, "Codex");
    const codexNext = buildConferencePrompt(lastClaude.content, "Claude");
    await runConferenceRound(thread, claudeNext, codexNext);
  };

  const runConferenceRound = async (
    thread: Thread,
    promptForClaude: string,
    promptForCodex: string,
  ) => {
    const claudeSid = makeSid(thread.id, "claude", true);
    const codexSid = makeSid(thread.id, "codex", true);
    // 新しいdraftを初期化
    const newDrafts = { ...draftsRef.current };
    newDrafts[claudeSid] = FRESH_DRAFT(thread.id, "claude");
    newDrafts[codexSid] = FRESH_DRAFT(thread.id, "codex");
    draftsRef.current = newDrafts;
    setDrafts(newDrafts);
    setStreamingSids(
      (prev) => new Set([...prev, claudeSid, codexSid]),
    );
    try {
      await agentSend(claudeSid, promptForClaude);
      await agentSend(codexSid, promptForCodex);
    } catch (err) {
      console.error("conference round send failed", err);
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
    if (t?.splitMode) {
      await agentStop(makeSid(id, "claude", true)).catch(() => {});
      await agentStop(makeSid(id, "codex", true)).catch(() => {});
      sessionsStartedRef.current.delete(makeSid(id, "claude", true));
      sessionsStartedRef.current.delete(makeSid(id, "codex", true));
    } else {
      await agentStop(id).catch(() => {});
      sessionsStartedRef.current.delete(id);
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
    if (activeThread.splitMode) {
      const claudeSid = makeSid(activeThread.id, "claude", true);
      const codexSid = makeSid(activeThread.id, "codex", true);
      await Promise.all([
        agentStop(claudeSid).catch(() => {}),
        agentStop(codexSid).catch(() => {}),
      ]);
      sessionsStartedRef.current.delete(claudeSid);
      sessionsStartedRef.current.delete(codexSid);
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

  /** 並列モード時、片側（claude / codex）だけキャラを差し替える。 */
  const handleChangeSplitCharacter = async (
    provider: Provider,
    characterId: string,
  ) => {
    if (!activeThread) return;
    const sid = makeSid(activeThread.id, provider, activeThread.splitMode);
    await agentStop(sid).catch(() => {});
    sessionsStartedRef.current.delete(sid);
    const newChar = getCharacter(characterId);
    updateThread(activeThread.id, (t) => {
      const prev = t.splitCharacterIds ?? {
        claude: t.characterId,
        codex: t.characterId,
      };
      return {
        ...t,
        splitCharacterIds: { ...prev, [provider]: characterId },
        // Claude 側のキャラ変更時のみ thread.model も追従（Codex は SDK 側で別管理）
        ...(provider === "claude" && newChar?.defaultModel
          ? { model: newChar.defaultModel }
          : {}),
        updatedAt: Date.now(),
      };
    });
  };

  const handleChangeModel = (model: ModelId) => {
    if (!activeThread) return;
    updateThread(activeThread.id, (t) => ({ ...t, model, updatedAt: Date.now() }));
  };

  const handleChangeWorkspace = async () => {
    if (!activeThread) return;
    const ws = await pickWorkspace();
    if (!ws) return;
    if (activeThread.splitMode) {
      await agentStop(makeSid(activeThread.id, "claude", true)).catch(() => {});
      await agentStop(makeSid(activeThread.id, "codex", true)).catch(() => {});
      sessionsStartedRef.current.delete(makeSid(activeThread.id, "claude", true));
      sessionsStartedRef.current.delete(makeSid(activeThread.id, "codex", true));
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

  const ensureSessionStarted = async (
    thread: Thread,
    provider: Provider,
  ) => {
    const sid = makeSid(thread.id, provider, thread.splitMode);
    if (sessionsStartedRef.current.has(sid)) return;
    // 並列モードでは provider 別キャラを使う（CDO×CMO 等）。
    const character = getCharacter(characterIdFor(thread, provider));
    const apiKey = settings.authMode === "apikey" ? await getApiKey() : null;
    const effectivePrompt = buildEffectiveSystemPrompt(
      character?.systemPrompt ?? "",
      character?.personalityId ?? null,
      settings.beginnerMode ?? true,
    );
    await agentStart({
      sessionId: sid,
      workspace: thread.workspace,
      systemPrompt: effectivePrompt,
      model: thread.model,
      authMode: settings.authMode,
      apiKey,
      provider,
    });
    sessionsStartedRef.current.add(sid);
  };

  /**
   * メッセージ内のコマンドを「UNICREW で実行」する。
   * AI に対して「直前のコマンドを Bash ツールで実行してください」と再投げする。
   * systemPrompt の UNICREW_RUNTIME_RULES と組み合わせて、
   * AI が自分で実行→結果を会話に注入してくれる挙動になる。
   */
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
    // 会議モード：新しいユーザー発言が来たら、進行中の議論ラウンド状態をリセット
    if (thread.conferenceMode) {
      conferenceRef.current.set(thread.id, {
        round: 0,
        claudeText: null,
        codexText: null,
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

    // 並列か単独か。単独はキャラの provider を使う。
    const providers: Provider[] = thread.splitMode
      ? ["claude", "codex"]
      : [characterProvider(thread)];

    // 各 provider で draft 初期化＋送信
    const newDrafts = { ...draftsRef.current };
    const newStreaming = new Set(streamingSids);
    for (const p of providers) {
      const sid = makeSid(thread.id, p, thread.splitMode);
      newDrafts[sid] = FRESH_DRAFT(thread.id, p);
      newStreaming.add(sid);
    }
    draftsRef.current = newDrafts;
    setDrafts(newDrafts);
    setStreamingSids(newStreaming);

    for (const p of providers) {
      const sid = makeSid(thread.id, p, thread.splitMode);
      try {
        await ensureSessionStarted(thread, p);
        await agentSend(sid, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errMsg = {
          id: nanoid(8),
          role: "assistant" as const,
          content: `**起動エラー (${p})**: ${message}\n\n設定から認証状態を確認してください。`,
          createdAt: Date.now(),
          provider: p,
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
    if (thread.splitMode) {
      const claudeSid = makeSid(thread.id, "claude", true);
      const codexSid = makeSid(thread.id, "codex", true);
      finalizeDraft(claudeSid);
      finalizeDraft(codexSid);
      sessionsStartedRef.current.delete(claudeSid);
      sessionsStartedRef.current.delete(codexSid);
      void agentStop(claudeSid).catch(() => {});
      void agentStop(codexSid).catch(() => {});
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

  // ペイン単位で drafts と isStreaming を計算する
  const buildThreadDrafts = (
    thread: Thread | null,
  ): Record<Provider, ActiveDraft | null> => {
    const r: Record<Provider, ActiveDraft | null> = {
      claude: null,
      codex: null,
    };
    if (!thread) return r;
    if (thread.splitMode) {
      r.claude = drafts[makeSid(thread.id, "claude", true)] ?? null;
      r.codex = drafts[makeSid(thread.id, "codex", true)] ?? null;
    } else {
      const single = drafts[thread.id] ?? null;
      if (single) r[single.provider] = single;
    }
    return r;
  };

  const isThreadStreaming = (thread: Thread | null): boolean => {
    if (!thread) return false;
    return thread.splitMode
      ? streamingSids.has(makeSid(thread.id, "claude", true)) ||
          streamingSids.has(makeSid(thread.id, "codex", true))
      : streamingSids.has(thread.id);
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
        {
          label: settings.showActivity
            ? "ツール詳細表示 ON（クリックで OFF）"
            : "ツール詳細表示 OFF（クリックで ON）",
          onSelect: () => {
            const updated = {
              ...settings,
              showActivity: !settings.showActivity,
              beginnerMode: settings.showActivity ? settings.beginnerMode : false,
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
              />
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
