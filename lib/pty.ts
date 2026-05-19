"use client";

/**
 * 対話 PTY セッション（ハイブリッド方針 B）のフロント側ラッパ。
 * Rust の pty_* コマンド／pty:// イベントと橋渡しするだけ。
 * 既存の agent (headless) 系とは完全独立。
 */

import { isTauri } from "./tauri";

async function invoker() {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export interface PtyOpenParams {
  id: string;
  program: string;
  args?: string[];
  cwd?: string | null;
  cols: number;
  rows: number;
}

export async function ptyOpen(p: PtyOpenParams): Promise<void> {
  const invoke = await invoker();
  await invoke("pty_open", {
    id: p.id,
    program: p.program,
    args: p.args ?? [],
    cwd: p.cwd ?? null,
    cols: p.cols,
    rows: p.rows,
  });
}

export async function ptyWriteText(id: string, text: string): Promise<void> {
  const invoke = await invoker();
  await invoke("pty_write", {
    id,
    data: b64encode(new TextEncoder().encode(text)),
  });
}

export async function ptyResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  const invoke = await invoker();
  await invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  try {
    const invoke = await invoker();
    await invoke("pty_kill", { id });
  } catch {
    /* noop */
  }
}

export async function onPtyData(
  id: string,
  cb: (bytes: Uint8Array) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ id: string; data: string }>("pty://data", (e) => {
    if (e.payload.id === id) cb(b64decode(e.payload.data));
  });
}

export async function onPtyExit(
  id: string,
  cb: () => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ id: string }>("pty://exit", (e) => {
    if (e.payload.id === id) cb();
  });
}

export { isTauri };
