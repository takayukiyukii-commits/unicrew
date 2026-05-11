"use client";

import { ShieldAlert, FolderOpen, X, Lock, ShieldCheck } from "lucide-react";

interface Props {
  open: boolean;
  path: string | null;
  onTrust: () => void;
  onRestricted: () => void;
  onCancel: () => void;
}

/**
 * 未信頼フォルダをワークスペースに使おうとした時の確認モーダル。
 *
 * - 信頼する: 通常通りエージェントが書込みできる
 * - 制限モードで開く: そのまま使うが書込みは抑止（読み取り中心の挙動を期待）
 * - キャンセル: 何もしない
 *
 * VSCode の Workspace Trust 文言と整合させる（"このフォルダ内のファイルを信頼しますか？"）。
 */
export function TrustPromptModal({
  open,
  path,
  onTrust,
  onRestricted,
  onCancel,
}: Props) {
  if (!open || !path) return null;
  return (
    <div
      className="fixed inset-0 z-[58] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-label="Workspace Trust"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden flex flex-col">
        <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert size={16} className="text-amber-600" />
            <div className="text-[14px] font-semibold">
              このフォルダ内のファイルを信頼しますか？
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-[var(--color-surface)] text-[var(--color-muted)]"
            title="キャンセル"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)]">
            <FolderOpen size={13} className="text-amber-600 shrink-0" />
            <code className="text-[12px] truncate font-mono">{path}</code>
          </div>
          <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
            UNICREW は AI に「このフォルダで作業させる」ことができます。
            知らないフォルダや、ダウンロードしたばかりのコードは念のため
            <strong className="text-[var(--color-text)]"> 制限モード </strong>
            で開いてください。
          </p>
        </div>
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col gap-2">
          <button
            onClick={onTrust}
            className="w-full flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 text-white py-2 text-[13px] font-medium hover:bg-emerald-700"
          >
            <ShieldCheck size={14} />
            信頼する（このフォルダ）
          </button>
          <button
            onClick={onRestricted}
            className="w-full flex items-center justify-center gap-1.5 rounded-md bg-white border border-[var(--color-border)] text-[var(--color-text)] py-2 text-[13px] hover:bg-[var(--color-surface)]"
          >
            <Lock size={14} />
            制限モードで開く（書込みを促さない）
          </button>
          <button
            onClick={onCancel}
            className="w-full text-[11.5px] text-[var(--color-muted)] hover:text-[var(--color-text)] py-1"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
