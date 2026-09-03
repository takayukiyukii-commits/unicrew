"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { Sidebar, type MainView } from "@/components/Sidebar";
import { TerminalPanes } from "@/components/TerminalPanes";
import { ExplorerPanel } from "@/components/ExplorerPanel";
import { CommandPalette } from "@/components/CommandPalette";
import type { Command } from "@/lib/commands";
import { Walkthrough } from "@/components/Walkthrough";
import { isWalkthroughDone, resetWalkthrough } from "@/lib/walkthrough";
import { WhatsNewModal } from "@/components/WhatsNewModal";
import { resetWhatsNew, shouldShowWhatsNew, UNICREW_VERSION } from "@/lib/whatsnew";
import { useAppVersion } from "@/lib/app-version";
import { LanguagePickerModal } from "@/components/LanguagePickerModal";
import { isLocaleUnset, useLocaleInit, useTranslation } from "@/lib/i18n";
import { TrustPromptModal } from "@/components/TrustPromptModal";
import { isWorkspaceTrusted, trustWorkspace } from "@/lib/trust";
import { openFileInEditorWindow } from "@/lib/editor-window";
import { applyAppearance } from "@/lib/appearance";
import {
  Plus,
  FolderOpen as IconFolderOpen,
  Settings as IconSettings,
  Puzzle as IconPuzzle,
  FolderTree as IconFolderTree,
  Columns2 as IconColumns2,
  ListChecks,
  Smartphone,
  CalendarClock,
  Network,
  MessageSquare,
  Github,
  Bug,
  CircleStop,
  Sparkles,
  Workflow,
  User as IconUser,
  HelpCircle,
} from "lucide-react";
import { AddonsSection } from "@/components/AddonsSection";
import { AppMenuBar, type MenuDef } from "@/components/AppMenuBar";
import { ChatPane } from "@/components/ChatPane";
import { TaskQueuePanel } from "@/components/TaskQueuePanel";
import { UniMcpModal } from "@/components/UniMcpModal";
import { RoutinesModal } from "@/components/RoutinesModal";
import { RemoteControlModal } from "@/components/RemoteControlModal";
import {
  loadRoutines,
  markFired,
  saveRoutines,
  shouldFire,
} from "@/lib/routines";
import { sendLaunchPing } from "@/lib/telemetry";
import { FeedbackCard } from "@/components/FeedbackCard";
import {
  countUserMessages,
  shouldShowFeedback,
  markFeedbackShown,
} from "@/lib/feedback";
import { RightPane } from "@/components/RightPane";
import { SettingsModal } from "@/components/SettingsModal";
import type { ProviderCategory } from "@/lib/providerCategories";
import { CharacterPickerModal } from "@/components/CharacterPickerModal";
import { CharacterEditModal } from "@/components/CharacterEditModal";
import { PermissionPromptModal } from "@/components/PermissionPromptModal";
import { WelcomeLanding } from "@/components/WelcomeLanding";
import { type ConferencePreset, presetName } from "@/components/ConferencePresets";
import { FreeModeWizard } from "@/components/FreeModeWizard";
import { ActivityVisibilityContext } from "@/components/ActivityContext";
import { PaneResizer } from "@/components/PaneResizer";
import {
  appendMessage,
  createThread,
  loadLastWorkspace,
  loadSettings,
  loadThreads,
  saveLastWorkspace,
  saveSettings,
  saveThreads,
} from "@/lib/storage";
import {
  acpCliStatus,
  agentPermissionResponse,
  agentSend,
  inlineableImages,
  agentStart,
  agentStop,
  worktreePrepare,
  worktreeRemove,
  workspaceSnapshot,
  checkUnicrewUpdate,
  claudeStatus,
  codexStatus,
  defaultWorkspacePath,
  getApiKey,
  graphifyUpdate,
  isTauri,
  listenAgentEvents,
  pickWorkspace,
  type AcpCliProvider,
  type AgentEvent,
} from "@/lib/tauri";
import {
  cloneFromTemplate,
  getAllCharacters,
  getCharacter,
  loadUserCharacters,
  saveUserCharacters,
  TEMPLATE_CHARACTERS,
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
import { shouldIsolate, withSlotWorktree } from "@/lib/worktree";
import { snapshotCwds, withTurnBase } from "@/lib/changes";
import { showToast } from "@/lib/toast";
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
  Message,
  MessageAttachment,
  ModelId,
  ParticipantSlot,
  PendingPermission,
  Provider,
  TextBlock,
  Thread,
  ToolUseBlock,
} from "@/lib/types";
import { PERMISSION_MODE_ORDER, toCliPermissionMode } from "@/lib/types";

interface PendingSend {
  text: string;
  attachments?: MessageAttachment[];
}

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
  /**
   * 直近の Tauri agent:event 到着時刻。inactivity watchdog 用。
   * OpenCode / Goose 等 ACP プロバイダで agent 側が StopReason を返さず
   * 「応答中…」スピナーが永久に止まらないバグへの保険として、
   * lastEventAt から一定時間 (INACTIVITY_STUCK_MS) 経過したら finalize を促すバナーを出す。
   */
  lastEventAt: number;
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
  lastEventAt: Date.now(),
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

/**
 * AI 切替時に「これまでの会話履歴」として systemPrompt に注入する文脈ブロックを組み立てる。
 * 直近 maxExchanges 往復を [ユーザー] / [アシスタント] でラベル付け、各メッセージは長さで切る。
 *
 * @param maxExchanges 何往復ぶん拾うか（user+assistant を1往復として概算）
 */
function buildConversationHistoryContext(
  messages: Message[],
  maxExchanges = 5,
): string {
  if (messages.length === 0) return "";
  // 最後の N 往復ぶん（user + assistant ペア × N = 2N メッセージ）。
  // 単独に偏っても上限内に収まれば全部拾うため slice 末尾参照。
  const recent = messages.slice(-maxExchanges * 2);
  const lines: string[] = [
    "## このスレッドの直近の会話",
    "",
    "別の AI（または別キャラ）が応答した分も含まれます。前回までの文脈を踏まえて続きを対応してください。",
    "",
  ];
  for (const m of recent) {
    if (m.role === "user") {
      lines.push("[ユーザー]");
    } else {
      const provider = m.provider ?? "claude";
      lines.push(`[アシスタント・${provider}]`);
    }
    // 各メッセージは 2000 文字でカット（context bloat 抑制）
    const text = m.content.length > 2000 ? m.content.slice(0, 2000) + "…（省略）" : m.content;
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 「他ペインの直近の会話」を参考情報として組み立てる。
 * 自分のペイン以外の thread を、最大 maxExchangesPerPane 往復ぶん含める。
 */
function buildPeekOtherPanesContext(
  currentThreadId: string,
  paneThreadIds: readonly string[],
  threads: Thread[],
  maxExchangesPerPane = 3,
): string {
  const otherThreads = paneThreadIds
    .filter((id) => id !== currentThreadId)
    .map((id) => threads.find((t) => t.id === id))
    .filter((t): t is Thread => !!t && t.messages.length > 0);
  if (otherThreads.length === 0) return "";
  const blocks = otherThreads.map((t) => {
    const recent = t.messages.slice(-maxExchangesPerPane * 2);
    const messageBlock = recent
      .map((m) => {
        const speaker =
          m.role === "user"
            ? "[ユーザー]"
            : `[${m.provider ?? "AI"}]`;
        const text =
          m.content.length > 1500 ? m.content.slice(0, 1500) + "…（省略）" : m.content;
        return `${speaker}\n${text}`;
      })
      .join("\n\n");
    return `### ペイン「${t.title || "（無題）"}」\n\n${messageBlock}`;
  });
  return [
    "## 他ペインの直近の会話（参考情報）",
    "",
    "ユーザーは今このペインで質問していますが、他のペインで進行中の会話も渡されています。回答時にコンテキストとして使ってよい。引用する場合はどのペインの誰の発言か明示してください。",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

export default function Page() {
  // 既存コードに `t: Thread` パラメータが多数あるため、翻訳関数はエイリアス `tr` で受ける。
  const { t: tr } = useTranslation();
  const appVersion = useAppVersion();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * 並列ペインに表示するスレッドIDの配列。空なら単一ペインのみ。
   * 上限5（主ペイン1 + 分割5 = 最大6ペイン）。
   * 3つ以上になったら3列×2段のグリッド表示に切替（横一列だと細くて読めないため）。
   */
  const [splitIds, setSplitIds] = useState<string[]>([]);
  const MAX_SPLIT_PANES = 5;
  /**
   * 並列ペイン中、ユーザーが「このペインを編集対象にする」と指定したスレッドID。
   * RightPane（キャラ・モデル・人格・参加者・記憶）の操作はこの focused thread に適用する。
   * null なら activeId（主ペイン）にフォールバック（単一モードの従来挙動と同じ）。
   * パネルをクリックすると更新、サイドバーで activeId が変わると null にリセット。
   */
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  /**
   * 「他ペインの会話も参照する」モードが ON になっているスレッド ID の集合。
   * ON の thread から送信するときだけ、他ペインの直近会話を [参考情報] として
   * メッセージ先頭に差し込む。spawn 時の systemPrompt ではなく送信ごとに付け替えるため、
   * 他ペインが進行中でも最新の状況が反映される。
   */
  const [peekPaneIds, setPeekPaneIds] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<AppSettings>({
    defaultCharacterId: "tmpl-claude-normal",
    authMode: "subscription",
    showActivity: false,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * 設定モーダルを「特定カテゴリを開いた状態で」表示するためのシグナル。
   * 「無料で試す」フローから open_local accordion を強制展開するのに使う。
   * 値が変わるたび accordion 側が open=true を再適用する。
   */
  const [settingsForceCategory, setSettingsForceCategory] =
    useState<ProviderCategory | null>(null);
  const [settingsForceTick, setSettingsForceTick] = useState(0);
  const openSettingsForCategory = useCallback(
    (category: ProviderCategory | null) => {
      setSettingsForceCategory(category);
      setSettingsForceTick((t) => t + 1);
      setSettingsOpen(true);
    },
    [],
  );
  /**
   * 「1分で始める」FreeMode Wizard の開閉。
   * open=true で Ollama + qwen2.5-coder:7b + OpenCode を自動セットアップし、
   * 完了時に `handleFreeModeCompleted` が OpenCode 単独スレッドを spawn する。
   */
  const [freeModeOpen, setFreeModeOpen] = useState(false);
  /** フィードバック・サーベイ表示フラグ。たまに会話末尾に差し込む。 */
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [addonsTab, setAddonsTab] = useState<string>("claude-plugin");
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
  /** 公式 Remote Control ランチャー */
  const [rcOpen, setRcOpen] = useState(false);
  /** graphify ナレッジグラフ自動更新（アイデア6）の進捗表示。 */
  const [graphifyStatus, setGraphifyStatus] = useState<{
    state: "updating" | "done" | "error";
    message?: string;
  } | null>(null);
  /**
   * graphify 同時起動の抑止と「ナレッジ更新中…無限固着バグ」の防護壁。
   * - inFlightWorkspaces: 現在 graphify update 中のワークスペース集合（重複起動を抑止）
   * - safetyTimerRef: トースト自動消去のフェイルセーフ。CLI が予期せず resolve しなかった
   *   ときも UI 側でトーストを必ず閉じる（Rust 側にも 120s timeout を入れているので二重防護）
   */
  const graphifyInFlightRef = useRef<Set<string>>(new Set());
  const graphifySafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  /** VSCode風エクスプローラー列の開閉状態。永続化は localStorage */
  const [explorerOpen, setExplorerOpen] = useState(false);
  /**
   * 既定では explorer 開時にサイドバーを畳むが、ユーザーが「広げたまま使いたい」と
   * 思ったときの解除フラグ。explorer を閉じると自動でリセットして次回の開時にまた畳まれる。
   */
  const [sidebarManuallyExpanded, setSidebarManuallyExpanded] = useState(false);
  // ワークスペースは `activeThread.workspace` 一本に統一（旧 `explorerWorkspace` state は削除）。
  // 過去には Explorer 専用 workspace を別に持っていたが、右サイドバーの変更が
  // Explorer に反映されないなど混乱の元だったため一本化。
  /** Command Palette の開閉 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Walkthrough（初回オンボ） */
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  /** What's New（バージョン更新時に 1 回だけ自動表示） */
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  /** 初回起動言語ピッカー（locale未設定なら開く。Walkthroughより先） */
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  // <html lang> を現在のロケールに同期させる
  useLocaleInit();
  /** Trust 確認モーダルの状態。開く時は path / resolve を入れる */
  const [trustPrompt, setTrustPrompt] = useState<{
    path: string;
    resolve: (value: "trusted" | "restricted" | "cancel") => void;
  } | null>(null);
  /** 制限モードでオープン中のワークスペース集合（書込みを促す UI を抑制） */
  const [restrictedWorkspaces, setRestrictedWorkspaces] = useState<Set<string>>(
    new Set(),
  );
  const [characterRevision, setCharacterRevision] = useState(0);
  // 承認要求は「待ち行列」で持つ。
  // 単一の state だと、2つのセッションがほぼ同時に許可を求めたときに後勝ちで上書きされ、
  // 先に聞いてきた側が返事をもらえないまま固まる（CLI は stdin の返事を待って止まる）。
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>(
    [],
  );
  const pendingPermission = permissionQueue[0] ?? null;
  /** session_id -> ActiveDraft（split時は2つ、single時は1つ） */
  const [drafts, setDrafts] = useState<Record<string, ActiveDraft>>({});
  const [streamingSids, setStreamingSids] = useState<Set<string>>(new Set());
  /** heartbeat 等の closure 内で最新値を参照するため */
  const streamingSidsRef = useRef<Set<string>>(new Set());
  streamingSidsRef.current = streamingSids;
  const [hydrated, setHydrated] = useState(false);

  // ターミナル風の指示連投。応答中に送信されたメッセージを thread ごとに
  // 溜め、その thread がアイドルに戻ったら先頭から自動送出する。
  const enqueuedSendsRef = useRef<Record<string, PendingSend[]>>({});
  const [enqueuedCounts, setEnqueuedCounts] = useState<
    Record<string, number>
  >({});

  const sessionsStartedRef = useRef<Set<string>>(new Set());

  /** worktree 隔離に失敗したスレッド（警告は1回だけ出す） */

  const isolationWarnedRef = useRef<Set<string>>(new Set());
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

  /**
   * 議論モード Sequential 用: slot の応答完了を Promise で待つためのレゾルバ集合。
   * `awaitSlotCompletion(sid)` が呼ばれると Promise を作って resolver を Map に登録、
   * `finalizeDraft(sid)` が呼ばれた時に resolver を呼んで Promise を解決する。
   * 1 sid に複数回 await はせず、resolver は 1 回だけ。
   */
  const slotCompletionResolversRef = useRef<Map<string, () => void>>(new Map());

  /** slot の応答完了 Promise を返す。完了済みなら即時 resolve しない（保留 Promise を返す）。 */
  const awaitSlotCompletion = (sid: string) =>
    new Promise<void>((resolve) => {
      slotCompletionResolversRef.current.set(sid, resolve);
    });

  // 外観設定を画面へ反映（初期ロード・保存・モーダル変更すべてに追従）
  useEffect(() => {
    applyAppearance(settings.appearance);
  }, [settings.appearance]);

  // 匿名の起動記録（インストール数を数えるためだけ・設定でオフにできる）。
  // 🚨 送るのは乱数ID・バージョン・OSの3つだけ。PRIVACY.md と必ず一致させること。
  useEffect(() => {
    void sendLaunchPing();
  }, []);

  // /mcp 等の REPL コマンド横取り（ChatPane が dispatch）→ 対応画面へ
  useEffect(() => {
    const onSlash = (e: Event) => {
      const d = (e as CustomEvent<{ command?: string; target?: string }>)
        .detail;
      if (!d) return;
      if (d.target === "addons") {
        setAddonsTab(
          d.command === "/mcp"
            ? "claude-mcp"
            : d.command === "/agents"
              ? "claude-skill"
              : "claude-plugin",
        );
        setMainView("addons");
      } else setSettingsOpen(true);
    };
    window.addEventListener("unicrew:slash", onSlash);
    return () => window.removeEventListener("unicrew:slash", onSlash);
  }, []);

  // hydrate
  useEffect(() => {
    const t = loadThreads();
    const s = loadSettings();
    setThreads(t);
    setSettings(s);
    setHydrated(true);
    if (typeof window !== "undefined") {
      const v = localStorage.getItem("unicrew.explorerOpen");
      if (v === "1") setExplorerOpen(true);
      // 旧 unicrew.explorerWorkspace は廃止。残骸を一度だけ削除しておく。
      localStorage.removeItem("unicrew.explorerWorkspace");
      // 言語未設定なら言語ピッカーを最優先で表示（Walkthrough/WhatsNewより前）
      if (isLocaleUnset()) {
        setLanguagePickerOpen(true);
      } else if (isWalkthroughDone() && shouldShowWhatsNew()) {
        // Walkthrough 完了済みでバージョンが上がっていたら What's New を出す
        setWhatsNewOpen(true);
      }
    }

    (async () => {
      if (!isTauri()) return;
      // 既定ワークスペース（~/Documents/UNICREW）は自動信頼
      try {
        const def = await defaultWorkspacePath();
        if (def) {
          const ok = await isWorkspaceTrusted(def);
          if (!ok) await trustWorkspace(def);
        }
      } catch {
        /* noop */
      }
      // 言語ピッカー表示中はオンボード判定をスキップ（閉じた時に onClose で再開する）
      if (isLocaleUnset()) return;
      // 初回起動: Walkthrough 未完了なら Walkthrough を出して既存の設定モーダル誘導は出さない
      if (!isWalkthroughDone()) {
        setWalkthroughOpen(true);
        return;
      }
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
    if (typeof window === "undefined") return;
    localStorage.setItem("unicrew.explorerOpen", explorerOpen ? "1" : "0");
  }, [explorerOpen]);

  useEffect(() => {
    if (hydrated) saveThreads(threads);
  }, [threads, hydrated]);

  useEffect(() => {
    if (threads.length > 0 && !activeId) setActiveId(threads[0].id);
  }, [threads, activeId]);

  // splitIds の中で、削除済みスレッドを指している ID を掃除する
  useEffect(() => {
    setSplitIds((prev) => {
      const filtered = prev.filter((id) => threads.some((t) => t.id === id));
      return filtered.length === prev.length ? prev : filtered;
    });
    // 削除済みスレッドの peek フラグも掃除する
    setPeekPaneIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (threads.some((t) => t.id === id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [threads]);

  /** 他ペイン参照モードのトグル。並列ペインが複数存在するスレッドでのみ意味を持つ。 */
  const togglePeekForThread = (threadId: string) => {
    setPeekPaneIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  // focusedThreadId が消えたスレッドを指していたらクリア（activeId にフォールバック）
  useEffect(() => {
    if (focusedThreadId && !threads.some((t) => t.id === focusedThreadId)) {
      setFocusedThreadId(null);
    }
  }, [threads, focusedThreadId]);

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
    splitThreads: { thread: Thread; streaming: boolean }[];
    primaryStreaming: boolean;
    abortThread: (t: Thread) => void;
    abortAll: () => void;
  } | null>(null);

  // Shift+Tab でパーミッションモード（acceptEdits ↔ plan）をトグル。
  // Claude Code 流。フォーカスがどこにあっても反応するが、修飾キーが他に付いてる場合は無視。
  const togglePermissionModeRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      togglePermissionModeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
          return;
        }
        const streamingSplit = ctx.splitThreads.find((s) => s.streaming);
        if (streamingSplit) {
          e.preventDefault();
          ctx.abortThread(streamingSplit.thread);
        }
        return;
      }
      // Ctrl/⌘+C: input/選択中じゃない時のみ停止に流す（コピー優先）
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        if (isInput || hasSelection) return;
        if (ctx.primaryThread && ctx.primaryStreaming) {
          e.preventDefault();
          ctx.abortThread(ctx.primaryThread);
          return;
        }
        const streamingSplit = ctx.splitThreads.find((s) => s.streaming);
        if (streamingSplit) {
          e.preventDefault();
          ctx.abortThread(streamingSplit.thread);
        }
        return;
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Command Palette: Ctrl/⌘+K もしくは Ctrl/⌘+Shift+P でトグル
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isPalette =
        ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) ||
        ((e.ctrlKey || e.metaKey) &&
          e.shiftKey &&
          (e.key === "p" || e.key === "P"));
      if (isPalette) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
        void handleSendForThread(`[ルーティーン: ${r.label}]\n${r.prompt}`, t);
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
  // アクティブスレッドの workspace が変わったら「次に新規作成する時の既定値」として保存。
  useEffect(() => {
    if (activeThread?.workspace) saveLastWorkspace(activeThread.workspace);
  }, [activeThread?.workspace]);
  /**
   * RightPane の編集対象。ユーザーがパネルをクリックして focusedThreadId を指定して
   * いればそれ、未指定なら activeThread（主ペイン）。
   * 並列ペイン中、どのターミナルにキャラ変更が適用されるかをユーザーに明示する手がかりになる。
   */
  const focusedThread =
    (focusedThreadId
      ? threads.find((t) => t.id === focusedThreadId)
      : null) ?? activeThread;

  const updateThread = (id: string, mut: (t: Thread) => Thread) => {
    setThreads((prev) => prev.map((t) => (t.id === id ? mut(t) : t)));
  };

  const updateDraft = (sid: string, mut: (d: ActiveDraft) => ActiveDraft) => {
    setDrafts((prev) => {
      const existing = prev[sid];
      if (!existing) return prev;
      const next = { ...prev, [sid]: mut(existing) };
      // finalizeDraft は draftsRef.current から読む。render flush 前に停止が
      // 割り込んでも最新 blocks を確定できるよう ref を即同期しておく。
      draftsRef.current = next;
      return next;
    });
  };

  function handleAgentEvent(event: AgentEvent) {
    if (event.kind === "ready") return;

    // CLI セッション ID を thread に保存（再起動後の `--resume` / `exec resume` 用の土台）。
    // 単独モードは sid === thread.id、並列モードは slot id がサフィックス付きで埋まっている。
    if (event.kind === "cli_session_id") {
      const sid = event.session_id;
      const cliSid = event.cli_session_id;
      const threadById = new Map(threadsRef.current.map((t) => [t.id, t]));
      const { thread, slot } = lookupSlot(sid, threadById);
      if (!thread || !slot) return;
      const key: "claudeSessionId" | "codexSessionId" =
        slot.provider === "codex" ? "codexSessionId" : "claudeSessionId";
      if (thread[key] === cliSid) return; // 変化なしならno-op
      updateThread(thread.id, (t) => ({ ...t, [key]: cliSid }));
      return;
    }

    if (event.kind === "permission_request") {
      setPermissionQueue((queue) => {
        // 同じ request_id が二度届いても二重に積まない
        if (queue.some((q) => q.requestId === event.request_id)) return queue;
        return [
          ...queue,
          {
            sessionId: event.session_id,
            requestId: event.request_id,
            toolName: event.tool_name,
            input: event.input,
          },
        ];
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
      // 停止/完了でセッションを畳んだ後、Rust 側 mpsc キューに残っていた遅延
      // イベントが届くケースがある。ここで安易に fresh draft を作ると、停止済み
      // セッションが「ストリーミング中」にゴースト復活し、後続の遅延 result /
      // error で壊れた assistant メッセージが挿入されたり null 参照でクラッシュ
      // （= 停止ボタンで白画面）する。開始済みセッション（ensureSlotSession で
      // add 済み）でなければ、これは終了後の遅延ゴーストなので無視する。
      if (!sessionsStartedRef.current.has(sid)) return;
      const fresh = FRESH_DRAFT(thread.id, slot);
      draftsRef.current = { ...draftsRef.current, [sid]: fresh };
      setDrafts(draftsRef.current);
      setStreamingSids((prev) => new Set([...prev, sid]));
    } else {
      // inactivity watchdog 用に「最後に何か来た時刻」を更新。
      // 全 event 共通の path（result/error 含む）で叩いておく。
      // updateDraft 経由で setDrafts も発火し、StreamingStatus 側の「応答止まったかも？」
      // 検知ロジックが新しい lastEventAt を読めるようになる。
      updateDraft(sid, (d) => ({ ...d, lastEventAt: Date.now() }));
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
      const lower = event.message.toLowerCase();
      const isUsageLimit =
        lower.includes("usage limit") ||
        lower.includes("you've hit your usage") ||
        lower.includes("rate limit") ||
        lower.includes("quota exceeded");
      const text = isUsageLimit
        ? tr("page.error.usageLimit", { message: event.message })
        : tr("page.error.generic", { message: event.message });
      updateDraft(sid, (d) => ({
        ...d,
        blocks: [
          ...d.blocks,
          { kind: "text", text } as TextBlock,
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
    // 🚨 中身ゼロ（テキストもブロックも無い）の draft の扱い（2026-08-14）:
    // Codex は 1 回の送信に対して turn.completed（= Result イベント）を複数回返すことがあり、
    // そのたびに finalizeDraft が走って「アイコン＋名前＋…」だけの空ふきだしが積まれていた。
    // - 単独チャット: 空 draft は破棄（進捗は StreamingStatus 側に一本化）
    // - 並列/会議スレッド: 破棄すると①直列送信の「直前の発言」検索が過去ラウンドの
    //   メッセージを誤って拾う ②会議進行が空応答のまま先へ進む（監査第2回 HIGH）ため、
    //   破棄せず明示プレースホルダで残してフロー整合を保つ
    const isEmptyDraft = finalText === "" && d.blocks.length === 0;
    const parallelCtx = thread ? isThreadParallel(thread) : false;
    if (!isEmptyDraft) {
      updateThread(d.threadId, (t) => appendMessage(t, assistantMsg));
    } else if (parallelCtx) {
      updateThread(d.threadId, (t) =>
        appendMessage(t, {
          ...assistantMsg,
          content: tr("chat.emptyResponsePlaceholder"),
        }),
      );
    }
    const next = { ...draftsRef.current };
    delete next[sid];
    draftsRef.current = next;
    setDrafts(next);
    setStreamingSids((prev) => {
      const n = new Set(prev);
      n.delete(sid);
      return n;
    });

    // 議論モード Sequential 用: 完了レゾルバを呼んで「応答待ち」の Promise を解放
    const resolver = slotCompletionResolversRef.current.get(sid);
    if (resolver) {
      slotCompletionResolversRef.current.delete(sid);
      resolver();
    }

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
        // 同じ workspace で graphify が走っているなら重複起動しない。
        // （並列ペインや高速連投で onStreamComplete が立て続けに発火しても 1 本だけ）
        if (graphifyInFlightRef.current.has(ws)) {
          // skip
        } else {
          graphifyInFlightRef.current.add(ws);
          setGraphifyStatus({ state: "updating" });
          // 既存の安全タイマーがあれば一旦クリア（複数回更新で延命する形）
          if (graphifySafetyTimerRef.current) {
            clearTimeout(graphifySafetyTimerRef.current);
            graphifySafetyTimerRef.current = null;
          }
          // フェイルセーフ：Rust 側 timeout(120s) ＋猶予 60s で必ずトーストを消す。
          // .then/.catch が何らかの理由で発火しないケース（ハングや HMR）への保険。
          graphifySafetyTimerRef.current = setTimeout(() => {
            graphifyInFlightRef.current.delete(ws);
            setGraphifyStatus((cur) => (cur?.state === "updating" ? null : cur));
            graphifySafetyTimerRef.current = null;
          }, 180_000);
          void graphifyUpdate(ws)
            .then(() => {
              graphifyInFlightRef.current.delete(ws);
              setGraphifyStatus({ state: "done" });
              if (graphifySafetyTimerRef.current) {
                clearTimeout(graphifySafetyTimerRef.current);
                graphifySafetyTimerRef.current = null;
              }
              setTimeout(
                () =>
                  setGraphifyStatus((cur) =>
                    cur?.state === "done" ? null : cur,
                  ),
                3000,
              );
            })
            .catch((err) => {
              graphifyInFlightRef.current.delete(ws);
              setGraphifyStatus({
                state: "error",
                message: err instanceof Error ? err.message : String(err),
              });
              if (graphifySafetyTimerRef.current) {
                clearTimeout(graphifySafetyTimerRef.current);
                graphifySafetyTimerRef.current = null;
              }
              setTimeout(
                () =>
                  setGraphifyStatus((cur) =>
                    cur?.state === "error" ? null : cur,
                  ),
                6000,
              );
            });
        }
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
   * N-way 議論ラウンドを発射する（Sequential）。
   *
   * 各 slot を A→B→C の順で起動し、後の参加者には「直前までに更新された他者の発言」を
   * 渡す。これによりラウンド継続時もユーザー初発時と同じ「順番に発言する」自然な流れに
   * なる。並列同時発射しないので、重い AI 同士で API 衝突も避けられる。
   *
   * `responses` は前ラウンドのスナップショット。最初の slot は前ラウンドの他者発言を
   * 使ってクロスレビューし、それ以降は直前話者の更新後発言を反映する。
   */
  const runConferenceRoundNway = async (
    thread: Thread,
    responses: Record<string, string | null>,
  ) => {
    const slots = effectiveParticipants(thread).filter(
      (s) => s.role !== "moderator",
    );
    const parallel = isThreadParallel(thread);
    // 進行中に上書きしていく "他者の発言" 辞書（slotId → 最新発言）
    const liveResponses: Record<string, string | null> = { ...responses };

    for (const slot of slots) {
      const sid = makeSlotSid(thread.id, slot.id, parallel);

      // この slot だけ draft 初期化＋streaming 開始
      draftsRef.current = {
        ...draftsRef.current,
        [sid]: FRESH_DRAFT(thread.id, slot),
      };
      setDrafts(draftsRef.current);
      setStreamingSids((prev) => new Set([...prev, sid]));

      const others = slots
        .filter((s) => s.id !== slot.id)
        .map((s) => {
          const c = getCharacter(s.characterId);
          return { name: c?.name ?? s.id, text: liveResponses[s.id] ?? "" };
        });
      const prompt = buildConferencePromptNway(others);

      try {
        await ensureSlotSession(thread, slot);
        const completion = awaitSlotCompletion(sid);
        await agentSend(sid, prompt);
        await completion;

        // 自分の応答を取り出して liveResponses に書き戻し、次の slot の文脈に反映
        const updatedThread = threadsRef.current.find(
          (t) => t.id === thread.id,
        );
        const myMsg = updatedThread?.messages
          .slice()
          .reverse()
          .find(
            (m) =>
              m.role === "assistant" && m.participantSlotId === slot.id,
          );
        if (myMsg) liveResponses[slot.id] = myMsg.content;
      } catch (err) {
        console.error("conference round send failed", err);
        // resolver leak 防止
        slotCompletionResolversRef.current.delete(sid);
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
      alert(tr("page.alert.tauriRequired"));
      return;
    }
    if (settings.authMode === "subscription") {
      const status = await claudeStatus();
      if (!status.installed || !status.logged_in) {
        alert(tr("page.alert.claudeSetupIncomplete"));
        setSettingsOpen(true);
        return;
      }
    } else {
      const key = await getApiKey();
      if (!key) {
        alert(tr("page.alert.apiKeyMissing"));
        setSettingsOpen(true);
        return;
      }
    }
    setPickerSplitMode(false);
    setPickerConferenceMode(false);
    setPickerSlot("primary");
    setPickerOpen(true);
  };

  /**
   * 並列ペインを1つ追加する（物理的に独立した対話ペインを開く）。
   *
   * 開いた並列ペインは `isSplitPane` 付きの一時スレッドとして作られ、
   * サイドバーには出さない（並列でもサイドバーは「1会話」）。閉じると破棄。
   * 独立会話＝サイドバー項目が欲しい時は「新しい会話」を使う。
   * 上限 MAX_SPLIT_PANES に達していたら無視。
   */
  const handleOpenSplitPane = () => {
    if (!isTauri()) {
      alert(tr("page.alert.tauriRequiredShort"));
      return;
    }
    if (splitIds.length >= MAX_SPLIT_PANES) return;
    void handleCreateInstant("split");
  };

  /**
   * 並列ペインを閉じる。
   * - 引数なし: 全ての並列ペインを閉じる
   * - id 指定: その ID だけ並列ペインから外す（スレッド自体は残る）
   */
  /** 並列ペインのうち、このペインだけを単独表示に切り替える。 */
  const handleSoloPane = (id: string) => {
    setActiveId(id);
    setSplitIds([]);
    setFocusedThreadId(null);
  };

  const handleCloseSplitPane = (id?: string) => {
    if (id) {
      setSplitIds((prev) => prev.filter((x) => x !== id));
    } else {
      setSplitIds([]);
    }
  };

  /**
   * 扉アイコン用: ワンクリックで新しい単独モードのスレッドを作る。
   *
   * - キャラ Picker を出さず、いま開いているスレッドのキャラ／ワークスペースを引き継ぐ
   *   （初回など参照先がない時はテンプレ筆頭にフォールバック）
   * - AI／キャラの差し替えはユーザーが右サイドバー（RightPane）で行う
   * - Tauri 起動と Claude のセットアップだけ簡易チェック。並列モードは作らないので Codex は不要。
   * - `slot` で配置先を切り替える:
   *   - `"primary"`（既定） → 主ペイン（activeId）に開く
   *   - `"split"` → 並列ペイン（splitIds に追加）に開く。並列ペインの扉アイコンから呼ばれる用途
   */
  const handleCreateInstant = async (slot: PaneSlot = "primary") => {
    if (!isTauri()) {
      alert(tr("page.alert.tauriRequired"));
      return;
    }
    if (settings.authMode === "subscription") {
      const status = await claudeStatus();
      if (!status.installed || !status.logged_in) {
        alert(tr("page.alert.claudeSetupIncomplete"));
        setSettingsOpen(true);
        return;
      }
    } else {
      const key = await getApiKey();
      if (!key) {
        alert(tr("page.alert.apiKeyMissing"));
        setSettingsOpen(true);
        return;
      }
    }
    const baseChar =
      activeThread?.characterId ??
      TEMPLATE_CHARACTERS[0]?.id ??
      "tmpl-claude-normal";
    const ws =
      activeThread?.workspace ??
      loadLastWorkspace() ??
      (await defaultWorkspacePath());
    const t = createThread({
      characterId: baseChar,
      workspace: ws,
      splitMode: false,
      conferenceMode: false,
    });
    setThreads((prev) => [t, ...prev]);
    if (slot === "split") {
      setSplitIds((prev) =>
        prev.includes(t.id) || prev.length >= MAX_SPLIT_PANES
          ? prev
          : [...prev, t.id],
      );
    } else {
      setActiveId(t.id);
    }
    setMainView("chat");
  };

  /**
   * チームテンプレートから新スレッドを作成する。
   * participants に複数キャラ＋（任意で）moderator が一気にセットされる。
   */
  const handleCreateFromTeam = async (teamId: string) => {
    if (!isTauri()) {
      alert(tr("page.alert.tauriRequired"));
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
        alert(tr("page.alert.claudeSetupIncomplete"));
        setSettingsOpen(true);
        return;
      }
      if (usedProviders.has("codex")) {
        const cx = await codexStatus();
        if (!cx.installed || !cx.logged_in) {
          alert(tr("page.alert.teamNeedsCodex"));
          setSettingsOpen(true);
          return;
        }
      }
    } else {
      const key = await getApiKey();
      if (!key) {
        alert(tr("page.alert.apiKeyMissing"));
        setSettingsOpen(true);
        return;
      }
    }

    const ws = loadLastWorkspace() ?? (await defaultWorkspacePath());
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
   * 議論モードプリセット（ConferencePresets）から新スレッドを開始する。
   *
   * 認証/インストールチェック方針（memory: project_unicrew_v02_acp.md）:
   * - L1 商用 CLI（claude/codex/gemini）は従来通り installed/logged_in を確認
   * - L3 ACP プロバイダ（goose/opencode/codex-acp/kiro）は `acp_cli_status` で
   *   インストール状況を確認し、未インストールなら設定画面（OSS accordion）へ誘導
   * - 全部 OK の時だけスレッドを作成
   */
  const handleApplyPreset = async (preset: ConferencePreset) => {
    if (!isTauri()) {
      alert(tr("page.alert.tauriRequired"));
      return;
    }
    const needsClaude = preset.participants.some((p) => p.provider === "claude");
    const needsCodex = preset.participants.some((p) => p.provider === "codex");
    if (settings.authMode === "subscription") {
      if (needsClaude) {
        const status = await claudeStatus();
        if (!status.installed || !status.logged_in) {
          alert(tr("page.alert.presetNeedsClaude"));
          setSettingsOpen(true);
          return;
        }
      }
      if (needsCodex) {
        const cx = await codexStatus();
        if (!cx.installed || !cx.logged_in) {
          alert(tr("page.alert.presetNeedsCodex"));
          setSettingsOpen(true);
          return;
        }
      }
    } else {
      const commercial = new Set<Provider>(["claude", "codex", "gemini"]);
      if (preset.participants.some((p) => commercial.has(p.provider))) {
        const key = await getApiKey();
        if (!key) {
          alert(tr("page.alert.apiKeyMissing"));
          setSettingsOpen(true);
          return;
        }
      }
    }

    // L2/L3 ローカル/OSS プロバイダのインストール確認。未インストールが1つでもあれば
    // OSS accordion を展開した状態の設定画面へ誘導する。
    // Qwen は ACP ではないが、CLI install/status を同じ仕組みに乗せているので同列で扱う。
    const acpProvidersInPreset: AcpCliProvider[] = [];
    for (const p of preset.participants) {
      if (
        p.provider === "goose" ||
        p.provider === "opencode" ||
        p.provider === "codex-acp" ||
        p.provider === "kiro" ||
        p.provider === "qwen" ||
        p.provider === "kimi" ||
        p.provider === "grok" ||
        p.provider === "cursor"
      ) {
        acpProvidersInPreset.push(p.provider);
      }
    }
    for (const acp of acpProvidersInPreset) {
      const s = await acpCliStatus(acp);
      if (!s.installed) {
        alert(tr("page.alert.presetAcpNotInstalled", { acp }));
        openSettingsForCategory("open_local");
        return;
      }
    }

    const ws = loadLastWorkspace() ?? (await defaultWorkspacePath());
    const lead = preset.participants[0];
    const t = createThread({
      characterId: lead?.characterId ?? "tmpl-claude-normal",
      workspace: ws,
      splitMode: true,
      conferenceMode: true,
      conferenceMaxRounds: 3,
    });
    const enriched: Thread = {
      ...t,
      participants: preset.participants,
      title: presetName(preset),
    };
    setThreads((prev) => [enriched, ...prev]);
    setActiveId(enriched.id);
    setMainView("chat");
  };

  /**
   * FreeModeWizard が4ステップ全成功時に呼ぶ。
   * OpenCode（ローカル Ollama backed）の単独スレッドを起動する。
   * Wizard 側で Ollama install → モデル pull → OpenCode install が終わっている前提。
   */
  const handleFreeModeCompleted = useCallback(async () => {
    if (!isTauri()) return;
    const ws = loadLastWorkspace() ?? (await defaultWorkspacePath());
    const t = createThread({
      characterId: "tmpl-opencode-normal",
      workspace: ws,
      splitMode: false,
      conferenceMode: false,
    });
    setThreads((prev) => [t, ...prev]);
    setActiveId(t.id);
    setMainView("chat");
  }, []);

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
        alert(tr("page.alert.splitNeedsCodex"));
        setSettingsOpen(true);
        return;
      }
    }
    const ws = loadLastWorkspace() ?? (await defaultWorkspacePath());
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
      setSplitIds((prev) =>
        prev.includes(t.id) || prev.length >= MAX_SPLIT_PANES
          ? prev
          : [...prev, t.id],
      );
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

  const handleCloneTemplate = (
    tmpl: Character,
    overrides?: Partial<Character>,
  ) => {
    setPickerOpen(false);
    setEditingCharacter(cloneFromTemplate(tmpl, overrides));
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
    // worktree 隔離（v0.4.0）: スレッドと一緒に作業場を片付ける（ブランチは残る）
    if (t?.workspace) {
      for (const slot of effectiveParticipants(t)) {
        if (slot.worktreePath) {
          void worktreeRemove(t.workspace, slot.worktreePath).catch(() => {});
        }
      }
    }
    setThreads((prev) => prev.filter((tt) => tt.id !== id));
    setSplitIds((prev) => prev.filter((x) => x !== id));
    if (activeId === id) {
      const remaining = threads.filter((tt) => tt.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
  };

  const handleChangeCharacter = async (characterId: string) => {
    // RightPane の操作対象は focusedThread。並列ペイン中はクリック中のペインに反映。
    const target = focusedThread;
    if (!target) return;
    const newChar = getCharacter(characterId);
    // 既存セッションを止めて、次の send で新しい systemPrompt が反映されるようにする
    const slots = effectiveParticipants(target);
    const parallel = slots.length >= 2;
    if (parallel) {
      await Promise.all(
        slots.map((slot) => {
          const sid = makeSlotSid(target.id, slot.id, parallel);
          sessionsStartedRef.current.delete(sid);
          return agentStop(sid).catch(() => {});
        }),
      );
    } else {
      await agentStop(target.id).catch(() => {});
      sessionsStartedRef.current.delete(target.id);
    }
    updateThread(target.id, (t) => ({
      ...t,
      characterId,
      model: newChar?.defaultModel ?? t.model,
      updatedAt: Date.now(),
    }));
  };

  /**
   * Shift+Tab で focusedThread のパーミッションモードをトグルする。
   * acceptEdits（自動編集） ↔ plan（読取・分析のみ）。
   * 既存 subprocess は止め、次回送信時に新モードで再 spawn される。
   */
  const togglePermissionMode = async () => {
    const target = focusedThread;
    if (!target) return;
    const order = PERMISSION_MODE_ORDER;
    const cur = target.permissionMode ?? "acceptEdits";
    const next = order[(order.indexOf(cur) + 1) % order.length];
    const slots = effectiveParticipants(target);
    const parallel = slots.length >= 2;
    if (parallel) {
      await Promise.all(
        slots.map((slot) => {
          const sid = makeSlotSid(target.id, slot.id, parallel);
          sessionsStartedRef.current.delete(sid);
          return agentStop(sid).catch(() => {});
        }),
      );
    } else {
      await agentStop(target.id).catch(() => {});
      sessionsStartedRef.current.delete(target.id);
    }
    updateThread(target.id, (t) => ({
      ...t,
      permissionMode: next,
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
    const target = focusedThread;
    if (!target) return;
    const slots = effectiveParticipants(target);
    const parallel = slots.length >= 2;
    const sid = makeSlotSid(target.id, slotIdOrProvider, parallel);
    await agentStop(sid).catch(() => {});
    sessionsStartedRef.current.delete(sid);
    const newChar = getCharacter(characterId);

    updateThread(target.id, (t) => {
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
    const target = focusedThread;
    if (!target) return;
    // 既存セッションは生かしておいて新規 slot だけ起動。
    updateThread(target.id, (t) => addParticipant(t, slot));
  };

  /**
   * 現在のスレッドの participants 構成を JSON でクリップボードにコピーする。
   * 共有された JSON は「ファイル」メニュー →「JSONからチームをインポート…」で取り込める。
   */
  const handleExportTeamJson = async () => {
    const target = focusedThread;
    if (!target) return;
    const slots = effectiveParticipants(target);
    const participantSlots = slots.filter((s) => s.role !== "moderator");
    const moderatorSlot = slots.find((s) => s.role === "moderator");
    const team = {
      id: "tmp",
      name: target.title || tr("page.team.untitled"),
      description: "",
      emoji: "",
      defaultConference: target.conferenceMode,
      defaultMaxRounds: target.conferenceMaxRounds,
      participants: participantSlots,
      moderator: moderatorSlot,
      defaultModel: target.model,
      isTemplate: false,
      createdAt: 0,
      updatedAt: 0,
    };
    const json = exportTeamToJson(team);
    try {
      await navigator.clipboard.writeText(json);
      alert(tr("page.alert.teamJsonCopied"));
    } catch {
      // フォールバック：プロンプトでJSONを表示
      window.prompt(tr("page.alert.teamJsonCopyFailed"), json);
    }
  };

  /**
   * JSON 文字列からチームをインポートする。
   * 取り込み後はファイルメニューに即時反映。
   */
  const handleImportTeamJson = () => {
    const json = window.prompt(tr("page.alert.teamJsonImportPrompt"), "");
    if (!json) return;
    try {
      const team = importTeamFromJson(json);
      const existing = loadUserTeams();
      saveUserTeams([team, ...existing]);
      alert(tr("page.alert.teamImported", { name: team.name }));
    } catch (e) {
      alert(
        tr("page.alert.teamImportFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
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
    const target = focusedThread;
    if (!target) return;
    const slots = effectiveParticipants(target);
    const participantSlots = slots.filter((s) => s.role !== "moderator");
    const moderatorSlot = slots.find((s) => s.role === "moderator");
    const now = Date.now();
    const newTeam = {
      id: newTeamId(),
      name: meta.name,
      description: meta.description,
      emoji: meta.emoji || "",
      defaultConference: target.conferenceMode,
      defaultMaxRounds: target.conferenceMaxRounds,
      participants: participantSlots,
      moderator: moderatorSlot,
      defaultModel: target.model,
      isTemplate: false,
      createdAt: now,
      updatedAt: now,
    };
    const existing = loadUserTeams();
    saveUserTeams([newTeam, ...existing]);
  };

  /** 参加者を削除する。 */
  const handleRemoveParticipant = async (slotId: string) => {
    const target = focusedThread;
    if (!target) return;
    const sid = makeSlotSid(
      target.id,
      slotId,
      isThreadParallel(target),
    );
    await agentStop(sid).catch(() => {});
    sessionsStartedRef.current.delete(sid);
    updateThread(target.id, (t) => removeParticipant(t, slotId));
  };

  const handleChangeModel = (model: ModelId) => {
    const target = focusedThread;
    if (!target) return;
    updateThread(target.id, (t) => ({ ...t, model, updatedAt: Date.now() }));
  };

  /**
   * 並列モード：参加者スロットの起動 AI（provider）を切替える。
   * slot.provider はキャラと独立した「このスロットを動かす AI」フィールドなので、
   * キャラはそのままに provider だけ書換える（CEO×Codex / CEO×Claude を簡単に切替可能）。
   */
  const handleChangeSlotProvider = async (
    slotId: string,
    provider: Provider,
  ) => {
    const target = focusedThread;
    if (!target) return;
    const slots = effectiveParticipants(target);
    const slot = slots.find((s) => s.id === slotId);
    if (!slot || slot.provider === provider) return;

    // 該当 slot の subprocess を止めて、新 provider で spawn し直す
    const sid = makeSlotSid(target.id, slotId, true);
    await agentStop(sid).catch(() => {});
    sessionsStartedRef.current.delete(sid);

    updateThread(target.id, (t) => {
      if (!t.participants) return t;
      return {
        ...t,
        participants: t.participants.map((p) =>
          p.id === slotId ? { ...p, provider } : p,
        ),
        updatedAt: Date.now(),
      };
    });
  };

  /**
   * 「覚えてほしいこと」（persistentMemory）の更新ハンドラ。
   *
   * - 値は thread に保存（再起動後も保持）
   * - 既存 subprocess セッションは system_prompt が古いまま固まっているので、
   *   `workspace` 変更時と同様に slot ごとに kill して、次の send で新メモを乗せて再 spawn させる
   * - 並列モードは全 slot を、単独モードは thread.id をそのまま session id として使っている
   */
  const handleChangePersistentMemory = async (memo: string) => {
    const target = focusedThread;
    if (!target) return;
    const slots = effectiveParticipants(target);
    const parallel = slots.length >= 2;
    if (parallel) {
      await Promise.all(
        slots.map((slot) => {
          const sid = makeSlotSid(target.id, slot.id, parallel);
          sessionsStartedRef.current.delete(sid);
          return agentStop(sid).catch(() => {});
        }),
      );
    } else {
      await agentStop(target.id).catch(() => {});
      sessionsStartedRef.current.delete(target.id);
    }
    updateThread(target.id, (t) => ({
      ...t,
      persistentMemory: memo,
      // メモ書き換えで履歴順序が動くのは UX ノイズなので updatedAt は触らない
    }));
  };

  /**
   * ワークスペース選択 → Trust チェック → ステータスを返す。
   *
   * 戻り値 null = キャンセル / 未選択。
   * trusted=true なら通常通り、trusted=false なら制限モードでセット。
   */
  const pickWorkspaceWithTrust = async (): Promise<
    { path: string; trusted: boolean } | null
  > => {
    // 直前に開いていたフォルダをダイアログの初期表示位置にする。
    // 新しいターミナル/会話を始める時にユーザーが毎回フォルダを探し直さずに済む。
    const ws = await pickWorkspace({
      defaultPath: activeThread?.workspace ?? loadLastWorkspace(),
    });
    if (!ws) return null;
    const ok = await isWorkspaceTrusted(ws);
    if (ok) return { path: ws, trusted: true };
    const decision = await new Promise<"trusted" | "restricted" | "cancel">(
      (resolve) => {
        setTrustPrompt({ path: ws, resolve });
      },
    );
    setTrustPrompt(null);
    if (decision === "cancel") return null;
    if (decision === "trusted") {
      await trustWorkspace(ws);
      return { path: ws, trusted: true };
    }
    setRestrictedWorkspaces((prev) => {
      const next = new Set(prev);
      next.add(ws);
      return next;
    });
    return { path: ws, trusted: false };
  };

  const handleChangeWorkspace = async () => {
    if (!activeThread) return;
    const picked = await pickWorkspaceWithTrust();
    if (!picked) return;
    const ws = picked.path;
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
    saveLastWorkspace(ws);
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
      slot.role === "moderator" ? undefined : thread.permissionMode,
    );
    // Memory.md 方式: スレッドに紐づく "覚えてほしいこと" があれば最先頭に前置きする。
    // moderator は中立審判なのでメモは食わせない（人格汚染を避ける）。
    const memo =
      slot.role === "moderator" ? "" : (thread.persistentMemory ?? "").trim();
    const promptWithMemo = memo
      ? `## ユーザーが覚えてほしいこと\n\n${memo}\n\n---\n\n${effectivePrompt}`
      : effectivePrompt;
    // 既存 CLI セッションを再開できるなら渡す。
    // - Claude（slot.provider === "claude"）: thread.claudeSessionId
    // - Codex（slot.provider === "codex"）: thread.codexSessionId
    // moderator はキャラ汚染回避のため新規セッション固定（resume しない）
    const resumeCliSessionId =
      slot.role === "moderator"
        ? null
        : slot.provider === "codex"
          ? thread.codexSessionId ?? null
          : slot.provider === "claude"
            ? thread.claudeSessionId ?? null
            : null;

    // ── 会話履歴の自動継承 ──
    // resumeCliSessionId が null（= この AI でこのスレッドが初起動）かつ既に過去の
    // 会話メッセージがある場合、別の AI で進行していた会話の続きを引き継ぐため、
    // 直近のやり取りを systemPrompt に「これまでの会話履歴」として注入する。
    // 例: Claude で 5往復 → Codex に切替 → Codex 初回 spawn 時、
    //     Claude とのやり取りを Codex の systemPrompt に貼り付けて続きから対応させる。
    const isFreshSpawn = resumeCliSessionId == null;
    const hasHistory =
      thread.messages.length > 0 && slot.role !== "moderator";
    const historyBlock =
      isFreshSpawn && hasHistory
        ? buildConversationHistoryContext(thread.messages, 5)
        : "";
    const promptWithHistory = historyBlock
      ? `${promptWithMemo}\n\n---\n\n${historyBlock}`
      : promptWithMemo;

    // worktree 隔離（v0.4.0）: 並列・議論モードでは AI ごとに独立した作業場（git worktree）を切る。
    // 失敗（git 管理外・コミット無し）は従来どおり同じフォルダで続行し、警告を1回だけ出す。
    let slotCwd = thread.workspace;
    if (thread.workspace && shouldIsolate(thread, slot)) {
      try {
        const info = await worktreePrepare(thread.workspace, thread.id, slot.id);
        slotCwd = info.path;
        if (slot.worktreePath !== info.path || slot.worktreeBranch !== info.branch) {
          updateThread(thread.id, (t) => withSlotWorktree(t, slot.id, info));
        }
      } catch (e) {
        const key = `${thread.id}:isolation`;
        if (!isolationWarnedRef.current.has(key)) {
          isolationWarnedRef.current.add(key);
          showToast(
            `AIごとの作業場を分けられないため、同じフォルダで実行します: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
        }
      }
    }

    await agentStart({
      sessionId: sid,
      workspace: slotCwd,
      systemPrompt: promptWithHistory,
      model: thread.model,
      authMode: settings.authMode,
      apiKey,
      provider: slot.provider,
      resumeCliSessionId,
      permissionMode: toCliPermissionMode(thread.permissionMode),
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
    const text = `直前のエラーを助けてほしいです。

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

  const handleSendForThread = async (
    text: string,
    thread: Thread,
    attachments?: MessageAttachment[],
  ) => {
    // 添付画像は「パスの文字列」ではなく本物の画像として CLI に渡す。
    // 従来はワークスペース外のパスを AI に開かせていたため、Claude Code の
    // 「ワークスペース外の読み取りには許可が要る」に必ず引っかかっていた
    // （2026-09-01 実測で再現）。渡せない形式（SVG 等）は除かれ、その場合は
    // 本文のパス行が残るので従来動作に戻るだけ。
    const inlineImages = inlineableImages(attachments);

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

    // 他ペイン参照モード ON のスレッドは、他ペインの直近会話をユーザーメッセージ先頭に
    // [参考情報] として差し込む。AI は systemPrompt と本文の両方を読むので、毎回最新の
    // 他ペイン状況を見せられる（systemPrompt は spawn 時固定なので peek 用途には不向き）。
    let textWithPeek = text;
    if (peekPaneIds.has(thread.id)) {
      const allPaneIds = [
        ...(activeId ? [activeId] : []),
        ...splitIds,
      ];
      const peekBlock = buildPeekOtherPanesContext(
        thread.id,
        allPaneIds,
        threadsRef.current,
      );
      if (peekBlock) {
        textWithPeek = `${peekBlock}\n\n---\n\n[ユーザーからのメッセージ]\n${text}`;
      }
    }

    const userMsg = {
      id: nanoid(8),
      role: "user" as const,
      content: textWithPeek,
      attachments,
      createdAt: Date.now(),
    };
    const next = appendMessage(thread, userMsg);
    updateThread(thread.id, () => next);

    // 差分ビュー（v0.4.0）: ターン開始時の作業ツリーを git の tree として記録しておく
    // （利用者の index/HEAD は動かさない）。AI が動く前に取るため await する。
    // 失敗（git 管理外など）は黙って HEAD 比較に落ちる。今ターンで初めて作られる worktree は
    // HEAD から切られるので、記録が無くても HEAD 比較で正しい。
    if (thread.workspace) {
      const pairs = await Promise.all(
        snapshotCwds(next).map(
          async (cwd) => [cwd, await workspaceSnapshot(cwd).catch(() => null)] as const,
        ),
      );
      const trees: Record<string, string> = {};
      for (const [cwd, tree] of pairs) if (tree) trees[cwd] = tree;
      updateThread(thread.id, (t) => withTurnBase(t, trees));
    }

    // 議論モード（conferenceMode + N-way）は Sequential：A→B→C と順番に喋らせて、
    // 後の参加者は前の発言を文脈として受け取る。
    // それ以外（並列モード非議論 / 単独モード）は従来通り並列同時送信。
    const sequential = thread.conferenceMode && parallel && slots.length >= 2;

    if (sequential) {
      // 直列: 各 slot を順番に処理。draft 初期化はその slot を呼ぶ直前にやる。
      let prevSpeakerLabel: string | null = null;
      let prevResponse: string | null = null;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const sid = makeSlotSid(thread.id, slot.id, parallel);

        // この slot だけ draft 初期化＋streaming 開始
        draftsRef.current = {
          ...draftsRef.current,
          [sid]: FRESH_DRAFT(thread.id, slot),
        };
        setDrafts(draftsRef.current);
        setStreamingSids((prev) => new Set([...prev, sid]));

        // 前の発言があれば文脈として前置注入。最初の話者には素のテキスト。
        const promptForSlot =
          prevResponse && prevSpeakerLabel
            ? `直前に【${prevSpeakerLabel}】が次のように発言しました:\n\n${prevResponse}\n\n---\n\n上記をふまえ、自分の立場から応答してください。\n\n[ユーザーの最初の発言]\n${text}`
            : text;

        try {
          await ensureSlotSession(thread, slot);
          // 完了 Promise を agentSend より先に登録（resolve 取りこぼし防止）
          const completion = awaitSlotCompletion(sid);
          await agentSend(sid, promptForSlot, inlineImages);
          await completion;

          // 完了したら自分の応答を取り出して次へ渡す
          const updatedThread = threadsRef.current.find(
            (t) => t.id === thread.id,
          );
          const myMsg = updatedThread?.messages
            .slice()
            .reverse()
            .find(
              (m) =>
                m.role === "assistant" && m.participantSlotId === slot.id,
            );
          if (myMsg) {
            prevResponse = myMsg.content;
            const character = getCharacter(slot.characterId);
            const providerLabel =
              slot.provider === "claude" ? "Claude" : slot.provider === "codex" ? "Codex" : "Gemini";
            prevSpeakerLabel = character?.name
              ? `${character.name}（${providerLabel}）`
              : providerLabel;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errMsg = {
            id: nanoid(8),
            role: "assistant" as const,
            content: tr("page.assistant.startupError", {
              provider: slot.provider,
              message,
            }),
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
          // resolver を解放（leak 防止）
          slotCompletionResolversRef.current.delete(sid);
          // エラーが出た slot は飛ばして次へ
        }
      }
      return;
    }

    // 並列パス（従来）：全 slot を同時に start
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
        await agentSend(sid, text, inlineImages);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errMsg = {
          id: nanoid(8),
          role: "assistant" as const,
          content: tr("page.assistant.startupError", {
            provider: slot.provider,
            message,
          }),
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

  /** thread が応答中（いずれかの slot が streaming）か。ref 経由で常に最新。 */
  const isThreadBusy = (thread: Thread): boolean => {
    const parallel = isThreadParallel(thread);
    return effectiveParticipants(thread).some((slot) =>
      streamingSidsRef.current.has(makeSlotSid(thread.id, slot.id, parallel)),
    );
  };

  /**
   * ChatPane からの送信入口。応答中ならキューに積み（ターミナル風連投）、
   * アイドルなら即送信。flush は streamingSids 変化の useEffect で行う。
   */
  const submitOrQueue = (
    text: string,
    thread: Thread,
    attachments?: MessageAttachment[],
  ) => {
    const value = text.trim();
    if (!value && (!attachments || attachments.length === 0)) return;
    if (isThreadBusy(thread)) {
      const q = enqueuedSendsRef.current[thread.id] ?? [];
      q.push({ text: value, attachments });
      enqueuedSendsRef.current[thread.id] = q;
      setEnqueuedCounts((prev) => ({ ...prev, [thread.id]: q.length }));
      return;
    }
    void handleSendForThread(value, thread, attachments);
  };

  const handleRenameThread = (id: string, title: string) => {
    const value = title.trim();
    if (!value) return;
    updateThread(id, (t) => ({
      ...t,
      title: value,
      titleEdited: true,
      updatedAt: Date.now(),
    }));
  };

  // アイドルに戻った thread のキュー先頭を 1 件送出。streamingSids が
  // 変わるたびに評価し、busy が解けた瞬間に次を流す。handleSendForThread は
  // 同期的に setStreamingSids するので二重送出にはならない。
  useEffect(() => {
    for (const [tid, q] of Object.entries(enqueuedSendsRef.current)) {
      if (!q || q.length === 0) continue;
      const thread = threadsRef.current.find((t) => t.id === tid);
      if (!thread) {
        delete enqueuedSendsRef.current[tid];
        setEnqueuedCounts((prev) => {
          const n = { ...prev };
          delete n[tid];
          return n;
        });
        continue;
      }
      if (isThreadBusy(thread)) continue;
      const next = q.shift();
      if (next === undefined) continue;
      setEnqueuedCounts((prev) => ({ ...prev, [tid]: q.length }));
      void handleSendForThread(next.text, thread, next.attachments);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamingSids]);

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

  /**
   * 「resume failed: claude --resume <死んだsid> でハング」自動回復ウォッチドッグ。
   *
   * - 30秒以上ブロックが0でかつ claude/codex session id が保存されてる draft を検出
   * - 1度だけ自動で sid を破棄して新規セッションで再起動を試みる（無限ループ防止に Set 管理）
   * - 失敗を会話末尾に明示し、未送信ユーザーメッセージを再送する
   *
   * 既に session が応答してれば（少なくとも cli_session_id イベントは即届く）firstTextAt
   * か blocks.length > 0 になるので、ここには引っかからない。
   */
  const resumeRecoveredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const RESUME_STUCK_MS = 30_000;
      const drafts = draftsRef.current;
      for (const [sid, d] of Object.entries(drafts)) {
        if (!d) continue;
        if (resumeRecoveredRef.current.has(sid)) continue;
        if (d.blocks.length > 0) continue;
        if (now - d.startedAt < RESUME_STUCK_MS) continue;
        const thread = threadsRef.current.find((t) => t.id === d.threadId);
        if (!thread) continue;
        const slot = effectiveParticipants(thread).find(
          (s) => s.id === d.slotId,
        );
        if (!slot) continue;
        // resume_cli_session_id が無いケース（純粋な無音）は対象外。
        // CLI 側のバグや認証問題を強引に新規起動で踏み抜く副作用を避ける。
        const cliSid =
          slot.provider === "codex"
            ? thread.codexSessionId
            : slot.provider === "claude"
              ? thread.claudeSessionId
              : null;
        if (!cliSid) continue;
        resumeRecoveredRef.current.add(sid);
        // 直近のユーザーメッセージ（直前の send）を回収して再送する。
        const lastUserMsg = [...thread.messages]
          .reverse()
          .find((m) => m.role === "user");
        const retryText = lastUserMsg?.content ?? null;
        // 1) 古いセッション破棄
        finalizeDraft(sid);
        sessionsStartedRef.current.delete(sid);
        void agentStop(sid).catch(() => {});
        // 2) thread の壊れた cli_session_id をクリア（型上は string|undefined なので undefined を入れる）
        updateThread(thread.id, (t) => ({
          ...t,
          claudeSessionId:
            slot.provider === "claude" ? undefined : t.claudeSessionId,
          codexSessionId:
            slot.provider === "codex" ? undefined : t.codexSessionId,
        }));
        // 3) 失敗を会話末尾に明示
        const noticeMsg = {
          id: nanoid(8),
          role: "assistant" as const,
          content: tr("page.assistant.autoRecover"),
          createdAt: Date.now(),
          provider: slot.provider,
          participantSlotId: slot.id,
        };
        updateThread(thread.id, (t) => appendMessage(t, noticeMsg));
        // 4) ユーザーメッセージを再送（ある場合のみ）
        if (retryText) {
          setTimeout(() => {
            const fresh = threadsRef.current.find((t) => t.id === thread.id);
            if (fresh) {
              void handleSendForThread(retryText, fresh);
            }
          }, 250);
        }
      }
    }, 5_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePermissionDecision = async (
    decision: "allow" | "deny" | "allow_once",
  ) => {
    if (!pendingPermission) return;
    const answered = pendingPermission;
    try {
      await agentPermissionResponse(
        answered.sessionId,
        answered.requestId,
        decision,
      );
    } catch (e) {
      // セッションが既に閉じている等で返信に失敗しても、行列は必ず進める。
      // ここで止まるとモーダルが閉じられなくなり、以降の操作が全部できなくなる。
      console.error("[unicrew] permission response failed", e);
    } finally {
      setPermissionQueue((queue) =>
        queue.filter((q) => q.requestId !== answered.requestId),
      );
    }
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

  // 並列ペインの実体（順序維持）。削除済み ID は事前に弾く。
  const splitThreads: Thread[] = splitIds
    .map((id) => threads.find((t) => t.id === id))
    .filter((t): t is Thread => !!t);
  const splitThread = splitThreads[0] ?? null; // 旧: 1ペイン目（互換用）

  const primaryDrafts = buildThreadDrafts(activeThread);
  const primaryStreaming = isThreadStreaming(activeThread);
  // 並列ペインそれぞれの drafts / streaming
  const splitPaneStates = splitThreads.map((t) => ({
    thread: t,
    drafts: buildThreadDrafts(t),
    streaming: isThreadStreaming(t),
  }));

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
      // 既に並列ペインにあれば追加しない（ただし最大数までは増やせる）
      setSplitIds((prev) => {
        if (prev.includes(id)) return prev;
        if (prev.length >= MAX_SPLIT_PANES) return prev;
        return [...prev, id];
      });
      return;
    }
    // 主ペインに開く時の挙動：
    // クリックしたスレッドが既に並列ペインに居る場合は、旧主ペインを「クリック先の位置」に
    // 差し込んで入れ替える（pane の総数を減らさない）。並列モードを維持したまま見たい
    // ペインを主ペインに引き出すイメージ。
    // クリックしたスレッドが並列ペインに居なければ、splitIds はそのままで activeId のみ差替。
    if (id === activeId) return;
    if (splitIds.includes(id) && activeId) {
      const oldActive = activeId;
      setSplitIds((prev) => prev.map((x) => (x === id ? oldActive : x)));
    }
    setActiveId(id);
    // サイドバーで主ペインを切り替えたら、RightPane のフォーカスは新 activeId に追従させる。
    setFocusedThreadId(null);
  };

  const totalPanes = 1 + splitThreads.length;
  const showSplit = splitThreads.length > 0;
  const isEmpty = threads.length === 0;

  // Shift+Tab ハンドラ用に最新の toggle 関数を ref に流し込む
  togglePermissionModeRef.current = togglePermissionMode;

  // ESC ショートカット用に最新値を ref に流し込む
  abortContextRef.current = {
    primaryThread: activeThread,
    splitThreads: splitPaneStates.map((s) => ({
      thread: s.thread,
      streaming: s.streaming,
    })),
    primaryStreaming,
    abortThread: handleAbortForThread,
    abortAll: handleAbortAll,
  };
  // 「あなた」アバター用の userProfile を AppSettings から派生。
  // ChatPane → MessageItem まで流して、ユーザー側メッセージのアイコン・表示名に使う。
  const userProfile = {
    displayName: settings.userDisplayName,
    avatarPath: settings.userAvatarPath ?? null,
    emoji: settings.userEmoji,
    accentColor: settings.userAccentColor,
  };

  // クラウドリレーは別の useEffect 内 setInterval で heartbeat する（subscribe 非同期対応）
  activeIdRef.current = activeId;
  // Command Palette が表示するコマンド配列。毎レンダ再計算（state を捕まえるため）。
  const paletteCommands: Command[] = (() => {
    const list: Command[] = [
      {
        id: "thread.new",
        label: tr("palette.thread.new"),
        category: tr("palette.category.action"),
        description: tr("palette.thread.new.desc"),
        shortcut: "Ctrl+N",
        icon: Plus,
        keywords: ["new", "create", "thread", "あたらしい", "かいわ"],
        run: () => {
          setMainView("chat");
          handleCreate();
        },
      },
      {
        id: "workspace.change",
        label: tr("palette.workspace.change"),
        category: tr("palette.category.action"),
        description: activeThread?.workspace ?? tr("palette.workspace.unset"),
        icon: IconFolderOpen,
        keywords: ["folder", "ws", "workspace", "ふぉるだ"],
        run: () => {
          void handleChangeWorkspace();
        },
        enabled: !!activeThread,
      },
      {
        id: "explorer.toggle",
        label: explorerOpen
          ? tr("palette.explorer.close")
          : tr("palette.explorer.open"),
        category: tr("palette.category.view"),
        icon: IconFolderTree,
        keywords: ["explorer", "tree", "ファイル"],
        run: () => setExplorerOpen((v) => !v),
      },
      {
        id: "split.toggle",
        label:
          splitIds.length > 0
            ? tr("palette.split.closeAll", { count: splitIds.length })
            : tr("palette.split.open"),
        category: tr("palette.category.view"),
        icon: IconColumns2,
        keywords: ["split", "pane", "へいれつ"],
        run: () => {
          if (splitIds.length > 0) handleCloseSplitPane();
          else handleOpenSplitPane();
        },
      },
      {
        id: "view.chat",
        label: tr("palette.view.chat"),
        category: tr("palette.category.view"),
        icon: MessageSquare,
        run: () => setMainView("chat"),
        enabled: mainView !== "chat",
      },
      {
        id: "view.addons",
        label: tr("palette.view.addons"),
        category: tr("palette.category.view"),
        icon: IconPuzzle,
        keywords: ["plugin", "skill", "mcp", "addons"],
        run: () => setMainView("addons"),
        enabled: mainView !== "addons",
      },
      {
        id: "settings.open",
        label: tr("palette.settings.open"),
        category: tr("palette.category.action"),
        icon: IconSettings,
        shortcut: "Ctrl+,",
        keywords: ["settings", "config", "せってい"],
        run: () => setSettingsOpen(true),
      },
      {
        id: "uni-mcp.open",
        label: tr("palette.uniMcp.open"),
        category: tr("palette.category.action"),
        icon: Network,
        keywords: ["uni", "mcp", "connect"],
        run: () => setUniMcpOpen(true),
      },
      {
        id: "routines.open",
        label: tr("palette.routines.open"),
        category: tr("palette.category.action"),
        icon: CalendarClock,
        keywords: ["routine", "schedule", "cron", "ていきじっこう"],
        run: () => setRoutinesOpen(true),
      },
      {
        id: "rc.open",
        label: tr("palette.rc.open"),
        category: tr("palette.category.action"),
        icon: Smartphone,
        keywords: ["remote", "control", "phone", "official"],
        run: () => setRcOpen(true),
      },
      {
        id: "queue.toggle",
        label: taskQueueOpen
          ? tr("palette.queue.hide")
          : tr("palette.queue.show"),
        category: tr("palette.category.view"),
        icon: ListChecks,
        keywords: ["task", "queue", "tasks"],
        run: () => setTaskQueueOpen((v) => !v),
      },
      {
        id: "beginner.toggle",
        label: settings.beginnerMode
          ? tr("palette.beginner.off")
          : tr("palette.beginner.on"),
        category: tr("palette.category.settings"),
        icon: Sparkles,
        keywords: ["beginner", "mode", "しょしんしゃ"],
        run: () => {
          const next = !(settings.beginnerMode ?? true);
          const updated = {
            ...settings,
            beginnerMode: next,
            showActivity: !next,
          };
          setSettings(updated);
          saveSettings(updated);
        },
      },
      {
        id: "abort.all",
        label: tr("palette.abort.all"),
        category: tr("palette.category.action"),
        icon: CircleStop,
        shortcut: "Ctrl+Shift+C",
        keywords: ["stop", "abort", "ていし"],
        run: () => handleAbortAll(),
      },
      {
        id: "feedback.open",
        label: tr("palette.feedback.open"),
        category: tr("palette.category.help"),
        icon: HelpCircle,
        run: () => {
          setFeedbackVisible(true);
          markFeedbackShown();
          setMainView("chat");
        },
      },
      {
        id: "walkthrough.replay",
        label: tr("palette.walkthrough.replay"),
        category: tr("palette.category.help"),
        description: tr("palette.walkthrough.replay.desc"),
        icon: Sparkles,
        keywords: ["walkthrough", "tutorial", "onboarding", "オンボ"],
        run: () => {
          resetWalkthrough();
          setWalkthroughOpen(true);
        },
      },
      {
        id: "whatsnew.show",
        label: tr("palette.whatsnew.show", { version: UNICREW_VERSION }),
        category: tr("palette.category.help"),
        icon: Sparkles,
        keywords: ["whats new", "release", "リリース", "新機能"],
        run: () => {
          resetWhatsNew();
          setWhatsNewOpen(true);
        },
      },
      {
        id: "trust.list",
        label: tr("palette.trust.list"),
        category: tr("palette.category.help"),
        description: tr("palette.trust.list.desc"),
        icon: HelpCircle,
        keywords: ["trust", "trusted", "workspace", "信頼"],
        run: async () => {
          const list = await import("@/lib/trust").then((m) =>
            m.listTrustedWorkspaces(),
          );
          if (list.length === 0) {
            alert(tr("page.alert.noTrustedFolders"));
          } else {
            alert(tr("page.alert.trustedFoldersList", { list: list.join("\n") }));
          }
        },
      },
      {
        id: "otel.status",
        label: tr("palette.otel.status"),
        category: tr("palette.category.help"),
        description: tr("palette.otel.status.desc"),
        icon: HelpCircle,
        keywords: ["otel", "observability", "telemetry", "観測", "ログ"],
        run: async () => {
          const s = await import("@/lib/observability").then((m) =>
            m.observabilityStatus(),
          );
          alert(
            tr("page.alert.otelStatus", {
              state: s.active
                ? tr("page.alert.otelActive")
                : tr("page.alert.otelInactive"),
              endpoint: s.endpoint ?? tr("page.alert.otelEndpointUnset"),
              note: s.note,
            }),
          );
        },
      },
      {
        id: "github.open",
        label: tr("palette.github.open"),
        category: tr("palette.category.help"),
        icon: Github,
        run: () =>
          window.open(
            "https://github.com/takayukiyukii-commits/unicrew",
            "_blank",
          ),
      },
      {
        id: "issues.open",
        label: tr("palette.issues.open"),
        category: tr("palette.category.help"),
        icon: Bug,
        run: () =>
          window.open(
            "https://github.com/takayukiyukii-commits/unicrew/issues",
            "_blank",
          ),
      },
    ];

    // チームテンプレ → 新規スレッド
    const teams = [...loadUserTeams(), ...TEMPLATE_TEAMS];
    for (const team of teams) {
      list.push({
        id: `team.${team.id}`,
        label: tr("palette.team.prefix", { name: team.name }),
        category: tr("palette.category.team"),
        icon: Workflow,
        run: () => {
          setMainView("chat");
          void handleCreateFromTeam(team.id);
        },
      });
    }

    // キャラクター切替（activeThread がある場合のみ）
    if (activeThread) {
      const chars = getAllCharacters();
      for (const ch of chars) {
        list.push({
          id: `char.${ch.id}`,
          label: tr("palette.character.prefix", { name: ch.name }),
          category: tr("palette.category.character"),
          description: ch.roleTag,
          icon: IconUser,
          run: () => {
            void handleChangeCharacter(ch.id);
          },
        });
      }
    }

    // 既存スレッドへ移動
    for (const th of threads) {
      list.push({
        id: `thread.go.${th.id}`,
        label: tr("palette.thread.prefix", { title: th.title }),
        category: tr("palette.category.thread"),
        description: getCharacter(th.characterId)?.name ?? undefined,
        icon: MessageSquare,
        run: () => {
          setMainView("chat");
          handleSidebarSelect(th.id);
        },
        enabled: th.id !== activeId,
      });
    }

    return list;
  })();

  const menuDefs: MenuDef[] = [
    {
      id: "file",
      label: tr("menu.file"),
      items: [
        {
          label: tr("menu.file.new"),
          shortcut: "Ctrl+N",
          onSelect: () => {
            setMainView("chat");
            handleCreate();
          },
        },
        {
          label: tr("menu.file.openWorkspace"),
          onSelect: () => {
            void handleChangeWorkspace();
          },
        },
        { divider: true },
        // チームスナップ：登録済みチーム + プリセットを並べる
        ...[...loadUserTeams(), ...TEMPLATE_TEAMS].map((team) => ({
          label: team.name,
          onSelect: () => {
            setMainView("chat");
            void handleCreateFromTeam(team.id);
          },
        })),
        { divider: true },
        {
          label: tr("menu.file.importTeamJson"),
          onSelect: () => handleImportTeamJson(),
        },
        { divider: true },
        {
          label: tr("menu.file.uniMcp"),
          onSelect: () => setUniMcpOpen(true),
        },
        {
          label: tr("menu.file.routines"),
          onSelect: () => setRoutinesOpen(true),
        },
        {
          label: tr("menu.file.remoteControl"),
          onSelect: () => setRcOpen(true),
        },
        { divider: true },
        {
          label: tr("menu.file.settings"),
          shortcut: "Ctrl+,",
          onSelect: () => setSettingsOpen(true),
        },
      ],
    },
    {
      id: "edit",
      label: tr("menu.edit"),
      items: [
        {
          label: tr("menu.edit.copy"),
          shortcut: "Ctrl+C",
          onSelect: () => document.execCommand("copy"),
        },
        {
          label: tr("menu.edit.paste"),
          shortcut: "Ctrl+V",
          onSelect: () => document.execCommand("paste"),
        },
        {
          label: tr("menu.edit.selectAll"),
          shortcut: "Ctrl+A",
          onSelect: () => document.execCommand("selectAll"),
        },
      ],
    },
    {
      id: "view",
      label: tr("menu.view"),
      items: [
        {
          label:
            mainView === "chat"
              ? tr("menu.view.chatCurrent")
              : tr("menu.view.chatSwitch"),
          onSelect: () => setMainView("chat"),
        },
        {
          label:
            mainView === "addons"
              ? tr("menu.view.addonsCurrent")
              : tr("menu.view.addonsOpen"),
          onSelect: () => setMainView("addons"),
        },
        { divider: true },
        {
          label: settings.beginnerMode
            ? tr("menu.view.beginnerOn")
            : tr("menu.view.beginnerOff"),
          onSelect: () => {
            const next = !(settings.beginnerMode ?? true);
            const updated = {
              ...settings,
              beginnerMode: next,
              showActivity: !next,
            };
            setSettings(updated);
            saveSettings(updated);
          },
        },
      ],
    },
    {
      id: "window",
      label: tr("menu.window"),
      items: [
        {
          label:
            splitIds.length > 0
              ? tr("palette.split.closeAll", { count: splitIds.length })
              : tr("palette.split.open"),
          onSelect: () => {
            if (splitIds.length > 0) handleCloseSplitPane();
            else handleOpenSplitPane();
          },
        },
        {
          label: taskQueueOpen
            ? tr("palette.queue.hide")
            : tr("palette.queue.show"),
          onSelect: () => setTaskQueueOpen((v) => !v),
        },
        { divider: true },
        {
          label: tr("palette.abort.all"),
          shortcut: "Ctrl+Shift+C",
          onSelect: () => handleAbortAll(),
        },
      ],
    },
    {
      id: "help",
      label: tr("menu.help"),
      items: [
        {
          label: tr("menu.help.feedback"),
          onSelect: () => {
            setFeedbackVisible(true);
            markFeedbackShown();
            setMainView("chat");
          },
        },
        { divider: true },
        {
          label: tr("menu.help.github"),
          onSelect: () =>
            window.open(
              "https://github.com/takayukiyukii-commits/unicrew",
              "_blank",
            ),
        },
        {
          label: tr("menu.help.issues"),
          onSelect: () =>
            window.open(
              "https://github.com/takayukiyukii-commits/unicrew/issues",
              "_blank",
            ),
        },
        { divider: true },
        {
          label: tr("menu.help.version"),
          onSelect: () => {
            void (async () => {
              let v = "";
              try {
                const { getVersion } = await import("@tauri-apps/api/app");
                v = await getVersion();
              } catch {
                /* noop */
              }
              const head = v ? `UNICREW v${v}

` : "";
              alert(head + tr("page.alert.versionInfo"));
            })();
          },
        },
      ],
    },
  ];

  return (
    <ActivityVisibilityContext.Provider value={settings.showActivity}>
      <div className="h-screen w-screen flex flex-col bg-white overflow-hidden">
        <AppMenuBar
          menus={menuDefs}
          onCheckUpdates={async () => {
            // plugin-updater で GitHub Releases の latest.json を実チェックする。
            // （旧実装は未配線で、メニューバーのボタンは常に「最新版です」を
            //   返すだけのダミーだった。2026-08-14 修正）
            const r = await checkUnicrewUpdate();
            if (!r) {
              return { hasUpdate: false, message: tr("appmenu.checkFailed") };
            }
            if (r.available) {
              return {
                hasUpdate: true,
                message: tr("appmenu.newVersion", { version: r.version }),
              };
            }
            return { hasUpdate: false };
          }}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div className="flex-1 min-h-0 flex">
        <Sidebar
          threads={threads}
          activeThreadId={activeId}
          splitThreadIds={splitIds}
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
          onRename={handleRenameThread}
          onOpenSettings={() => setSettingsOpen(true)}
          mainView={mainView}
          onOpenAddons={() => setMainView("addons")}
          onOpenTerminal={
            settings.beginnerMode === false
              ? () => setMainView("terminal")
              : undefined
          }
          explorerOpen={explorerOpen}
          onToggleExplorer={() => {
            setExplorerOpen((v) => {
              const next = !v;
              // 閉じる時に「手動展開」フラグをリセット → 次に開いた時はまた畳まれる
              if (!next) setSidebarManuallyExpanded(false);
              return next;
            });
          }}
          collapsed={explorerOpen && !sidebarManuallyExpanded}
          onExpand={() => setSidebarManuallyExpanded(true)}
        />
        {explorerOpen && (() => {
          const ws = activeThread?.workspace ?? null;
          const restricted = !!ws && restrictedWorkspaces.has(ws);
          return (
            <ExplorerPanel
              workspace={ws}
              restricted={restricted}
              onPickWorkspace={() => {
                // 単一の workspace 状態 (= activeThread.workspace) を更新する。
                // セッション再起動・トラスト処理込みで handleChangeWorkspace が一手に担う。
                void handleChangeWorkspace();
              }}
              onClose={() => setExplorerOpen(false)}
              onSelectFile={(path) => {
                void openFileInEditorWindow(path);
              }}
            />
          );
        })()}
        {/* ターミナル表示中はチャット系UIを display:none で隠す（アンマウントしない）。
            contents ラッパは layout box を作らないので、内部の flex-1 ペインは
            これまで通りメイン行の直接の子として振る舞う。 */}
        <div className={mainView === "terminal" ? "hidden" : "contents"}>
        {mainView === "addons" ? (
          <main className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-white">
            <div className="max-w-5xl mx-auto px-6 py-8">
              <header className="mb-6">
                <h1 className="text-[22px] font-bold tracking-tight">
                  {tr("page.addons.title")}
                </h1>
                <p className="text-[13px] text-[var(--color-muted)] mt-1 leading-relaxed">
                  {tr("page.addons.subtitle1")}
                  <br />
                  {tr("page.addons.subtitle2")}
                </p>
              </header>
              <AddonsSection
                initialTab={addonsTab}
                workspace={activeThread?.workspace ?? null}
                advancedMode={settings.advancedMode ?? false}
                autoCheckAddonUpdates={settings.autoCheckAddonUpdates ?? true}
                autoApplyAddonUpdates={settings.autoApplyAddonUpdates ?? false}
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
            onStartFreeMode={() => setFreeModeOpen(true)}
            onApplyPreset={(preset) => void handleApplyPreset(preset)}
          />
        ) : totalPanes >= 3 ? (
          // 3ペイン以上は CSS Grid で 3列 ×（必要なら）2段に並べる。
          // 横一列だと細くて読めなくなるため、4ペイン目以降は下段に折り返す。
          // 1セル目=主ペイン、2..6セル目=splitThreads[0..4]
          <div
            ref={paneAreaRef}
            className="flex-1 min-w-0 min-h-0 grid gap-px bg-[var(--color-border)]"
            style={{
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gridTemplateRows:
                totalPanes > 3 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)",
            }}
          >
            <div
              className={`bg-white flex flex-col min-w-0 min-h-0 ring-inset transition ${
                focusedThread?.id === activeThread?.id
                  ? "ring-2 ring-[var(--color-accent)]"
                  : "ring-0 cursor-pointer"
              }`}
              onClick={() => {
                if (activeThread) setFocusedThreadId(activeThread.id);
              }}
              title={tr("page.pane.focusHint")}
            >
              <ChatPane
                thread={activeThread}
                paneRole="primary"
                isStreaming={primaryStreaming}
                threadDrafts={primaryDrafts}
                userProfile={userProfile}
                onSend={(text, attachments) =>
                  activeThread && submitOrQueue(text, activeThread, attachments)
                }
                queuedCount={
                  activeThread ? enqueuedCounts[activeThread.id] ?? 0 : 0
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
                peekActive={
                  activeThread ? peekPaneIds.has(activeThread.id) : false
                }
                onTogglePeek={
                  activeThread
                    ? () => togglePeekForThread(activeThread.id)
                    : undefined
                }
                onTogglePermissionMode={
                  activeThread ? togglePermissionMode : undefined
                }
                onSuggestNewThread={
                  activeThread ? () => void handleCreateInstant("primary") : undefined
                }
                feedbackSlot={
                  feedbackVisible ? (
                    <FeedbackCard
                      appVersion={appVersion}
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
            {splitPaneStates.map(({ thread: t, drafts, streaming }) => (
              <div
                key={t.id}
                className={`bg-white flex flex-col min-w-0 min-h-0 ring-inset transition ${
                  focusedThread?.id === t.id
                    ? "ring-2 ring-[var(--color-accent)]"
                    : "ring-0 cursor-pointer"
                }`}
                onClick={() => setFocusedThreadId(t.id)}
                title={tr("page.pane.focusHint")}
              >
                <ChatPane
                  thread={t}
                  paneRole="split"
                  isStreaming={streaming}
                  threadDrafts={drafts}
                  userProfile={userProfile}
                  onSend={(text, attachments) => submitOrQueue(text, t, attachments)}
                  queuedCount={enqueuedCounts[t.id] ?? 0}
                  onAbort={() => handleAbortForThread(t)}
                  onSplit={handleOpenSplitPane}
                  onCloseSplit={() => handleCloseSplitPane(t.id)}
                  onSolo={() => handleSoloPane(t.id)}
                  onContinueConference={() => handleContinueConference(t)}
                  onExecuteCommand={(cmd, lang) =>
                    handleExecuteCommand(cmd, lang, t)
                  }
                  onSosForError={(err) => handleSosForError(err, t)}
                  peekActive={peekPaneIds.has(t.id)}
                  onTogglePeek={() => togglePeekForThread(t.id)}
                  onTogglePermissionMode={togglePermissionMode}
                  onSuggestNewThread={() => void handleCreateInstant("split")}
                />
              </div>
            ))}
          </div>
        ) : (
          // 1〜2ペインは従来の flex + リサイザでそのまま運用
          <div ref={paneAreaRef} className="flex-1 flex min-w-0 min-h-0">
            <div
              className={`flex flex-col min-w-0 min-h-0 ring-inset transition ${
                showSplit && focusedThread?.id === activeThread?.id
                  ? "ring-2 ring-[var(--color-accent)]"
                  : "ring-0"
              } ${showSplit ? "cursor-pointer" : ""}`}
              style={
                showSplit
                  ? { flex: `0 0 calc(${splitWidthPct}% - 2px)` }
                  : { flex: 1 }
              }
              onClick={() => {
                if (showSplit && activeThread) setFocusedThreadId(activeThread.id);
              }}
              title={showSplit ? tr("page.pane.focusHint") : undefined}
            >
              <ChatPane
                thread={activeThread}
                paneRole={showSplit ? "primary" : "single"}
                isStreaming={primaryStreaming}
                threadDrafts={primaryDrafts}
                userProfile={userProfile}
                onSend={(text, attachments) =>
                  activeThread && submitOrQueue(text, activeThread, attachments)
                }
                queuedCount={
                  activeThread ? enqueuedCounts[activeThread.id] ?? 0 : 0
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
                peekActive={
                  showSplit && activeThread
                    ? peekPaneIds.has(activeThread.id)
                    : false
                }
                onTogglePeek={
                  showSplit && activeThread
                    ? () => togglePeekForThread(activeThread.id)
                    : undefined
                }
                onTogglePermissionMode={
                  activeThread ? togglePermissionMode : undefined
                }
                onSuggestNewThread={
                  activeThread ? () => void handleCreateInstant("primary") : undefined
                }
                feedbackSlot={
                  feedbackVisible ? (
                    <FeedbackCard
                      appVersion={appVersion}
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
                <div
                  className={`flex flex-col min-w-0 min-h-0 flex-1 ring-inset transition cursor-pointer ${
                    focusedThread?.id === splitThread.id
                      ? "ring-2 ring-[var(--color-accent)]"
                      : "ring-0"
                  }`}
                  onClick={() => setFocusedThreadId(splitThread.id)}
                  title={tr("page.pane.focusHint")}
                >
                  <ChatPane
                    thread={splitThread}
                    paneRole="split"
                    isStreaming={splitPaneStates[0]?.streaming ?? false}
                    threadDrafts={splitPaneStates[0]?.drafts ?? {}}
                    userProfile={userProfile}
                    onSend={(text, attachments) =>
                      submitOrQueue(text, splitThread, attachments)
                    }
                    queuedCount={enqueuedCounts[splitThread.id] ?? 0}
                    onAbort={() => handleAbortForThread(splitThread)}
                    onSplit={handleOpenSplitPane}
                    onCloseSplit={() => handleCloseSplitPane(splitThread.id)}
                    onSolo={() => handleSoloPane(splitThread.id)}
                    onContinueConference={() =>
                      handleContinueConference(splitThread)
                    }
                    onExecuteCommand={(cmd, lang) =>
                      handleExecuteCommand(cmd, lang, splitThread)
                    }
                    onSosForError={(err) =>
                      handleSosForError(err, splitThread)
                    }
                    peekActive={peekPaneIds.has(splitThread.id)}
                    onTogglePeek={() => togglePeekForThread(splitThread.id)}
                    onTogglePermissionMode={togglePermissionMode}
                    onSuggestNewThread={() => void handleCreateInstant("split")}
                  />
                </div>
              </>
            )}
          </div>
        )}
        </div>
        {/* ターミナルは常時マウントのまま hidden で切替。ビュー切替で unmount すると
            PTY が kill され xterm バッファも消えるため、複数ペイン構成ごと状態を保持する。 */}
        <div
          className={
            mainView === "terminal"
              ? "flex-1 flex min-w-0 min-h-0 bg-[#faf9f6]"
              : "hidden"
          }
        >
          <TerminalPanes workspace={activeThread?.workspace ?? null} />
        </div>
        {mainView === "chat" && (
          <RightPane
            thread={focusedThread}
            isFocusedFromSplit={
              focusedThread != null &&
              focusedThread.id !== activeId &&
              splitIds.includes(focusedThread.id)
            }
            onChangeCharacter={handleChangeCharacter}
            onChangeSplitCharacter={handleChangeSplitCharacter}
            onChangeSlotProvider={handleChangeSlotProvider}
            onAddParticipant={handleAddParticipant}
            onRemoveParticipant={handleRemoveParticipant}
            onSaveAsTeam={handleSaveAsTeam}
            onExportTeamJson={handleExportTeamJson}
            onChangeModel={handleChangeModel}
            onChangePersistentMemory={handleChangePersistentMemory}
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
        forceOpenCategory={settingsForceCategory}
        forceOpenAccordionKey={settingsForceTick}
      />
      <FreeModeWizard
        open={freeModeOpen}
        onClose={() => setFreeModeOpen(false)}
        onCompleted={() => void handleFreeModeCompleted()}
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
      <RemoteControlModal
        open={rcOpen}
        onClose={() => setRcOpen(false)}
        workspace={activeThread?.workspace ?? null}
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
              ? tr("page.graphify.updating")
              : graphifyStatus.state === "done"
              ? tr("page.graphify.done")
              : tr("page.graphify.failed")}
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
      />
      <LanguagePickerModal
        open={languagePickerOpen}
        onClose={() => {
          setLanguagePickerOpen(false);
          // 言語ピッカー閉じた後に既存の初回フロー（Walkthrough）へ
          if (!isWalkthroughDone()) {
            setWalkthroughOpen(true);
          } else if (shouldShowWhatsNew()) {
            setWhatsNewOpen(true);
          }
        }}
      />
      <Walkthrough
        open={walkthroughOpen}
        onClose={() => setWalkthroughOpen(false)}
        onPickFirstCharacter={() => {
          // Step3 完了時に "新しい会話" 画面へ。 既存の handleCreate はキャラ Picker を開く
          handleCreate();
        }}
      />
      <WhatsNewModal open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
      <TrustPromptModal
        open={!!trustPrompt}
        path={trustPrompt?.path ?? null}
        onTrust={() => trustPrompt?.resolve("trusted")}
        onRestricted={() => trustPrompt?.resolve("restricted")}
        onCancel={() => trustPrompt?.resolve("cancel")}
      />
      </div>
    </ActivityVisibilityContext.Provider>
  );
}
