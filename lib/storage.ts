"use client";

import { nanoid } from "nanoid";
import type { AppSettings, Message, Thread } from "./types";
import { DEFAULT_CHARACTER_ID, getCharacter } from "./characters";

const THREADS_KEY = "unicrew.threads.v2";
const SETTINGS_KEY = "unicrew.settings.v2";

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
  showActivity: true,
  advancedMode: false,
  beginnerMode: true,
};

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(settings: AppSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
