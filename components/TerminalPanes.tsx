"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Columns2,
  X,
  FolderOpen,
  SquareTerminal,
  Bot,
  ChevronDown,
} from "lucide-react";
import { InteractiveTerminal } from "./InteractiveTerminal";
import {
  availableTerminalClis,
  terminalCliById,
  type TerminalCli,
} from "@/lib/terminal-clis";
import { useTranslation } from "@/lib/i18n";

/**
 * 同時に開けるターミナルペインの上限。
 * 3カラム以上は自動的に「上段＋下段3列」の2段グリッドになるため、
 * 2段ぶん（最大 3×2）まで許可する。
 */
const MAX_PANES = 6;
/** 1行あたりの最大カラム数。これを超えると段（行）が増える。 */
const COLS = 3;

interface Pane {
  /** PTY ID にも使う一意なキー。タブを閉じるまで PTY を保持する。 */
  key: string;
  /** 設計書⑤: ペインで起動するプログラム。claude（既定）または OS シェル。 */
  kind: "claude" | "shell";
  /**
   * マルチAI: lib/terminal-clis.ts の CLI id。指定時は該当 CLI を PTY で起動する。
   * - "claude"（または未指定）→ 従来どおり kind="claude" 経路（完全互換）
   * - その他 → kind="shell" + command 指定（claude 固有のペースト特殊処理を
   *   他 CLI に送らないため。起動プログラムは command が上書きする）
   */
  cliId?: string;
}

interface Props {
  workspace?: string | null;
}

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
 * 複数ペインのターミナル表示。
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
 * cwd はアクティブな workspace に「連動」する（workspace 値変化で PTY 開き直し）。
 */
export function TerminalPanes({ workspace = null }: Props) {
  const { t } = useTranslation();
  const [panes, setPanes] = useState<Pane[]>(() => [
    {
      key: `pane-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      kind: "claude",
    },
  ]);
  /** ＋AI メニューを開いているペインの key（1つだけ開く） */
  const [aiMenuFor, setAiMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isWindows =
    typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
  const clis = availableTerminalClis(isWindows);

  // 外側クリックで ＋AI メニューを閉じる
  useEffect(() => {
    if (!aiMenuFor) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setAiMenuFor(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [aiMenuFor]);

  const handleSplit = useCallback(
    (kind: "claude" | "shell" = "claude", cliId?: string) => {
      setPanes((prev) => {
        if (prev.length >= MAX_PANES) return prev;
        return [
          ...prev,
          {
            key: `pane-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            kind,
            cliId,
          },
        ];
      });
      setAiMenuFor(null);
    },
    [],
  );

  const handleSplitCli = useCallback(
    (cli: TerminalCli) => {
      // claude は従来経路（完全互換）。他 CLI は shell 扱い + command 上書き。
      if (cli.id === "claude") handleSplit("claude", "claude");
      else handleSplit("shell", cli.id);
    },
    [handleSplit],
  );

  const handleClose = useCallback((key: string) => {
    setPanes((prev) => {
      // 最後の 1 ペインは閉じない（必ず 1 つ残す）。
      if (prev.length <= 1) return prev;
      return prev.filter((p) => p.key !== key);
    });
  }, []);

  const n = panes.length;
  const cols = Math.min(n, COLS);
  const rows = n <= COLS ? 1 : Math.ceil(n / COLS);

  return (
    <div
      className="flex-1 grid min-w-0 min-h-0 bg-[#faf9f6]"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {panes.map((pane, idx) => {
        const { row, col } = placement(idx, n);
        const canSplit = panes.length < MAX_PANES;
        const canClose = panes.length > 1;
        const cli =
          pane.cliId && pane.cliId !== "claude"
            ? terminalCliById(pane.cliId)
            : undefined;
        return (
          <div
            key={pane.key}
            style={{ gridColumn: col, gridRow: row }}
            className={`min-w-0 min-h-0 flex flex-col ${
              col > 1 ? "border-l border-[var(--color-border)]" : ""
            } ${row > 1 ? "border-t border-[var(--color-border)]" : ""}`}
          >
            <div className="shrink-0 h-7 px-2 flex items-center gap-2 border-b border-[var(--color-border)] bg-white text-[11px] text-[var(--color-muted)]">
              {workspace && (
                <span className="flex items-center gap-1 truncate font-mono">
                  <FolderOpen size={11} />
                  <span className="truncate" title={workspace}>
                    {workspace}
                  </span>
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
                      onClick={() =>
                        setAiMenuFor((cur) =>
                          cur === pane.key ? null : pane.key,
                        )
                      }
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
                        className="absolute right-0 top-full mt-1 min-w-[170px] rounded-md border border-[var(--color-border)] bg-white shadow-lg z-50 py-1"
                        role="menu"
                      >
                        {clis.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => handleSplitCli(c)}
                            className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface)]"
                            role="menuitem"
                          >
                            {c.label}
                          </button>
                        ))}
                        <div className="my-1 border-t border-[var(--color-border)]" />
                        <button
                          type="button"
                          onClick={() => handleSplit("shell")}
                          className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface)]"
                          role="menuitem"
                        >
                          {t("terminal.menuShell")}
                        </button>
                      </div>
                    )}
                  </span>
                )}
                {canSplit && (
                  <button
                    type="button"
                    onClick={() => handleSplit("shell")}
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
                    onClick={() => handleSplit("claude")}
                    className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
                    title={t("terminal.splitTitle")}
                    aria-label={t("terminal.splitAria")}
                  >
                    <Columns2 size={13} />
                  </button>
                )}
                {canClose && (
                  <button
                    type="button"
                    onClick={() => handleClose(pane.key)}
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
              {/* workspace に連動：値が変われば PTY を開き直す（key には含めない＝
                  ペイン自体は維持しつつ InteractiveTerminal の effect で cwd 切替） */}
              <InteractiveTerminal
                workspace={workspace}
                paneKey={pane.key}
                kind={pane.kind}
                command={
                  cli ? { program: cli.program, args: cli.args } : undefined
                }
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
