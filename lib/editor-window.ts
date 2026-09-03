"use client";

/**
 * UNICREW エディタウィンドウ（別ウィンドウ）の管理。
 *
 * 動作:
 *  - 初回クリック: 新しい Tauri ウィンドウ ("editor") を生成し、URL クエリ ?file=... に
 *    最初のファイルパスを乗せて開く。エディタウィンドウは mount 時にこれを最初のタブとして開く。
 *  - 2回目以降: すでに開いているエディタウィンドウに `editor://open-tab` イベントを emit して
 *    タブを追加し、ウィンドウを前面に出す。
 *  - 差分（v0.4.0）: 右ペイン「変更」からは `?diff=<JSON>` / `editor://open-diff` で
 *    読み取り専用の左右比較タブを開く（同じウィンドウ・同じタブ列に並ぶ）。
 *
 * VSCode のエクスプローラー → エディタを別ウィンドウに切り出すための薄いラッパ。
 * 「メインの会話画面の邪魔をしない」要件に対応。
 */

import { isTauri } from "./tauri";

const EDITOR_WINDOW_LABEL = "editor";
export const EDITOR_OPEN_TAB_EVENT = "editor://open-tab";
export const EDITOR_OPEN_DIFF_EVENT = "editor://open-diff";

/** 差分タブの要求（RightPane「変更」→ エディタウィンドウ）。 */
export interface DiffRequest {
  /** git 管理下のフォルダ（worktree 隔離中はその worktree） */
  workspace: string;
  /** リポジトリ内の相対パス */
  file: string;
  /** 基準（tree/commit oid）。無ければ HEAD */
  base?: string;
  /** 表示用の補足（例: 参加者名） */
  label?: string;
}

async function loadWebviewWindow() {
  return await import("@tauri-apps/api/webviewWindow");
}

async function loadEvent() {
  return await import("@tauri-apps/api/event");
}

/** 既存ウィンドウにイベントを送って前面化する。無ければ false。 */
async function emitToExisting(event: string, payload: unknown): Promise<boolean> {
  const { WebviewWindow } = await loadWebviewWindow();
  const existing = await WebviewWindow.getByLabel(EDITOR_WINDOW_LABEL);
  if (!existing) return false;
  const { emit } = await loadEvent();
  await emit(event, payload);
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
  return true;
}

/** エディタウィンドウを新規生成する。Tauri の frontendDist 上では Next.js の static export が
 *  /editor/index.html として配置される。dev (next dev) でも /editor で解決される。 */
async function createEditorWindow(query: string): Promise<void> {
  const { WebviewWindow } = await loadWebviewWindow();
  const win = new WebviewWindow(EDITOR_WINDOW_LABEL, {
    url: `/editor?${query}`,
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
    console.error("[editor window] failed to create", e);
  });
}

/** ファイルをエディタウィンドウで開く（無ければ生成、有ればタブ追加して前面化） */
export async function openFileInEditorWindow(path: string): Promise<void> {
  if (!isTauri()) {
    alert(
      "エディタウィンドウは Tauri アプリ起動時のみ利用できます。\n`npm run tauri:dev` で起動してください。",
    );
    return;
  }
  if (await emitToExisting(EDITOR_OPEN_TAB_EVENT, { path })) return;
  await createEditorWindow(`file=${encodeURIComponent(path)}`);
}

/** 差分（基準 vs 今のファイル）をエディタウィンドウで読み取り専用に開く。 */
export async function openDiffInEditorWindow(req: DiffRequest): Promise<void> {
  if (!isTauri()) {
    alert("差分ビューは Tauri アプリ起動時のみ利用できます。");
    return;
  }
  if (await emitToExisting(EDITOR_OPEN_DIFF_EVENT, req)) return;
  await createEditorWindow(`diff=${encodeURIComponent(JSON.stringify(req))}`);
}
