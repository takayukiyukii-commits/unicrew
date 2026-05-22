"use client";

import { useState, useCallback } from "react";
import { Columns2, X, FolderOpen } from "lucide-react";
import { InteractiveTerminal } from "./InteractiveTerminal";
import { useTranslation } from "@/lib/i18n";

/** 同時に開けるターミナルペインの上限（チャット並列と同じ感覚）。 */
const MAX_PANES = 4;

interface Pane {
  /** PTY ID にも使う一意なキー。タブを閉じるまで PTY を保持する。 */
  key: string;
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
 *
 * cwd はアクティブな workspace に「連動」する：
 *   - workspace 値が変わると各 InteractiveTerminal の effect が再実行され、
 *     新しいディレクトリで PTY を開き直す（= ワークスペース切替に追従）
 *   - 単なるビュー切替（workspace 値は不変）では再生成されないので状態は保たれる
 *
 * PaneResizer を入れずに均等 flex で並べる。
 * シェル PTY は xterm の resize で都度フィットするので、
 * ウィンドウサイズ変更や開閉時にも追従する。
 */
export function TerminalPanes({ workspace = null }: Props) {
  const { t } = useTranslation();
  const [panes, setPanes] = useState<Pane[]>(() => [
    { key: `pane-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  ]);

  const handleSplit = useCallback(() => {
    setPanes((prev) => {
      if (prev.length >= MAX_PANES) return prev;
      return [
        ...prev,
        { key: `pane-${Date.now()}-${Math.random().toString(36).slice(2)}` },
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
              {workspace && (
                <span className="flex items-center gap-1 truncate font-mono">
                  <FolderOpen size={11} />
                  <span className="truncate" title={workspace}>
                    {workspace}
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
              {/* workspace に連動：値が変われば PTY を開き直す（key には含めない＝
                  ペイン自体は維持しつつ InteractiveTerminal の effect で cwd 切替） */}
              <InteractiveTerminal workspace={workspace} paneKey={pane.key} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
