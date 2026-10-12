"use client";

import { useEffect, useState } from "react";
import type { Options } from "react-markdown";

type RemarkPlugins = NonNullable<Options["remarkPlugins"]>;

// remark-gfm（中の mdast-util-gfm-autolink-literal）は正規表現の後読み `(?<=…)` を使う。
// Safari 16.4 より前の WebKit（古い macOS の WKWebView）はこれを「構文エラー」として扱うため、
// 起動時に読む JS に入っているとファイルごと読み込みに失敗し、画面は出てもボタンが一切効かなくなる
// （2026-10-13 macOS 12.7.6 で実際に発生）。
// → remark-gfm は別ファイルに分けて後から読み込む。後読みが使えない環境では GFM なしで表示する。
let cached: RemarkPlugins | null = null;
let pending: Promise<RemarkPlugins> | null = null;

export function supportsRegexLookbehind(): boolean {
  try {
    new RegExp("(?<=a)b");
    return true;
  } catch {
    return false;
  }
}

export function loadRemarkPlugins(): Promise<RemarkPlugins> {
  if (cached) return Promise.resolve(cached);
  if (!supportsRegexLookbehind()) {
    // 非対応は環境の性質なので確定してよい（以後も GFM なし）
    cached = [];
    return Promise.resolve(cached);
  }
  if (!pending) {
    pending = import("remark-gfm")
      .then((m) => (cached = [m.default]))
      .catch(() => {
        // 一時的な読込失敗は確定させない（次に表示するときにもう一度読む）
        pending = null;
        return [] as RemarkPlugins;
      });
  }
  return pending;
}

export function useRemarkPlugins(): RemarkPlugins {
  const [plugins, setPlugins] = useState<RemarkPlugins>(() => cached ?? []);
  useEffect(() => {
    if (cached) {
      setPlugins(cached);
      return;
    }
    let alive = true;
    void loadRemarkPlugins().then((p) => {
      if (alive) setPlugins(p);
    });
    return () => {
      alive = false;
    };
  }, []);
  return plugins;
}
