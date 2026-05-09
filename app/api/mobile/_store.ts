/**
 * Mobile Bridge のサーバサイドメモリストア（API Route 共有）。
 *
 * Next.js dev モードでは module は singleton として保持されるので、
 * このファイル内の `state` は同一プロセス内の全 API Route から共有される。
 * Tauri 静的ビルド（output: "export"）では API Route 自体が無効なため
 * このストアも使われない。
 */

import type {
  MobileInboxItem,
  MobileStateSnapshot,
} from "@/lib/mobile-bridge";

interface BridgeStore {
  /** 認証トークン。React 起動時に POST /api/mobile/auth でセットされる */
  token: string | null;
  /** スマホ → PC のキュー */
  inbox: MobileInboxItem[];
  /** PC → スマホに見せる最新スナップショット */
  snapshot: MobileStateSnapshot | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __unicrew_mobile_store__: BridgeStore | undefined;
}

function getStore(): BridgeStore {
  if (!globalThis.__unicrew_mobile_store__) {
    globalThis.__unicrew_mobile_store__ = {
      token: null,
      inbox: [],
      snapshot: null,
    };
  }
  return globalThis.__unicrew_mobile_store__;
}

export function setToken(token: string | null) {
  getStore().token = token;
}

export function checkToken(provided: string | null): boolean {
  const t = getStore().token;
  if (!t) return false;
  return provided === t;
}

export function pushInbox(item: MobileInboxItem) {
  getStore().inbox.push(item);
}

export function takeInbox(): MobileInboxItem[] {
  const s = getStore();
  const list = s.inbox;
  s.inbox = [];
  return list;
}

export function setSnapshot(snap: MobileStateSnapshot) {
  getStore().snapshot = snap;
}

export function getSnapshot(): MobileStateSnapshot | null {
  return getStore().snapshot;
}
