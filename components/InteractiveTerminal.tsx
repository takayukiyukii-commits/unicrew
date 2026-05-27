"use client";

import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { isTauri, defaultWorkspacePath } from "@/lib/tauri";
import {
  ptyOpen,
  ptyWriteText,
  ptyResize,
  ptyKill,
  onPtyData,
  onPtyExit,
} from "@/lib/pty";
import { findPathMatches, resolveFilePath } from "@/lib/file-link";
import { openFileInEditorWindow } from "@/lib/editor-window";

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
      // 実サイズが付くまで数フレーム待つ（hidden 中は付かない＝IO が後で再 fit する）
      for (let i = 0; i < 30; i++) {
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

      // ターミナル内のファイルパスを Ctrl/Cmd+Click でエディタウィンドウに開く
      try {
        linkProvider = term.registerLinkProvider({
          provideLinks(
            bufferLineNumber: number,
            callback: (links: unknown[] | undefined) => void,
          ) {
            const lineBuf = term.buffer?.active?.getLine(bufferLineNumber - 1);
            if (!lineBuf) {
              callback(undefined);
              return;
            }
            const text = lineBuf.translateToString(true);
            const matches = findPathMatches(text);
            if (matches.length === 0) {
              callback(undefined);
              return;
            }
            callback(
              matches.map((mt) => ({
                text: mt.raw,
                range: {
                  start: { x: mt.start + 1, y: bufferLineNumber },
                  end: { x: mt.end, y: bufferLineNumber },
                },
                activate: (e: MouseEvent) => {
                  // VSCode 風: 修飾キー付きクリックでのみ開く（誤クリック防止・選択は通常通り）
                  if (!(e.ctrlKey || e.metaKey)) return;
                  const abs = resolveFilePath(mt.openPath, workspace ?? null);
                  void openFileInEditorWindow(abs).catch(() => {
                    /* 開けない場合は無視 */
                  });
                },
              })),
            );
          },
        });
      } catch {
        /* registerLinkProvider 非対応版では何もしない */
      }

      // コピー＆ペースト（Ctrl/Cmd + C / V）。
      // - Ctrl/Cmd+C: 選択があればクリップボードへコピー（無ければ既定の SIGINT を通す）
      // - Ctrl/Cmd+V: 実際の貼り付けは xterm.js のネイティブ paste イベントに任せ、
      //   ここでは「xterm にキー処理させない（false を返す）」だけにする。
      //
      //   なぜ false を返すだけにするか：
      //   xterm は Ctrl+V を制御文字 ^V(0x16) として PTY に送ってしまう。これが
      //   直後に届くネイティブ paste（ブラケットペースト）の前に入ると、claude/
      //   readline の quoted-insert として解釈され、貼り付け全体が壊れる（＝貼れない）。
      //   かといってここで term.paste() を自前で呼ぶと、ネイティブ paste と合わせて
      //   同じ文字列が 2 回入る（＝二重貼り付け）。
      //   よって「^V は送らせない（false）／貼り付けはネイティブ paste 1 本に任せる
      //   （term.paste は呼ばない）」のが、二重貼り付けにも貼れない問題にもならない正解。
      //   ※ false を返しても event.preventDefault はされないため、ブラウザ/WebView の
      //     paste イベントはそのまま発火して 1 回だけ貼り付けられる。
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") return true;
        const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
        if (mod && (e.key === "c" || e.key === "C")) {
          if (term.hasSelection()) {
            const sel = term.getSelection();
            if (sel) void navigator.clipboard.writeText(sel);
            term.clearSelection();
            return false; // SIGINT を送らずコピーを優先
          }
          return true; // 選択が無ければ通常どおり SIGINT
        }
        if (mod && (e.key === "v" || e.key === "V")) {
          // ^V を PTY に送らせない。貼り付けはネイティブ paste に任せる（二重防止）。
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
