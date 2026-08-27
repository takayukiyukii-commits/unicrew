"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "@xterm/xterm/css/xterm.css";
import {
  isTauri,
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
} from "@/lib/pty";
import { findPathMatches, findUrlMatches } from "@/lib/file-link";
import { readLogicalLine, matchToBufferRange } from "@/lib/terminal-links";
import { findCompositionOverride } from "@/lib/terminal-ime";
import { joinHardWrappedLines } from "@/lib/terminal-copy";
import { openFileSmart } from "@/lib/open-file";
import { openExternal } from "@/lib/preview-window";

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
}) {
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
  // ── 右端ドラッグ・スクロールバー（設計書①）──────────────────────────
  // term インスタンスは effect 内ローカルだったが、ドラッグ操作（React イベント）
  // から scrollToLine を呼ぶために ref 化する。
  const termRef = useRef<{
    rows: number;
    buffer?: { active?: { length: number; viewportY: number } };
    scrollToLine(line: number): void;
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
  /** TUI へのホイール注入関数（effect 内で生成・cleanup で null）。 */
  const tuiInjectRef = useRef<((down: boolean, lines: number) => void) | null>(
    null,
  );
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragLastYRef = useRef(0);

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
      ? `term-${paneKey}`
      : `term-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let term: any;
    let fit: any;
    let unData: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let ro: ResizeObserver | undefined;
    let io: IntersectionObserver | undefined;
    let linkProvider: { dispose(): void } | undefined;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    let compCleanup: (() => void) | undefined;
    const scrollDisposables: Array<{ dispose(): void }> = [];
    // ペイン再マウントで PTY を開き直す際、前セッションのバー状態を持ち越さない
    setScroll({ top: 0, max: 0, rows: 0 });
    setTuiMouse(false);

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
        fontSize: 13,
        theme: {
          // オフホワイト基調（UNI 共通ライトテーマと馴染ませる）
          background: "#faf9f6",
          foreground: "#1f2328",
          cursor: "#1f2328",
          cursorAccent: "#faf9f6",
          selectionBackground: "#d0d7de",
          selectionForeground: "#1f2328",
          // ANSI 8色（明るい背景でも視認できるよう調整）
          black: "#1f2328",
          red: "#cf222e",
          green: "#116329",
          yellow: "#9a6700",
          blue: "#0969da",
          magenta: "#8250df",
          cyan: "#1b7c83",
          white: "#6e7781",
          brightBlack: "#57606a",
          brightRed: "#a40e26",
          brightGreen: "#1a7f37",
          brightYellow: "#7d4e00",
          brightBlue: "#0550ae",
          brightMagenta: "#6639ba",
          brightCyan: "#3192aa",
          brightWhite: "#1f2328",
        },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
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
        if (onOutputRef.current) {
          try {
            onOutputRef.current(outputDecoder.decode(bytes, { stream: true }));
          } catch {
            /* observer hook must never break the terminal */
          }
        }
      });
      unExit = await onPtyExit(id, () => {
        onExitedRef.current?.();
        term?.write(
          "\r\n\x1b[33m[プロセスが終了しました。再度開くと新しいセッションが始まります]\x1b[0m\r\n",
        );
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
      const wsAtOpen = workspaceRef.current;
      let cwd = wsAtOpen && wsAtOpen.trim() ? wsAtOpen : null;
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
  }, [paneKey, kind, nudgeTuiThumb]);

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
    <div className="unicrew-term relative h-full w-full bg-[#faf9f6] p-2">
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
              className="absolute right-0.5 w-2 rounded bg-black/20 hover:bg-black/35 transition-colors"
              style={{ height: `${thumbPct}%`, top: `${thumbTopPct}%` }}
            />
          ) : (
            // TUI（claude等）モード: 推定位置つまみ。ドラッグ／ホイール注入に
            // 追従し、離してもその場に留まる（入力時に最下部へ戻る）。
            <div
              className="absolute right-0.5 w-2 rounded bg-black/15 hover:bg-black/30 transition-colors"
              style={{
                height: `${TUI_THUMB_HEIGHT_PCT}%`,
                top: `${tuiThumbTop}%`,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
