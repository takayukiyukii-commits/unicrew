"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  FolderOpen,
  FilePlus2,
  FolderPlus,
  PencilLine,
  Trash2,
  Copy,
  ExternalLink,
} from "lucide-react";
import {
  listDirectory,
  fsRename,
  fsDelete,
  fsCreateFile,
  fsCreateDir,
  revealInFileManager,
  type DirEntry,
} from "@/lib/tauri";
import { useTranslation } from "@/lib/i18n";

/* ------------------------------------------------------------------ */
/* 右クリックコンテキストメニュー（VS Code 風）                          */
/* ------------------------------------------------------------------ */

interface MenuState {
  x: number;
  y: number;
  entry: DirEntry;
  /** ワークスペースルート直下を対象にした空白部分の右クリック */
  isRoot: boolean;
}

type DialogMode = "newFile" | "newFolder" | "rename" | "delete";

interface DialogState {
  mode: DialogMode;
  entry: DirEntry;
}

/** entry の親フォルダ（新規作成のターゲット解決用） */
function parentDir(path: string): string {
  return path.replace(/[\\/][^\\/]+$/, "");
}

interface NodeProps {
  entry: DirEntry;
  depth: number;
  onSelectFile: (path: string) => void;
  openPaths: Set<string>;
  toggleOpen: (path: string) => void;
  /** ファイル操作後に増える。開いているフォルダの中身を再読込するトリガ */
  version: number;
  onContext: (e: React.MouseEvent, entry: DirEntry) => void;
}

function TreeNode({
  entry,
  depth,
  onSelectFile,
  openPaths,
  toggleOpen,
  version,
  onContext,
}: NodeProps) {
  const { t } = useTranslation();
  const open = entry.is_dir && openPaths.has(entry.path);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  // 開いている間は version が変わるたびに中身を取り直す
  // （ファイル操作後も開閉状態を保ったまま最新化するため）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(children === null);
    listDirectory(entry.path)
      .then((list) => {
        if (!cancelled) setChildren(list);
      })
      .catch(() => {
        if (!cancelled) setChildren([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version, entry.path]);

  const onClick = () => {
    if (!entry.is_dir) {
      onSelectFile(entry.path);
      return;
    }
    toggleOpen(entry.path);
  };

  return (
    <div>
      <button
        onClick={onClick}
        onContextMenu={(e) => onContext(e, entry)}
        className="w-full flex items-center gap-1 py-1 px-1.5 hover:bg-white/60 rounded text-[12px] text-left truncate"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={entry.path}
      >
        {entry.is_dir ? (
          open ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--color-muted)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--color-muted)]" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {entry.is_dir ? (
          open ? (
            <FolderOpen size={13} className="shrink-0 text-amber-600" />
          ) : (
            <Folder size={13} className="shrink-0 text-amber-600" />
          )
        ) : (
          <FileText size={13} className="shrink-0 text-[var(--color-muted)]" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {open && (
        <div>
          {loading && (
            <div
              className="text-[11px] text-[var(--color-muted)] py-1"
              style={{ paddingLeft: 8 + (depth + 1) * 12 + 16 }}
            >
              {t("workspace.loading")}
            </div>
          )}
          {children?.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              onSelectFile={onSelectFile}
              openPaths={openPaths}
              toggleOpen={toggleOpen}
              version={version}
              onContext={onContext}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  workspace: string | null;
  onSelectFile: (path: string) => void;
  /** true なら書込み系操作（新規作成・名前変更・削除）を出さない */
  restricted?: boolean;
}

export function WorkspaceTree({ workspace, onSelectFile, restricted = false }: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogName, setDialogName] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!workspace) {
      setEntries(null);
      return;
    }
    listDirectory(workspace)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [workspace, version]);

  // メニューは外側クリック / Esc / スクロールで閉じる
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  // ダイアログを開いたら入力へフォーカス（rename は既存名をプリセット）
  useEffect(() => {
    if (!dialog) return;
    setDialogError(null);
    setDialogName(dialog.mode === "rename" ? dialog.entry.name : "");
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      if (dialog.mode === "rename") {
        // 拡張子の手前まで選択（VS Code 風）
        const dot = dialog.entry.name.lastIndexOf(".");
        inputRef.current?.setSelectionRange(
          0,
          !dialog.entry.is_dir && dot > 0 ? dot : dialog.entry.name.length,
        );
      }
    }, 30);
    return () => window.clearTimeout(id);
  }, [dialog]);

  const toggleOpen = useCallback((path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onContext = useCallback((e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry, isRoot: false });
  }, []);

  const onRootContext = useCallback(
    (e: React.MouseEvent) => {
      if (!workspace) return;
      e.preventDefault();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        entry: {
          name: workspace.split(/[/\\]/).pop() || workspace,
          path: workspace,
          is_dir: true,
        },
        isRoot: true,
      });
    },
    [workspace],
  );

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const runDialogAction = async () => {
    if (!dialog || dialogBusy) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      const { mode, entry } = dialog;
      if (mode === "delete") {
        await fsDelete(entry.path);
        setOpenPaths((prev) => {
          const next = new Set(prev);
          next.delete(entry.path);
          return next;
        });
      } else if (mode === "rename") {
        await fsRename(entry.path, dialogName);
        setOpenPaths((prev) => {
          const next = new Set(prev);
          next.delete(entry.path);
          return next;
        });
      } else {
        const dir = entry.is_dir ? entry.path : parentDir(entry.path);
        if (mode === "newFile") await fsCreateFile(dir, dialogName);
        else await fsCreateDir(dir, dialogName);
        // 作成先フォルダを開いて見えるようにする
        setOpenPaths((prev) => new Set(prev).add(dir));
      }
      setDialog(null);
      refresh();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setDialogBusy(false);
    }
  };

  if (!workspace) {
    return (
      <div className="px-3 py-2 text-[11px] text-[var(--color-muted)]">
        {t("workspace.notSelected")}
      </div>
    );
  }

  const menuItemCls =
    "w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-[var(--color-surface)] disabled:opacity-40";

  const dialogTitles: Record<DialogMode, string> = {
    newFile: t("explorer.dialog.newFileTitle"),
    newFolder: t("explorer.dialog.newFolderTitle"),
    rename: t("explorer.dialog.renameTitle"),
    delete: t("explorer.dialog.deleteTitle"),
  };
  const dialogActions: Record<DialogMode, string> = {
    newFile: t("explorer.dialog.create"),
    newFolder: t("explorer.dialog.create"),
    rename: t("explorer.dialog.renameAction"),
    delete: t("explorer.dialog.deleteAction"),
  };

  return (
    <div className="py-1 min-h-full" onContextMenu={onRootContext}>
      <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)] truncate">
        {workspace.split(/[/\\]/).pop() || workspace}
      </div>
      {entries === null && (
        <div className="px-2 py-1 text-[11px] text-[var(--color-muted)]">
          {t("workspace.loading")}
        </div>
      )}
      {entries?.length === 0 && (
        <div className="px-2 py-1 text-[11px] text-[var(--color-muted)]">
          {t("workspace.empty")}
        </div>
      )}
      {entries?.map((e) => (
        <TreeNode
          key={e.path}
          entry={e}
          depth={0}
          onSelectFile={onSelectFile}
          openPaths={openPaths}
          toggleOpen={toggleOpen}
          version={version}
          onContext={onContext}
        />
      ))}

      {/* ---------- コンテキストメニュー ---------- */}
      {menu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-md border border-[var(--color-border)] bg-white shadow-lg py-1"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 240),
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {!menu.entry.is_dir && (
            <button
              type="button"
              className={menuItemCls}
              onClick={() => {
                setMenu(null);
                onSelectFile(menu.entry.path);
              }}
            >
              <FileText size={13} className="text-[var(--color-muted)]" />
              {t("explorer.ctx.open")}
            </button>
          )}
          {!restricted && (
            <>
              <button
                type="button"
                className={menuItemCls}
                onClick={() => {
                  setMenu(null);
                  setDialog({ mode: "newFile", entry: menu.entry });
                }}
              >
                <FilePlus2 size={13} className="text-[var(--color-muted)]" />
                {t("explorer.ctx.newFile")}
              </button>
              <button
                type="button"
                className={menuItemCls}
                onClick={() => {
                  setMenu(null);
                  setDialog({ mode: "newFolder", entry: menu.entry });
                }}
              >
                <FolderPlus size={13} className="text-[var(--color-muted)]" />
                {t("explorer.ctx.newFolder")}
              </button>
              {!menu.isRoot && (
                <>
                  <div className="my-1 border-t border-[var(--color-border)]" />
                  <button
                    type="button"
                    className={menuItemCls}
                    onClick={() => {
                      setMenu(null);
                      setDialog({ mode: "rename", entry: menu.entry });
                    }}
                  >
                    <PencilLine size={13} className="text-[var(--color-muted)]" />
                    {t("explorer.ctx.rename")}
                  </button>
                  <button
                    type="button"
                    className={`${menuItemCls} text-red-600`}
                    onClick={() => {
                      setMenu(null);
                      setDialog({ mode: "delete", entry: menu.entry });
                    }}
                  >
                    <Trash2 size={13} />
                    {t("explorer.ctx.delete")}
                  </button>
                </>
              )}
            </>
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button
            type="button"
            className={menuItemCls}
            onClick={() => {
              setMenu(null);
              void navigator.clipboard.writeText(menu.entry.path);
            }}
          >
            <Copy size={13} className="text-[var(--color-muted)]" />
            {t("explorer.ctx.copyPath")}
          </button>
          <button
            type="button"
            className={menuItemCls}
            onClick={() => {
              setMenu(null);
              void revealInFileManager(menu.entry.path).catch(() => {});
            }}
          >
            <ExternalLink size={13} className="text-[var(--color-muted)]" />
            {t("explorer.ctx.reveal")}
          </button>
        </div>
      )}

      {/* ---------- 入力 / 確認ダイアログ ---------- */}
      {dialog && (
        <div
          className="fixed inset-0 z-50 bg-black/20 flex items-start justify-center pt-[18vh]"
          onClick={() => !dialogBusy && setDialog(null)}
        >
          <div
            className="w-[320px] rounded-lg border border-[var(--color-border)] bg-white shadow-xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[13px] font-semibold text-[var(--color-text)] mb-2">
              {dialogTitles[dialog.mode]}
            </div>
            {dialog.mode === "delete" ? (
              <div className="text-[12px] text-[var(--color-text)] mb-3">
                {t("explorer.dialog.deleteMessage", { name: dialog.entry.name })}
              </div>
            ) : (
              <input
                ref={inputRef}
                value={dialogName}
                onChange={(e) => setDialogName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runDialogAction();
                  if (e.key === "Escape" && !dialogBusy) setDialog(null);
                }}
                placeholder={t("explorer.dialog.namePlaceholder")}
                className="w-full mb-3 px-2 py-1.5 text-[12px] rounded border border-[var(--color-border)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent,#6366f1)]"
              />
            )}
            {dialogError && (
              <div className="mb-3 text-[11px] text-red-600">{dialogError}</div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={dialogBusy}
                onClick={() => setDialog(null)}
                className="px-3 py-1.5 text-[12px] rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)]"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={
                  dialogBusy ||
                  (dialog.mode !== "delete" && dialogName.trim().length === 0)
                }
                onClick={() => void runDialogAction()}
                className={`px-3 py-1.5 text-[12px] rounded text-white disabled:opacity-50 ${
                  dialog.mode === "delete"
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-[var(--color-accent,#6366f1)] hover:opacity-90"
                }`}
              >
                {dialogActions[dialog.mode]}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
