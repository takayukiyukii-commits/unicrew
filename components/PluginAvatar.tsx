"use client";

import { useEffect, useRef, useState } from "react";
import { fetchGithubAvatar } from "@/lib/tauri";
import { resolveGithubUserForItem } from "@/lib/marketplace-owners";

interface Props {
  name: string;
  category: string | null | undefined;
  namespace: string | null;
  author: string | null;
  size?: number;
}

// 名前→アクセント色（モノグラム fallback 用）の決定的ハッシュ
const PALETTE = [
  { bg: "#dbeafe", fg: "#1d4ed8" }, // blue
  { bg: "#dcfce7", fg: "#15803d" }, // green
  { bg: "#fef3c7", fg: "#b45309" }, // amber
  { bg: "#fee2e2", fg: "#b91c1c" }, // rose
  { bg: "#ede9fe", fg: "#6d28d9" }, // violet
  { bg: "#cffafe", fg: "#0e7490" }, // cyan
  { bg: "#fce7f3", fg: "#be185d" }, // pink
  { bg: "#e0e7ff", fg: "#3730a3" }, // indigo
  { bg: "#f1f5f9", fg: "#475569" }, // slate
  { bg: "#fae8ff", fg: "#a21caf" }, // fuchsia
];

function hashColor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function monogramOf(name: string): string {
  const cleaned = name.replace(/^@?([a-zA-Z0-9_-]+).*$/, "$1");
  const parts = cleaned.split(/[-_\s]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

// アバター取得を抑制するためのプロセス内キャッシュ（同じ user に重複 fetch しない）
const avatarCache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

async function getCachedAvatar(user: string): Promise<string | null> {
  if (avatarCache.has(user)) return avatarCache.get(user)!;
  if (inFlight.has(user)) return inFlight.get(user)!;
  const p = (async () => {
    try {
      const url = await fetchGithubAvatar(user);
      avatarCache.set(user, url);
      return url;
    } catch {
      avatarCache.set(user, null);
      return null;
    } finally {
      inFlight.delete(user);
    }
  })();
  inFlight.set(user, p);
  return p;
}

export function PluginAvatar({
  name,
  namespace,
  author,
  size = 32,
}: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const user = resolveGithubUserForItem({ namespace, author });
    if (!user) return;
    void getCachedAvatar(user).then((url) => {
      if (mounted.current) setSrc(url);
    });
    return () => {
      mounted.current = false;
    };
  }, [namespace, author]);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="rounded-lg shrink-0 object-cover border border-[var(--color-border)] bg-white"
        style={{ width: size, height: size }}
        loading="lazy"
      />
    );
  }

  const { bg, fg } = hashColor(`${namespace ?? ""}:${name}`);
  const mono = monogramOf(name);
  return (
    <div
      className="rounded-lg shrink-0 flex items-center justify-center font-bold tracking-tight"
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        color: fg,
        fontSize: Math.round(size * 0.42),
      }}
      aria-hidden
    >
      {mono}
    </div>
  );
}
