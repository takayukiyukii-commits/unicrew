"use client";

import { isTauri } from "./tauri";

export interface OtelStatus {
  active: boolean;
  endpoint: string | null;
  note: string;
}

export async function observabilityStatus(): Promise<OtelStatus> {
  if (!isTauri()) {
    return {
      active: false,
      endpoint: null,
      note: "ブラウザ開発モードでは取得できません。",
    };
  }
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<OtelStatus>("observability_status");
}
