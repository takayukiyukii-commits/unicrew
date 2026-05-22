"use client";

import { useState, useCallback, useRef } from "react";
import { Columns2, X, FolderOpen } from "lucide-react";
import { InteractiveTerminal } from "./InteractiveTerminal";
import { useTranslation } from "@/lib/i18n";

/** 同時に開けるターミナルペインの上限（チャット並列と同じ感覚）。 */
const MAX_PANES = 4;

interface Pane {
  /** PTY ID にも使う一意なキー。タブを閉じるまで PTY を保持する。 */
  key: string;
  /**
   * このペインを起動した時点の workspace。
   * 親の workspace prop が後から変わっても（チャットでスレッド切替した等）、
   * 既存ペインの PTY を作り直さないよう、ペインごとに固定して持つ。
   */
  workspace: string | null;
}

interface Props {
  workspace?: string | null;
}

/**
 * 複数ペインのターミナル表示。
 *
 * チャットの「並列ペイン」（Columns2 アイコン）と同じ感覚で
 * ターミナルでもワンクリックでペインを増やせる「扉ボタン」を提供する。
 * ペインを増やしても 1 ペインあたりの PTY は独立しており、
 * `/clear` や `/compact` 等はそのペインだけに作用する。
 *
 * このコンポーネントは（page.tsx 側で）ビューを切り替えても unmount されず
 * hidden で隠れるだけなので、ペイン構成・PTY・xterm バッファはすべて保持される。
 * 各ペインは起動時の workspace を固定で持ち、親 prop の変化では作り直さない。
 *
 * PaneResizer を入れずに均等 flex で並べる。
 * シェル PTY は xterm の resize で都度フィットするので、
 * ウィンドウサイズ変更や開閉時にも追従する。
 */
export function TerminalPanes({ workspace = null }: Props) {
  const { t } = useTranslation();
  // 親の最新 workspace を ref で追従（新規ペイン作成時の初期 cwd に使う）。
  const latestWorkspaceRef = useRef<string | null>(workspace);
  latestWorkspaceRef.current = workspace;

  const [panes, setPanes] = useState<Pane[]>(() => [
    {
      key: `pane-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      workspace,
    },
  ]);

  const handleSplit = useCallback(() => {
    setPanes((prev) => {
      if (prev.length >= MAX_PANES) return prev;
      return [
        ...prev,
        {
          key: `pane-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          // 新しいペインは「いま」の workspace で開く。
          workspace: latestWorkspaceRef.current,
        },
      ];
    });
  }, []);

  const handleClose = useCallback((key: string) => {
    setPanes((prev) => {
      // 最後の 1 ペインは閉じない（必ず 1 つ残す）。
      if (prev.length <= 1) return prev;
      return prev.filter((p) => p.key !== key);
    });
  }, []);

  return (
    <div className="flex-1 flex min-w-0 min-h-0 bg-[#faf9f6]">
      {panes.map((pane, idx) => {
        const isFirst = idx === 0;
        const canSplit = panes.length < MAX_PANES;
        const canClose = panes.length > 1;
        return (
          <div
            key={pane.key}
            className={`flex-1 min-w-0 min-h-0 flex flex-col ${
              isFirst ? "" : "border-l border-[var(--color-border)]"
            }`}
          >
            <div className="shrink-0 h-7 px-2 flex items-center gap-2 border-b border-[var(--color-border)] bg-white text-[11px] text-[var(--color-muted)]">
              {pane.workspace && (
                <span className="flex items-center gap-1 truncate font-mono">
                  <FolderOpen size={11} />
                  <span className="truncate" title={pane.workspace}>
                    {pane.workspace}
                  </span>
                </span>
              )}
              <span className="ml-auto flex items-center gap-0.5 shrink-0">
                {canSplit && (
                  <button
                    type="button"
                    onClick={handleSplit}
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
              <InteractiveTerminal
                workspace={pane.workspace}
                paneKey={pane.key}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
