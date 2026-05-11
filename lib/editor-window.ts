"use client";

/**
 * UNICREW エディタウィンドウ（別ウィンドウ）の管理。
 *
 * 動作:
 *  - 初回クリック: 新しい Tauri ウィンドウ ("editor") を生成し、URL クエリ ?file=... に
 *    最初のファイルパスを乗せて開く。エディタウィンドウは mount 時にこれを最初のタブとして開く。
 *  - 2回目以降: すでに開いているエディタウィンドウに `editor://open-tab` イベントを emit して
 *    タブを追加し、ウィンドウを前面に出す。
 *
 * VSCode のエクスプローラー → エディタを別ウィンドウに切り出すための薄いラッパ。
 * 「メインの会話画面の邪魔をしない」要件に対応。
 */

import { isTauri } from "./tauri";

const EDITOR_WINDOW_LABEL = "editor";
export const EDITOR_OPEN_TAB_EVENT = "editor://open-tab";

async function loadWebviewWindow() {
  return await import("@tauri-apps/api/webviewWindow");
}

async function loadEvent() {
  return await import("@tauri-apps/api/event");
}

/** ファイルをエディタウィンドウで開く（無ければ生成、有ればタブ追加して前面化） */
export async function openFileInEditorWindow(path: string): Promise<void> {
  if (!isTauri()) {
    alert(
      "エディタウィンドウは Tauri アプリ起動時のみ利用できます。\n`npm run tauri:dev` で起動してください。",
    );
    return;
  }
  const { WebviewWindow } = await loadWebviewWindow();
  const existing = await WebviewWindow.getByLabel(EDITOR_WINDOW_LABEL);
  if (existing) {
    const { emit } = await loadEvent();
    await emit(EDITOR_OPEN_TAB_EVENT, { path });
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
  // 新規生成。Tauri の frontendDist 上では Next.js の static export が
  // /editor/index.html として配置される。dev (next dev) でも /editor で解決される。
  const url = `/editor?file=${encodeURIComponent(path)}`;
  const win = new WebviewWindow(EDITOR_WINDOW_LABEL, {
    url,
    title: "UNICREW Editor",
    width: 1100,
    height: 760,
    minWidth: 600,
    minHeight: 400,
    resizable: true,
    decorations: true,
    center: true,
  });
  // エラー検知のみ（成功イベントはここでは待たない；エディタ側 mount 時に URL から拾う）
  win.once("tauri://error", (e) => {
    // eslint-disable-next-line no-console
    console.error("[editor window] failed to create", e);
  });
}
