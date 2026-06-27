"use client";

import { useEffect, useRef } from "react";
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
import { findPathMatches, findUrlMatches, resolveFilePath } from "@/lib/file-link";
import { readLogicalLine, matchToBufferRange } from "@/lib/terminal-links";
import { findCompositionOverride } from "@/lib/terminal-ime";
import { openFileInEditorWindow } from "@/lib/editor-window";
import { openExternal } from "@/lib/preview-window";

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
}: {
  workspace?: string | null;
  /**
   * 同じ workspace で複数ペインを立てるときに、ペインごとに独立した PTY を
   * 起動するための識別子。指定が無ければ自動生成（後方互換）。
   */
  paneKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

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
      // WebGL レンダラ（VSCode 統合ターミナルと同じ方式）。各グリフをセル枠にクリップして
      // GPU 描画するため、DOM レンダラで起きていた「全角(日本語)入力時に差分描画がズレて
      // 入力中の文字が別の行に描かれる」問題に強い。生成失敗/コンテキスト喪失時は DOM へ戻す。
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try {
            webgl.dispose();
          } catch {
            /* noop */
          }
        });
        term.loadAddon(webgl);
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
                  const abs = resolveFilePath(mt.openPath, workspace ?? null);
                  void openFileInEditorWindow(abs).catch(() => {
                    /* 開けない場合は無視 */
                  });
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
            const sel = term.getSelection();
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
              if (text) term.paste(text);
            } catch {
              /* クリップボード取得不可時は何もしない */
            }
          })();
          return false;
        }
        return true;
      });

      unData = await onPtyData(id, (bytes) => term?.write(bytes));
      unExit = await onPtyExit(id, () => {
        term?.write(
          "\r\n\x1b[33m[プロセスが終了しました。再度開くと新しいセッションが始まります]\x1b[0m\r\n",
        );
      });

      // workspace が無いと PTY が親プロセス(unicrew.exe)の cwd を継承してしまい
      // C: 基点で開いてしまう。明示的にデフォルト workspace へフォールバックする。
      let cwd = workspace && workspace.trim() ? workspace : null;
      if (!cwd) {
        try {
          cwd = await defaultWorkspacePath();
        } catch {
          cwd = null;
        }
      }

      // フォント＆レイアウト確定後に確定 fit してから PTY を開く。
      // これで「開いた直後から打った文字と表示位置がズレる」現象を防ぐ。
      await fitBeforeOpen();
      if (disposed) return;

      await ptyOpen({
        id,
        program: "claude",
        args: [],
        cwd,
        cols: term.cols,
        rows: term.rows,
      });

      term.onData((d: string) => {
        void ptyWriteText(id, d);
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
      void ptyKill(id);
      try {
        term?.dispose();
      } catch {
        /* noop */
      }
    };
  }, [workspace, paneKey]);

  if (!isTauri()) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--color-muted)]">
        対話ターミナルは UNICREW アプリ起動時のみ利用できます。
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-[#faf9f6] p-2">
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}
