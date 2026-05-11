"use client";

import { FolderOpen, Lock, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { WorkspaceTree } from "./WorkspaceTree";

interface Props {
  workspace: string | null;
  onPickWorkspace: () => void;
  onClose: () => void;
  onSelectFile: (path: string) => void;
  /** true なら制限モード（書込み抑止）を視覚的に示す */
  restricted?: boolean;
}

/**
 * VS Code 風のエクスプローラー列。Sidebar と main の間に挿入する。
 *
 * UNICREW のメイン画面（チャット）を狭めずにファイル一覧を出すための専用列。
 * ファイルクリックは親側で `openFileInEditorWindow` に流すため、ここでは
 * onSelectFile を上に投げるだけ。
 */
export function ExplorerPanel({
  workspace,
  onPickWorkspace,
  onClose,
  onSelectFile,
  restricted = false,
}: Props) {
  // 再描画キーを増やすことで WorkspaceTree の useEffect を再走させる
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <aside className="w-64 shrink-0 border-r border-[var(--color-border)] bg-white flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--color-muted)]">
          エクスプローラー
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)]"
            title="再読み込み"
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)]"
            title="閉じる"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={onPickWorkspace}
        className="mx-3 my-2 flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-white py-1.5 text-[12px] text-[var(--color-text)]"
        title="表示するワークスペースフォルダを選択"
      >
        <FolderOpen size={13} />
        {workspace ? "ワークスペース変更" : "フォルダを開く"}
      </button>

      {restricted && (
        <div className="mx-3 mb-2 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200 text-[10.5px] text-amber-800 flex items-center gap-1.5">
          <Lock size={11} className="shrink-0" />
          <span>制限モード（書込みを促しません）</span>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto unicrew-scroll">
        <WorkspaceTree
          key={`${workspace ?? "none"}::${refreshKey}`}
          workspace={workspace}
          onSelectFile={onSelectFile}
        />
      </div>

      <div className="border-t border-[var(--color-border)] px-3 py-1.5 text-[10.5px] text-[var(--color-muted)] leading-snug">
        ファイルをクリックすると別ウィンドウのエディタで開きます。
        2つ目以降は同じウィンドウにタブで追加されます。
      </div>
    </aside>
  );
}
