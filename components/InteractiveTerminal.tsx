"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  RotateCw,
  Search,
  Send,
  X,
  Pin,
  PinOff,
  Cpu,
  Gauge,
  AlertTriangle,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import {
  isTauri,
  pathExists,
  defaultWorkspacePath,
  readClipboardText,
  writeClipboardText,
  copyTextSync,
} from "@/lib/tauri";
import {
  ptyOpen,
  ptyWriteText,
  ptyResize,
  ptyKill,
  onPtyData,
  onPtyExit,
  ptyIdForPane,
  type PtyExitInfo,
} from "@/lib/pty";
import { findPathMatches, findUrlMatches } from "@/lib/file-link";
import { readLogicalLine, matchToBufferRange } from "@/lib/terminal-links";
import { findCompositionOverride } from "@/lib/terminal-ime";
import { joinHardWrappedLines } from "@/lib/terminal-copy";
import {
  searchBuffer,
  pickHitIndex,
  type SearchHit,
} from "@/lib/terminal-search";
import { useTranslation } from "@/lib/i18n";
import {
  detectModel,
  detectEffortRejected,
  appendTail,
} from "@/lib/terminal-status";
import { feedInput, EMPTY_ECHO, type EchoState } from "@/lib/terminal-input-echo";
import { showsDefaultEffortBadge } from "@/lib/terminal-effort";
import {
  parseShellEvents,
  splitPendingOsc,
} from "@/lib/terminal-shell-integration";
import { useTerminalTheme } from "@/lib/terminal-theme";
import {
  loadTerminalFontSize,
  setTerminalFontSize,
  subscribeTerminalFontSize,
  clampFontSize,
} from "@/lib/terminal-prefs";
import { openFileSmart } from "@/lib/open-file";
import { openExternal } from "@/lib/preview-window";

/** 検索で使う xterm バッファ行の最小インターフェース（lib/terminal-search と接続する）。 */
interface TermBufferLine {
  isWrapped: boolean;
  length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
  translateToString(trimRight?: boolean): string;
}

/** 検索の実行間隔（打鍵ごとに 50,000 行を走査しないためのデバウンス・ms）。 */
const SEARCH_DEBOUNCE_MS = 180;

/** AI へ渡す選択テキストの上限（文字）。これを超えたら末尾側を残す。 */
const MAX_SEND_TO_AI_CHARS = 20000;

/** TUI モード疑似つまみの高さ（%）。 */
const TUI_THUMB_HEIGHT_PCT = 20;
/** TUI モード疑似つまみ top の最大値（% = 100 - 高さ）。最下部を表す。 */
const TUI_THUMB_MAX_TOP = 100 - TUI_THUMB_HEIGHT_PCT;

/**
 * 本物の対話 Claude Code を擬似端末で動かすターミナル（ハイブリッド B）。
 *
 * VSCode の統合ターミナルと同じく PTY 上で対話 CLI をそのまま動かすので、
 * /mcp・/compact・/clear 等の REPL コマンドは CLI 本体がネイティブに処理する。
 * 既存の構造化チャット（headless）には一切影響しない、独立ビュー。
 *
 * 配色は UNI シリーズ共通の白基調に揃えるためオフホワイト背景＋ダーク文字。
 * （旧 #1e1e1e の黒背景は他ビューと浮いていたため廃止）
 */
export function InteractiveTerminal({
  workspace,
  paneKey,
  kind = "claude",
  command,
  onOutput,
  onExited,
  onCwd,
  visible = true,
  onActivity,
  onSendToAi,
  initialCwd = null,
  initialInput,
  cliId,
  effort,
}: {
  workspace?: string | null;
  /**
   * 同じ workspace で複数ペインを立てるときに、ペインごとに独立した PTY を
   * 起動するための識別子。指定が無ければ自動生成（後方互換）。
   */
  paneKey?: string;
  /**
   * 設計書⑤: 起動対象。既定は "claude"（後方互換）。"shell" なら OS 既定の
   * シェル（Git Bash / PowerShell / cmd / $SHELL）を Rust 側 default_shell で
   * 解決して起動する。PTY 基盤・IME・コピー・リンク等の既存処理は共通。
   */
  kind?: "claude" | "shell" | "remote-control";
  /**
   * PTY 出力（デコード済みテキスト）を親でも観測するフック（remote-control の
   * URL 抽出用）。ref 経由で保持するため、コールバックの参照が変わっても
   * PTY は再起動しない。未指定なら従来と完全に同じ動作。
   */
  onOutput?: (text: string) => void;
  /** PTY プロセス終了時に親へ通知（remote-control の状態表示用）。 */
  onExited?: () => void;
  /**
   * PTY を実際に開いた作業ディレクトリを親へ通知（ペインヘッダーの表示用）。
   * workspace 切替でも PTY は維持されるため、表示は「実際の cwd」を正とする。
   */
  onCwd?: (cwd: string | null) => void;
  /**
   * 起動プログラムの直接指定（ターミナルのマルチAI対応）。指定時は kind の
   * 既定プログラム決定を上書きする。**マウント時の値で固定**（paneKey ごとに
   * 1 CLI の想定。同一ペインでの差し替えは想定しない＝PTY は再起動しない）。
   */
  command?: { program: string; args?: string[] };
  /**
   * このペインが今“見えている”か（＝所属ページがアクティブか）。
   * 見えていない間に出力や異常終了があったことを onActivity で親へ伝えるためだけに使う。
   * 表示/非表示の切替は親が display:none で行うので、この値で PTY は開き直さない。
   */
  visible?: boolean;
  /**
   * 見えていない間に起きたことを親へ 1 回だけ通知する（タブのバッジ用）。
   * 出力のたびに呼ぶと再描画が走るので、非表示期間ごとに最大 1 回に絞っている。
   */
  onActivity?: (kind: "output" | "exit", info?: PtyExitInfo) => void;
  /**
   * ターミナルで選択したテキストを AI へ渡す（未指定ならボタンを出さない）。
   * 折り返し改行は取り除いた本文を渡す（コピーと同じ整形）。
   */
  onSendToAi?: (text: string) => void;
  /**
   * 復元されたペインが「前回開いていた作業ディレクトリ」。
   * **マウント時の値で固定**（command と同じ扱い）。実在しなければ従来どおり
   * workspace → 既定ワークスペースの順に倒す。
   */
  initialCwd?: string | null;
  /**
   * 開いた直後に 1 回だけ流す入力（タスクランナー用）。末尾に Enter を付けて送る。
   * 🚨 1 回きり。再起動ボタンでは流し直さない（破壊的なコマンドを勝手に
   * 2 度実行しないため）。保存もしない（次回起動で勝手に走らないため）。
   */
  initialInput?: string;
  /** どの CLI で開いているか（モデル名の読み取りパターンを選ぶのに使う）。 */
  cliId?: string;
  /** 起動時に渡したエフォート（下のステータス行に出す）。 */
  effort?: string;
}) {
  const { t } = useTranslation();
  // effect 内（PTY イベント）から使う t。依存に入れると locale 変更で
  // PTY が張り直されてしまうので ref で持つ。
  const tRef = useRef(t);
  tRef.current = t;
  /**
   * 画面の外観プリセットに追従する配色（明るいテーマでは従来値と完全に同じ）。
   * effect の依存には入れない（配色変更で PTY を張り直さない）。
   */
  const theme = useTerminalTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  /** ターミナルの文字サイズ（Ctrl+ホイールで変更・端末ごとに永続化）。 */
  const [fontSize, setFontSize] = useState<number>(() => loadTerminalFontSize());
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const ref = useRef<HTMLDivElement>(null);
  // onOutput/onExited は毎レンダーで参照が変わりうるので ref で持つ
  // （effect の依存に入れると PTY が再起動してしまう）。
  const onOutputRef = useRef<typeof onOutput>(onOutput);
  onOutputRef.current = onOutput;
  const onExitedRef = useRef<typeof onExited>(onExited);
  onExitedRef.current = onExited;
  const onCwdRef = useRef<typeof onCwd>(onCwd);
  onCwdRef.current = onCwd;
  /**
   * 【2026-08-28 修正】workspace は effect の依存から外し ref で参照する。
   * 旧実装は依存に workspace が入っており、アクティブスレッドの切替等で
   * workspace 値が変わるたびに cleanup → ptyKill が走り、
   * 「他の画面を見ている間にターミナルが勝手に閉じる（セッションが死ぬ）」
   * 直接原因になっていた。VS Code と同じく、開いた後のターミナルは
   * プロジェクト切替でも維持し、cwd は「PTY を開く瞬間」の workspace で確定する。
   */
  const workspaceRef = useRef<typeof workspace>(workspace);
  workspaceRef.current = workspace;
  // command はマウント時の値で固定（参照変化で PTY を再起動させない）
  const commandRef = useRef(command);
  // 復元 cwd も同様にマウント時固定（開き直しのたびに前回値へ戻す）
  const initialCwdRef = useRef(initialCwd);
  /** 開いた直後に流す入力（使ったら消す＝1 回きり）。 */
  const pendingInputRef = useRef(initialInput);
  // ── 右端ドラッグ・スクロールバー（設計書①）──────────────────────────
  // term インスタンスは effect 内ローカルだったが、ドラッグ操作（React イベント）
  // から scrollToLine を呼ぶために ref 化する。
  const termRef = useRef<{
    rows: number;
    cols: number;
    buffer?: {
      active?: {
        length: number;
        viewportY: number;
        getLine(row: number): TermBufferLine | undefined;
      };
    };
    options: { theme?: unknown; fontSize?: number };
    scrollToLine(line: number): void;
    select(column: number, row: number, length: number): void;
    clearSelection(): void;
    hasSelection(): boolean;
    getSelection(): string;
    focus(): void;
  } | null>(null);
  /** スクロールバック量と表示位置（つまみ描画用）。 */
  const [scroll, setScroll] = useState({ top: 0, max: 0, rows: 0 });
  /**
   * TUI（claude 等）がマウストラッキングを要求中か。true の間はスクロールバックが
   * 無くても（＝TUI が画面を管理していても）バーを出し、ドラッグ量をホイール
   * イベント注入に変換して TUI 側をスクロールさせる（ホイール対応と同方式）。
   */
  const [tuiMouse, setTuiMouse] = useState(false);
  /**
   * TUI モード時のつまみ位置（%・0=最上 80=最下）。TUI は絶対スクロール位置を
   * 報告しないため「推定位置」を描く：
   *  - ホイール／ドラッグで注入した行数ぶんつまみを動かす（方向は正確・量は目安）
   *  - 離してもその場に留まる（以前は 40% へスナップバックし「固定されたバー」に
   *    見えていた＝ユーザー報告 2026-07-16 の直接原因）
   *  - キー入力すると claude 側が最下部へ飛ぶので、つまみも最下部へ戻す
   */
  const [tuiThumbTop, setTuiThumbTop] = useState(TUI_THUMB_MAX_TOP);
  /** 文字サイズ変更後の再フィット（effect 内で生成・cleanup で null）。 */
  const refitRef = useRef<(() => void) | null>(null);
  /** TUI へのホイール注入関数（effect 内で生成・cleanup で null）。 */
  const tuiInjectRef = useRef<((down: boolean, lines: number) => void) | null>(
    null,
  );
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragLastYRef = useRef(0);

  // ── ターミナル内検索（Ctrl+F）────────────────────────────────
  // 一致位置の算出は lib/terminal-search.ts（純関数・単体テスト済み）に置き、
  // ここは「xterm から行を渡す」「見つかった位置を選択して見せる」だけを持つ。
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findHits, setFindHits] = useState<SearchHit[]>([]);
  const [findIndex, setFindIndex] = useState(-1);
  const findInputRef = useRef<HTMLInputElement>(null);
  /** 直近に選んだヒット位置（「次／前」の基準）。 */
  const lastHitRef = useRef<{ row: number; col: number } | null>(null);
  const findTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── プロセス終了と再起動 ────────────────────────────────────
  /** null = 動作中。値が入っていれば終了済み（code は取れなければ null）。 */
  const [exitInfo, setExitInfo] = useState<PtyExitInfo | null>(null);
  /** 再起動のたびに増やす。PTY 起動 effect の依存に入っているので張り直しが走る。 */
  const [restartNonce, setRestartNonce] = useState(0);

  /** 選択中のテキストがあるか（「AIに送る」ボタンの表示条件）。 */
  const [hasSelection, setHasSelection] = useState(false);

  // ── ステータス行（モデル名・エフォート）────────────────────────
  /** 画面表示から読み取れたモデル名（読めないうちは null＝何も出さない）。 */
  const [model, setModel] = useState<string | null>(null);
  /**
   * 🚨 claude は不正な --effort を渡しても落ちず、警告して既定で走る。
   * その警告を見つけたらエフォート表示を「効いていない」に切り替える
   * （送った値をそのまま信じてバッジを出すと、画面が嘘をつく）。
   */
  const [effortRejected, setEffortRejected] = useState(false);
  const cliIdRef = useRef(cliId);
  cliIdRef.current = cliId;
  /**
   * エフォートを指定せずに開いた AI ペインで「おまかせ」と薄く出すか。
   * 判定は純関数（lib/terminal-effort）に置いて単体テストで固定してある。
   * 🚨 表示だけの話で、起動引数は 1 バイトも変わらない。
   */
  const effortDefaultShown = showsDefaultEffortBadge({ kind, cliId, effort });

  /**
   * シェル統合（OSC 133/7）が入っているシェルでだけ分かる「直前のコマンド」。
   * 入っていなければ null のまま＝ステータス行には何も出ない。
   */
  const [lastCmd, setLastCmd] = useState<{
    command: string | null;
    exitCode: number | null;
    durationMs: number;
  } | null>(null);
  /** 直前のコマンドの出力（AI へ渡す用。再描画を起こさないよう ref で持つ）。 */
  const lastCmdOutputRef = useRef<string>("");

  // ── 直近に送った指示のピン留め ─────────────────────────────
  const [echo, setEcho] = useState<EchoState>(EMPTY_ECHO);
  const [pinOpen, setPinOpen] = useState(true);
  const [pinExpanded, setPinExpanded] = useState(false);

  // ── 見えていない間の出来事を親へ通知（タブのバッジ用）────────
  const visibleRef = useRef(visible);
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  /** 非表示期間ごとに 1 回だけ通知するためのフラグ。 */
  const activityFiredRef = useRef(false);
  useEffect(() => {
    visibleRef.current = visible;
    // 見えた＝ユーザーが確認した。次に隠れたときまた 1 回通知できるよう戻す。
    if (visible) activityFiredRef.current = false;
  }, [visible]);

  // 外観プリセットが変わったら、開いているターミナルの配色だけ差し替える。
  // PTY もスクロールバッファも触らないので、セッションは維持される。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.theme = theme;
    } catch {
      /* 非対応版では次に開いたときから反映される */
    }
  }, [theme]);

  // 文字サイズの変更を購読して自分にも反映する（どのペインで拡大しても全部に効く）。
  useEffect(() => subscribeTerminalFontSize(setFontSize), []);

  // 文字サイズを反映し、行数・桁数を測り直す。
  // 🚨 fit は PTY へ resize を伝える（onResize → pty_resize）。ここを省くと
  // 表示は大きくなるのに CLI 側は古い桁数のままで、折り返しがズレる。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.fontSize = fontSize;
    } catch {
      return;
    }
    refitRef.current?.();
  }, [fontSize]);

  /** いまのバッファ全体から一致位置を集める。 */
  const collectHits = useCallback(
    (query: string, caseSensitive: boolean): SearchHit[] => {
      const term = termRef.current;
      const buf = term?.buffer?.active;
      if (!term || !buf || !query) return [];
      try {
        return searchBuffer({
          rowCount: buf.length,
          cols: term.cols,
          getLine: (row) => buf.getLine(row),
          getLineText: (row) => buf.getLine(row)?.translateToString(true),
          query,
          caseSensitive,
        });
      } catch {
        return [];
      }
    },
    [],
  );

  /** ヒットを選択して画面中央付近へスクロールする。 */
  const gotoHit = useCallback((hits: SearchHit[], index: number) => {
    const term = termRef.current;
    if (!term || index < 0 || index >= hits.length) return;
    const h = hits[index];
    try {
      term.select(h.col, h.row, h.length);
      term.scrollToLine(Math.max(0, h.row - Math.floor(term.rows / 2)));
    } catch {
      /* 選択できなくても検索自体は壊さない */
    }
    lastHitRef.current = { row: h.row, col: h.col };
    setFindIndex(index);
  }, []);

  /**
   * 検索を実行する。
   * fromCurrent=false（打鍵中）は「いま見ている位置」から、
   * true（次／前）は「直近のヒット」から探す。端まで行ったら回り込む。
   */
  const runSearch = useCallback(
    (
      query: string,
      caseSensitive: boolean,
      direction: 1 | -1 = 1,
      fromCurrent = false,
    ) => {
      const term = termRef.current;
      const hits = collectHits(query, caseSensitive);
      setFindHits(hits);
      if (hits.length === 0) {
        setFindIndex(-1);
        lastHitRef.current = null;
        try {
          term?.clearSelection();
        } catch {
          /* noop */
        }
        return;
      }
      const viewportTop = term?.buffer?.active?.viewportY ?? 0;
      const idx = pickHitIndex(
        hits,
        fromCurrent ? lastHitRef.current : null,
        direction,
        viewportTop,
      );
      gotoHit(hits, idx);
    },
    [collectHits, gotoHit],
  );

  const openFind = useCallback(() => {
    setFindOpen(true);
    // 選択中の文字列があれば検索語として引き継ぐ（VS Code と同じ作法）
    try {
      const sel = termRef.current?.getSelection() ?? "";
      const oneLine = sel.split("\n")[0]?.trim() ?? "";
      if (oneLine && oneLine.length <= 200) setFindQuery(oneLine);
    } catch {
      /* noop */
    }
    // 描画後にフォーカス（開いた直後に打てるように）
    setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindHits([]);
    setFindIndex(-1);
    lastHitRef.current = null;
    try {
      termRef.current?.clearSelection();
      termRef.current?.focus();
    } catch {
      /* noop */
    }
  }, []);

  // 打鍵ごとに 50,000 行を走査しないようデバウンスしてから検索する。
  useEffect(() => {
    if (!findOpen) return;
    if (findTimerRef.current) clearTimeout(findTimerRef.current);
    findTimerRef.current = setTimeout(() => {
      findTimerRef.current = null;
      runSearch(findQuery, findCase, 1, false);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (findTimerRef.current) {
        clearTimeout(findTimerRef.current);
        findTimerRef.current = null;
      }
    };
  }, [findOpen, findQuery, findCase, runSearch]);

  /** 選択テキストを AI へ渡す（折り返し改行は除去。長すぎる場合は末尾側を残す）。 */
  const sendSelectionToAi = useCallback(() => {
    const term = termRef.current;
    if (!term || !onSendToAi) return;
    let text = "";
    try {
      text = joinHardWrappedLines(term.getSelection(), term.cols).trim();
    } catch {
      text = "";
    }
    if (!text) return;
    // 末尾側（新しい出力＝エラー本体があることが多い）を残す
    if (text.length > MAX_SEND_TO_AI_CHARS) {
      text = "…（省略）\n" + text.slice(text.length - MAX_SEND_TO_AI_CHARS);
    }
    onSendToAi(text);
  }, [onSendToAi]);

  /** 終了した PTY を同じペインで開き直す（閉じて開き直すとレイアウトが崩れるため）。 */
  const handleRestart = useCallback(() => {
    setExitInfo(null);
    setFindOpen(false);
    setFindHits([]);
    setFindIndex(-1);
    lastHitRef.current = null;
    setHasSelection(false);
    setRestartNonce((n) => n + 1);
  }, []);

  /** TUI つまみの推定位置を注入行数ぶん動かす（ホイール／トラッククリック共用）。 */
  const nudgeTuiThumb = useCallback((down: boolean, lines: number) => {
    setTuiThumbTop((prev) => {
      const next = prev + (down ? 1 : -1) * lines * 1.5;
      return Math.min(TUI_THUMB_MAX_TOP, Math.max(0, next));
    });
  }, []);

  /** トラック上の縦位置 → スクロールバック行へ写像して xterm を移動する。 */
  const scrollToClientY = useCallback((clientY: number) => {
    const track = trackRef.current;
    const term = termRef.current;
    if (!track || !term) return;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    try {
      const buf = term.buffer?.active;
      const max = Math.max(0, (buf?.length ?? 0) - term.rows);
      term.scrollToLine(Math.round(ratio * max));
    } catch {
      /* noop */
    }
  }, []);

  /** いま xterm バッファにスクロールバックがあるか（TUI 相対モードとの切替判定）。 */
  const hasScrollback = useCallback(() => {
    const term = termRef.current;
    if (!term) return false;
    try {
      const buf = term.buffer?.active;
      return Math.max(0, (buf?.length ?? 0) - term.rows) > 0;
    } catch {
      return false;
    }
  }, []);

  const onTrackPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // テキスト選択やフォーカス移動を起こさずにドラッグを開始する
      e.preventDefault();
      draggingRef.current = true;
      dragLastYRef.current = e.clientY;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      if (hasScrollback()) {
        scrollToClientY(e.clientY);
        return;
      }
      // TUI モード: つまみの外（トラック余白）クリックはページスクロール注入
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect && rect.height > 0) {
        const pct = ((e.clientY - rect.top) / rect.height) * 100;
        if (pct < tuiThumbTop || pct > tuiThumbTop + TUI_THUMB_HEIGHT_PCT) {
          const down = pct > tuiThumbTop + TUI_THUMB_HEIGHT_PCT;
          tuiInjectRef.current?.(down, 10);
          nudgeTuiThumb(down, 10);
        }
      }
    },
    [hasScrollback, scrollToClientY, tuiThumbTop, nudgeTuiThumb],
  );
  const onTrackPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      if (hasScrollback()) {
        // スクロールバックあり: トラック位置→行の絶対写像
        scrollToClientY(e.clientY);
        dragLastYRef.current = e.clientY;
        return;
      }
      // TUI モード: ドラッグ移動量をホイールイベント注入に変換（相対スクロール）
      const STEP_PX = 8; // 8px ごとに 1 行ぶん注入
      const delta = e.clientY - dragLastYRef.current;
      const n = Math.trunc(delta / STEP_PX);
      if (n !== 0 && tuiInjectRef.current) {
        tuiInjectRef.current(n > 0, Math.min(Math.abs(n), 10));
        dragLastYRef.current += n * STEP_PX;
      }
      // つまみは指に追従させる（TUI は絶対位置を持たないため視覚フィードバック）
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect && rect.height > 0) {
        const pct =
          ((e.clientY - rect.top) / rect.height) * 100 -
          TUI_THUMB_HEIGHT_PCT / 2;
        setTuiThumbTop(Math.min(TUI_THUMB_MAX_TOP, Math.max(0, pct)));
      }
    },
    [hasScrollback, scrollToClientY],
  );
  const onTrackPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // つまみはその場に留める（スナップバックさせない）。claude 側の実位置とは
      // ズレ得るが、「離した瞬間に元へ戻る＝壊れて見える」よりはるかに自然。
      draggingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    },
    [],
  );
  // ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isTauri() || !ref.current) return;
    let disposed = false;
    const id = paneKey
      ? ptyIdForPane(paneKey)
      : ptyIdForPane(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
    let term: any;
    let fit: any;
    let unData: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let ro: ResizeObserver | undefined;
    let io: IntersectionObserver | undefined;
    let linkProvider: { dispose(): void } | undefined;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const inputTimerRef: { current: ReturnType<typeof setTimeout> | undefined } =
      { current: undefined };
    /** シェル統合の読み取り用（effect ローカル）。 */
    const oscCarry = { value: "" };
    const shellCwd: { value: string | null } = { value: null };
    const cmdLine: { value: string | null } = { value: null };
    const cmdRunning = { value: false };
    const cmdStartedAt = { value: 0 };
    const cmdOutput = { value: "" };
    /** モデル名読み取り用の末尾バッファと間引きタイマー。 */
    const statusTail = { value: "" };
    const statusTimer: { current: ReturnType<typeof setTimeout> | undefined } = {
      current: undefined,
    };
    let compCleanup: (() => void) | undefined;
    const scrollDisposables: Array<{ dispose(): void }> = [];
    // ペイン再マウントで PTY を開き直す際、前セッションのバー状態を持ち越さない
    setScroll({ top: 0, max: 0, rows: 0 });
    setTuiMouse(false);
    setExitInfo(null);
    setHasSelection(false);
    setModel(null);
    setEffortRejected(false);
    setEcho(EMPTY_ECHO);
    setLastCmd(null);
    lastCmdOutputRef.current = "";

    /**
     * 要素が実際に表示されている（サイズ > 0）ときだけ fit する。
     * 別ビューに切り替わって display:none の間は clientWidth/Height が 0 になり、
     * そこで fit すると行高が壊れて「文字が縦に圧縮される」ため、0 サイズなら何もしない。
     * 表示に戻った時は IntersectionObserver / ResizeObserver が改めて呼ぶ。
     */
    const doFit = () => {
      const el = ref.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit?.fit();
      } catch {
        /* noop */
      }
    };
    // observer 経由の fit はデバウンス＋次フレームで「レイアウト確定後に1回」だけ実行する。
    // タブ切替や分割ペインのドラッグ中に一瞬縮んだ高さで fit すると、誤った rows が
    // ConPTY に伝わり、対話CLIが入力ボックスを画面上部に描いてしまう（入力が左上に出る）ため。
    const safeFit = () => {
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        fitTimer = undefined;
        requestAnimationFrame(doFit);
      }, 80);
    };

    const raf = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    /**
     * PTY を開く「前」に、確実に正しい cols/rows を確定させるための初期 fit。
     *
     * これが本コンポーネント最大の地雷だった：term.open() 直後に同期で fit すると、
     * ① monospace フォントのメトリクスが未確定（document.fonts 未ロード）／
     * ② Flex レイアウトの実寸が未確定（clientWidth/Height がまだ最終値でない）
     * のタイミングだと、xterm がセル幅・桁数を誤算出して cols/rows がズレる。
     * その誤サイズで ptyOpen すると、claude(Ink) は「自分が思う桁数」で折り返し・
     * カーソル移動するのに xterm は別の実寸で描画するため、
     * 「打った文字と表示位置がズレる」状態が“開いた直後から常時”発生する。
     *
     * → フォント確定（fonts.ready）＋実サイズ確定（rAF を挟む）を待ってから fit し、
     *   その確定後の cols/rows で PTY を開く。
     */
    const fitBeforeOpen = async () => {
      try {
        // フォントのメトリクス確定を待つ（system font でも最低1ティック待てる）
        if (typeof document !== "undefined" && document.fonts?.ready) {
          await document.fonts.ready;
        }
      } catch {
        /* noop */
      }
      // 表示されて実サイズが付くまで待つ。隠れたタブで mount されたまま 80x24 で
      // PTY を開くと、表示時に resize が走って claude が再描画の嵐になり、カーソルが
      // ステータス行に取り残されて日本語IME未確定文字がズレる一因になる。
      // 表示＆サイズ確定まで PTY を開かない＝開いた瞬間から正しい cols/rows にする。
      while (!disposed) {
        const el = ref.current;
        if (el && el.clientWidth > 0 && el.clientHeight > 0) break;
        await raf();
      }
      // レイアウト確定後の1フレームで最終 fit
      await raf();
      doFit();
    };

    (async () => {
      // PTY の作業ディレクトリ（後段で確定）。リンク activate の解決フォールバックに使う。
      let ptyCwd: string | null = null;
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-unicode11"),
        ]);
      if (disposed || !ref.current) return;

      // Windows の ConPTY 行折り返し対策（最重要）。
      // ConPTY は折り返し（line wrap）やスクロールを“自分側”で処理して出力する。
      // xterm.js は既定だと「unix pty が自前で reflow する」前提で動くため、ConPTY と
      // 二重に折り返し解釈してしまい、入力中の文字が本来と違う行に描かれる
      // （上に出たり下に出たり、起動バナーやスクロールバックの行位置までズレる）。
      // xterm の windowsPty オプションに backend:"conpty" と OS ビルド番号を渡すと、
      // 「折り返しは backend 側が担当する」と認識して reflow を二重にせず、行位置が揃う。
      // （VSCode 統合ターミナルが正常に出るのはこの設定をしているため。）
      let windowsPty:
        | { backend: "conpty" | "winpty"; buildNumber?: number }
        | undefined;
      try {
        const os = await import("@tauri-apps/plugin-os");
        if (os.platform() === "windows") {
          // version() は同期。Windows では "10.0.22631" 等 → 末尾が build 番号。
          const ver = os.version() || "";
          const build = Number(ver.split(".").pop());
          windowsPty = Number.isFinite(build)
            ? { backend: "conpty", buildNumber: build }
            : { backend: "conpty" };
        }
      } catch {
        /* OS 取得不可（非 Windows / プラグイン未初期化）時は未設定でよい */
      }
      if (disposed || !ref.current) return;

      term = new Terminal({
        cursorBlink: true,
        // claude の長い応答でも履歴を保てるよう既定(1000)から拡大。
        // 上限到達時の行トリムでスクロール位置が天井へ張り付く現象も緩和される。
        // 2026-07-16: 10000 → 50000。上限到達後は claude の出力のたびに先頭行が
        // トリムされ、xterm は選択範囲が押し出されると選択を全クリアする仕様のため、
        // 長時間セッションで「ドラッグ選択が勝手に終わる」直接原因になっていた。
        scrollback: 50000,
        windowsPty,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace',
        // 文字サイズは Ctrl+ホイールで変えられる（既定 13 = 従来値）。
        fontSize: fontSizeRef.current,
        // 配色は画面の外観プリセットに追従する。明るいテーマでは従来と同じ値。
        theme: themeRef.current,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      // 文字サイズ変更後に「行数・桁数を測り直す」ため、effect の外からも呼べるようにする。
      refitRef.current = () => {
        try {
          fit?.fit();
        } catch {
          /* noop */
        }
      };
      // 全角(CJK)文字幅を Unicode 11 準拠にする。xterm 既定は Unicode 6 のため、
      // claude(Ink) 側の文字幅(string-width=Unicode 11系)と食い違い、日本語入力時に
      // カーソル桁数がズレて入力中の文字が別の行へ描かれていた（IME のときだけ起きる）。
      // activeVersion を "11" に揃えると一致して解消する。
      try {
        const u11 = new Unicode11Addon();
        term.loadAddon(u11);
        term.unicode.activeVersion = "11";
      } catch {
        /* 非対応版では既定のまま */
      }
      term.open(ref.current);
      termRef.current = term;

      // ── 右端ドラッグ・スクロールバー（設計書①）──────────────────────
      // buffer.active の length / viewportY を React state に写して、つまみを描画する。
      // 全画面 TUI（vim 等）中は代替バッファで length==rows → max=0 となり自動的に
      // バー非表示＝既存挙動に影響しない。ホイールでスクロールしてもつまみが追従する。
      const updateScroll = () => {
        try {
          const buf = term.buffer?.active;
          if (!buf) return;
          const rows: number = term.rows;
          const max = Math.max(0, buf.length - rows);
          const top: number = buf.viewportY;
          setScroll((prev) =>
            prev.top === top && prev.max === max && prev.rows === rows
              ? prev
              : { top, max, rows },
          );
        } catch {
          /* noop */
        }
      };
      try {
        scrollDisposables.push(term.onScroll(updateScroll));
        scrollDisposables.push(term.onRender(updateScroll));
        scrollDisposables.push(term.onResize(updateScroll));
      } catch {
        /* onScroll/onRender 非対応版ではバー非表示のまま（他機能は維持） */
      }
      // 選択の有無だけを React state に写す（本文は取りに行かない＝毎回の
      // getSelection は重いので、押されたときだけ読む）。
      try {
        scrollDisposables.push(
          term.onSelectionChange(() => {
            let has = false;
            try {
              has = term.hasSelection();
            } catch {
              has = false;
            }
            setHasSelection((prev) => (prev === has ? prev : has));
          }),
        );
      } catch {
        /* 非対応版では「AIに送る」ボタンが出ないだけ */
      }
      // ────────────────────────────────────────────────────────────────

      // ── ターミナルのコピー & スクロール対応 ──────────────────────────
      // claude 等の TUI は CSI ? 1000/1002/1003(+1006) h でマウストラッキングを
      // 有効化する。これが有効だと左ドラッグがアプリ側へ送られ、xterm 内に
      // テキスト選択が作られず Ctrl+C でコピーできない（本アプリ最大のコピー不具合の
      // 真因）。UNICREW は「普通のドラッグで選択 → Ctrl+C でコピー」を最優先するため、
      // マウス報告の有効化要求(DECSET)を握りつぶして無効化する。
      //
      // ただしマウス報告を全部殺すと TUI がホイールスクロールを受け取れず
      // 「ターミナルがスクロールできない」状態になる。そこで「アプリがマウスを要求中」
      // という事実だけ記録し、ホイール操作時のみ こちらで SGR/X10 のホイールイベントを
      // PTY に注入して TUI にスクロールさせる（＝選択もスクロールも両立）。代償として
      // TUI 内のマウス「クリック」は効かない（クリックは注入しない）。
      let appMouseRequested = false;
      let appMouseSgr = false;
      try {
        const MOUSE_TRACK = new Set([1000, 1001, 1002, 1003]);
        const MOUSE_ENC = new Set([1005, 1006, 1015, 1016]);
        const isMouse = (p: number) => MOUSE_TRACK.has(p) || MOUSE_ENC.has(p);
        const flatten = (params: (number | number[])[]) =>
          params.map((p) => (Array.isArray(p) ? p[0] : p));
        // DECSET (CSI ? Pm h): マウス関連は飲み込む（有効化させない）が要求事実は記録
        term.parser.registerCsiHandler(
          { prefix: "?", final: "h" },
          (params: (number | number[])[]) => {
            const flat = flatten(params);
            if (!flat.some(isMouse)) return false; // マウス無関係はそのまま処理
            if (flat.some((p) => MOUSE_TRACK.has(p))) {
              appMouseRequested = true;
              setTuiMouse(true); // TUI用ドラッグスクロールバーを出す
            }
            if (flat.some((p) => p === 1006 || p === 1015 || p === 1016))
              appMouseSgr = true;
            return true; // 握りつぶす＝xterm では有効化しない
          },
        );
        // DECRST (CSI ? Pm l): 無効化は観測してフラグを下げる（処理自体は通す）
        term.parser.registerCsiHandler(
          { prefix: "?", final: "l" },
          (params: (number | number[])[]) => {
            const flat = flatten(params);
            if (flat.some((p) => MOUSE_TRACK.has(p))) {
              appMouseRequested = false;
              setTuiMouse(false);
            }
            if (flat.some((p) => p === 1006 || p === 1015 || p === 1016))
              appMouseSgr = false;
            return false; // 無効化はそのまま xterm に処理させる
          },
        );
        // ドラッグスクロールバー（TUIモード）からも使うホイール注入関数。
        // 位置は画面中央を名乗る（claude 等はホイールの座標を見ないため十分）。
        tuiInjectRef.current = (down: boolean, lines: number) => {
          if (!appMouseRequested) return;
          try {
            const col = Math.max(1, Math.floor((term.cols || 2) / 2));
            const row = Math.max(1, Math.floor((term.rows || 2) / 2));
            const seq = appMouseSgr
              ? `\x1b[<${down ? 65 : 64};${col};${row}M`
              : `\x1b[M${String.fromCharCode(down ? 97 : 96, 32 + col, 32 + row)}`;
            let payload = "";
            for (let i = 0; i < lines; i++) payload += seq;
            void ptyWriteText(id, payload);
          } catch {
            /* 失敗時はスクロールしない */
          }
        };
        // ホイール: アプリがマウス要求中なら PTY にホイールイベントを注入して
        // TUI をスクロールさせる（xterm 自身のバッファスクロールは抑止）。
        term.attachCustomWheelEventHandler((e: WheelEvent) => {
          // Ctrl+ホイール = 文字サイズの拡大縮小（VS Code と同じ）。
          // 🚨 TUI へのホイール注入より **先に** 判定する。後ろに置くと
          // claude 等がマウス要求中のときにスクロールとして食われて効かない。
          // preventDefault を入れないと WebView 全体のズームが同時に走る。
          if (e.ctrlKey || e.metaKey) {
            try {
              e.preventDefault();
            } catch {
              /* noop */
            }
            const dir = e.deltaY > 0 ? -1 : 1;
            // 保存＋全ペインへ配布（購読側で各ターミナルの state が更新される）
            setTerminalFontSize(clampFontSize(fontSizeRef.current + dir));
            return false;
          }
          if (!appMouseRequested) return true; // 通常時は xterm がバッファをスクロール
          try {
            const rect = ref.current?.getBoundingClientRect();
            let col = 1;
            let row = 1;
            if (rect && term.cols && term.rows) {
              col = Math.min(
                term.cols,
                Math.max(1, Math.floor(((e.clientX - rect.left) / rect.width) * term.cols) + 1),
              );
              row = Math.min(
                term.rows,
                Math.max(1, Math.floor(((e.clientY - rect.top) / rect.height) * term.rows) + 1),
              );
            }
            const down = e.deltaY > 0;
            const lines = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40) || 1));
            const seq = appMouseSgr
              ? `\x1b[<${down ? 65 : 64};${col};${row}M`
              : `\x1b[M${String.fromCharCode(down ? 97 : 96, 32 + col, 32 + row)}`;
            let payload = "";
            for (let i = 0; i < lines; i++) payload += seq;
            void ptyWriteText(id, payload);
            // つまみ（推定位置）もホイール方向へ追従させる。
            // これが無いと「ホイールで中身は動くのに右のバーは固定のまま」に見える。
            nudgeTuiThumb(down, lines);
          } catch {
            /* 失敗時はスクロールしない */
          }
          return false; // xterm 側ではスクロールしない（TUI に委ねた）
        });
      } catch {
        /* parser/wheel API 非対応版では何もしない（Shift+ドラッグで選択可能） */
      }
      // ────────────────────────────────────────────────────────────────
      // WebGL レンダラ（VSCode 統合ターミナルと同じ方式）。各グリフをセル枠にクリップして
      // GPU 描画するため、DOM レンダラで起きていた「全角(日本語)入力時に差分描画がズレて
      // 入力中の文字が別の行に描かれる」問題に強い。生成失敗/コンテキスト喪失時は DOM へ戻す。
      // 【2026-08-14 修正】旧実装はコンテキスト喪失時に dispose() だけして
      // DOM レンダラへ落としていた。DOM レンダラには上記の「全角の差分描画ズレ」が
      // あるため、長時間使用（GPU リセット・スリープ復帰・メモリ逼迫で喪失が起きる）
      // の後に「文章が崩れて表示される」状態へ移行していた。VS Code と同じく
      // 喪失時は WebGL アドオンを作り直し、復帰後に全面 refresh して描画を復元する。
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        let webglRetries = 0;
        const loadWebgl = () => {
          if (disposed) return;
          // GPU が完全に死んでいる環境で 喪失→再生成→即喪失 の高速ループに
          // ならないよう上限を設ける（上限到達後は DOM レンダラで継続）
          if (webglRetries++ > 5) return;
          try {
            const webgl = new WebglAddon();
            webgl.onContextLoss(() => {
              try {
                webgl.dispose();
              } catch {
                /* noop */
              }
              // 直後の再生成は同じ喪失中コンテキストを掴みがちなので 1 ティック譲る
              setTimeout(loadWebgl, 50);
            });
            term.loadAddon(webgl);
            // 再生成後はアトラスが空なので全面再描画で現画面を復元する
            try {
              term.refresh(0, Math.max(0, term.rows - 1));
            } catch {
              /* noop */
            }
          } catch {
            // WebGL 再生成不可（GPU 無効化等）→ DOM レンダラで継続。
            // せめて全面 refresh して喪失時点の描き掛けを消す。
            try {
              term.refresh(0, Math.max(0, term.rows - 1));
            } catch {
              /* noop */
            }
          }
        };
        loadWebgl();
      } catch {
        /* WebGL 不可環境では DOM レンダラのまま（機能は維持） */
      }
      // 同期 fit はあくまで暫定。確定 fit は PTY を開く直前に fitBeforeOpen() で行う。
      doFit();

      // ターミナル内のファイルパス／URL を Ctrl/Cmd+Click で開く（VSCode 統合ターミナル相当）。
      //  - ファイルパス: openFileInEditorWindow（別ウィンドウのエディタにタブ追加）
      //  - http(s) URL : openExternal（OS 既定ブラウザ）
      // URL とファイルパスは互いに排他（findPathMatches/findUrlMatches 双方で URL は除外済）。
      // 重複行のリンクは「URL を優先」してファイル側の重なる範囲を捨てる（ありえないが念のため）。
      try {
        linkProvider = term.registerLinkProvider({
          provideLinks(
            bufferLineNumber: number,
            callback: (links: unknown[] | undefined) => void,
          ) {
            // 折り返しを連結した「論理行」で検出する（視覚行単位だと長いパスが
            // 断片になる）。さらに文字列インデックス→セル座標の変換を行う。
            // 全角(日本語)は文字列1文字でも2セルを占めるため、変換しないと
            // 日本語入りパスのクリック領域が短くなる（部分クリックバグ）。
            // ロジックは lib/terminal-links.ts（純関数・単体テスト済）。
            const info = readLogicalLine(
              (r: number) => term.buffer?.active?.getLine(r),
              bufferLineNumber - 1,
            );
            if (!info || !info.text) {
              callback(undefined);
              return;
            }
            const urlMatches = findUrlMatches(info.text);
            const pathMatches = findPathMatches(info.text).filter((p) =>
              urlMatches.every((u) => p.end <= u.start || p.start >= u.end),
            );
            if (urlMatches.length === 0 && pathMatches.length === 0) {
              callback(undefined);
              return;
            }
            const links = [
              ...urlMatches.map((mt) => ({
                range: matchToBufferRange(info, mt.start, mt.end),
                text: mt.raw,
                activate: (e: MouseEvent) => {
                  if (!(e.ctrlKey || e.metaKey)) return;
                  void openExternal(mt.url).catch(() => {
                    /* 開けない場合は無視 */
                  });
                },
              })),
              ...pathMatches.map((mt) => ({
                range: matchToBufferRange(info, mt.start, mt.end),
                text: mt.raw,
                activate: (e: MouseEvent) => {
                  // VSCode 風: 修飾キー付きクリックでのみ開く（誤クリック防止・選択は通常通り）
                  if (!(e.ctrlKey || e.metaKey)) return;
                  // 設計書③: workspace 直下に無ければ Rust 側で配下を探索し、
                  // 見つからなければトースト表示（無言握り潰しをやめる）。
                  // 監査MED（2026-08-28 Codex）: リンク解決は「このペインの PTY が
                  // 開いた世界」＝ptyCwd で行う。現在の workspace を使うと、
                  // workspace 切替後に古い PTY 出力の相対パスが新 workspace 側へ
                  // 解決されてしまう（PTY を凍結したのだからリンク基準も凍結する）。
                  void openFileSmart(mt.openPath, ptyCwd, ptyCwd).catch(
                    () => {
                      /* openFileSmart 内でトースト表示済み */
                    },
                  );
                },
              })),
            ].filter(
              (l): l is typeof l & { range: NonNullable<typeof l.range> } =>
                l.range != null &&
                // 問い合わせ行に重なるリンクだけ返す（他行のものは各行の照会時に返す）
                l.range.start.y <= bufferLineNumber &&
                l.range.end.y >= bufferLineNumber,
            );
            callback(links.length > 0 ? links : undefined);
          },
        });
      } catch {
        /* registerLinkProvider 非対応版では何もしない */
      }

      // コピー＆ペースト（Ctrl/Cmd + C / V）。OS クリップボードを明示的に読み書きする。
      // - Ctrl/Cmd+C: 選択があれば writeClipboardText でコピー（無ければ既定の SIGINT を通す）
      // - Ctrl/Cmd+V: readClipboardText で本文を読み、term.paste() で 1 回だけ貼り付ける。
      //
      //   なぜネイティブ paste イベントに任せないか：
      //   旧実装は「^V を送らせない（false）／貼り付けは WebView のネイティブ paste
      //   イベント 1 本に任せる」方式だったが、WebView2 ではネイティブ paste イベントや
      //   navigator.clipboard が届かず「コピペができない」事象が発生した。
      //   そこで OS レベルの Tauri clipboard-manager を第一経路に据え、貼り付けは
      //   e.preventDefault() でネイティブ paste を止めてから term.paste() を 1 回だけ呼ぶ。
      //   preventDefault で native が発火しないので二重貼り付けにならず、xterm 内部の
      //   ブラケットペースト処理（ESC[200~ … ESC[201~）は term.paste() 側が担うため
      //   claude/readline でも貼り付けが壊れない。^V(0x16) は return false で送らせない。
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") return true;
        const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
        // Ctrl/⌘+F: ターミナル内検索を開く。
        // 🚨 stopPropagation が要る理由: document 側（app/page.tsx）にチャット検索の
        // Ctrl+F ハンドラがあり、素通しすると「ターミナルを見ているのに、隠れている
        // チャットの検索が動く」＝ターミナルでは何も起きないように見えていた。
        if (mod && !e.shiftKey && (e.key === "f" || e.key === "F")) {
          e.preventDefault();
          e.stopPropagation();
          openFind();
          return false;
        }
        // Ctrl/⌘+K: シェルの行削除（readline の kill-line）を優先する。
        // 素通しするとコマンドパレットが同時に開き、「行が消える」と
        // 「パレットが出る」が一度に起きていた。^K は PTY へ送る（return true）。
        if (mod && !e.shiftKey && (e.key === "k" || e.key === "K")) {
          e.stopPropagation();
          return true;
        }
        if (mod && (e.key === "c" || e.key === "C")) {
          if (term.hasSelection()) {
            // claude(Ink) は本文を端末幅で折り返す際に実改行を挿入して描画するため、
            // そのままコピーすると画面上の折返し改行が混入して他アプリで崩れる。
            // 幅いっぱいの行だけ次行と連結して原文の改行に近づける（terminal-copy.ts）。
            const sel = joinHardWrappedLines(term.getSelection(), term.cols);
            // WebView2 では plugin / navigator.clipboard の書き込みが失敗し
            // 「Ctrl+C でコピーできない」事象がある。keydown ジェスチャ内で同期実行できる
            // execCommand("copy") を第一経路にして確実にコピーし、失敗時のみ OS
            // クリップボード plugin にフォールバックする。
            if (sel) {
              e.preventDefault();
              const ok = copyTextSync(sel);
              if (!ok) void writeClipboardText(sel);
            }
            term.clearSelection();
            return false; // SIGINT を送らずコピーを優先
          }
          return true; // 選択が無ければ通常どおり SIGINT
        }
        if (mod && (e.key === "v" || e.key === "V")) {
          // 貼り付けはネイティブ paste イベントに頼らず、OS クリップボードを明示的に
          // 読んで term.paste() する（WebView2 でネイティブ paste が届かず貼れない事例の対策）。
          // preventDefault でネイティブ paste を止めるため二重貼り付けにはならない。
          // ^V(0x16) も return false で PTY に送らせない。
          e.preventDefault();
          void (async () => {
            try {
              const text = await readClipboardText();
              if (!text) return;
              // 【2026-08-14 修正】複数行ペーストの崩れ対策。
              // claude(Ink) は起動時に ?2004h（ブラケットペースト）を有効化するが、
              // Windows の ConPTY はこのモード変更を端末側へ通さないことがあり、
              // その場合 xterm はブラケットモードに入らず term.paste() が素の \r を送る。
              // claude は \r を Enter として処理するため、複数行テキストが行ごとに
              // 送信されて Ink の再描画で改行・空白が混入して崩れる。
              // → モードが立っていない claude ターミナルでは、マーカー
              //   （ESC[200~ … ESC[201~）を自前で付けて PTY へ直接書く。
              //   claude CLI 自身はマーカーを解釈して「1 個の貼り付けブロック」として
              //   受け取るため、どちらの環境でも同じ挙動になる。
              //   （shell ターミナルは cmd がマーカー未対応のため従来どおり term.paste()）
              const normalized = text.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
              const bracketed = (() => {
                try {
                  return term.modes?.bracketedPasteMode === true;
                } catch {
                  return false;
                }
              })();
              if (!bracketed && kind === "claude" && normalized.includes("\r")) {
                // onData を経由しない経路なので、ここでも写し取る
                setEcho((prev) => feedInput(prev, normalized));
                void ptyWriteText(id, "\x1b[200~" + normalized + "\x1b[201~");
              } else {
                term.paste(text);
              }
            } catch {
              /* クリップボード取得不可時は何もしない */
            }
          })();
          return false;
        }
        return true;
      });

      const outputDecoder = new TextDecoder();
      unData = await onPtyData(id, (bytes) => {
        term?.write(bytes);
        // 🚨 起動直後に書き込むと、シェルが端末を初期化する前で入力が捨てられる
        //    ことがある。最初の出力（＝プロンプトが出た合図）を見てから少し待って流す。
        if (pendingInputRef.current && inputTimerRef.current === undefined) {
          inputTimerRef.current = setTimeout(() => {
            inputTimerRef.current = undefined;
            const text = pendingInputRef.current;
            pendingInputRef.current = undefined; // 1 回きり
            if (text) void ptyWriteText(id, text + "\r");
          }, 250);
        }
        // 見えていない間に出力が来たことだけを 1 回通知する（タブのバッジ用）。
        // 出力のたびに親へ setState させると 24 ペイン分の再描画が走るので絞る。
        if (!visibleRef.current && !activityFiredRef.current) {
          activityFiredRef.current = true;
          try {
            onActivityRef.current?.("output");
          } catch {
            /* 通知の失敗でターミナルを壊さない */
          }
        }
        // 出力は 1 回だけデコードして、観測フック・シェル統合・モデル名読み取りで共有する。
        let text = "";
        try {
          text = outputDecoder.decode(bytes, { stream: true });
        } catch {
          text = "";
        }
        if (onOutputRef.current && text) {
          try {
            onOutputRef.current(text);
          } catch {
            /* observer hook must never break the terminal */
          }
        }
        // シェル統合（OSC 133/7）。入れていないシェルでは 1 件も拾えず何も起きない。
        if (text) {
          const [ready, pending] = splitPendingOsc(oscCarry.value + text);
          oscCarry.value = pending;
          if (ready.indexOf("]") >= 0) {
            for (const ev of parseShellEvents(ready)) {
              if (ev.kind === "cwd") {
                // cd に追随する（ヘッダーが「開いた瞬間の場所」で止まって嘘になるのを防ぐ）
                if (shellCwd.value !== ev.cwd) {
                  shellCwd.value = ev.cwd;
                  try {
                    onCwdRef.current?.(ev.cwd);
                  } catch {
                    /* 表示用フックの失敗でターミナルを壊さない */
                  }
                }
              } else if (ev.kind === "command-line") {
                cmdLine.value = ev.command;
              } else if (ev.kind === "command-start") {
                cmdRunning.value = true;
                cmdStartedAt.value = Date.now();
                cmdOutput.value = "";
              } else if (ev.kind === "command-end") {
                const started = cmdStartedAt.value;
                lastCmdOutputRef.current = cmdOutput.value;
                setLastCmd({
                  command: cmdLine.value,
                  exitCode: ev.exitCode,
                  durationMs: started ? Date.now() - started : 0,
                });
                cmdRunning.value = false;
                cmdStartedAt.value = 0;
                cmdLine.value = null;
              }
            }
          }
          // 実行中のコマンドの出力だけを貯める（AI へ渡す用・上限つき）
          if (cmdRunning.value) {
            cmdOutput.value = appendTail(cmdOutput.value, text, 100000);
          }
          // モデル名の読み取りは重いので、末尾だけ貯めて 500ms に 1 回だけ見る。
          statusTail.value = appendTail(statusTail.value, text);
          if (statusTimer.current === undefined) {
            statusTimer.current = setTimeout(() => {
              statusTimer.current = undefined;
              const tail = statusTail.value;
              const found = detectModel(tail, cliIdRef.current);
              if (found) setModel((prev) => (prev === found ? prev : found));
              // 🚨「効かなかった」を見つけたら表示を取り消す（嘘を出さない）
              if (detectEffortRejected(tail)) setEffortRejected(true);
            }, 500);
          }
        }
      });
      unExit = await onPtyExit(id, (info) => {
        onExitedRef.current?.();
        setExitInfo(info);
        // 終了コードは「取れたときだけ」出す。取れなければ 0 で埋めずに黙る
        //（分からないことを、分かったように書かない）。
        const msg =
          info.code === null
            ? tRef.current("terminal.exitedUnknown")
            : tRef.current("terminal.exitedWithCode", { code: info.code });
        // 異常終了は赤、正常終了は黄（従来色）。
        const color = info.success === false ? "\x1b[31m" : "\x1b[33m";
        term?.write("\r\n" + color + "[" + msg + "]\x1b[0m" + "\r\n");
        // 見えていないページで落ちたことは必ず知らせる（出力通知より優先）。
        if (!visibleRef.current) {
          activityFiredRef.current = true;
          try {
            onActivityRef.current?.("exit", info);
          } catch {
            /* 通知の失敗でターミナルを壊さない */
          }
        }
      });

      // フォント＆レイアウト確定後に確定 fit してから PTY を開く。
      // これで「開いた直後から打った文字と表示位置がズレる」現象を防ぐ。
      await fitBeforeOpen();
      if (disposed) return;

      // cwd は「PTY を開く瞬間」（＝初回表示時）の workspace で確定する。
      // fitBeforeOpen が表示まで待つので、ターミナルビューを開いた時点の
      // アクティブ workspace が反映される。以後 workspace が変わっても
      // この PTY は開き直さない（セッション維持・2026-08-28 修正）。
      // workspace が無いと PTY が親プロセス(unicrew.exe)の cwd を継承してしまい
      // C: 基点で開いてしまう。明示的にデフォルト workspace へフォールバックする。
      // 復元されたペインは「前回開いていた場所」を優先する。
      // 🚨 実在を確かめてから使う。消えたフォルダを渡すと spawn が失敗して
      // 「開いた瞬間に何も出ないペイン」になる（原因が画面から分からない）。
      let cwd: string | null = null;
      const savedCwd = initialCwdRef.current;
      if (savedCwd && savedCwd.trim()) {
        cwd = (await pathExists(savedCwd)) ? savedCwd : null;
      }
      if (disposed) return;
      const wsAtOpen = workspaceRef.current;
      if (!cwd) cwd = wsAtOpen && wsAtOpen.trim() ? wsAtOpen : null;
      if (!cwd) {
        try {
          cwd = await defaultWorkspacePath();
        } catch {
          cwd = null;
        }
      }

      ptyCwd = cwd;
      try {
        onCwdRef.current?.(cwd);
      } catch {
        /* 表示用フックの失敗でターミナルを壊さない */
      }

      // 設計書⑤: 起動プログラムの決定。shell は Rust 側でOS別に解決する。
      let program = "claude";
      let args: string[] = [];
      if (kind === "remote-control") {
        // 公式 Remote Control（サーバーモード）。claude.ai / Claude アプリから
        // このPCのセッションに接続できる。会話はスマホ/ブラウザ側で行う。
        args = ["remote-control"];
      }
      if (commandRef.current) {
        // マルチAI: 指定プログラムをそのまま起動（PATH 解決は Rust 側）。
        program = commandRef.current.program;
        args = commandRef.current.args ?? [];
      } else if (kind === "shell") {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const info = await invoke<{
            program: string;
            args: string[];
            label: string;
          }>("default_shell");
          program = info.program;
          args = info.args ?? [];
        } catch (err) {
          // 無言で失敗させない（③と同方針）。Git Bash 等が無い環境で明示する。
          term.write(
            "\r\n\x1b[31m[シェルが見つかりません] " +
              String(err) +
              "\x1b[0m\r\n",
          );
          return;
        }
      }
      if (disposed) return;

      await ptyOpen({
        id,
        program,
        args,
        cwd,
        cols: term.cols,
        rows: term.rows,
      });

      term.onData((d: string) => {
        void ptyWriteText(id, d);
        // 送った指示を写し取る（画面を読むのではなく、送った文字を正本にする）
        setEcho((prev) => feedInput(prev, d));
        // 文字入力・Enter で claude(TUI) は自動的に最下部へ戻るため、
        // 推定つまみも最下部へ同期する（ESC始まりの制御列は除外）。
        if (d && !d.startsWith("\x1b")) setTuiThumbTop(TUI_THUMB_MAX_TOP);
      });
      let lastCols = term.cols;
      let lastRows = term.rows;
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (cols === lastCols && rows === lastRows) return;
        lastCols = cols;
        lastRows = rows;
        void ptyResize(id, cols, rows);
      });

      // 実サイズ変化に追従（display:none の間は safeFit が 0 サイズを弾く）
      ro = new ResizeObserver(() => safeFit());
      ro.observe(ref.current);

      // 別ビューから戻って再表示された瞬間に fit し直す。
      // display:none → 表示で IntersectionObserver が isIntersecting:true を返すので、
      // レイアウト確定後（rAF）に safeFit して縦圧縮を確実に直す。
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            requestAnimationFrame(() => safeFit());
          }
        }
      });
      io.observe(ref.current);

      // 日本語IME未確定文字の位置補正（v0.2.30〜 VS Code方式）。
      // 基本は何もしない：xterm の CompositionHelper は実カーソル位置に未確定文字を
      // 置き、claude CLI は「実カーソル＝挿入点」を upstream で保守している
      // （VS Code 統合ターミナルがズレない理由と同じ契約）。
      // 実カーソルが入力領域の外にある異常時のみヒューリスティックで上書きする。
      // 判定ロジックは lib/terminal-ime.ts（純関数・単体テストで回帰防止）。
      const promptInputPos = (): { top: number; left: number } | null => {
        try {
          const buf = term.buffer?.active;
          const rows: number = term.rows;
          const cols: number = term.cols;
          if (!buf || !rows || !cols) return null;
          const base: number = buf.baseY;
          const pos = findCompositionOverride({
            rows,
            cols,
            lineText: (y: number) =>
              buf.getLine(base + y)?.translateToString(true) ?? "",
            isInverse: (y: number, x: number) => {
              const cell = buf.getLine(base + y)?.getCell(x);
              return Boolean(cell && cell.isInverse && cell.isInverse());
            },
            cursorY: buf.cursorY,
            cursorX: buf.cursorX,
          });
          if (!pos) return null; // null = xterm ネイティブ配置を信頼（基本経路）
          const screen = ref.current?.querySelector(
            ".xterm-screen",
          ) as HTMLElement | null;
          const h = screen?.clientHeight ?? ref.current?.clientHeight ?? 0;
          const w = screen?.clientWidth ?? ref.current?.clientWidth ?? 0;
          if (!h || !w) return null;
          return {
            top: Math.round((pos.rowY * h) / rows),
            left: Math.round((pos.col * w) / cols),
          };
        } catch {
          return null;
        }
      };
      const fixComposition = () => {
        const pos = promptInputPos();
        if (!pos) return;
        const view = ref.current?.querySelector(
          ".composition-view",
        ) as HTMLElement | null;
        const ta = term.textarea as HTMLTextAreaElement | undefined;
        if (view) {
          view.style.top = `${pos.top}px`;
          view.style.left = `${pos.left}px`;
        }
        if (ta) {
          ta.style.top = `${pos.top}px`;
          ta.style.left = `${pos.left}px`;
        }
      };
      const cleanups: Array<() => void> = [];
      // 本命：xterm の位置決め updateCompositionElements をフックし、xterm が位置を
      // 入れた“同じ同期処理内”で挿入点へ上書きする。後追い(setTimeout)だと誤位置が
      // 1フレーム描画されて画面が震える（ブルブル）。同期上書きなら誤位置は一度も
      // 描画されず震えが出ない。
      let patched = false;
      try {
        const core = (term as unknown as { _core?: Record<string, unknown> })
          ._core;
        if (core) {
          for (const k of Object.keys(core)) {
            const obj = core[k] as
              | { updateCompositionElements?: (x?: boolean) => void }
              | null;
            if (obj && typeof obj.updateCompositionElements === "function") {
              const orig = obj.updateCompositionElements.bind(obj);
              obj.updateCompositionElements = (dontRecurse?: boolean) => {
                orig(dontRecurse);
                fixComposition();
              };
              cleanups.push(() => {
                obj.updateCompositionElements = orig as never;
              });
              patched = true;
              break;
            }
          }
        }
      } catch {
        /* フック不可環境ではフォールバックへ */
      }
      // 【2026-07-16 修正】ビューポートが上にスクロールされたまま IME 合成を始めると、
      // xterm の CompositionHelper は isCursorInViewport=false で位置決めを丸ごと
      // スキップし、合成ボックスが既定位置（画面左上 0,0）に出る。通常キーは
      // scrollOnUserInput で最下部へ戻るが、IME 合成キー（keyCode 229）はその経路を
      // 通らない。合成開始時に明示的に最下部へ戻して実カーソルを視界に入れる
      //（通常キー入力と同じ挙動に揃えるだけなので副作用なし）。
      const taForScroll = term.textarea as HTMLTextAreaElement | undefined;
      if (taForScroll) {
        const scrollOnCompose = () => {
          try {
            term.scrollToBottom();
          } catch {
            /* noop */
          }
        };
        taForScroll.addEventListener("compositionstart", scrollOnCompose);
        cleanups.push(() =>
          taForScroll.removeEventListener("compositionstart", scrollOnCompose),
        );
      }

      // フォールバック：フックできない環境では従来どおりイベントで後追い補正
      // （位置は合うが震えは残る）。
      const taEl = term.textarea as HTMLTextAreaElement | undefined;
      if (!patched && taEl) {
        const onComp = () => setTimeout(fixComposition, 0);
        taEl.addEventListener("compositionstart", onComp);
        taEl.addEventListener("compositionupdate", onComp);
        cleanups.push(() => {
          taEl.removeEventListener("compositionstart", onComp);
          taEl.removeEventListener("compositionupdate", onComp);
        });
      }
      compCleanup = () => {
        for (const c of cleanups) {
          try {
            c();
          } catch {
            /* noop */
          }
        }
      };

      term.focus();
    })();

    return () => {
      disposed = true;
      if (fitTimer !== undefined) clearTimeout(fitTimer);
      if (inputTimerRef.current !== undefined) {
        clearTimeout(inputTimerRef.current);
        inputTimerRef.current = undefined;
      }
      if (statusTimer.current !== undefined) {
        clearTimeout(statusTimer.current);
        statusTimer.current = undefined;
      }
      try {
        ro?.disconnect();
      } catch {
        /* noop */
      }
      try {
        io?.disconnect();
      } catch {
        /* noop */
      }
      try {
        unData?.();
      } catch {
        /* noop */
      }
      try {
        unExit?.();
      } catch {
        /* noop */
      }
      try {
        linkProvider?.dispose();
      } catch {
        /* noop */
      }
      try {
        compCleanup?.();
      } catch {
        /* noop */
      }
      for (const d of scrollDisposables) {
        try {
          d.dispose();
        } catch {
          /* noop */
        }
      }
      termRef.current = null;
      tuiInjectRef.current = null;
      refitRef.current = null;
      void ptyKill(id);
      try {
        term?.dispose();
      } catch {
        /* noop */
      }
    };
    // workspace は意図的に依存へ入れない（ref 参照）。入れると workspace 変化の
    // たびに ptyKill → 開き直しが走り、ターミナルが勝手に閉じる（2026-08-28 根治）。
    // nudgeTuiThumb は useCallback([]) の恒等安定な関数（入れても再実行されない）。
    // restartNonce: 「再起動」ボタンで増やすと cleanup（ptyKill＋dispose）→
    // 再初期化が走る。開き直しの手順を 2 か所に書かないための仕掛け。
  }, [paneKey, kind, nudgeTuiThumb, restartNonce, openFind]);

  if (!isTauri()) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--color-muted)]">
        対話ターミナルは UNICREW アプリ起動時のみ利用できます。
      </div>
    );
  }

  // つまみの高さ％（表示行数/全体比・最低8%）と位置％（スクロール位置比）。
  const thumbPct =
    scroll.max > 0
      ? Math.max(8, (scroll.rows / (scroll.max + scroll.rows)) * 100)
      : 100;
  const thumbTopPct =
    scroll.max > 0 ? (scroll.top / scroll.max) * (100 - thumbPct) : 0;

  return (
    // unicrew-term: globals.css で xterm 標準スクロールバーを隠すためのスコープ。
    // 標準バーとカスタムバーが二重に出ると、標準バーの右半分がオーバーレイに
    // 覆われて「押しても動かないバー」に見えるため、カスタムバーへ一本化する。
    <div
      className="unicrew-term flex h-full w-full flex-col"
      style={{ backgroundColor: theme.background }}
    >
      {/* いま出した指示のピン留め。流れていっても上に残る。 */}
      {echo.last && pinOpen && (
        <div
          className="shrink-0 flex items-start gap-1.5 border-b border-[var(--color-border)] px-2 py-1 text-[11.5px]"
          style={{ backgroundColor: theme.background }}
        >
          <Pin
            size={11}
            className="mt-0.5 shrink-0 text-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={() => setPinExpanded((v) => !v)}
            title={t("terminal.pinExpand")}
            className={`min-w-0 flex-1 text-left font-mono ${
              pinExpanded ? "whitespace-pre-wrap break-words" : "truncate"
            }`}
            style={{ color: theme.foreground, opacity: 0.85 }}
          >
            {echo.last}
          </button>
          <button
            type="button"
            onClick={() => setPinOpen(false)}
            title={t("terminal.pinHide")}
            aria-label={t("terminal.pinHide")}
            className="shrink-0 rounded p-0.5 text-[var(--color-muted)] transition hover:bg-[var(--color-surface)]"
          >
            <PinOff size={11} />
          </button>
        </div>
      )}
      {/* 隠したあとに戻すための細い帯（指示があるときだけ） */}
      {echo.last && !pinOpen && (
        <button
          type="button"
          onClick={() => setPinOpen(true)}
          title={t("terminal.pinShow")}
          className="shrink-0 flex items-center gap-1 border-b border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
        >
          <Pin size={10} />
          {t("terminal.pinShow")}
        </button>
      )}

      <div className="relative min-h-0 min-w-0 flex-1 p-2">
      <div ref={ref} className="h-full w-full" />
      {(scroll.max > 0 || tuiMouse) && (
        <div
          ref={trackRef}
          className="absolute top-2 right-0 bottom-2 w-3 z-10 cursor-ns-resize select-none touch-none"
          onPointerDown={onTrackPointerDown}
          onPointerMove={onTrackPointerMove}
          onPointerUp={onTrackPointerUp}
          onPointerCancel={onTrackPointerUp}
        >
          {scroll.max > 0 ? (
            <div
              className="absolute right-0.5 w-2 rounded transition-colors"
              style={{
                height: `${thumbPct}%`,
                top: `${thumbTopPct}%`,
                // 黒固定だと暗いテーマで見えない。文字色を薄めて使う。
                backgroundColor: theme.foreground,
                opacity: 0.28,
              }}
            />
          ) : (
            // TUI（claude等）モード: 推定位置つまみ。ドラッグ／ホイール注入に
            // 追従し、離してもその場に留まる（入力時に最下部へ戻る）。
            <div
              className="absolute right-0.5 w-2 rounded transition-colors"
              style={{
                height: `${TUI_THUMB_HEIGHT_PCT}%`,
                top: `${tuiThumbTop}%`,
                backgroundColor: theme.foreground,
                opacity: 0.22,
              }}
            />
          )}
        </div>
      )}

      {/* 検索バー（Ctrl+F）。スクロールバックは 50,000 行あるので、
          「出た文字を探せない」を無くすための最小 UI。 */}
      {findOpen && (
        <div className="absolute top-1 right-4 z-20 flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-1 shadow-md">
          <Search size={12} className="shrink-0 text-[var(--color-muted)]" />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              // Esc / Enter はターミナル側にも document 側にも渡さない
              //（Esc は「実行中AIの停止」に、Ctrl+F はチャット検索に繋がっている）。
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeFind();
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                runSearch(findQuery, findCase, e.shiftKey ? -1 : 1, true);
                return;
              }
              if (
                (e.ctrlKey || e.metaKey) &&
                (e.key === "f" || e.key === "F")
              ) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            placeholder={t("terminal.findPlaceholder")}
            aria-label={t("terminal.findPlaceholder")}
            spellCheck={false}
            className="w-44 bg-transparent text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-muted)]"
          />
          <span
            className={`shrink-0 font-mono text-[10.5px] ${
              findQuery && findHits.length === 0
                ? "text-red-500"
                : "text-[var(--color-muted)]"
            }`}
          >
            {findQuery === ""
              ? ""
              : findHits.length === 0
                ? t("terminal.findNoMatch")
                : `${findIndex + 1}/${findHits.length}`}
          </span>
          <button
            type="button"
            onClick={() => setFindCase((v) => !v)}
            title={t("terminal.findCaseTitle")}
            aria-label={t("terminal.findCaseTitle")}
            aria-pressed={findCase}
            className={`rounded p-0.5 transition ${
              findCase
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
            }`}
          >
            <CaseSensitive size={13} />
          </button>
          <button
            type="button"
            onClick={() => runSearch(findQuery, findCase, -1, true)}
            title={t("terminal.findPrev")}
            aria-label={t("terminal.findPrev")}
            className="rounded p-0.5 text-[var(--color-muted)] transition hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            onClick={() => runSearch(findQuery, findCase, 1, true)}
            title={t("terminal.findNext")}
            aria-label={t("terminal.findNext")}
            className="rounded p-0.5 text-[var(--color-muted)] transition hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            onClick={closeFind}
            title={t("terminal.findClose")}
            aria-label={t("terminal.findClose")}
            className="rounded p-0.5 text-[var(--color-muted)] transition hover:bg-red-50 hover:text-red-500"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* 右下の操作: 落ちたら「再起動」、選択したら「AIに送る」。
          どちらも出ていない間は何も描かない（ターミナルの邪魔をしない）。 */}
      {(exitInfo !== null || (hasSelection && !!onSendToAi)) && (
        <div className="absolute bottom-3 right-4 z-20 flex flex-col items-end gap-1.5">
          {exitInfo !== null && (
            <button
              type="button"
              onClick={handleRestart}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11.5px] text-[var(--color-text)] shadow-md transition hover:opacity-90"
            >
              <RotateCw size={12} />
              {exitInfo.code === null
                ? t("terminal.restart")
                : t("terminal.restartWithCode", { code: exitInfo.code })}
            </button>
          )}
          {hasSelection && !!onSendToAi && (
            <button
              type="button"
              onClick={sendSelectionToAi}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-1 text-[11.5px] text-white shadow-md transition hover:opacity-90"
            >
              <Send size={12} />
              {t("terminal.sendSelectionToAi")}
            </button>
          )}
        </div>
      )}
      </div>

      {/* ステータス行（分かっていることだけ出す。分からないものは出さない） */}
      {(effort || effortDefaultShown || model || lastCmd) && (
        <div
          className="shrink-0 flex items-center gap-3 border-t border-[var(--color-border)] px-2 py-0.5 text-[10.5px]"
          style={{ backgroundColor: theme.background }}
        >
          {effort && (
            <span
              className={`inline-flex items-center gap-1 font-mono ${
                effortRejected ? "text-red-500" : "text-[var(--color-accent)]"
              }`}
              title={
                effortRejected
                  ? t("terminal.effortRejectedTitle")
                  : t("terminal.effortBadgeTitle", { level: effort })
              }
            >
              {effortRejected ? (
                <AlertTriangle size={10} />
              ) : (
                <Gauge size={10} />
              )}
              <span className={effortRejected ? "line-through" : ""}>
                {effort}
              </span>
              {effortRejected && (
                <span className="not-italic">
                  {t("terminal.effortRejectedShort")}
                </span>
              )}
            </span>
          )}
          {effortDefaultShown && (
            <span
              className="inline-flex items-center gap-1 font-mono text-[var(--color-muted)] opacity-70"
              title={t("terminal.effortDefaultBadgeTitle")}
            >
              <Gauge size={10} />
              {t("terminal.effortDefaultBadge")}
            </span>
          )}
          {model && (
            <span
              className="inline-flex min-w-0 items-center gap-1 font-mono text-[var(--color-muted)]"
              title={t("terminal.modelReadFromScreen")}
            >
              <Cpu size={10} />
              <span className="truncate">{model}</span>
            </span>
          )}
          {lastCmd && (
            <span
              className={`inline-flex min-w-0 items-center gap-1 font-mono ${
                lastCmd.exitCode === 0 || lastCmd.exitCode === null
                  ? "text-[var(--color-muted)]"
                  : "text-red-500"
              }`}
              title={t("terminal.lastCommandTitle")}
            >
              <span className="truncate">
                {lastCmd.command ?? t("terminal.lastCommandUnknown")}
              </span>
              {lastCmd.exitCode !== null && (
                <span>
                  {lastCmd.exitCode === 0
                    ? "✓"
                    : `✗ ${lastCmd.exitCode}`}
                </span>
              )}
              <span className="opacity-70">
                {(lastCmd.durationMs / 1000).toFixed(1)}s
              </span>
            </span>
          )}
          {lastCmd && !!onSendToAi && (
            <button
              type="button"
              onClick={() => {
                const out = lastCmdOutputRef.current.trim();
                if (!out) return;
                const head = lastCmd.command
                  ? "$ " + lastCmd.command + "\n"
                  : "";
                onSendToAi(head + out.slice(-MAX_SEND_TO_AI_CHARS));
              }}
              className="ml-auto shrink-0 inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)] transition hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              title={t("terminal.sendLastOutputTitle")}
            >
              <Send size={9} />
              {t("terminal.sendLastOutput")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
