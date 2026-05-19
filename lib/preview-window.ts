"use client";

/**
 * UNICREW プレビューウィンドウ（別ウィンドウ）。
 *
 * AI が作ったアプリ / サイト / ファイルを、ブラウザではなく Tauri の
 * 独立ウィンドウで開く。editor-window.ts と同じ「/preview ルートを
 * 別 WebviewWindow で開く」方式（Rust/capability 変更不要）。
 *
 * - url:  http(s) のローカル開発サーバや公開URL → そのまま iframe 表示
 * - file: .html/画像 → /preview 側で読み込んで表示
 * 「必要な時はブラウザ」: openExternal() で OS 既定（ブラウザ/既定アプリ）。
 */

import { isTauri } from "./tauri";

const PREVIEW_WINDOW_LABEL = "preview";
export const PREVIEW_NAVIGATE_EVENT = "preview://navigate";

async function loadWebviewWindow() {
  return await import("@tauri-apps/api/webviewWindow");
}
async function loadEvent() {
  return await import("@tauri-apps/api/event");
}

export type PreviewTarget = { url: string } | { file: string };

function toQuery(t: PreviewTarget): string {
  return "url" in t
    ? `url=${encodeURIComponent(t.url)}`
    : `file=${encodeURIComponent(t.file)}`;
}

/** 別ウィンドウでプレビューを開く（既存ウィンドウがあれば再利用して前面化）。 */
export async function openPreviewWindow(t: PreviewTarget): Promise<void> {
  if (!isTauri()) {
    // ブラウザ実行時（next dev をブラウザで見ている等）は素直に新規タブ。
    if ("url" in t) window.open(t.url, "_blank", "noopener");
    else
      alert(
        "プレビューウィンドウは UNICREW アプリ起動時のみ利用できます。",
      );
    return;
  }
  const { WebviewWindow } = await loadWebviewWindow();
  const existing = await WebviewWindow.getByLabel(PREVIEW_WINDOW_LABEL);
  if (existing) {
    const { emit } = await loadEvent();
    await emit(PREVIEW_NAVIGATE_EVENT, t);
    try {
      await existing.unminimize();
    } catch {
      /* noop */
    }
    try {
      await existing.show();
    } catch {
      /* noop */
    }
    try {
      await existing.setFocus();
    } catch {
      /* noop */
    }
    return;
  }
  const win = new WebviewWindow(PREVIEW_WINDOW_LABEL, {
    url: `/preview?${toQuery(t)}`,
    title: "UNICREW プレビュー",
    width: 1180,
    height: 820,
    minWidth: 480,
    minHeight: 360,
    resizable: true,
    decorations: true,
    center: true,
  });
  win.once("tauri://error", (e) => {
    console.error("[preview window] failed to create", e);
  });
}

/** OS 既定（ブラウザ / 既定アプリ）で開く。「必要な時はブラウザ」用。 */
export async function openExternal(target: string): Promise<void> {
  if (!isTauri()) {
    window.open(target, "_blank", "noopener");
    return;
  }
  try {
    const shell = await import("@tauri-apps/plugin-shell");
    await shell.open(target);
  } catch (e) {
    console.error("[preview] openExternal failed", e);
  }
}
