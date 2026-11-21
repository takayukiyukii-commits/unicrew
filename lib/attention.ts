/**
 * 「作業が終わった」を人に知らせる（2026-10-07 追加）。
 *
 * - OS の通知を出す（設定 notifyOnDone、既定 ON）
 * - UNICREW を見ていない間に終わった件数を、通知領域のアイコンとタスクバーの印に出す
 *   （窓を前に出した＝見た、で消える）
 * 実体は Rust 側の src-tauri/src/attention.rs。
 */
import { isTauri } from "./tauri";

let unread = 0;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!isTauri()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** いま利用者が UNICREW の画面を見ているか。 */
function isLooking(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** 通知に付けるボタン。押されると `attention:action` で { tag, action } が戻ってくる（action はボタンの id。通知の本文を押したときは空）。 */
export interface AttentionAsk {
  tag: string;
  actions: { id: string; label: string }[];
}

export interface AttentionAction {
  tag: string;
  action: string;
}

/** 通知のボタンが押された知らせを受け取る（Tauri のときだけ。ブラウザでは何もしない）。 */
export async function listenAttentionActions(onAction: (a: AttentionAction) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const ev = await import("@tauri-apps/api/event");
  return ev.listen<AttentionAction>("attention:action", (e) => {
    const p = e.payload;
    if (p && typeof p.tag === "string" && typeof p.action === "string") onAction(p);
  });
}

export async function reportWorkDone(
  opts: { title: string; body: string; notify: boolean; ask?: AttentionAsk },
): Promise<void> {
  try {
    if (opts.notify) {
      // ボタン付きの通知（いまは Windows だけ。ほかの OS は Rust 側でふつうの通知になる）
      if (opts.ask) await invoke("notify_with_actions", { title: opts.title, body: opts.body, tag: opts.ask.tag, actions: opts.ask.actions });
      else await invoke("notify_work_done", { title: opts.title, body: opts.body });
    }
    if (!isLooking()) {
      unread += 1;
      await invoke("set_unread_badge", { count: unread });
    }
  } catch (e) {
    // 知らせに失敗しても作業そのものは止めない
    console.warn("[attention] 通知に失敗", e);
  }
}

/** 見た（窓が前に来た）ので印を消す。 */
export async function clearUnread(): Promise<void> {
  if (unread === 0) return;
  unread = 0;
  try {
    await invoke("set_unread_badge", { count: 0 });
  } catch {
    /* noop */
  }
}

export async function applyTrayResident(enabled: boolean): Promise<void> {
  try {
    await invoke("set_tray_resident", { enabled });
  } catch {
    /* noop */
  }
}
