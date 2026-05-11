"use client";

import { nanoid } from "nanoid";
import type { AppSettings, Message, Thread } from "./types";
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
    return JSON.parse(raw) as Thread[];
  } catch {
    return [];
  }
}

export function saveThreads(threads: Thread[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
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
    model: character?.defaultModel || "claude-sonnet-4-6",
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
  if (thread.title === "新しい会話" && message.role === "user") {
    updated.title = message.content.slice(0, 30) || "新しい会話";
  }
  return updated;
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
