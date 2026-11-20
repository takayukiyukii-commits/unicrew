/**
 * 会社（Office）と、その「いま」（OfficeRun）の保存。
 *
 * 置き場所は localStorage。会社の名簿は小さく、「いま」は件数に上限がある（engine.ts）。
 * 🚨 保存が失敗しても画面は止めない（保存できなかったことだけ返す）。
 */
import type { Locale } from "../i18n";
import { emptyRun, reconcileRun } from "./engine";
import type { Office, OfficeRun } from "./types";

const OFFICES_KEY = "unicrew.offices.v1";
const ACTIVE_KEY = "unicrew.offices.active.v1";
const RUN_PREFIX = "unicrew.office.run.v1.";

function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isOffice(x: unknown): x is Office {
  if (!x || typeof x !== "object") return false;
  const o = x as Partial<Office>;
  return typeof o.id === "string" && typeof o.name === "string" && Array.isArray(o.staff) && Array.isArray(o.departments);
}

export function loadOffices(): Office[] {
  const list = read<unknown[]>(OFFICES_KEY);
  return Array.isArray(list) ? list.filter(isOffice) : [];
}

export function saveOffices(offices: Office[]): boolean {
  return write(OFFICES_KEY, offices);
}

export function loadActiveOfficeId(): string | null {
  const v = read<string>(ACTIVE_KEY);
  return typeof v === "string" ? v : null;
}

export function saveActiveOfficeId(id: string | null): void {
  if (id === null) {
    try {
      window.localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* 保存できなくても続ける */
    }
    return;
  }
  write(ACTIVE_KEY, id);
}

/** 開き直したときに読む。動いていた仕事は「止まっている」状態に直して返す。 */
export function loadRun(office: Office, locale: Locale = "ja"): OfficeRun {
  const saved = read<OfficeRun>(RUN_PREFIX + office.id);
  if (!saved || typeof saved !== "object" || saved.officeId !== office.id || !saved.staff) return emptyRun(office);
  const base = { ...emptyRun(office), ...saved };
  return reconcileRun(base, office, { afterRestart: true, locale });
}

export function saveRun(run: OfficeRun): boolean {
  // 書きかけの返事と道具の中身は保存しない（大きい・開き直したら使わない）
  const staff: OfficeRun["staff"] = {};
  for (const [id, s] of Object.entries(run.staff)) staff[id] = { ...s, draft: "", tools: {} };
  return write(RUN_PREFIX + run.officeId, { ...run, staff });
}

export function deleteRun(officeId: string): void {
  try {
    window.localStorage.removeItem(RUN_PREFIX + officeId);
  } catch {
    /* 消せなくても続ける */
  }
}
