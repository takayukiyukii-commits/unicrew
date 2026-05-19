"use client";

import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { isTauri } from "@/lib/tauri";
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
 */
export function InteractiveTerminal({
  workspace,
}: {
  workspace?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauri() || !ref.current) return;
    let disposed = false;
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let term: any;
    let fit: any;
    let unData: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    let ro: ResizeObserver | undefined;

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
        theme: { background: "#1e1e1e", foreground: "#cccccc" },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      try {
        fit.fit();
      } catch {
        /* noop */
      }

      unData = await onPtyData(id, (bytes) => term?.write(bytes));
      unExit = await onPtyExit(id, () => {
        term?.write(
          "\r\n\x1b[33m[プロセスが終了しました。再度開くと新しいセッションが始まります]\x1b[0m\r\n",
        );
      });

      await ptyOpen({
        id,
        program: "claude",
        args: [],
        cwd: workspace ?? null,
        cols: term.cols,
        rows: term.rows,
      });

      term.onData((d: string) => {
        void ptyWriteText(id, d);
      });
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        void ptyResize(id, cols, rows);
      });

      ro = new ResizeObserver(() => {
        try {
          fit?.fit();
        } catch {
          /* noop */
        }
      });
      ro.observe(ref.current);
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
  }, [workspace]);

  if (!isTauri()) {
    return (
      <div className="h-full flex items-center justify-center text-[12px] text-[var(--color-muted)]">
        対話ターミナルは UNICREW アプリ起動時のみ利用できます。
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-[#1e1e1e] p-2">
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}
