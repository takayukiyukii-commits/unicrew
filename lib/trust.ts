"use client";

/**
 * Workspace Trust の TypeScript 側ラッパ。
 *
 * 既定信頼: `~/Documents/UNICREW`（既定ワークスペース）は初回起動で自動追加する。
 * 自動追加は app/page.tsx 側でやる（ここでは API だけ）。
 */

import { isTauri } from "./tauri";

async function loadInvoke() {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke;
}

export async function isWorkspaceTrusted(path: string): Promise<boolean> {
  if (!isTauri()) return true; // ブラウザ開発時は素通し
  const invoke = await loadInvoke();
  return invoke<boolean>("is_workspace_trusted", { path });
}

export async function trustWorkspace(path: string): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("trust_workspace", { path });
}

export async function untrustWorkspace(path: string): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("untrust_workspace", { path });
}

export async function listTrustedWorkspaces(): Promise<string[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<string[]>("list_trusted_workspaces");
}
