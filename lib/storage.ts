"use client";

import { normalizeModelId, type AppSettings, type Thread } from "./types";

const THREADS_KEY = "unicrew.threads.v2";
/** 0.6.3 が残した「ファイルへ移した会話」の印（id:中身の印）。読むだけ */
const MIGRATED_KEY = "unicrew.threads.migratedIds.v1";

/** 0.6.3 と同じ作り方の「中身の印」。 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 0.6.3 で「ファイルへ移した」と記録されている古い保存か。移したあとに消した会話を、残っていた古い保存から戻さないために使う。 */
function migratedBefore(entry: Thread, done: Set<string>): boolean {
  if (done.size === 0) return false;
  try {
    return done.has(`${entry.id}:${shortHash(JSON.stringify({ ...entry, model: normalizeModelId(entry.model) }))}`);
  } catch {
    return false;
  }
}
const SETTINGS_KEY = "unicrew.settings.v2";
const LAST_WORKSPACE_KEY = "unicrew.lastWorkspace.v1";

// ---------- last workspace ----------
// 会社がまだないときのターミナルと、フォルダ選択の初期位置に使う。

export function loadLastWorkspace(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function saveLastWorkspace(path: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (path) localStorage.setItem(LAST_WORKSPACE_KEY, path);
    else localStorage.removeItem(LAST_WORKSPACE_KEY);
  } catch {
    /* noop */
  }
}

// ---------- 過去の会話：読み込みと、確認後の削除だけ ----------

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
let invokeImpl: Invoke | null = null;
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeImpl) invokeImpl = (await import("@tauri-apps/api/core")).invoke as Invoke;
  return invokeImpl<T>(command, args);
}

export interface LoadThreadsResult {
  threads: Thread[];
  broken: string[];
  exitErrors: Array<{ id: string; message: string }>;
}
interface Origin { fileId?: string; legacy?: string[] }
const origins = new Map<string, Origin>();
let loadPromise: Promise<LoadThreadsResult> | null = null;

function isThread(value: unknown): value is Thread {
  if (!value || typeof value !== "object") return false;
  const thread = value as Thread;
  return typeof thread.id === "string" && typeof thread.title === "string" && Array.isArray(thread.messages)
    && thread.messages.every((message) => message && typeof message.id === "string" && typeof message.content === "string");
}

/** ファイルと古い保存をその場で読む。移行・会話の新規保存・書き戻しはしない。 */
export function loadThreadsAsync(isTauriEnv: boolean): Promise<LoadThreadsResult> {
  if (!loadPromise) loadPromise = doLoad(isTauriEnv).catch((error) => { loadPromise = null; throw error; });
  return loadPromise;
}

async function doLoad(isTauriEnv: boolean): Promise<LoadThreadsResult> {
  const loaded = isTauriEnv ? await invoke<{ threads: string[]; broken: string[]; exit_errors?: Array<{ id: string; message: string }> }>("threads_load_all")
    : { threads: [], broken: [], exit_errors: [] };
  const threads = new Map<string, Thread>();
  const broken = [...loaded.broken];
  origins.clear();
  for (const json of loaded.threads) {
    try {
      const thread: unknown = JSON.parse(json);
      if (!isThread(thread)) throw new Error();
      threads.set(thread.id, thread);
      origins.set(thread.id, { fileId: thread.id });
    } catch { broken.push("JSON"); }
  }
  if (typeof window !== "undefined") {
    const raw = localStorage.getItem(THREADS_KEY);
    if (raw) {
      try {
        const legacy: unknown = JSON.parse(raw);
        if (!Array.isArray(legacy)) throw new Error();
        let done = new Set<string>();
        try { done = new Set(JSON.parse(localStorage.getItem(MIGRATED_KEY) ?? "[]") as string[]); } catch { /* 印が読めなければ、全部見せる */ }
        for (const entry of legacy) {
          if (!isThread(entry)) { broken.push(THREADS_KEY); continue; }
          // 0.6.3 がファイルへ移し終えた会話で、いまファイルに無い物＝そのあと利用者が消した会話。古い保存から戻さない
          if (!threads.has(entry.id) && migratedBefore(entry, done)) continue;
          const json = JSON.stringify(entry);
          const existing = threads.get(entry.id);
          if (existing && JSON.stringify(existing) === json) {
            const origin = origins.get(entry.id)!;
            origin.legacy = [...(origin.legacy ?? []), json];
            continue;
          }
          // 同じ ID に異なる記録があれば両方を見せる。表示上の ID だけで区別し、元データには触れない。
          let id = entry.id;
          while (threads.has(id)) id += "-legacy";
          threads.set(id, id === entry.id ? entry : { ...entry, id });
          origins.set(id, { legacy: [json] });
        }
      } catch { broken.push(THREADS_KEY); }
    }
  }
  return { threads: [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt), broken, exitErrors: loaded.exit_errors ?? [] };
}

/** 確認された会話だけ消す。別の会話や旧作業フォルダ・チェックポイントには触れない。 */
export async function deletePastThread(id: string): Promise<void> {
  const origin = origins.get(id);
  if (!origin) throw new Error("削除する会話の保存先を確認できませんでした");
  if (origin.fileId) {
    await invoke("thread_delete", { id: origin.fileId });
    // Rust の削除は順番待ちに入るだけなので、書き切りと再読込で結果を確かめる。
    await invoke("threads_flush");
    const result = await invoke<{ threads: string[]; broken: string[] }>("threads_load_all");
    if (result.broken.some((name) => name === `${origin.fileId}.json`) || result.threads.some((json) => {
      try { return (JSON.parse(json) as { id?: string }).id === origin.fileId; } catch { return true; }
    })) throw new Error("会話を削除できませんでした");
  }
  if (origin.legacy?.length) {
    const raw = localStorage.getItem(THREADS_KEY);
    if (raw) {
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries)) throw new Error("古い会話の保存を読み取れませんでした");
      // 読んだ後に別の画面が変更した内容は消さない。
      const next = entries.filter((entry) => !origin.legacy!.includes(JSON.stringify(entry)));
      // 読んだあとに中身が変わっていて消せなかったら、消えたことにしない（次に開くと、また一覧に出るため）
      if (next.length === entries.length && !origin.fileId) throw new Error("この会話は、読み込んだあとに内容が変わっていたため消していません。アプリを開き直して、もう一度確かめてから消してください");
      if (next.length !== entries.length) localStorage.setItem(THREADS_KEY, JSON.stringify(next));
    }
  }
  origins.delete(id);
  if (loadPromise) loadPromise = loadPromise.then((result) => ({ ...result, threads: result.threads.filter((thread) => thread.id !== id) }));
}

/** テストでは利用者の保存先へ接続しない。 */
export function __resetThreadStoreForTest(fakeInvoke: Invoke | null) {
  invokeImpl = fakeInvoke;
  loadPromise = null;
  origins.clear();
}

// ---------- settings ----------

const DEFAULTS: AppSettings = {
  defaultCharacterId: "tmpl-claude-normal",
  authMode: "subscription",
  showActivity: false,
  advancedMode: false,
  beginnerMode: true,
};

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const merged = {
      ...DEFAULTS,
      ...(JSON.parse(raw) as Partial<AppSettings>),
    };
    return merged;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(settings: AppSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
