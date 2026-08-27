"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Columns2,
  X,
  FolderOpen,
  SquareTerminal,
  Bot,
  ChevronDown,
  Plus,
} from "lucide-react";
import { InteractiveTerminal } from "./InteractiveTerminal";
import {
  availableTerminalClis,
  terminalCliById,
  type TerminalCli,
} from "@/lib/terminal-clis";
import { useTranslation } from "@/lib/i18n";

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

/** ページ = 最大6ペインの1セット。ページを切り替えても全ページの PTY は生きたまま。 */
interface Page {
  id: string;
  panes: Pane[];
}

interface Props {
  workspace?: string | null;
}

const newKey = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const newPane = (kind: "claude" | "shell" = "claude", cliId?: string): Pane => ({
  key: newKey("pane"),
  kind,
  cliId,
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
export function TerminalPanes({ workspace = null }: Props) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<Page[]>(() => [
    { id: newKey("page"), panes: [newPane()] },
  ]);
  const [activePageId, setActivePageId] = useState<string>("");
  // 初期表示や閉じた直後に activePageId が実在しない場合は先頭ページへ倒す
  const resolvedActiveId = pages.some((p) => p.id === activePageId)
    ? activePageId
    : pages[0].id;
  /** ＋AI メニューを開いているペインの key（1つだけ開く） */
  const [aiMenuFor, setAiMenuFor] = useState<string | null>(null);
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

  // アンマウント時に二度押しタイマーを掃除
  useEffect(
    () => () => {
      if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
    },
    [],
  );

  const handleSplit = useCallback(
    (pageId: string, kind: "claude" | "shell" = "claude", cliId?: string) => {
      setPages((prev) =>
        prev.map((pg) => {
          if (pg.id !== pageId) return pg;
          if (pg.panes.length >= MAX_PANES) return pg;
          return { ...pg, panes: [...pg.panes, newPane(kind, cliId)] };
        }),
      );
      setAiMenuFor(null);
    },
    [],
  );

  const handleSplitCli = useCallback(
    (pageId: string, cli: TerminalCli) => {
      // claude は従来経路（完全互換）。他 CLI は shell 扱い + command 上書き。
      if (cli.id === "claude") handleSplit(pageId, "claude", "claude");
      else handleSplit(pageId, "shell", cli.id);
    },
    [handleSplit],
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
        // アクティブページを閉じたら残り先頭へ（resolvedActiveId が実在しない
        // id を先頭へ倒すため、ここでは「閉じた id のままにしない」だけでよい）
        setActivePageId((cur) => (cur === pageId ? "" : cur));
      }
    },
    [armedClose, forgetPaneCwds],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#faf9f6]">
      {/* ページタブバー */}
      <div className="shrink-0 h-7 px-2 flex items-center gap-1 border-b border-[var(--color-border)] bg-white">
        {pages.map((pg, i) => {
          const isActive = pg.id === resolvedActiveId;
          const isArmed = armedClose === pg.id;
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
                onClick={() => setActivePageId(pg.id)}
                className="pl-2 pr-1 py-0.5 inline-flex items-center gap-1"
                title={t("terminal.pageTabTitle", { n: i + 1 })}
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
        return (
          <div
            key={pg.id}
            className={
              isActivePage
                ? "flex-1 grid min-w-0 min-h-0 bg-[#faf9f6]"
                : "hidden"
            }
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            }}
          >
            {pg.panes.map((pane, idx) => {
              const { row, col } = placement(idx, n);
              const canSplit = pg.panes.length < MAX_PANES;
              const canClose = pg.panes.length > 1;
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
                                  onClick={() => handleSplitCli(pg.id, c)}
                                  className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-surface)]"
                                  role="menuitem"
                                >
                                  {c.label}
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
                      command={
                        cli
                          ? { program: cli.program, args: cli.args }
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
    </div>
  );
}
