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
import type { Artifact } from "./turn-artifacts";

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
    // グローバル emit ではなく preview ウィンドウ宛てに明示配送する。
    // （global emit は取りこぼしの温床。対象ラベル指定の emitTo が確実）
    const { emitTo } = await loadEvent();
    await emitTo(PREVIEW_WINDOW_LABEL, PREVIEW_NAVIGATE_EVENT, t);
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

// ── 作業ごとの自動プレビュー（2026-10-07）──────────────────────────────
//
// AI が1回の作業で作った・直したもの（lib/turn-artifacts.ts）をまとめて渡し、
// プレビュー窓の左に「どのフォルダに何を作ったか」を並べ、右に中身を出す。
// 中身の受け渡しは localStorage（同じアプリの窓どうしは同じ保存先を共有する）。
// URL に全部載せると長くなり、窓の再利用時にも送り直せないため。


export const PREVIEW_SESSION_KEY = "unicrew.preview.session.v1";

export interface PreviewSession {
  /** どの会話の作業か（窓のタイトル用） */
  title: string;
  workspace: string | null;
  items: Artifact[];
  /** 最初に開くもの（items のどれかの target） */
  selected: string | null;
  at: number;
}

export function loadPreviewSession(): PreviewSession | null {
  try {
    const raw = localStorage.getItem(PREVIEW_SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as PreviewSession;
    return Array.isArray(v?.items) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 作業の成果物をプレビュー窓に出す。
 * `focus: false`（自動で開くとき）は、打っている最中の入力欄からフォーカスを奪わない。
 */
export async function openPreviewSession(
  session: PreviewSession,
  opts: { focus?: boolean } = {},
): Promise<void> {
  const focus = opts.focus ?? true;
  try {
    localStorage.setItem(PREVIEW_SESSION_KEY, JSON.stringify(session));
  } catch {
    /* 容量超過などは無視（窓は前回の中身のまま） */
  }
  if (!isTauri()) return;
  const { WebviewWindow } = await loadWebviewWindow();
  const existing = await WebviewWindow.getByLabel(PREVIEW_WINDOW_LABEL);
  if (existing) {
    const { emitTo } = await loadEvent();
    await emitTo(PREVIEW_WINDOW_LABEL, PREVIEW_NAVIGATE_EVENT, { session: true });
    try {
      await existing.unminimize();
      await existing.show();
      if (focus) await existing.setFocus();
    } catch {
      /* noop */
    }
    return;
  }
  const win = new WebviewWindow(PREVIEW_WINDOW_LABEL, {
    url: `/preview?session=1`,
    title: "UNICREW プレビュー",
    width: 1280,
    height: 840,
    minWidth: 560,
    minHeight: 360,
    resizable: true,
    decorations: true,
    center: true,
    focus,
  });
  win.once("tauri://error", (e) => {
    console.error("[preview window] failed to create", e);
  });
}
