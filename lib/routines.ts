"use client";

import { nanoid } from "nanoid";

/**
 * アイデア14: scripted automation（ルーティーン/オートメーション）。
 *
 * 「毎朝9時にこの prompt 実行」をローカルで設定できる。
 * 最小実装として "daily"（指定時刻）のみサポート。
 * once / weekly / cron式 は将来拡張する余地として `type` フィールドで予約。
 *
 * 起動条件はフロントの setInterval（60秒ごと）でチェック：
 *   - 現在時刻が hour/minute と一致する分内に入っている
 *   - lastFiredDay が今日でない
 * を満たすルーティーンを発火する。
 */

export type RoutineScheduleType = "daily";

export interface RoutineSchedule {
  type: RoutineScheduleType;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** ISO日付（YYYY-MM-DD）。最後に発火した日。同日重複発火を防ぐ。 */
  lastFiredDay?: string;
}

export interface Routine {
  id: string;
  /** ボードに表示する短い名前 */
  label: string;
  /** どのスレッドで実行するか */
  threadId: string;
  /** 実行するプロンプト（ユーザー発言扱いで送信される） */
  prompt: string;
  schedule: RoutineSchedule;
  /** false なら一時停止（次回実行をスキップ） */
  enabled: boolean;
  createdAt: number;
}

const STORAGE_KEY = "unicrew.routines.v1";

export function loadRoutines(): Routine[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // 監査（ファイルタブR1）: 非配列や schedule 欠落の要素で管理画面・発火判定が
    // TypeError で落ちるのを防ぐ。要素スキーマ（id/threadId/prompt/enabled/schedule）を検証。
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is Routine => {
      if (!r || typeof r !== "object") return false;
      const o = r as Record<string, unknown>;
      const sc = o.schedule as Record<string, unknown> | undefined;
      return (
        typeof o.id === "string" &&
        typeof o.threadId === "string" &&
        typeof o.prompt === "string" &&
        typeof o.enabled === "boolean" &&
        !!sc &&
        typeof sc === "object" &&
        typeof sc.hour === "number" &&
        typeof sc.minute === "number"
      );
    });
  } catch {
    return [];
  }
}

export function saveRoutines(list: Routine[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function newRoutineId(): string {
  return "rt-" + nanoid(8);
}

export function todayStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 指定時刻にこのルーティーンが発火すべきかを判定する。
 * - enabled でない → false
 * - 今日既に発火済み（lastFiredDay === today）→ false
 * - 現在時刻が hour:minute 〜 hour:minute+1分 の間 → true
 *
 * 60秒間隔のpollingなのでぴったり0秒で実行されるとは限らないが、
 * 1分間に1回チェックすれば確実にその分内に発火する。
 */
export function shouldFire(routine: Routine, now: Date = new Date()): boolean {
  if (!routine.enabled) return false;
  const today = todayStamp(now);
  if (routine.schedule.lastFiredDay === today) return false;
  // hour/minute 一致 or 過ぎている（同日中で未発火なら発火する：起動時に過去時刻を回収する挙動）
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes =
    routine.schedule.hour * 60 + routine.schedule.minute;
  return nowMinutes >= targetMinutes;
}

/**
 * 監査（ファイルタブR3）: 新規作成時、当日の指定時刻を既に過ぎている場合に
 * セットする lastFiredDay を返す。shouldFire は「同日で未発火なら過去時刻を回収」
 * する仕様のため、これが無いと 18:00 に 09:00 のルーティーンを作った瞬間に発火する。
 * 未来時刻なら undefined（当日中に正常に発火させる）。
 */
export function initialLastFiredDay(
  hour: number,
  minute: number,
  now: Date = new Date(),
): string | undefined {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes = hour * 60 + minute;
  return nowMinutes >= targetMinutes ? todayStamp(now) : undefined;
}

export function markFired(
  routines: Routine[],
  id: string,
  when: Date = new Date(),
): Routine[] {
  const today = todayStamp(when);
  return routines.map((r) =>
    r.id === id
      ? { ...r, schedule: { ...r.schedule, lastFiredDay: today } }
      : r,
  );
}
