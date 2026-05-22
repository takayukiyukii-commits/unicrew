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

    /**
     * 要素が実際に表示されている（サイズ > 0）ときだけ fit する。
     * 別ビューに切り替わって display:none の間は clientWidth/Height が 0 になり、
     * そこで fit すると行高が壊れて「文字が縦に圧縮される」ため、0 サイズなら何もしない。
     * 表示に戻った時は IntersectionObserver / ResizeObserver が改めて呼ぶ。
     */
    const safeFit = () => {
      const el = ref.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit?.fit();
      } catch {
        /* noop */
      }
    };

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !ref.current) return;
      term = new Terminal({
        cursorBlink: true,
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
      term.open(ref.current);
      safeFit();

      // コピー＆ペースト（Ctrl/Cmd + C / V）。
      // - Ctrl/Cmd+C: 選択があればクリップボードへコピー（無ければ既定の SIGINT を通す）
      // - Ctrl/Cmd+V: クリップボードから貼り付け（term.paste でブラケットペースト対応）
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
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text);
            })
            .catch(() => {
              /* クリップボード読取り不可時は無視 */
            });
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
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
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
