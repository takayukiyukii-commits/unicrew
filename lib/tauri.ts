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

// ---------- Clipboard ----------
// コピー＆ペーストを WebView のネイティブ clipboard / paste イベントに頼ると、
// WebView2 等で「コピペができない」事例がある。OS レベルの Tauri clipboard-manager
// プラグインを第一経路にし、失敗時のみ navigator.clipboard へフォールバックする。

export async function writeClipboardText(text: string): Promise<void> {
  if (isTauri()) {
    try {
      const mod = await import("@tauri-apps/plugin-clipboard-manager");
      await mod.writeText(text);
      return;
    } catch {
      /* プラグイン未初期化等はフォールバックへ */
    }
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    /* 権限なし等は黙って諦める */
  }
}

export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    try {
      const mod = await import("@tauri-apps/plugin-clipboard-manager");
      const t = await mod.readText();
      return t ?? "";
    } catch {
      /* プラグイン未初期化等はフォールバックへ */
    }
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      return (await navigator.clipboard.readText()) ?? "";
    }
  } catch {
    /* 権限なし等 */
  }
  return "";
}

// 同期コピー。WebView2 では Tauri plugin / navigator.clipboard の書き込みが
// （権限・ユーザージェスチャ消失・環境差で）失敗し「コピーできない」事象がある。
// keydown ジェスチャ内で同期実行できる execCommand("copy") は WebView2 でも確実に
// 動く最も互換性の高い書き込み方法なので、これを第一経路にする。
export function copyTextSync(text: string): boolean {
  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    const prev = document.activeElement as HTMLElement | null;
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    try {
      prev?.focus?.();
    } catch {
      /* フォーカス復帰失敗は無視 */
    }
    return ok;
  } catch {
    return false;
  }
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

export async function pickWorkspace(opts?: {
  /**
   * ダイアログを最初に開いた時に表示するフォルダ。
   * 「新しいターミナル/会話を開いた時に最後に開いたフォルダがデフォルト選択されてほしい」
   * 要望に応えるため、呼び出し側で `loadLastWorkspace()` を渡すのが既定の使い方。
   */
  defaultPath?: string | null;
}): Promise<string | null> {
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
    defaultPath: opts?.defaultPath ?? undefined,
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

export async function readFileBase64(path: string): Promise<string> {
  if (!isTauri()) throw new Error("readFileBase64 は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("read_file_base64", { path });
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  if (!isTauri()) throw new Error("writeTextFile は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  await invoke("write_text_file", { path, contents });
}

// ---------- エクスプローラーのファイル操作（右クリックメニュー用） ----------

/** 名前を変更し、新しい絶対パスを返す */
export async function fsRename(path: string, newName: string): Promise<string> {
  if (!isTauri()) throw new Error("fsRename は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("fs_rename", { path, newName });
}

/** OS のゴミ箱へ移動（完全削除はしない） */
export async function fsDelete(path: string): Promise<void> {
  if (!isTauri()) throw new Error("fsDelete は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  await invoke("fs_delete", { path });
}

/** 空ファイルを作成し、絶対パスを返す */
export async function fsCreateFile(dir: string, name: string): Promise<string> {
  if (!isTauri()) throw new Error("fsCreateFile は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("fs_create_file", { dir, name });
}

/** フォルダを作成し、絶対パスを返す */
export async function fsCreateDir(dir: string, name: string): Promise<string> {
  if (!isTauri()) throw new Error("fsCreateDir は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("fs_create_dir", { dir, name });
}

/** OS のファイルマネージャーで対象を表示 */
export async function revealInFileManager(path: string): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("reveal_in_file_manager", { path });
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

export async function pickAttachment(): Promise<
  { path: string; kind: "image" | "file" } | null
> {
  if (!isTauri()) {
    alert("ファイル添付は Tauri アプリ起動時のみ利用できます。");
    return null;
  }
  const dialog = await loadDialog();
  const IMG = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
  const DOC = [
    "pdf", "txt", "md", "markdown", "csv", "tsv", "json",
    "yaml", "yml", "log", "docx", "xlsx", "pptx", "html", "xml",
  ];
  const file = await dialog.open({
    multiple: false,
    directory: false,
    filters: [
      { name: "画像・書類", extensions: [...IMG, ...DOC] },
      { name: "すべてのファイル", extensions: ["*"] },
    ],
    title: "添付するファイルを選択",
  });
  if (!file || Array.isArray(file)) return null;
  const src = file as string;
  const dot = src.lastIndexOf(".");
  const ext = dot >= 0 ? src.slice(dot + 1).toLowerCase() : "";
  if (IMG.includes(ext)) {
    const invoke = await loadInvoke();
    const saved = await invoke<string>("save_avatar_image", {
      sourcePath: src,
    });
    return { path: saved, kind: "image" };
  }
  // 書類はコピーせず元パスをそのまま渡す（AI が Read ツールで開く）
  return { path: src, kind: "file" };
}

export async function deleteAvatar(path: string): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("delete_avatar_image", { path });
}

/**
 * Drag&Drop で受け取った File をそのまま AppData/avatars/ に保存する。
 * Tauri webview に画像がドロップされても OS パスが取れない（File API 経由）のため、
 * ArrayBuffer を base64 化して Rust 側に流す。
 */
export async function saveAvatarFromFile(file: File): Promise<string | null> {
  if (!isTauri()) {
    alert("画像保存は Tauri アプリ起動時のみ利用できます。");
    return null;
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const bytes_b64 = btoa(binary);
  // 拡張子: file.name の最後の "." 以降。無ければ MIME から推測
  const dot = file.name.lastIndexOf(".");
  let ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!ext) {
    const m = (file.type || "").match(/^image\/(\w+)$/);
    ext = m ? m[1] : "png";
  }
  const invoke = await loadInvoke();
  return invoke<string>("save_avatar_bytes", { bytesB64: bytes_b64, ext });
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

export interface GeminiStatus {
  installed: boolean;
  logged_in: boolean;
  version: string | null;
  has_api_key_env: boolean;
  hint: string;
}

export async function geminiStatus(): Promise<GeminiStatus> {
  if (!isTauri()) {
    return {
      installed: false,
      logged_in: false,
      version: null,
      has_api_key_env: false,
      hint: "（ブラウザ開発モードでは取得できません）",
    };
  }
  const invoke = await loadInvoke();
  return invoke<GeminiStatus>("gemini_status");
}

export async function installGemini(): Promise<void> {
  if (!isTauri()) {
    alert("インストール操作は Tauri アプリ起動時のみ利用できます。");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("install_gemini");
}

/**
 * `npm install -g @google/gemini-cli` の進捗（stdout/stderr 行）を listen。
 * onDone は exit code success のとき true。
 */
export async function listenGeminiInstallProgress(handlers: {
  onLine?: (line: string) => void;
  onDone?: (success: boolean) => void;
}): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlistens = await Promise.all([
    ev.listen<string>("gemini_install:line", (e) =>
      handlers.onLine?.(e.payload),
    ),
    ev.listen<boolean>("gemini_install:done", (e) =>
      handlers.onDone?.(e.payload),
    ),
  ]);
  return () => {
    unlistens.forEach((u) => u());
  };
}

// ---------- ACP / OSS CLI (Goose / OpenCode / Ollama) ----------

/**
 * L3 ACP / ローカル LLM 系の status 検出対応プロバイダ。
 *
 * - goose / opencode / ollama: 自動インストール対応（installAcpCli 実行可）
 * - codex-acp / kiro: status 検出のみ対応。installAcpCli は reject される
 *   （npm 配布が現状無く、AWS Builder ID 等の前提があるため手動インストール限定）
 */
export type AcpCliProvider =
  | "goose"
  | "opencode"
  | "ollama"
  | "codex-acp"
  | "kiro"
  | "qwen"
  | "kimi"
  | "grok"
  | "cursor";

/**
 * installAcpCli が動く provider だけの subset。
 *
 * - opencode  : 全 OS で `npm install -g opencode-ai`
 * - codex-acp : 全 OS で `npm install -g @zed-industries/codex-acp`（実行時 OPENAI_API_KEY 必須）
 * - ollama    : Windows のみ `winget install Ollama.Ollama`、macOS/Linux は手動
 * - qwen      : 全 OS で `npm install -g @qwen-code/qwen-code`（実行時 DASHSCOPE_API_KEY 必須、Sprint 3）
 * - goose は winget 公式パッケージが無いため auto 除外（manual 扱い、2026-05-11）
 * - kiro は AWS Builder ID 必須のため auto 除外（manual 扱い）
 */
export type AcpCliAutoInstallProvider =
  | "opencode"
  | "codex-acp"
  | "ollama"
  | "qwen";

export interface AcpCliStatus {
  provider: AcpCliProvider;
  installed: boolean;
  version: string | null;
}

/**
 * `<bin> --version` で installed/version を検出する。
 * ブラウザ dev では `installed: false` を返す。
 */
export async function acpCliStatus(
  provider: AcpCliProvider,
): Promise<AcpCliStatus> {
  if (!isTauri()) {
    return { provider, installed: false, version: null };
  }
  const invoke = await loadInvoke();
  return invoke<AcpCliStatus>("acp_cli_status", { provider });
}

/**
 * 指定 provider をインストール。進捗は `listenAcpInstallProgress` で受け取る。
 * - 自動対応 (`AcpCliAutoInstallProvider`) 以外を渡すと Rust 側で reject される
 * - OS 非対応の組合せも Promise reject される（UI 側で外部リンク誘導に切替）
 */
export async function installAcpCli(
  provider: AcpCliAutoInstallProvider,
): Promise<void> {
  if (!isTauri()) {
    alert("インストール操作は Tauri アプリ起動時のみ利用できます。");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("install_acp_cli", { provider });
}

export interface AcpInstallLineEvent {
  provider: AcpCliProvider;
  line: string;
}

export interface AcpInstallDoneEvent {
  provider: AcpCliProvider;
  success: boolean;
}

/**
 * ACP CLI インストール進捗を listen。複数 provider 同時実行に対応するため
 * payload に provider 名が含まれる。UI 側で provider が一致するイベントだけ
 * 拾うこと。
 */
export async function listenAcpInstallProgress(handlers: {
  onLine?: (ev: AcpInstallLineEvent) => void;
  onDone?: (ev: AcpInstallDoneEvent) => void;
}): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlistens = await Promise.all([
    ev.listen<AcpInstallLineEvent>("acp_install:line", (e) =>
      handlers.onLine?.(e.payload),
    ),
    ev.listen<AcpInstallDoneEvent>("acp_install:done", (e) =>
      handlers.onDone?.(e.payload),
    ),
  ]);
  return () => unlistens.forEach((u) => u());
}

// ---------- Ollama model pull ----------

export interface OllamaPullLineEvent {
  model: string;
  line: string;
}

export interface OllamaPullDoneEvent {
  model: string;
  success: boolean;
}

/**
 * `ollama pull <model>` を起動して指定モデルをダウンロードする。
 * 進捗は `listenOllamaPullProgress` で受ける。
 * Ollama 本体未インストールの場合は Promise reject。
 */
export async function ollamaPull(model: string): Promise<void> {
  if (!isTauri()) {
    alert("Ollama のモデル取得は Tauri アプリ起動時のみ利用できます。");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("ollama_pull", { model });
}

/**
 * `ollama pull` 進捗を listen。複数モデル同時取得に備え payload に model 名を含む。
 */
export async function listenOllamaPullProgress(handlers: {
  onLine?: (ev: OllamaPullLineEvent) => void;
  onDone?: (ev: OllamaPullDoneEvent) => void;
}): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const unlistens = await Promise.all([
    ev.listen<OllamaPullLineEvent>("ollama_pull:line", (e) =>
      handlers.onLine?.(e.payload),
    ),
    ev.listen<OllamaPullDoneEvent>("ollama_pull:done", (e) =>
      handlers.onDone?.(e.payload),
    ),
  ]);
  return () => unlistens.forEach((u) => u());
}

export interface CliVersionInfo {
  name: string;
  package: string;
  current: string | null;
  latest: string | null;
  update_available: boolean;
}

export interface CliVersions {
  claude: CliVersionInfo;
  codex: CliVersionInfo;
}

/**
 * インストール済 CLI バージョンと npm 最新バージョンを取得。
 * Settings の「最新版チェック」用。
 */
export async function cliVersions(): Promise<CliVersions | null> {
  if (!isTauri()) return null;
  const invoke = await loadInvoke();
  return await invoke<CliVersions>("cli_versions");
}

/**
 * 指定 provider の CLI を `npm install -g <pkg>@latest` で更新する。
 * 進捗は `cli_update:line` イベントで stream される（必要なら listen で拾う）。
 */
export async function updateCli(provider: "claude" | "codex"): Promise<void> {
  if (!isTauri()) {
    alert("更新操作は Tauri アプリ起動時のみ利用できます。");
    return;
  }
  const invoke = await loadInvoke();
  await invoke("update_cli", { provider });
}

// ---------- UNICREW 本体（self-update）の自動アップデート ----------

/**
 * GitHub Releases に上がっている latest.json を見にいき、新しいバージョンがあるかチェックする。
 * 戻り値: { available, version, body } / null = エラー or 未対応環境
 */
export interface UnicrewUpdateInfo {
  available: boolean;
  /** 利用可能な最新バージョン（available=false の時は現在バージョン） */
  version: string;
  /** リリースノート（CHANGELOG）。Markdown 文字列。 */
  body: string;
  /** 内部的に保持する「進める準備が出来た Update オブジェクト」へのトークン。
   * downloadAndInstallUnicrewUpdate で再利用する。 */
  __token: number;
}

// Update オブジェクトは Promise を返すと壊れるので、グローバルにキャッシュしてトークンで参照する。
let _updateCache:
  | { token: number; update: { available: boolean; version: string; body?: string | null; downloadAndInstall: (cb?: (e: unknown) => void) => Promise<void> } }
  | null = null;
let _updateTokenSeq = 1;

export async function checkUnicrewUpdate(): Promise<UnicrewUpdateInfo | null> {
  if (!isTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      // 未対応 or 同じバージョン
      return {
        available: false,
        version: "",
        body: "",
        __token: 0,
      };
    }
    const token = _updateTokenSeq++;
    _updateCache = { token, update };
    return {
      available: update.available,
      version: update.version ?? "",
      body: update.body ?? "",
      __token: token,
    };
  } catch (e) {
    console.error("[updater] check failed", e);
    return null;
  }
}

/**
 * 直前の checkUnicrewUpdate で見つかった更新をダウンロード→インストール→再起動する。
 * 失敗時は throw、進捗は progressCb に DownloadEvent が流れる。
 */
export async function downloadAndInstallUnicrewUpdate(
  token: number,
  progressCb?: (event: unknown) => void,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Tauri アプリ起動時のみ利用できます");
  }
  if (!_updateCache || _updateCache.token !== token) {
    throw new Error("更新トークンが古いため再度チェックしてください");
  }
  await _updateCache.update.downloadAndInstall(progressCb);
  // インストール直後にアプリ再起動（プロセス入れ替え）
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    console.error("[updater] relaunch failed", e);
  }
}

// ---------- Aggregated Addon updates (Phase 1) ----------

/**
 * 設定 → 機能の追加に並ぶ CLI / Plugin / Skill の最新版チェック結果。
 *
 * - `kind` で分岐：cli / claude_plugin / codex_plugin / skill
 * - `id` を `applyAddonUpdate` にそのまま渡すと Rust 側で適切なコマンド（npm / claude / git）が走る
 * - `detail` は人間向け補足（"3 commits behind origin" など）
 */
export interface AddonUpdateItem {
  kind:
    | "cli"
    | "claude_plugin"
    | "codex_plugin"
    | "codex_marketplace"
    | "skill";
  id: string;
  name: string;
  current: string | null;
  latest: string | null;
  has_update: boolean;
  detail: string | null;
}

export interface AddonUpdateSummary {
  /** epoch millis。最終チェック表示用。 */
  checked_at: number;
  items: AddonUpdateItem[];
}

/**
 * 全アドオン（CLI/Plugin/Skill）の最新版を一括チェック。
 * 通信先は npm registry と各 skill の git remote のみ。
 */
export async function checkAddonUpdates(): Promise<AddonUpdateSummary | null> {
  if (!isTauri()) return null;
  const invoke = await loadInvoke();
  return await invoke<AddonUpdateSummary>("check_addon_updates");
}

/**
 * 1 アイテム分のアドオン更新を実行。
 * - kind="cli" → npm install -g <pkg>@latest（進捗は cli_update:line で stream）
 * - kind="claude_plugin" → claude --print /plugin install <id>
 * - kind="skill" → git pull --ff-only
 * 戻り値は CLI / git の stdout 文字列（成功時の表示用）。
 */
export async function applyAddonUpdate(
  kind: AddonUpdateItem["kind"],
  id: string,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("更新操作は Tauri アプリ起動時のみ利用できます。");
  }
  const invoke = await loadInvoke();
  return await invoke<string>("apply_addon_update", { kind, id });
}

export async function listenCliUpdate(
  cb: (line: string) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await loadEvent();
  const un = await ev.listen<string>("cli_update:line", (e) => cb(e.payload));
  return () => {
    un();
  };
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

// ---------- Agent CLI Conductor bridge ----------
//
// Rust 側の providers/ レイヤと話すブリッジ。SDK ではなく公式 claude / codex CLI を
// subprocess として spawn し、stream-json を NormalizedEvent に変換した結果を
// agent:event イベントで購読する。

export type AuthMode = "subscription" | "apikey";

// Provider 型は lib/types.ts の正本を使う。
// 旧コード（2026-05-10 以前）はここに重複定義していたが、Sprint 1 の
// "goose" 追加で型不整合が発生したため統一した。新プロバイダ追加時は
// lib/types.ts の Provider と lib/providerCategories.ts の PROVIDER_CATEGORY
// だけ更新すれば全コンポーネントに伝播する。
import type { Provider } from "./types";
export type { Provider };

export interface AgentStartParams {
  sessionId: string;
  workspace: string | null;
  systemPrompt: string;
  model: string;
  authMode: AuthMode;
  apiKey?: string | null;
  provider?: Provider;
  /**
   * 既存 CLI セッションを再開するための CLI 側 session_id。
   * Claude: `--resume <sid>` / Codex: `exec resume <sid>` に渡される。
   * thread.claudeSessionId / thread.codexSessionId から拾って渡す想定。
   * 値が無効・期限切れだった場合 CLI 側がエラーを返すので、上位で再起動を判断する。
   */
  resumeCliSessionId?: string | null;
  /**
   * Shift+Tab で切替されるパーミッションモード。
   * "acceptEdits"（既定）= 自動編集 / "plan" = 読み取り・分析のみ。
   */
  permissionMode?: "acceptEdits" | "plan";
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
      resume_cli_session_id: params.resumeCliSessionId ?? null,
      permission_mode: params.permissionMode ?? "acceptEdits",
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
  | {
      /**
       * CLI（Claude / Codex）が割り当てた本物のセッションID。
       * フロント側で thread.claudeSessionId / thread.codexSessionId に保存し、
       * 将来 `--resume` / `exec resume` で再起動後の継続会話に使う。
       */
      kind: "cli_session_id";
      session_id: string;
      cli_session_id: string;
    }
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
  category: string | null;
  author: string | null;
  /** 説明ページ（plugin.json の homepage / repository）。無ければ null。 */
  homepage: string | null;
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

export async function listCodexMcp(): Promise<AddonItem[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<AddonItem[]>("list_codex_mcp");
}

export async function addCodexMcp(req: McpAddRequest): Promise<string> {
  if (!isTauri()) throw new Error("Codex MCP 追加は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("add_codex_mcp", { req });
}

export async function removeCodexMcp(name: string): Promise<string> {
  if (!isTauri()) throw new Error("Codex MCP 削除は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("remove_codex_mcp", { name });
}

export async function toggleCodexMcp(
  name: string,
  enabled: boolean,
): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("toggle_codex_mcp", { name, enabled });
}

/**
 * ~/.claude/plugins/marketplaces/ 配下の **全プラグイン** を返す。
 * marketplace.json があれば richer メタデータ（category/author/tags）込で。
 */
export async function listClaudeMarketplaceCatalog(): Promise<AddonItem[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<AddonItem[]>("list_claude_marketplace_catalog");
}

/**
 * ~/.codex/.tmp/bundled-marketplaces/ と ~/.codex/plugins/marketplaces/ の全プラグイン。
 */
export async function listCodexMarketplaceCatalog(): Promise<AddonItem[]> {
  if (!isTauri()) return [];
  const invoke = await loadInvoke();
  return invoke<AddonItem[]>("list_codex_marketplace_catalog");
}

/**
 * GitHub ユーザー/組織のアバターを data URL で取得。失敗時は null。
 * Tauri 側で 7 日キャッシュ（`~/.claude/plugins/cache/avatars/`）を持つ。
 */
export async function fetchGithubAvatar(
  user: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  const invoke = await loadInvoke();
  return invoke<string | null>("fetch_github_avatar", { user });
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
  /** http/sse 用の HTTP ヘッダ。UNI製品MCP一括接続で Bearer 認証に使う。 */
  headers?: Record<string, string> | null;
}

/**
 * graphify ナレッジグラフを指定ワークスペースで更新する（アイデア6）。
 * AI が write/edit したらフロントが debounce して呼んでくる。
 */
export async function graphifyUpdate(workspace: string): Promise<string> {
  if (!isTauri()) throw new Error("graphify 更新は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("graphify_update", { workspace });
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

/** Codex プラグインを marketplace からインストール（`codex plugin add <id>`）。 */
export async function installCodexPlugin(id: string): Promise<string> {
  if (!isTauri()) throw new Error("プラグイン追加は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("install_codex_plugin", { id });
}

/** Codex プラグインを削除（`codex plugin remove <id>`）。 */
export async function uninstallCodexPlugin(id: string): Promise<string> {
  if (!isTauri()) throw new Error("プラグイン削除は Tauri 環境のみ対応");
  const invoke = await loadInvoke();
  return invoke<string>("uninstall_codex_plugin", { id });
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

// ---------- UNIHUB リモート受付（UNIPILOT P3-M3） ----------

export interface RemoteExecResult {
  ok: boolean;
  /** claude -p の標準出力（失敗時は日本語のエラーメッセージ） */
  output: string;
  /** タイムアウト or トグルOFFで打ち切った場合 true */
  killed: boolean;
  /** 開発モード（許可フォルダ配下・acceptEdits）で実行した場合 true */
  dev_mode: boolean;
}

/** UNIHUB から届いたジョブを `claude -p` の一発実行で処理する。 */
export async function remoteExecClaude(args: {
  jobId: string;
  prompt: string;
  cwd?: string | null;
  timeoutSecs?: number;
  /** 開発モード（P3-M6）: 編集・ビルドを許可するフォルダ。cwd がこの配下なら acceptEdits で実行 */
  devFolders?: string[];
}): Promise<RemoteExecResult> {
  if (!isTauri()) {
    throw new Error("リモート受付は Tauri アプリ起動時のみ利用できます");
  }
  const invoke = await loadInvoke();
  return invoke<RemoteExecResult>("remote_exec_claude", {
    jobId: args.jobId,
    prompt: args.prompt,
    cwd: args.cwd ?? null,
    timeoutSecs: args.timeoutSecs ?? null,
    devFolders: args.devFolders ?? [],
  });
}

/** 実行中のリモートジョブを全て kill（トグルOFF＝緊急停止用）。 */
export async function remoteExecKillAll(): Promise<void> {
  if (!isTauri()) return;
  const invoke = await loadInvoke();
  await invoke("remote_exec_kill_all");
}
