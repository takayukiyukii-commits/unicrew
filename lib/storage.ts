"use client";

import { nanoid } from "nanoid";
import type { AppSettings, Message, Thread } from "./types";
import { normalizeModelId } from "./types";
import { DEFAULT_CHARACTER_ID, getCharacter } from "./characters";

const THREADS_KEY = "unicrew.threads.v2";
const SETTINGS_KEY = "unicrew.settings.v2";
const LAST_WORKSPACE_KEY = "unicrew.lastWorkspace.v1";

// ---------- last workspace ----------
// 直近に開いたワークスペースを記憶し、新規スレッド作成時の既定値に使う。
// 既存スレッドの workspace は thread 自身に保存されるので、ここは「次に開く時の初期値」専用。

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

// ---------- threads ----------

export function loadThreads(): Thread[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    if (!raw) return [];
    // 旧版の版数つきモデル名（claude-opus-4-7 等）を別名へ直す。types.ts の normalizeModelId 参照
    return (JSON.parse(raw) as Thread[]).map((t) => ({
      ...t,
      model: normalizeModelId(t.model),
    }));
  } catch {
    return [];
  }
}

/**
 * 保存に失敗したときの通知先（app 側が1回だけ差し込む）。
 * title があるのはファイル保存でその会話の保存に失敗したとき。
 */
let onSaveError: ((message: string, title?: string) => void) | null = null;
export function setThreadsSaveErrorHandler(fn: ((message: string, title?: string) => void) | null) {
  onSaveError = fn;
}
let lastSaveErrorAt = 0;

// ---------- 会話のファイル保存（Tauri）----------
// 2026-10-13：localStorage は上限（数MB）があり、使い続けると誰でもいつか保存できなくなる。
// 配布アプリ（Tauri）では、会話ごとにアプリ専用フォルダの threads/<id>.json へ保存する
// （src-tauri/src/thread_store.rs）。ブラウザ（開発・テスト）では従来どおり localStorage。
//
// 画面側は「変わった会話をすぐ Rust の順番待ちに渡す」だけで、書き残しを持たない。
// 書き込みと削除の順番・最新だけを書く・終了時の書き切りは Rust 側（thread_store.rs の Queue）。
// 失敗は Rust からイベント（unicrew://thread-save-error）で届き、次の変更でもう一度渡す。

/** ファイル保存が使える状態か（読み込みが成功してから true） */
let fileMode = false;
/** Rust に渡した最後の会話オブジェクト（React は変わっていない会話を同じ物のまま渡すので、同一なら渡さない） */
const savedObj = new Map<string, Thread>();
/**
 * ディスクにあるかもしれない会話 id（読み込んだ・書き込みを渡した）。削除の対象はここから決める。
 * savedObj と分ける：保存に失敗して savedObj から外れても、前回までのファイルは残っているため
 * （2026-10-13 監査：保存に失敗した会話を消しても削除が送られず、再起動で復活した）
 */
const known = new Set<string>();
/** 削除に失敗した id（次の保存でもう一度送る） */
const pendingDeletes = new Set<string>();
/** 移行で取り込み済みの id（localStorage が残っていても二度取り込まない。消した会話の復活を防ぐ） */
const MIGRATED_KEY = "unicrew.threads.migratedIds.v1";
/** 失敗の案内に出す会話名 */
const titles = new Map<string, string>();
/** 起動時の読み込み（開発時の二重実行でも1回だけ＝2026-10-13 監査） */
let loadPromise: Promise<LoadThreadsResult> | null = null;

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = (event: string, cb: (e: { payload: unknown }) => void) => Promise<unknown>;
let invokeImpl: Invoke | null = null;
let listenImpl: Listen | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeImpl) invokeImpl = (await import("@tauri-apps/api/core")).invoke as Invoke;
  return invokeImpl<T>(cmd, args);
}
async function listen(event: string, cb: (e: { payload: unknown }) => void) {
  if (!listenImpl) listenImpl = (await import("@tauri-apps/api/event")).listen as unknown as Listen;
  return listenImpl(event, cb);
}

export interface LoadThreadsResult {
  threads: Thread[];
  /** localStorage からファイルへ移した会話の数（今回の起動で移したときだけ） */
  migrated: number;
  /** 壊れていて読めなかったファイル名 */
  broken: string[];
  /** 前回の終了の間際に保存できなかった会話（Rust が記録して、今回の起動で渡す） */
  exitErrors: Array<{ id: string; message: string }>;
}

/** 内容から短い印を作る（（復元）の id がぶつからないように・FNV-1a 32bit） */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function readMigratedIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(MIGRATED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function normalizeThread(t: Thread): Thread {
  return { ...t, model: normalizeModelId(t.model) };
}

/**
 * 会話を読み込む（何度呼んでも読み込みは1回）。配布アプリではファイルから読み、
 * localStorage に古い保存が残っていればファイルへ移す。
 */
export function loadThreadsAsync(isTauriEnv: boolean): Promise<LoadThreadsResult> {
  if (!loadPromise) loadPromise = doLoad(isTauriEnv);
  return loadPromise;
}

/**
 * 移行は「何も上書きしない」（2026-10-13 監査）：
 *  - ファイルに無い会話 → ファイルへ書く
 *  - ファイルと同じ内容 → 何もしない
 *  - ファイルと内容が違う → ファイルはそのまま、localStorage 側を「（復元）」付きの別の会話として足す
 *    （更新日時は保存内容の世代ではないので、どちらが新しいかを断定しない）
 * 全部書けて、元の保存の控え（threads-backup/）も書けて、しかも控えを取ってから localStorage が
 * 変わっていないときだけ localStorage を消す。1つでも欠けたら残す（次回また照合する）。
 */
async function doLoad(isTauriEnv: boolean): Promise<LoadThreadsResult> {
  if (!isTauriEnv) return { threads: loadThreads(), migrated: 0, broken: [], exitErrors: [] };
  const loaded = await invoke<{
    threads: string[];
    broken: string[];
    exit_errors?: Array<{ id: string; message: string }>;
  }>("threads_load_all");
  const byId = new Map<string, Thread>();
  const saved = new Set<string>(); // ファイルにあると確かめられた会話
  const broken = [...loaded.broken];
  for (const text of loaded.threads) {
    try {
      const t = normalizeThread(JSON.parse(text) as Thread);
      if (t?.id) {
        byId.set(t.id, t);
        saved.add(t.id);
      }
    } catch {
      broken.push("(JSON)");
    }
  }
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(THREADS_KEY);
  } catch {
    raw = null;
  }
  let migrated = 0;
  let migrationOk = true;
  if (raw) {
    let legacy: Thread[] = [];
    try {
      legacy = (JSON.parse(raw) as Thread[]).map(normalizeThread);
    } catch {
      migrationOk = false; // 読めない保存は消さない
    }
    // 取り込み済みの記録は「id:中身の印」。中身が変わった会話（別の起動が代替で localStorage に
    // 保存した等）は取り込み済みとみなさない（2026-10-13 監査：id だけだと新しい内容を見落とした）
    const done = readMigratedIds();
    for (const t of legacy) {
      if (!t?.id) continue;
      const legacyJson = JSON.stringify(t);
      const doneKey = `${t.id}:${shortHash(legacyJson)}`;
      // 前回までに同じ中身を取り込み済み（その後に消した会話を、残っていた localStorage から復活させない）
      if (done.has(doneKey)) continue;
      const have = byId.get(t.id);
      let target = t;
      if (have) {
        if (JSON.stringify(have) === legacyJson) {
          done.add(doneKey);
          continue;
        }
        // 内容から作る id（同じ内容なら同じ id＝増えない／別の内容とはぶつからない）
        let restoredId = `${t.id}-r${shortHash(legacyJson)}`;
        const prior = byId.get(restoredId);
        if (prior && JSON.stringify({ ...prior, id: t.id, title: t.title }) === legacyJson) {
          done.add(doneKey);
          continue;
        }
        if (prior) restoredId = `${restoredId}-${Date.now().toString(36)}`;
        target = { ...t, id: restoredId, title: `${t.title}（復元）` };
      }
      byId.set(target.id, target); // 書けなくても画面には出す（次の変更でもう一度書く）
      try {
        await invoke("thread_write_now", { id: target.id, json: JSON.stringify(target) });
        saved.add(target.id);
        done.add(doneKey);
        migrated++;
      } catch {
        migrationOk = false;
      }
    }
    try {
      localStorage.setItem(MIGRATED_KEY, JSON.stringify([...done]));
    } catch {
      /* 記録できなくても、次回は内容で照合する（同じ内容は増えない） */
    }
    if (migrationOk) {
      try {
        await invoke("threads_backup_legacy", { json: raw });
        // 控えを取ってから localStorage が変わっていなければ消す（変わっていたら次回また照合）
        if (localStorage.getItem(THREADS_KEY) === raw) {
          localStorage.removeItem(THREADS_KEY);
          localStorage.removeItem(MIGRATED_KEY);
        }
      } catch {
        /* 控えを書けない・消せないときは localStorage を残す */
      }
    }
  }
  const threads = [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  savedObj.clear();
  titles.clear();
  known.clear();
  pendingDeletes.clear();
  for (const t of threads) {
    titles.set(t.id, t.title);
    if (saved.has(t.id)) {
      savedObj.set(t.id, t); // 書けていない会話は次の保存で渡す
      known.add(t.id);
    }
  }
  await listen(SAVE_ERROR_EVENT, (e) => {
    const p = e.payload as { id?: string; message?: string; op?: string };
    if (!p?.id) return;
    if (p.op === "delete") pendingDeletes.add(p.id); // 次の保存でもう一度消す
    else savedObj.delete(p.id); // 次の変更でもう一度渡す（known には残す＝消すときは消す）
    reportSaveError(p.message ?? "", titles.get(p.id) ?? p.id);
  });
  fileMode = true;
  return { threads, migrated, broken, exitErrors: loaded.exit_errors ?? [] };
}

const SAVE_ERROR_EVENT = "unicrew://thread-save-error";

function reportSaveError(message: string, title?: string) {
  const now = Date.now();
  if (onSaveError && now - lastSaveErrorAt > 30_000) {
    lastSaveErrorAt = now;
    onSaveError(message, title);
  }
}

function saveThreadFiles(threads: Thread[]) {
  const seen = new Set<string>();
  for (const t of threads) {
    seen.add(t.id);
    titles.set(t.id, t.title);
    pendingDeletes.delete(t.id); // 一覧に戻った会話は消さない
    if (savedObj.get(t.id) === t) continue;
    savedObj.set(t.id, t);
    known.add(t.id);
    invoke("thread_write", { id: t.id, json: JSON.stringify(t) }).catch((e) => {
      savedObj.delete(t.id);
      reportSaveError(e instanceof Error ? e.message : String(e), t.title);
    });
  }
  const toDelete = new Set<string>(pendingDeletes);
  for (const id of known) if (!seen.has(id)) toDelete.add(id);
  for (const id of toDelete) {
    known.delete(id);
    savedObj.delete(id);
    pendingDeletes.delete(id);
    invoke("thread_delete", { id }).catch((e) => {
      pendingDeletes.add(id);
      reportSaveError(e instanceof Error ? e.message : String(e), titles.get(id) ?? id);
    });
  }
}

/** 読み込んだ会話に、読み込み中に画面で作られた会話（id が重ならないもの）を足す */
export function mergeLoadedThreads(loaded: Thread[], current: Thread[]): Thread[] {
  const ids = new Set(loaded.map((t) => t.id));
  const extra = current.filter((t) => !ids.has(t.id));
  return extra.length > 0 ? [...extra, ...loaded] : loaded;
}

/** テスト用：ファイル保存の状態を初期化する */
export function __resetThreadStoreForTest(fakeInvoke: Invoke | null, fakeListen: Listen | null = null) {
  fileMode = false;
  savedObj.clear();
  titles.clear();
  known.clear();
  pendingDeletes.clear();
  loadPromise = null;
  invokeImpl = fakeInvoke;
  listenImpl = fakeListen;
  lastSaveErrorAt = 0;
}

export function saveThreads(threads: Thread[]) {
  if (typeof window === "undefined") return;
  if (fileMode) {
    saveThreadFiles(threads);
    return;
  }
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
    // localStorage に新しく書いた内容は、次の起動で改めて照合させる（取り込み済みの記録を無効にする）
    localStorage.removeItem(MIGRATED_KEY);
  } catch (e) {
    // 🚨 2026-09-04 監査（横断の回）: v0.4.0 で送信のたびに Message.checkpoint と
    //    Thread.turnBase が増える。quota を超えると setItem が投げ、保存効果から例外が漏れて
    //    「次に起動したら会話も復元点も巻き戻っていた」に見える。握りつぶさず知らせる。
    reportSaveError(e instanceof Error ? e.message : String(e));
  }
}

export function createThread(opts: {
  characterId?: string;
  splitCharacterIds?: { claude: string; codex: string };
  workspace?: string | null;
  splitMode?: boolean;
  conferenceMode?: boolean;
  conferenceMaxRounds?: number;
}): Thread {
  const charId = opts.characterId || DEFAULT_CHARACTER_ID;
  const character = getCharacter(charId);
  return {
    id: nanoid(10),
    title: "新しい会話",
    characterId: charId,
    splitCharacterIds: opts.splitCharacterIds,
    model: normalizeModelId(character?.defaultModel),
    workspace: opts.workspace ?? null,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    splitMode: opts.splitMode ?? false,
    conferenceMode: opts.conferenceMode ?? false,
    conferenceMaxRounds: opts.conferenceMaxRounds ?? 3,
  };
}

export function appendMessage(thread: Thread, message: Message): Thread {
  const updated: Thread = {
    ...thread,
    messages: [...thread.messages, message],
    updatedAt: Date.now(),
  };
  if (!thread.titleEdited && thread.title === "新しい会話" && message.role === "user") {
    updated.title = makeThreadTitleFromPrompt(message.content);
  }
  return updated;
}

export function makeThreadTitleFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/\[添付画像:[^\]]+\]/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "画像について相談";

  const firstSentence =
    cleaned.match(/^(.{1,40}?[。！？!?]|.{1,40})/)?.[1]?.trim() ?? cleaned;
  return firstSentence.length > 24
    ? `${firstSentence.slice(0, 24)}…`
    : firstSentence;
}

// ---------- settings ----------

const DEFAULTS: AppSettings = {
  defaultCharacterId: DEFAULT_CHARACTER_ID,
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
    // 旧デフォルト（秘書）のまま明示変更されていないユーザーは新デフォルト（Claude（normal））に揃える。
    // 明示的に tmpl-secretary を選んだ人もここで上書きされるが、再選択できるので影響は許容範囲。
    if (merged.defaultCharacterId === "tmpl-secretary") {
      merged.defaultCharacterId = DEFAULT_CHARACTER_ID;
    }
    return merged;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(settings: AppSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
