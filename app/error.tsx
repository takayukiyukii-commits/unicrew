"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw, RefreshCw } from "lucide-react";

/**
 * ルートセグメントのエラーバウンダリ。
 * これが無いと React ツリーで未捕捉の例外が出た瞬間に WebView が真っ白になり、
 * ユーザーは手動フルリロードするしかなかった（停止ボタン押下時のクラッシュ等）。
 * ここで日本語の回復画面を出し、「やり直す」(reset) または「再読み込み」で
 * 1クリック復帰できるようにする。会話データは localStorage 永続なので失われない。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 開発時の原因追跡用。本番 WebView でも console には残る。
    console.error("[UNICREW] uncaught render error:", error);
  }, [error]);

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[var(--color-bg,#fafafa)] p-6">
      <div className="max-w-md w-full text-center">
        <div className="flex justify-center mb-4">
          <div className="rounded-full bg-amber-50 border border-amber-200 p-3">
            <AlertTriangle size={28} className="text-amber-600" aria-hidden="true" />
          </div>
        </div>
        <h1 className="text-lg font-semibold text-[var(--color-text,#1a1a1a)] mb-1">
          画面の表示でエラーが発生しました
        </h1>
        <p className="text-sm text-[var(--color-muted,#6b7280)] leading-relaxed mb-1">
          会話の内容は保存されているので失われていません。下のボタンで復帰できます。
        </p>
        <p className="text-[11px] text-[var(--color-muted,#9ca3af)] mb-5">
          A rendering error occurred. Your conversations are saved.
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => reset()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-[var(--color-accent,#2563eb)] text-white text-sm font-medium hover:opacity-90 transition"
          >
            <RotateCcw size={15} aria-hidden="true" />
            やり直す / Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md border border-[var(--color-border,#e5e7eb)] bg-white text-[var(--color-text,#1a1a1a)] text-sm font-medium hover:bg-[var(--color-surface,#f3f4f6)] transition"
          >
            <RefreshCw size={15} aria-hidden="true" />
            アプリを再読み込み / Reload
          </button>
        </div>
        {error?.digest && (
          <p className="mt-4 text-[10.5px] text-[var(--color-muted,#9ca3af)] font-mono">
            ref: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
