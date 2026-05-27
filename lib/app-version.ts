"use client";

import { useEffect, useState } from "react";

/**
 * アプリの実バージョン（tauri.conf.json の version）を返す共有ヘルパー。
 *
 * これまで各所に "0.1.0" / "0.2.1" 等がハードコードされていて実態と乖離し、
 * 「どのビルドが入っているか」をアプリ内で確認できなかった。
 * Tauri の getVersion() を一度だけ取得してキャッシュし、全表示で共有する。
 */
let cached: string | null = null;
let inflight: Promise<string> | null = null;

export async function getAppVersion(): Promise<string> {
  if (cached !== null) return cached;
  if (!inflight) {
    inflight = (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        cached = await getVersion();
      } catch {
        cached = ""; // 非 Tauri（ブラウザ）等
      }
      return cached;
    })();
  }
  return inflight;
}

/** React 用フック。初回は空文字、取得後に実バージョンへ更新される。 */
export function useAppVersion(): string {
  const [v, setV] = useState<string>(cached ?? "");
  useEffect(() => {
    let alive = true;
    void getAppVersion().then((ver) => {
      if (alive) setV(ver);
    });
    return () => {
      alive = false;
    };
  }, []);
  return v;
}
