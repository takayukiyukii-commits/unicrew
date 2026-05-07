"use client";

/**
 * Tauri との橋渡しレイヤ。
 *
 * - Tauriウィンドウで動いている場合は本物のコマンド／API を呼ぶ
 * - ブラウザ（npm run dev）で動いている場合は安全にno-op／例外で落ちる
 */

export type TauriEnv = "tauri" | "browser";

export function detectEnv(): TauriEnv {
  if (typeof window === "undefined") return "browser";
  // @ts-expect-error injected by Tauri
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) return "tauri";
  return "browser";
}

export const isTauri = () => detectEnv() === "tauri";

async function loadInvoke() {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke;
}

async function loadEvent() {
  return await import("@tauri-apps/api/event");
}

async function loadDialog() {
  return await import("@tauri-apps/plugin-dialog");
}

// ---------- Keychain ----------

export async function getApiKey(): Promise<string | null> {
  if (!isTauri()) {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("unicrew.devApiKey");
  }
  const invoke = await loadInvoke();
  return invoke<string | null>("get_api_key");
}

export async function setApiKey(key: string): Promise<void> {
  if (!isTauri()) {
    if (typeof window === "undefined") return;
    if (key) localStorage.setItem("unicrew.devApiKey", key);
    else localStorage.removeItem("unicrew.devApiKey");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("set_api_key", { key });
}

// ---------- Workspace selection ----------

export async function pickWorkspace(): Promise<string | null> {
  if (!isTauri()) {
    alert(
      "ワークスペース選択は Tauri アプリ起動時のみ利用できます。\n`npm run tauri:dev` で起動してください。",
    );
    return null;
  }
  const dialog = await loadDialog();
  const path = await dialog.open({
    directory: true,
    multiple: false,
    title: "ワークスペースとして開くフォルダを選択",
  });
  if (!path || Array.isArray(path)) return null;
  return path as string;
}

// ---------- Filesystem ----------

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export async function listDirectory(path: string): Promise<DirEntry[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<DirEntry[]>("list_directory", { path });
}

export async function readTextFile(path: string): Promise<string> {
  if (!isTauri()) throw new Error("readTextFile は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("read_text_file", { path });
}

// ---------- Claude Code (CLI) status & login ----------

export interface ClaudeStatus {
  installed: boolean;
  logged_in: boolean;
  version: string | null;
  hint: string;
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  if (!isTauri()) {
    return {
      installed: false,
      logged_in: false,
      version: null,
      hint: "（ブラウザ開発モードでは取得できません）",
    };
  }
  const invoke = await loadInvoke();
  return invoke<ClaudeStatus>("claude_status");
}

export async function startClaudeLogin(): Promise<void> {
  if (!isTauri()) {
    alert("ログイン操作は Tauri アプリ起動時のみ利用できます。");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("start_claude_login");
}

export async function installClaudeCode(): Promise<void> {
  if (!isTauri()) {
    alert("インストール操作は Tauri アプリ起動時のみ利用できます。");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("install_claude_code");
}

export async function defaultWorkspacePath(): Promise<string | null> {
  if (!isTauri()) return null;
  const invoke = await loadInvoke();
  return invoke<string>("default_workspace_path");
}

// ---------- Avatar image ----------

/** ユーザーに画像を選ばせて、AppData/avatars/ にコピーし、保存先絶対パスを返す。 */
export async function pickAndSaveAvatar(): Promise<string | null> {
  if (!isTauri()) {
    alert("画像選択は Tauri アプリ起動時のみ利用できます。");
    return null;
  }
  const dialog = await loadDialog();
  const file = await dialog.open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "画像",
        extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"],
      },
    ],
    title: "アバター画像を選択",
  });
  if (!file || Array.isArray(file)) return null;
  const invoke = await loadInvoke();
  return invoke<string>("save_avatar_image", { sourcePath: file as string });
}

export async function deleteAvatar(path: string): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("delete_avatar_image", { path });
}

/** ローカル絶対パスをdata URLとして取得（asset protocol不要の安定方式）。 */
export async function avatarSrc(path: string): Promise<string> {
  if (!isTauri()) return path;
  const invoke = await loadInvoke();
  return invoke<string>("read_image_as_data_url", { path });
}

// ---------- Login / Install progress events ----------

export interface LoginProgressHandlers {
  onLine?: (line: string) => void;
  onBrowserOpened?: (url: string) => void;
  onDone?: (success: boolean) => void;
  onStderr?: (line: string) => void;
}

export async function listenLoginProgress(
  h: LoginProgressHandlers,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlistens = await Promise.all([
    ev.listen<string>("claude_login:line", (e) => h.onLine?.(e.payload)),
    ev.listen<string>("claude_login:browser_opened", (e) =>
      h.onBrowserOpened?.(e.payload),
    ),
    ev.listen<boolean>("claude_login:done", (e) => h.onDone?.(e.payload)),
    ev.listen<string>("claude_login:stderr", (e) => h.onStderr?.(e.payload)),
  ]);
  return () => unlistens.forEach((u) => u());
}

export interface InstallProgressHandlers {
  onLine?: (line: string) => void;
  onDone?: (success: boolean) => void;
}

export async function listenInstallProgress(
  h: InstallProgressHandlers,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlistens = await Promise.all([
    ev.listen<string>("claude_install:line", (e) => h.onLine?.(e.payload)),
    ev.listen<boolean>("claude_install:done", (e) => h.onDone?.(e.payload)),
  ]);
  return () => unlistens.forEach((u) => u());
}

// ---------- Codex CLI ----------

export interface CodexStatus {
  installed: boolean;
  logged_in: boolean;
  version: string | null;
  hint: string;
}

export async function codexStatus(): Promise<CodexStatus> {
  if (!isTauri()) {
    return {
      installed: false,
      logged_in: false,
      version: null,
      hint: "（ブラウザ開発モードでは取得できません）",
    };
  }
  const invoke = await loadInvoke();
  return invoke<CodexStatus>("codex_status");
}

export async function startCodexLogin(): Promise<void> {
  if (!isTauri()) {
    alert("ログイン操作は Tauri アプリ起動時のみ利用できます。");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("start_codex_login");
}

export async function installCodex(): Promise<void> {
  if (!isTauri()) {
    alert("インストール操作は Tauri アプリ起動時のみ利用できます。");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("install_codex");
}

export async function listenCodexLoginProgress(
  h: LoginProgressHandlers,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlistens = await Promise.all([
    ev.listen<string>("codex_login:line", (e) => h.onLine?.(e.payload)),
    ev.listen<string>("codex_login:browser_opened", (e) =>
      h.onBrowserOpened?.(e.payload),
    ),
    ev.listen<boolean>("codex_login:done", (e) => h.onDone?.(e.payload)),
    ev.listen<string>("codex_login:stderr", (e) => h.onStderr?.(e.payload)),
  ]);
  return () => unlistens.forEach((u) => u());
}

export async function listenCodexInstallProgress(
  h: InstallProgressHandlers,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlistens = await Promise.all([
    ev.listen<string>("codex_install:line", (e) => h.onLine?.(e.payload)),
    ev.listen<boolean>("codex_install:done", (e) => h.onDone?.(e.payload)),
  ]);
  return () => unlistens.forEach((u) => u());
}

// ---------- Agent SDK bridge ----------

export type AuthMode = "subscription" | "apikey";
export type Provider = "claude" | "codex";

export interface AgentStartParams {
  sessionId: string;
  workspace: string | null;
  systemPrompt: string;
  model: string;
  authMode: AuthMode;
  apiKey?: string | null;
  provider?: Provider;
}

export async function agentStart(params: AgentStartParams): Promise<void> {
  if (!isTauri()) throw new Error("agentStart は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  await invoke("agent_start", {
    req: {
      session_id: params.sessionId,
      workspace: params.workspace,
      system_prompt: params.systemPrompt,
      model: params.model,
      auth_mode: params.authMode,
      api_key: params.authMode === "apikey" ? params.apiKey ?? null : null,
      provider: params.provider ?? "claude",
    },
  });
}

export async function agentSend(sessionId: string, text: string): Promise<void> {
  if (!isTauri()) throw new Error("agentSend は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  await invoke("agent_send", {
    req: { session_id: sessionId, text },
  });
}

export async function agentStop(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("agent_stop", { req: { session_id: sessionId } });
}

export async function agentPermissionResponse(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny" | "allow_once",
): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("agent_permission_response", {
    sessionId,
    requestId,
    decision,
  });
}

export type AgentEvent =
  | { kind: "ready" }
  | { kind: "assistant_text"; session_id: string; text: string }
  | {
      kind: "tool_use";
      session_id: string;
      tool_use_id: string;
      tool_name: string;
      tool_input: Record<string, unknown>;
    }
  | {
      kind: "tool_result";
      session_id: string;
      tool_use_id: string;
      is_error: boolean;
      content: unknown;
    }
  | {
      kind: "permission_request";
      session_id: string;
      request_id: string;
      tool_name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "result";
      session_id: string;
      subtype: string;
      cost_usd: number | null;
      usage: unknown;
    }
  | {
      kind: "usage_delta";
      session_id: string;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
    }
  | { kind: "error"; session_id: string; message: string };

export async function listenAgentEvents(
  cb: (event: AgentEvent) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlisten = await ev.listen<string>("agent:event", (e) => {
    try {
      cb(JSON.parse(e.payload) as AgentEvent);
    } catch {
      // ignore
    }
  });
  return unlisten;
}

// ---------- Addons (plugins / skills / MCP) ----------

export type AddonKind = "plugin" | "skill" | "mcp";
export type AddonSource = "claude" | "codex";

export interface AddonItem {
  id: string;
  name: string;
  namespace: string | null;
  version: string | null;
  enabled: boolean;
  scope: string;
  description: string | null;
  kind: AddonKind;
  source: AddonSource;
  path: string | null;
}

export async function listClaudePlugins(): Promise<AddonItem[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<AddonItem[]>("list_claude_plugins");
}

export async function listClaudeSkills(
  workspace?: string | null,
): Promise<AddonItem[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<AddonItem[]>("list_claude_skills", { workspace: workspace ?? null });
}

export async function listClaudeMcp(): Promise<AddonItem[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<AddonItem[]>("list_claude_mcp");
}

export async function listCodexPlugins(): Promise<AddonItem[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<AddonItem[]>("list_codex_plugins");
}

export async function listCodexSkills(): Promise<AddonItem[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<AddonItem[]>("list_codex_skills");
}

// ---------- Voice input (Whisper) ----------

export async function getOpenAiApiKey(): Promise<string | null> {
  if (!isTauri()) {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("unicrew.devOpenAiKey");
  }
  const invoke = await loadInvoke();
  return invoke<string | null>("get_openai_api_key");
}

export async function setOpenAiApiKey(key: string): Promise<void> {
  if (!isTauri()) {
    if (typeof window === "undefined") return;
    if (key) localStorage.setItem("unicrew.devOpenAiKey", key);
    else localStorage.removeItem("unicrew.devOpenAiKey");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("set_openai_api_key", { key });
}

export async function toggleClaudeMcp(
  name: string,
  enabled: boolean,
): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("toggle_claude_mcp", { name, enabled });
}

export interface McpAddRequest {
  name: string;
  kind: "stdio" | "sse" | "http";
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  env?: Record<string, string> | null;
}

export async function addClaudeMcp(req: McpAddRequest): Promise<void> {
  if (!isTauri()) throw new Error("MCP 追加は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  await invoke("add_claude_mcp", { req });
}

export async function removeClaudeMcp(name: string): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("remove_claude_mcp", { name });
}

export async function installClaudePlugin(id: string): Promise<string> {
  if (!isTauri()) throw new Error("プラグイン追加は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("install_claude_plugin", { id });
}

export async function uninstallClaudePlugin(id: string): Promise<string> {
  if (!isTauri()) throw new Error("プラグイン削除は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("uninstall_claude_plugin", { id });
}

export async function addClaudeMarketplace(
  id: string,
  repo: string,
): Promise<string> {
  if (!isTauri()) throw new Error("marketplace 追加は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("add_claude_marketplace", { id, repo });
}

export async function transcribeAudio(
  blob: Blob,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("音声入力は Tauri アプリ起動時のみ利用できます");
  }
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  const audioBase64 = btoa(binary);
  const invoke = await loadInvoke();
  return invoke<string>("transcribe_audio", {
    audioBase64,
    mime: blob.type || "audio/webm",
  });
}

export async function listenAgentStderr(
  cb: (line: string, sessionId: string) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlisten = await ev.listen<{ session_id: string; line: string }>(
    "agent:stderr",
    (e) => cb(e.payload.line, e.payload.session_id),
  );
  return unlisten;
}
