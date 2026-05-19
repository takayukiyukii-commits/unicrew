"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, ExternalLink, AlertCircle } from "lucide-react";
import { PREVIEW_NAVIGATE_EVENT, openExternal } from "@/lib/preview-window";
import { isTauri } from "@/lib/tauri";

type Target = { url: string } | { file: string } | null;

const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const HTML = /\.(html?|xhtml)$/i;

function mimeFromExt(p: string): string {
  const e = p.toLowerCase();
  if (/\.png$/.test(e)) return "image/png";
  if (/\.jpe?g$/.test(e)) return "image/jpeg";
  if (/\.gif$/.test(e)) return "image/gif";
  if (/\.webp$/.test(e)) return "image/webp";
  if (/\.svg$/.test(e)) return "image/svg+xml";
  if (/\.avif$/.test(e)) return "image/avif";
  if (/\.bmp$/.test(e)) return "image/bmp";
  if (/\.ico$/.test(e)) return "image/x-icon";
  return "application/octet-stream";
}

export function PreviewWindow() {
  const sp = useSearchParams();
  const initial: Target = sp.get("url")
    ? { url: sp.get("url") as string }
    : sp.get("file")
      ? { file: sp.get("file") as string }
      : null;

  const [target, setTarget] = useState<Target>(initial);
  const [html, setHtml] = useState<string | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const objUrlRef = useRef<string | null>(null);

  // ウィンドウ再利用時の遷移イベント
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const u = await listen<Target>(PREVIEW_NAVIGATE_EVENT, (e) => {
        setError(null);
        setHtml(null);
        setImgUrl(null);
        setTarget(e.payload);
      });
      un = u;
    })();
    return () => un?.();
  }, []);

  const loadFile = useCallback(async (file: string) => {
    setError(null);
    setHtml(null);
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
    setImgUrl(null);
    if (!isTauri()) {
      setError("ファイルプレビューは UNICREW アプリ起動時のみ利用できます。");
      return;
    }
    try {
      const fs = await import("@tauri-apps/plugin-fs");
      if (HTML.test(file)) {
        const text = await fs.readTextFile(file);
        setHtml(text);
      } else if (IMG.test(file)) {
        const bytes = await fs.readFile(file);
        const blob = new Blob([bytes], { type: mimeFromExt(file) });
        const u = URL.createObjectURL(blob);
        objUrlRef.current = u;
        setImgUrl(u);
      } else {
        setError("このファイルは既定アプリで開きます。");
        await openExternal(file);
      }
    } catch (e) {
      setError(
        `読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, []);

  useEffect(() => {
    if (target && "file" in target) void loadFile(target.file);
  }, [target, loadFile, reloadKey]);

  useEffect(() => {
    return () => {
      if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    };
  }, []);

  const label =
    target && "url" in target
      ? target.url
      : target && "file" in target
        ? target.file
        : "プレビュー";

  const onExternal = () => {
    if (!target) return;
    void openExternal("url" in target ? target.url : target.file);
  };
  const onReload = () => setReloadKey((k) => k + 1);

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--color-bg)]">
      {/* ツールバー */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
        <button
          onClick={onReload}
          title="再読み込み"
          className="p-1 rounded hover:bg-[var(--color-bg)] text-[var(--color-muted)]"
        >
          <RefreshCw size={14} />
        </button>
        <span className="flex-1 truncate text-[11.5px] font-mono text-[var(--color-muted)]">
          {label}
        </span>
        <button
          onClick={onExternal}
          title="ブラウザ / 既定アプリで開く"
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg)]"
        >
          <ExternalLink size={12} />
          ブラウザで開く
        </button>
      </div>

      {/* 本体 */}
      <div className="flex-1 min-h-0 relative bg-white">
        {error ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-[12px] text-[var(--color-muted)] px-6 text-center">
            <AlertCircle size={20} className="text-amber-500" />
            <p>{error}</p>
          </div>
        ) : target && "url" in target ? (
          <iframe
            key={`u-${reloadKey}`}
            src={target.url}
            className="w-full h-full border-0"
            title="preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : html != null ? (
          <iframe
            key={`h-${reloadKey}`}
            srcDoc={html}
            className="w-full h-full border-0"
            title="preview"
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
          />
        ) : imgUrl ? (
          <div className="h-full w-full overflow-auto flex items-center justify-center bg-[#1e1e1e]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imgUrl} alt="preview" className="max-w-full max-h-full" />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-[12px] text-[var(--color-muted)]">
            読み込み中…
          </div>
        )}
      </div>
    </div>
  );
}
