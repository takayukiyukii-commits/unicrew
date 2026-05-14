"use client";

import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, Folder, FileText, FolderOpen } from "lucide-react";
import { listDirectory, type DirEntry } from "@/lib/tauri";
import { useTranslation } from "@/lib/i18n";

interface NodeProps {
  entry: DirEntry;
  depth: number;
  onSelectFile: (path: string) => void;
}

function TreeNode({ entry, depth, onSelectFile }: NodeProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!entry.is_dir) {
      onSelectFile(entry.path);
      return;
    }
    if (open) {
      setOpen(false);
      return;
    }
    if (children === null) {
      setLoading(true);
      try {
        const list = await listDirectory(entry.path);
        setChildren(list);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
    setOpen(true);
  };

  return (
    <div>
      <button
        onClick={toggle}
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
}

export function WorkspaceTree({ workspace, onSelectFile }: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DirEntry[] | null>(null);

  useEffect(() => {
    if (!workspace) {
      setEntries(null);
      return;
    }
    listDirectory(workspace)
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [workspace]);

  if (!workspace) {
    return (
      <div className="px-3 py-2 text-[11px] text-[var(--color-muted)]">
        {t("workspace.notSelected")}
      </div>
    );
  }

  return (
    <div className="py-1">
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
        <TreeNode key={e.path} entry={e} depth={0} onSelectFile={onSelectFile} />
      ))}
    </div>
  );
}
