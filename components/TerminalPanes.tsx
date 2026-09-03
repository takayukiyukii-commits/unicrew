"use client";

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Columns2,
  X,
  FolderOpen,
  SquareTerminal,
  Bot,
  ChevronDown,
  Plus,
  Maximize2,
  Minimize2,
  Megaphone,
  CornerDownLeft,
  ChevronRight,
  ListChecks,
  Play,
  Plug,
  Copy,
} from "lucide-react";
import { InteractiveTerminal } from "./InteractiveTerminal";
import {
  availableTerminalClis,
  terminalCliById,
  TERMINAL_CLIS,
  type TerminalCli,
} from "@/lib/terminal-clis";
import { useTranslation } from "@/lib/i18n";
import { ptyWriteText, ptyIdForPane } from "@/lib/pty";
import {
  effortLevelsFor,
  supportsEffort,
  isValidEffort,
  paneLaunchCommand,
} from "@/lib/terminal-effort";
import { showToast } from "@/lib/toast";
import {
  integrationSnippet,
  type IntegrationShell,
} from "@/lib/terminal-shell-integration";
import { writeClipboardText, copyTextSync } from "@/lib/tauri";
import { listDirectory, readTextFile } from "@/lib/tauri";
import {
  packageManagerFrom,
  parsePackageScripts,
  parseMakefileTargets,
  cargoTasks,
  sortTasks,
  type DetectedTask,
} from "@/lib/task-runner";
import { useTerminalTheme } from "@/lib/terminal-theme";
import {
  loadTerminalLayout,
  saveTerminalLayout,
  toSavedLayout,
  type SavedLayout,
} from "@/lib/terminal-layout";
import {
  templateFromFractions,
  boundaryPercents,
  resizeAtBoundary,
  fitFractions,
} from "@/lib/terminal-grid";

/**
 * 同時に開けるターミナルペインの上限（1ページあたり）。
 * 3カラム以上は自動的に「上段＋下段3列」の2段グリッドになるため、
 * 2段ぶん（最大 3×2）まで許可する。
 */
const MAX_PANES = 6;
/** 1行あたりの最大カラム数。これを超えると段（行）が増える。 */
const COLS = 3;
/**
 * ページ（6分割セット）の上限。1ページ最大6 PTY × 4ページ = 24 PTY。
 * 使える CLI が増えたため複数ページを保持できるようにした（2026-08-28）。
 * 無制限にするとプロセスが際限なく増えるので上限を置く。
 */
const MAX_PAGES = 4;

interface Pane {
  /** PTY ID にも使う一意なキー。タブを閉じるまで PTY を保持する。 */
  key: string;
  /**
   * 前回終了時に PTY を開いていた作業ディレクトリ（復元されたペインだけ持つ）。
   * 新規に開いたペインは undefined で、従来どおり現在の workspace で開く。
   */
  savedCwd?: string | null;
  /** 設計書⑤: ペインで起動するプログラム。claude（既定）または OS シェル。 */
  kind: "claude" | "shell";
  /**
   * マルチAI: lib/terminal-clis.ts の CLI id。指定時は該当 CLI を PTY で起動する。
   * - "claude"（または未指定）→ 従来どおり kind="claude" 経路（完全互換）
   * - その他 → kind="shell" + command 指定（claude 固有のペースト特殊処理を
   *   他 CLI に送らないため。起動プログラムは command が上書きする）
   */
  cliId?: string;
  /**
   * エフォート（思考の深さ）。未指定なら CLI におまかせ＝引数を 1 つも足さない。
   * 起動時に固定される（途中変更は現状しない）。
   */
  effort?: string;
  /**
   * 開いた直後に 1 回だけ流すコマンド（タスクランナーから開いたとき）。
   * 🚨 保存しない。保存すると次回起動で勝手に走る。
   */
  initialInput?: string;
}

/** ページ = 最大6ペインの1セット。ページを切り替えても全ページの PTY は生きたまま。 */
interface Page {
  id: string;
  panes: Pane[];
}

interface Props {
  workspace?: string | null;
  /**
   * ターミナルで選択したテキストを AI へ渡す。cwd と CLI 名も一緒に渡して、
   * 受け取る側（チャット）が「どこで何を動かしていたか」を書けるようにする。
   */
  onSendToAi?: (
    text: string,
    meta: { cwd: string | null; label: string },
  ) => void;
  /**
   * いまのスレッドで AI ごとに切られている作業場（git worktree）。
   * 「その作業場でターミナルを開く」ために使う。v0.4.0 で worktree は切られる
   * ようになったのに、中を覗く手段がターミナル側に無かった。
   */
  worktrees?: { label: string; path: string; branch?: string }[];
}

const newKey = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const newPane = (
  kind: "claude" | "shell" = "claude",
  cliId?: string,
  effort?: string,
): Pane => ({
  key: newKey("pane"),
  kind,
  cliId,
  effort,
});

/** 各ペインの grid 上の配置（1-based の行・列）を返す。
 *
 *  方針: 下段を3列で埋め、余り（remainder）は上段に置く。
 *   - n<=3: 1段に n 列
 *   - n=4 : 上1 / 下3
 *   - n=5 : 上2 / 下3
 *   - n=6 : 上3 / 下3
 *  これにより「3カラム以上で上段＋下段3列」になる。
 */
function placement(index: number, total: number): { row: number; col: number } {
  if (total <= COLS) return { row: 1, col: index + 1 };
  const totalRows = Math.ceil(total / COLS);
  const topCount = total - (totalRows - 1) * COLS; // 上段（部分行）の個数
  if (index < topCount) return { row: 1, col: index + 1 };
  const k = index - topCount;
  return { row: 2 + Math.floor(k / COLS), col: (k % COLS) + 1 };
}

/**
 * ペインの分割線（グリッドに重ねるオーバーレイ）。
 *
 * 🚨 グリッドの「子」として挿さないのが要点。子として入れると列数が変わり、
 * 「段組みが変わってもペインを再マウントしない（＝PTY とスクロールバックを保つ）」
 * という既存の性質が壊れる。ここは絶対配置なのでグリッドの構造に影響しない。
 */
function GridResizers({
  colFr,
  rowFr,
  onColFr,
  onRowFr,
  getEl,
  colTitle,
  rowTitle,
}: {
  colFr: number[];
  rowFr: number[];
  onColFr: (next: number[]) => void;
  onRowFr: (next: number[]) => void;
  getEl: () => HTMLDivElement | null;
  colTitle: string;
  rowTitle: string;
}) {
  const dragRef = useRef<{ axis: "col" | "row"; index: number } | null>(null);

  const onDown =
    (axis: "col" | "row", index: number) =>
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { axis, index };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const el = getEl();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (drag.axis === "col") {
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      onColFr(resizeAtBoundary(colFr, drag.index, pct));
    } else {
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      onRowFr(resizeAtBoundary(rowFr, drag.index, pct));
    }
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  return (
    <>
      {boundaryPercents(colFr).map((pct, i) => (
        <div
          key={`c${i}`}
          role="separator"
          aria-orientation="vertical"
          title={colTitle}
          onPointerDown={onDown("col", i)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="absolute top-0 bottom-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize touch-none hover:bg-[var(--color-accent)]/30"
          style={{ left: `${pct}%` }}
        />
      ))}
      {boundaryPercents(rowFr).map((pct, i) => (
        <div
          key={`r${i}`}
          role="separator"
          aria-orientation="horizontal"
          title={rowTitle}
          onPointerDown={onDown("row", i)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="absolute left-0 right-0 z-30 h-1.5 -translate-y-1/2 cursor-row-resize touch-none hover:bg-[var(--color-accent)]/30"
          style={{ top: `${pct}%` }}
        />
      ))}
    </>
  );
}

/**
 * 複数ページ × 複数ペインのターミナル表示。
 *
 * - ページ = 最大6ペインの1セット。上部タブで切り替え、最大 MAX_PAGES ページ。
 *   非アクティブページは display:none で保持し（アンマウントしない）、
 *   全ページの PTY / xterm バッファが生き続ける（メインビュー切替と同じ方式）。
 * - ページの × は誤爆で PTY を殺さないよう二度押し（1回目で赤くなり、
 *   もう一度押すと閉じる。3秒で解除）。
 *
 * チャットの「並列ペイン」（Columns2 アイコン）と同じ感覚で
 * ターミナルでもワンクリックでペインを増やせる「扉ボタン」を提供する。
 * さらに「＋AI」メニューから Claude 以外の対話 CLI（Codex / Gemini / Grok /
 * OpenCode / Qwen / Kimi / Goose 等）も同じ PTY 基盤で開ける（マルチAI対応）。
 * ペインを増やしても 1 ペインあたりの PTY は独立しており、
 * `/clear` や `/compact` 等はそのペインだけに作用する。
 *
 * レイアウト: 1〜3 ペインは横一列、3カラムを超えると自動的に
 * 「上段（余り）＋下段3列」の 2 段グリッドになる。
 * 全ペインは単一 grid の直接の子のままなので、段組みが変わっても
 * InteractiveTerminal は再マウントされず PTY/xterm バッファを保持する。
 *
 * cwd は「ペインの PTY を開いた瞬間」のアクティブ workspace で確定する。
 * 以後 workspace が変わっても既存ペインの PTY は維持される（VS Code と同じ）。
 */
export function TerminalPanes({
  workspace = null,
  onSendToAi,
  worktrees = [],
}: Props) {
  const { t } = useTranslation();
  // ターミナル画面の枠もアプリの外観プリセットに追従させる
  // （明るいテーマでは従来の #faf9f6 がそのまま入る）。
  const theme = useTerminalTheme();
  /**
   * 前回の構成を復元する。壊れていれば null が返るので、その時は従来どおり
   * 「1ページ・1ペイン（claude）」で始める。復元しても PTY はページを
   * 表示するまで開かない（既存の遅延起動のまま）。
   */
  const restored = useRef<SavedLayout | null>(null);
  if (restored.current === null) {
    restored.current = loadTerminalLayout({
      maxPages: MAX_PAGES,
      maxPanes: MAX_PANES,
      knownCliIds: TERMINAL_CLIS.map((c) => c.id),
      isValidEffort,
    });
  }
  const [pages, setPages] = useState<Page[]>(() => {
    const saved = restored.current;
    if (!saved) return [{ id: newKey("page"), panes: [newPane()] }];
    return saved.pages.map((pg) => ({
      id: pg.id,
      panes: pg.panes.map((pn) => ({
        key: pn.key,
        kind: pn.kind,
        cliId: pn.cliId,
        effort: pn.effort,
        savedCwd: pn.cwd ?? null,
      })),
    }));
  });
  const [activePageId, setActivePageId] = useState<string>(
    () => restored.current?.activePageId ?? "",
  );
  // 初期表示や閉じた直後に activePageId が実在しない場合は先頭ページへ倒す
  const resolvedActiveId = pages.some((p) => p.id === activePageId)
    ? activePageId
    : pages[0].id;
  /** ＋AI メニューを開いているペインの key（1つだけ開く） */
  const [aiMenuFor, setAiMenuFor] = useState<string | null>(null);
  /** ＋AI メニューでエフォートを選んでいる最中の CLI（null なら一覧表示）。 */
  const [effortPick, setEffortPick] = useState<TerminalCli | null>(null);
  /** 二度押しで閉じる: 1回押されて「もう一度で閉じる」状態のページ id */
  const [armedClose, setArmedClose] = useState<string | null>(null);
  const armedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /**
   * ペインごとの「実際に PTY を開いた cwd」。ヘッダー表示用。
   * workspace 切替でも既存ペインの PTY は維持される（2026-08-28 修正）ため、
   * prop の workspace ではなく実際の cwd を表示して嘘をつかない。
   */
  const [paneCwds, setPaneCwds] = useState<Record<string, string | null>>({});
  /**
   * 見ていないページで起きたこと（タブのバッジ）。
   * "output" = 新しい出力が来た / "exit" = プロセスが終了した（こちらが優先）。
   * 24 セッションまで持てるのに、これまでタブは本数しか出しておらず、
   * 「裏で終わったか・落ちたか」が分からなかった。
   */
  const [pageActivity, setPageActivity] = useState<
    Record<string, "output" | "exit">
  >({});
  /**
   * ページごとの列・行の比率（分割線のドラッグ結果）。
   * ペイン枚数が変わったら fitFractions が均等へ戻す。
   */
  const [gridFr, setGridFr] = useState<
    Record<string, { colFr?: number[]; rowFr?: number[] }>
  >(() => {
    const saved = restored.current;
    if (!saved) return {};
    const out: Record<string, { colFr?: number[]; rowFr?: number[] }> = {};
    for (const pg of saved.pages) out[pg.id] = { colFr: pg.colFr, rowFr: pg.rowFr };
    return out;
  });
  /**
   * ページごとの「最大化中のペイン」。
   * 🚨 最大化しても他のペインはアンマウントしない（＝PTY を殺さない）。
   * 最大化したペインをグリッド全面に広げて上に重ねるだけ。
   */
  const [maximized, setMaximized] = useState<Record<string, string | null>>({});
  /** ページごとのグリッド要素（分割線のドラッグ量を測るのに使う）。 */
  const gridEls = useRef<Record<string, HTMLDivElement | null>>({});

  // ── タスクランナー（package.json / Makefile / Cargo.toml を読む）────
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasks, setTasks] = useState<DetectedTask[] | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const tasksMenuRef = useRef<HTMLDivElement>(null);

  // ── シェル統合の案内（こちらからは設定を書き換えない）──────────────
  const [integrationOpen, setIntegrationOpen] = useState(false);
  const [integrationShell, setIntegrationShell] =
    useState<IntegrationShell>("bash");
  const integrationRef = useRef<HTMLDivElement>(null);

  // ── 一斉送信（同じ指示を複数の AI へ同時に投げて見比べる）──────────
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastText, setBroadcastText] = useState("");
  /**
   * 送信対象から**外した**ペイン（既定は全部が対象）。
   * 「入っているものを消す」方式にしておくと、ペインを増やしたときに
   * 自動で対象へ入る＝「増やしたのに届かない」という分かりにくい事故を防げる。
   */
  const [broadcastOff, setBroadcastOff] = useState<Record<string, boolean>>({});
  const [broadcastBusy, setBroadcastBusy] = useState(false);

  /** いま表示中のページ id（イベント側から参照するため ref で持つ）。 */
  const activePageIdRef = useRef<string>("");
  activePageIdRef.current = resolvedActiveId;

  /**
   * ページに未確認の出来事を記録する（exit は output で上書きしない）。
   * 🚨 表示中のページには印を付けない。ページを切り替えた直後は
   * 「子の visible が true になる」より先に出力イベントが届きうるので、
   * ここで弾かないと「見ているページに未確認の印」が残る。
   */
  const markPageActivity = useCallback(
    (pageId: string, kind: "output" | "exit") => {
      if (pageId === activePageIdRef.current) return;
      setPageActivity((prev) => {
        if (prev[pageId] === kind) return prev;
        if (prev[pageId] === "exit" && kind === "output") return prev;
        return { ...prev, [pageId]: kind };
      });
    },
    [],
  );

  /** ページを見た＝バッジを消す。 */
  const clearPageActivity = useCallback((pageId: string) => {
    setPageActivity((prev) => {
      if (!(pageId in prev)) return prev;
      const next = { ...prev };
      delete next[pageId];
      return next;
    });
  }, []);

  /**
   * 構成が変わったら保存する（次回の起動で同じ形に戻すため）。
   * 保存するのは構成と cwd だけ。会話・出力・プロセスは保存しない。
   */
  useEffect(() => {
    // 🚨 保存してよい項目は toSavedLayout に固めてある（initialInput のような
    //    「次回に勝手に走ってしまう値」を保存しないため）。
    saveTerminalLayout(
      toSavedLayout(pages, paneCwds, gridFr, resolvedActiveId),
    );
  }, [pages, paneCwds, resolvedActiveId, gridFr]);

  /**
   * 🚨 いま表示されているページのバッジは必ず消す。
   * タブのクリックだけで消していると、**アクティブなページを閉じた**ときに
   * 先頭ページへ自動で倒れる経路（resolvedActiveId のフォールバック）を通らず、
   * 「見ているのにバッジが残り、次に別ページへ移った瞬間に未確認の印が復活する」
   * ＝一度も起きていない出来事を知らせる嘘のバッジになる。
   */
  useEffect(() => {
    clearPageActivity(resolvedActiveId);
  }, [resolvedActiveId, clearPageActivity]);

  const isWindows =
    typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
  const clis = availableTerminalClis(isWindows);

  // 外側クリックで ＋AI メニューを閉じる
  useEffect(() => {
    if (!aiMenuFor) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setAiMenuFor(null);
        setEffortPick(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [aiMenuFor]);

  // アンマウント時に二度押しタイマーを掃除
  useEffect(
    () => () => {
      if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
    },
    [],
  );

  const handleSplit = useCallback(
    (
      pageId: string,
      kind: "claude" | "shell" = "claude",
      cliId?: string,
      effort?: string,
    ) => {
      setPages((prev) =>
        prev.map((pg) => {
          if (pg.id !== pageId) return pg;
          if (pg.panes.length >= MAX_PANES) return pg;
          return { ...pg, panes: [...pg.panes, newPane(kind, cliId, effort)] };
        }),
      );
      setAiMenuFor(null);
      setEffortPick(null);
    },
    [],
  );

  const handleSplitCli = useCallback(
    (pageId: string, cli: TerminalCli, effort?: string) => {
      // claude は従来経路（完全互換）。他 CLI は shell 扱い + command 上書き。
      // 🚨 エフォート未指定なら、どちらも従来と 1 バイトも同じ引数で起動する。
      const level = isValidEffort(cli.id, effort) ? effort : undefined;
      if (cli.id === "claude") handleSplit(pageId, "claude", "claude", level);
      else handleSplit(pageId, "shell", cli.id, level);
    },
    [handleSplit],
  );

  /**
   * ペインの起動コマンドを決める。
   * 🚨 claude でエフォート未指定のときは **undefined を返す**（＝ command prop を
   * 渡さない＝従来の起動経路そのまま）。ここを常に返す実装にすると、
   * 既存ユーザーの claude ペインの起動経路が静かに変わってしまう。
   */
  const paneCommand = useCallback(
    (pane: Pane): { program: string; args?: string[] } | undefined =>
      paneLaunchCommand(pane.kind, pane.cliId, pane.effort, terminalCliById),
    [],
  );

  const forgetPaneCwds = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setPaneCwds((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const k of keys) {
        if (k in next) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  /**
   * いま表示しているページの、送信対象になっているペイン。
   * 🚨 対象は**アクティブページに限る**。裏ページまで送ると、見ていない
   * ターミナルに勝手に指示が流れて気づけない（24 セッション持てるため）。
   */
  const broadcastTargets = (
    pages.find((pg) => pg.id === resolvedActiveId)?.panes ?? []
  ).filter((pn) => !broadcastOff[pn.key]);

  /** 選んだペインへ同じ文字列を送る（末尾に Enter を付ける）。 */
  const sendBroadcast = useCallback(async () => {
    const text = broadcastText.trim();
    if (!text || broadcastBusy) return;
    const targets = (
      pages.find((pg) => pg.id === resolvedActiveId)?.panes ?? []
    ).filter((pn) => !broadcastOff[pn.key]);
    if (targets.length === 0) return;
    setBroadcastBusy(true);
    let ok = 0;
    let ng = 0;
    for (const pn of targets) {
      try {
        // まだ一度も表示していないペインは PTY が開いていない＝失敗する。
        // 黙って落とさず、件数として出す。
        await ptyWriteText(ptyIdForPane(pn.key), text + "\r");
        ok++;
      } catch {
        ng++;
      }
    }
    setBroadcastBusy(false);
    setBroadcastText("");
    showToast(
      ng === 0
        ? t("terminal.broadcastSent", { n: ok })
        : t("terminal.broadcastSentPartial", { n: ok, ng }),
      ng === 0 ? "info" : "error",
    );
  }, [
    broadcastText,
    broadcastBusy,
    pages,
    resolvedActiveId,
    broadcastOff,
    t,
  ]);

  /**
   * ワークスペースから実行できるタスクを探す（読むだけ・実行はしない）。
   * 見つからなければ空配列。失敗しても例外は投げない（ターミナルを壊さない）。
   */
  const scanTasks = useCallback(async (ws: string | null) => {
    if (!ws) {
      setTasks([]);
      return;
    }
    setTasksLoading(true);
    try {
      const entries = await listDirectory(ws);
      const names = entries.filter((e) => !e.is_dir).map((e) => e.name);
      const has = (n: string) =>
        names.some((x) => x.toLowerCase() === n.toLowerCase());
      const read = async (n: string) => {
        try {
          return await readTextFile(`${ws}/${n}`);
        } catch {
          return null;
        }
      };
      const found: DetectedTask[] = [];
      if (has("package.json")) {
        const text = await read("package.json");
        if (text) {
          found.push(...sortTasks(parsePackageScripts(text, packageManagerFrom(names))));
        }
      }
      if (has("Makefile")) {
        const text = await read("Makefile");
        if (text) found.push(...sortTasks(parseMakefileTargets(text)));
      }
      if (has("Cargo.toml")) {
        const text = await read("Cargo.toml");
        if (text) found.push(...cargoTasks(text));
      }
      setTasks(found);
    } catch {
      setTasks([]);
    } finally {
      setTasksLoading(false);
    }
  }, []);

  // ワークスペースが変わったら、次に開いたときに読み直す
  useEffect(() => {
    setTasks(null);
  }, [workspace]);

  // 外側クリックでシェル統合の案内を閉じる
  useEffect(() => {
    if (!integrationOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!integrationRef.current?.contains(e.target as Node)) {
        setIntegrationOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [integrationOpen]);

  // 外側クリックでタスク一覧を閉じる
  useEffect(() => {
    if (!tasksOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!tasksMenuRef.current?.contains(e.target as Node)) setTasksOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [tasksOpen]);

  /** タスクを新しいシェルのペインで実行する（クリックしたときだけ走る）。 */
  const runTask = useCallback(
    (pageId: string, command: string) => {
      setPages((prev) =>
        prev.map((pg) => {
          if (pg.id !== pageId) return pg;
          if (pg.panes.length >= MAX_PANES) return pg;
          return {
            ...pg,
            panes: [
              ...pg.panes,
              { ...newPane("shell"), initialInput: command },
            ],
          };
        }),
      );
      setTasksOpen(false);
    },
    [],
  );

  /**
   * 指定した作業場（worktree）で新しいシェルのペインを開く。
   * cwd は「開く瞬間」に固定される既存の仕組みに、初期 cwd として渡すだけ。
   */
  const openInWorktree = useCallback((pageId: string, path: string) => {
    setPages((prev) =>
      prev.map((pg) => {
        if (pg.id !== pageId) return pg;
        if (pg.panes.length >= MAX_PANES) return pg;
        return {
          ...pg,
          panes: [...pg.panes, { ...newPane("shell"), savedCwd: path }],
        };
      }),
    );
    setAiMenuFor(null);
    setEffortPick(null);
  }, []);

  /** ペインの最大化を切り替える（同じペインをもう一度押すと元に戻る）。 */
  const toggleMaximize = useCallback((pageId: string, key: string) => {
    setMaximized((prev) => ({
      ...prev,
      [pageId]: prev[pageId] === key ? null : key,
    }));
  }, []);

  const handleClosePane = useCallback(
    (pageId: string, key: string) => {
      setPages((prev) =>
        prev.map((pg) => {
          if (pg.id !== pageId) return pg;
          // 最後の 1 ペインは閉じない（必ず 1 つ残す）。
          if (pg.panes.length <= 1) return pg;
          return { ...pg, panes: pg.panes.filter((p) => p.key !== key) };
        }),
      );
      forgetPaneCwds([key]);
      // 最大化中のペインを閉じたら最大化も解除する
      //（残さないと「1 枚も最大化していないのに全面表示」に見える）
      setMaximized((prev) =>
        prev[pageId] === key ? { ...prev, [pageId]: null } : prev,
      );
    },
    [forgetPaneCwds],
  );

  const handleAddPage = useCallback(() => {
    // 監査LOW（2026-08-28 Codex）: setState の functional updater は純粋に保つ
    // （StrictMode の再実行で副作用が重複しないよう、id 生成と切替は外で行う）。
    const pg: Page = { id: newKey("page"), panes: [newPane()] };
    let added = false;
    setPages((prev) => {
      if (prev.length >= MAX_PAGES) return prev;
      added = true;
      return [...prev, pg];
    });
    // setPages 直後の同期呼び出し。追加できなかった場合は切り替えない。
    if (added) setActivePageId(pg.id);
  }, []);

  /** ページを閉じる（二度押し確認）。閉じるとそのページの全 PTY が終了する。 */
  const handleClosePage = useCallback(
    (pageId: string) => {
      if (armedClose !== pageId) {
        setArmedClose(pageId);
        if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
        armedTimerRef.current = setTimeout(() => {
          armedTimerRef.current = null;
          setArmedClose(null);
        }, 3000);
        return;
      }
      if (armedTimerRef.current) {
        clearTimeout(armedTimerRef.current);
        armedTimerRef.current = null;
      }
      setArmedClose(null);
      // 監査LOW（2026-08-28 Codex）: updater を純粋に保つため、削除対象の
      // pane key 回収と activePageId の切替は updater の外で行う。
      let closedKeys: string[] = [];
      setPages((prev) => {
        if (prev.length <= 1) return prev; // 最後の 1 ページは閉じない
        const target = prev.find((p) => p.id === pageId);
        if (!target) return prev;
        closedKeys = target.panes.map((p) => p.key);
        return prev.filter((p) => p.id !== pageId);
      });
      if (closedKeys.length > 0) {
        forgetPaneCwds(closedKeys);
        clearPageActivity(pageId);
        // 閉じたページの参照・比率・最大化状態を残さない
        //（DOM 参照を持ち続けると、外した要素が解放されない）
        delete gridEls.current[pageId];
        setGridFr((prev) => {
          if (!(pageId in prev)) return prev;
          const next = { ...prev };
          delete next[pageId];
          return next;
        });
        setMaximized((prev) => {
          if (!(pageId in prev)) return prev;
          const next = { ...prev };
          delete next[pageId];
          return next;
        });
        // アクティブページを閉じたら残り先頭へ（resolvedActiveId が実在しない
        // id を先頭へ倒すため、ここでは「閉じた id のままにしない」だけでよい）
        setActivePageId((cur) => (cur === pageId ? "" : cur));
      }
    },
    [armedClose, forgetPaneCwds, clearPageActivity],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0" style={{ backgroundColor: theme.background }}>
      {/* ページタブバー */}
      <div className="shrink-0 h-7 px-2 flex items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        {pages.map((pg, i) => {
          const isActive = pg.id === resolvedActiveId;
          const isArmed = armedClose === pg.id;
          const activity = pageActivity[pg.id];
          return (
            <span
              key={pg.id}
              className={`inline-flex items-center rounded-md border text-[11px] transition ${
                isActive
                  ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]"
                  : "bg-white text-[var(--color-muted)] border-[var(--color-border)] hover:bg-[var(--color-surface)]"
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  setActivePageId(pg.id);
                  clearPageActivity(pg.id);
                }}
                className="pl-2 pr-1 py-0.5 inline-flex items-center gap-1"
                title={
                  activity === "exit"
                    ? t("terminal.pageTabExited", { n: i + 1 })
                    : activity === "output"
                      ? t("terminal.pageTabOutput", { n: i + 1 })
                      : t("terminal.pageTabTitle", { n: i + 1 })
                }
              >
                <SquareTerminal size={11} />
                {i + 1}
                <span
                  className={`px-1 rounded-full text-[9.5px] font-mono ${
                    isActive ? "bg-white/25" : "bg-[var(--color-surface)]"
                  }`}
                >
                  {pg.panes.length}
                </span>
                {/* 見ていない間の出来事。赤=終了（落ちた）／橙=新しい出力 */}
                {!isActive && activity && (
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${
                      activity === "exit" ? "bg-red-500" : "bg-amber-500"
                    }`}
                  />
                )}
              </button>
              {pages.length > 1 && (
                <button
                  type="button"
                  onClick={() => handleClosePage(pg.id)}
                  className={`px-1 py-0.5 rounded-r-md transition ${
                    isArmed
                      ? "bg-red-500 text-white"
                      : isActive
                        ? "hover:bg-white/20"
                        : "hover:bg-red-50 hover:text-red-500"
                  }`}
                  title={
                    isArmed
                      ? t("terminal.closePageConfirm")
                      : t("terminal.closePageTitle")
                  }
                >
                  <X size={11} />
                </button>
              )}
            </span>
          );
        })}
        {/* シェル統合の案内（貼り付けてもらう。こちらからは書き換えない） */}
        <span className="relative ml-auto">
          <button
            type="button"
            onClick={() => setIntegrationOpen((v) => !v)}
            className={`p-1 rounded transition ${
              integrationOpen
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            }`}
            title={t("terminal.integrationTitle")}
            aria-label={t("terminal.integrationTitle")}
            aria-pressed={integrationOpen}
          >
            <Plug size={13} />
          </button>
          {integrationOpen && (
            <div
              ref={integrationRef}
              className="absolute right-0 top-full mt-1 w-[420px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg z-50 p-2"
            >
              <div className="text-[11.5px] text-[var(--color-text)]">
                {t("terminal.integrationHeading")}
              </div>
              <div className="mt-1 text-[10.5px] leading-relaxed text-[var(--color-muted)]">
                {t("terminal.integrationBody")}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                {(["bash", "zsh", "powershell"] as IntegrationShell[]).map(
                  (sh) => (
                    <button
                      key={sh}
                      type="button"
                      onClick={() => setIntegrationShell(sh)}
                      className={`rounded-full border px-2 py-0.5 text-[10.5px] transition ${
                        integrationShell === sh
                          ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                          : "border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-bg)]"
                      }`}
                    >
                      {sh}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  onClick={() => {
                    const text = integrationSnippet(integrationShell);
                    if (!copyTextSync(text)) void writeClipboardText(text);
                    showToast(t("terminal.integrationCopied"));
                  }}
                  className="ml-auto inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text)] transition hover:bg-[var(--color-bg)]"
                >
                  <Copy size={10} />
                  {t("terminal.integrationCopy")}
                </button>
              </div>
              <pre className="mt-1.5 max-h-[220px] overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[10px] leading-relaxed text-[var(--color-text)] whitespace-pre">
                {integrationSnippet(integrationShell)}
              </pre>
            </div>
          )}
        </span>

        {/* タスク（package.json / Makefile / Cargo.toml から拾う） */}
        <span className="relative">
          <button
            type="button"
            onClick={() => {
              const next = !tasksOpen;
              setTasksOpen(next);
              if (next && tasks === null) void scanTasks(workspace);
            }}
            className={`p-1 rounded transition ${
              tasksOpen
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            }`}
            title={t("terminal.tasksTitle")}
            aria-label={t("terminal.tasksTitle")}
            aria-pressed={tasksOpen}
          >
            <ListChecks size={13} />
          </button>
          {tasksOpen && (
            <div
              ref={tasksMenuRef}
              className="absolute right-0 top-full mt-1 w-[320px] max-h-[320px] overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg z-50 py-1"
              role="menu"
            >
              {tasksLoading && (
                <div className="px-3 py-2 text-[11.5px] text-[var(--color-muted)]">
                  {t("terminal.tasksLoading")}
                </div>
              )}
              {!tasksLoading && (tasks?.length ?? 0) === 0 && (
                <div className="px-3 py-2 text-[11.5px] text-[var(--color-muted)]">
                  {t("terminal.tasksEmpty")}
                </div>
              )}
              {!tasksLoading &&
                (tasks ?? []).map((task) => (
                  <button
                    key={`${task.source}:${task.name}`}
                    type="button"
                    onClick={() => runTask(resolvedActiveId, task.command)}
                    className="w-full px-3 py-1.5 text-left hover:bg-[var(--color-bg)] flex items-start gap-2"
                    role="menuitem"
                    title={t("terminal.tasksRunTitle", {
                      command: task.command,
                    })}
                  >
                    <Play
                      size={11}
                      className="mt-0.5 shrink-0 text-[var(--color-accent)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-[12px] text-[var(--color-text)]">
                        {task.name}
                        <span className="ml-1.5 text-[10px] text-[var(--color-muted)]">
                          {task.source}
                        </span>
                      </span>
                      <span className="block truncate font-mono text-[10.5px] text-[var(--color-muted)]">
                        {task.detail ?? task.command}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          )}
        </span>

        {/* 一斉送信の開閉（1 ペインのときは意味が無いので出さない） */}
        {(pages.find((pg) => pg.id === resolvedActiveId)?.panes.length ?? 0) >
          1 && (
          <button
            type="button"
            onClick={() => setBroadcastOpen((v) => !v)}
            className={`p-1 rounded transition ${
              broadcastOpen
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            }`}
            title={t("terminal.broadcastTitle")}
            aria-label={t("terminal.broadcastTitle")}
            aria-pressed={broadcastOpen}
          >
            <Megaphone size={13} />
          </button>
        )}
        {pages.length < MAX_PAGES && (
          <button
            type="button"
            onClick={handleAddPage}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
            title={t("terminal.newPageTitle")}
            aria-label={t("terminal.newPageTitle")}
          >
            <Plus size={13} />
          </button>
        )}
      </div>

      {/* 各ページ。非アクティブは hidden（アンマウントしない＝PTY 保持）。 */}
      {pages.map((pg) => {
        const n = pg.panes.length;
        const cols = Math.min(n, COLS);
        const rows = n <= COLS ? 1 : Math.ceil(n / COLS);
        const isActivePage = pg.id === resolvedActiveId;
        // 分割線で変えた比率。枚数が変わっていたら均等へ戻る。
        const colFr = fitFractions(gridFr[pg.id]?.colFr, cols);
        const rowFr = fitFractions(gridFr[pg.id]?.rowFr, rows);
        const maxKey = maximized[pg.id] ?? null;
        return (
          <div
            key={pg.id}
            ref={(el) => {
              gridEls.current[pg.id] = el;
            }}
            className={
              isActivePage
                ? "relative flex-1 grid min-w-0 min-h-0"
                : "hidden"
            }
            style={{
              gridTemplateColumns: templateFromFractions(colFr),
              gridTemplateRows: templateFromFractions(rowFr),
              backgroundColor: theme.background,
            }}
          >
            {/* 分割線（最大化中は出さない） */}
            {isActivePage && !maxKey && (cols > 1 || rows > 1) && (
              <GridResizers
                colFr={colFr}
                rowFr={rowFr}
                onColFr={(next) =>
                  setGridFr((prev) => ({
                    ...prev,
                    [pg.id]: { ...prev[pg.id], colFr: next },
                  }))
                }
                onRowFr={(next) =>
                  setGridFr((prev) => ({
                    ...prev,
                    [pg.id]: { ...prev[pg.id], rowFr: next },
                  }))
                }
                getEl={() => gridEls.current[pg.id] ?? null}
                colTitle={t("terminal.resizeCol")}
                rowTitle={t("terminal.resizeRow")}
              />
            )}
            {pg.panes.map((pane, idx) => {
              const { row, col } = placement(idx, n);
              const canSplit = pg.panes.length < MAX_PANES;
              const canClose = pg.panes.length > 1;
              const cli =
                pane.cliId && pane.cliId !== "claude"
                  ? terminalCliById(pane.cliId)
                  : undefined;
              const isMax = maxKey === pane.key;
              // 🚨 最大化は「全面に広げて上に重ねる」だけ。他のペインを
              // 描画から外すと unmount → PTY が死ぬ（セッションが消える）。
              // 変数名は既存の placement()（グリッド上の行・列を決める関数）と
              // 衝突させない。同名にすると自分自身を参照する初期化になる。
              const cellStyle = isMax
                ? { gridColumn: "1 / -1", gridRow: "1 / -1", zIndex: 20 }
                : { gridColumn: col, gridRow: row };
              return (
                <div
                  key={pane.key}
                  style={cellStyle}
                  className={`min-w-0 min-h-0 flex flex-col ${
                    !isMax && col > 1
                      ? "border-l border-[var(--color-border)]"
                      : ""
                  } ${
                    !isMax && row > 1
                      ? "border-t border-[var(--color-border)]"
                      : ""
                  }`}
                >
                  <div
                    className="shrink-0 h-7 px-2 flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] text-[11px] text-[var(--color-muted)] select-none"
                    onDoubleClick={() => {
                      if (pg.panes.length > 1) toggleMaximize(pg.id, pane.key);
                    }}
                  >
                    {(paneCwds[pane.key] ?? workspace) && (
                      <span className="flex items-center gap-1 truncate font-mono">
                        <FolderOpen size={11} />
                        <span
                          className="truncate"
                          title={paneCwds[pane.key] ?? workspace ?? undefined}
                        >
                          {paneCwds[pane.key] ?? workspace}
                        </span>
                      </span>
                    )}
                    {isValidEffort(
                      pane.cliId ?? (pane.kind === "claude" ? "claude" : ""),
                      pane.effort,
                    ) && (
                      <span
                        className="shrink-0 px-1 rounded border border-[var(--color-accent)] text-[var(--color-accent)] font-mono text-[10px]"
                        title={t("terminal.effortBadgeTitle", {
                          level: pane.effort ?? "",
                        })}
                      >
                        {pane.effort}
                      </span>
                    )}
                    {cli ? (
                      <span className="shrink-0 px-1 rounded bg-[var(--color-surface)] border border-[var(--color-border)] font-mono text-[10px]">
                        {cli.label}
                      </span>
                    ) : pane.kind === "shell" ? (
                      <span className="shrink-0 px-1 rounded bg-[var(--color-surface)] border border-[var(--color-border)] font-mono text-[10px]">
                        {t("terminal.shellBadge")}
                      </span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-0.5 shrink-0">
                      {canSplit && (
                        <span className="relative">
                          <button
                            type="button"
                            onClick={() => {
                              setEffortPick(null);
                              setAiMenuFor((cur) =>
                                cur === pane.key ? null : pane.key,
                              );
                            }}
                            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition inline-flex items-center"
                            title={t("terminal.newAiTitle")}
                            aria-label={t("terminal.newAiAria")}
                          >
                            <Bot size={13} />
                            <ChevronDown size={9} className="opacity-60" />
                          </button>
                          {aiMenuFor === pane.key && (
                            <div
                              ref={menuRef}
                              className="absolute right-0 top-full mt-1 min-w-[170px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg z-50 py-1"
                              role="menu"
                            >
                              {effortPick ? (
                                <>
                                  {/* エフォート選択（この CLI をどの深さで開くか） */}
                                  <div className="px-3 py-1 text-[10.5px] text-[var(--color-muted)]">
                                    {t("terminal.effortHeading", {
                                      cli: effortPick.label,
                                    })}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleSplitCli(pg.id, effortPick)
                                    }
                                    className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface)]"
                                    role="menuitem"
                                  >
                                    {t("terminal.effortDefault")}
                                  </button>
                                  {effortLevelsFor(effortPick.id).map((lv) => (
                                    <button
                                      key={lv}
                                      type="button"
                                      onClick={() =>
                                        handleSplitCli(pg.id, effortPick, lv)
                                      }
                                      className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface)]"
                                      role="menuitem"
                                    >
                                      <span className="font-mono">{lv}</span>
                                      <span className="ml-2 text-[10.5px] text-[var(--color-muted)]">
                                        {t(`terminal.effortHint.${lv}`)}
                                      </span>
                                    </button>
                                  ))}
                                  <div className="my-1 border-t border-[var(--color-border)]" />
                                  <button
                                    type="button"
                                    onClick={() => setEffortPick(null)}
                                    className="w-full px-3 py-1.5 text-left text-[12px] text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
                                    role="menuitem"
                                  >
                                    {t("terminal.effortBack")}
                                  </button>
                                </>
                              ) : (
                                <>
                                  {clis.map((c) => (
                                    <button
                                      key={c.id}
                                      type="button"
                                      onClick={() => {
                                        // エフォートを選べる CLI は 1 段深く聞く。
                                        // 選べない CLI は今までどおり即開く。
                                        if (supportsEffort(c.id))
                                          setEffortPick(c);
                                        else handleSplitCli(pg.id, c);
                                      }}
                                      className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface)] flex items-center justify-between gap-2"
                                      role="menuitem"
                                    >
                                      <span>{c.label}</span>
                                      {supportsEffort(c.id) && (
                                        <ChevronRight
                                          size={12}
                                          className="opacity-50"
                                        />
                                      )}
                                    </button>
                                  ))}
                                  <div className="my-1 border-t border-[var(--color-border)]" />
                                  <button
                                    type="button"
                                    onClick={() => handleSplit(pg.id, "shell")}
                                    className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface)]"
                                    role="menuitem"
                                  >
                                    {t("terminal.menuShell")}
                                  </button>
                                  {/* AI ごとの作業場（worktree）。無いときは何も出さない。 */}
                                  {worktrees.length > 0 && (
                                    <>
                                      <div className="my-1 border-t border-[var(--color-border)]" />
                                      <div className="px-3 py-1 text-[10.5px] text-[var(--color-muted)]">
                                        {t("terminal.worktreeHeading")}
                                      </div>
                                      {worktrees.map((w) => (
                                        <button
                                          key={w.path}
                                          type="button"
                                          onClick={() =>
                                            openInWorktree(pg.id, w.path)
                                          }
                                          className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface)]"
                                          role="menuitem"
                                          title={w.path}
                                        >
                                          {w.label}
                                          {w.branch && (
                                            <span className="ml-1.5 font-mono text-[10px] text-[var(--color-muted)]">
                                              {w.branch}
                                            </span>
                                          )}
                                        </button>
                                      ))}
                                    </>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </span>
                      )}
                      {canSplit && (
                        <button
                          type="button"
                          onClick={() => handleSplit(pg.id, "shell")}
                          className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                          title={t("terminal.newShellTitle")}
                          aria-label={t("terminal.newShellAria")}
                        >
                          <SquareTerminal size={13} />
                        </button>
                      )}
                      {canSplit && (
                        <button
                          type="button"
                          onClick={() => handleSplit(pg.id, "claude")}
                          className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                          title={t("terminal.splitTitle")}
                          aria-label={t("terminal.splitAria")}
                        >
                          <Columns2 size={13} />
                        </button>
                      )}
                      {pg.panes.length > 1 && (
                        <button
                          type="button"
                          onClick={() => toggleMaximize(pg.id, pane.key)}
                          className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                          title={
                            isMax
                              ? t("terminal.restoreSizeTitle")
                              : t("terminal.maximizeTitle")
                          }
                          aria-label={
                            isMax
                              ? t("terminal.restoreSizeTitle")
                              : t("terminal.maximizeTitle")
                          }
                          aria-pressed={isMax}
                        >
                          {isMax ? (
                            <Minimize2 size={13} />
                          ) : (
                            <Maximize2 size={13} />
                          )}
                        </button>
                      )}
                      {canClose && (
                        <button
                          type="button"
                          onClick={() => handleClosePane(pg.id, pane.key)}
                          className="p-1 rounded hover:bg-red-50 text-[var(--color-muted)] hover:text-red-500 transition"
                          title={t("terminal.closePaneTitle")}
                          aria-label={t("terminal.closePaneAria")}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="flex-1 min-h-0">
                    {/* cwd は「PTY を開いた瞬間」の workspace で確定し、以後の workspace
                        切替では開き直さない（セッション維持・2026-08-28 修正）。
                        新しい workspace で開きたいときは新しいペインを開く。 */}
                    <InteractiveTerminal
                      workspace={workspace}
                      paneKey={pane.key}
                      kind={pane.kind}
                      command={paneCommand(pane)}
                      initialCwd={pane.savedCwd ?? null}
                      initialInput={pane.initialInput}
                      cliId={
                        pane.cliId ??
                        (pane.kind === "claude" ? "claude" : undefined)
                      }
                      effort={pane.effort}
                      visible={isActivePage}
                      onActivity={(k) => markPageActivity(pg.id, k)}
                      onSendToAi={
                        onSendToAi
                          ? (text) =>
                              onSendToAi(text, {
                                cwd: paneCwds[pane.key] ?? workspace ?? null,
                                label:
                                  cli?.label ??
                                  (pane.kind === "shell"
                                    ? t("terminal.shellBadge")
                                    : "Claude Code"),
                              })
                          : undefined
                      }
                      onCwd={(cwd) =>
                        setPaneCwds((prev) =>
                          prev[pane.key] === cwd
                            ? prev
                            : { ...prev, [pane.key]: cwd },
                        )
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {/* 一斉送信バー。ここに打った文字は、押すまでどのターミナルにも届かない。 */}
      {broadcastOpen && (
        <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
          <div className="flex items-center gap-2">
            <Megaphone size={13} className="shrink-0 text-[var(--color-muted)]" />
            <input
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void sendBroadcast();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setBroadcastOpen(false);
                }
              }}
              placeholder={t("terminal.broadcastPlaceholder")}
              aria-label={t("terminal.broadcastPlaceholder")}
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted)]"
            />
            <button
              type="button"
              onClick={() => void sendBroadcast()}
              disabled={broadcastBusy || broadcastTargets.length === 0}
              className="shrink-0 inline-flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2 py-1 text-[11.5px] text-white transition hover:opacity-90 disabled:opacity-40"
            >
              <CornerDownLeft size={12} />
              {t("terminal.broadcastSend", { n: broadcastTargets.length })}
            </button>
          </div>
          {/* 送り先の選択。押すと対象から外れる（既定は全部が対象）。 */}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {(
              pages.find((pg) => pg.id === resolvedActiveId)?.panes ?? []
            ).map((pn, i) => {
              const on = !broadcastOff[pn.key];
              const cli =
                pn.cliId && pn.cliId !== "claude"
                  ? terminalCliById(pn.cliId)
                  : undefined;
              const label =
                cli?.label ??
                (pn.kind === "shell"
                  ? t("terminal.shellBadge")
                  : "Claude Code");
              return (
                <button
                  key={pn.key}
                  type="button"
                  onClick={() =>
                    setBroadcastOff((prev) => ({ ...prev, [pn.key]: on }))
                  }
                  aria-pressed={on}
                  className={`rounded-full border px-2 py-0.5 text-[10.5px] transition ${
                    on
                      ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                      : "border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-bg)]"
                  }`}
                  title={t("terminal.broadcastToggleTarget")}
                >
                  {i + 1}. {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
