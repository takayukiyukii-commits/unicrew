/**
 * 会社（Office）と、その「いま」（OfficeRun）の保存。
 *
 * 置き場所は localStorage。会社の名簿は小さく、「いま」は件数に上限がある（engine.ts）。
 * 🚨 保存が失敗しても画面は止めない（保存できなかったことを返し、画面が知らせる）。
 * 🚨 読めなかった保存は、消さずに `<キー>.broken` に残す（空の内容で上書きして、直す手がかりを失わないため）。
 */
import type { Locale } from "../i18n";
import { ASK_DETAIL_MAX } from "./ask-text";
import { emptyRun, emptyStaffRuntime, MAX_AUTO_LOG, reconcileRun } from "./engine";
import type { Office, OfficeRun } from "./types";

const OFFICES_KEY = "unicrew.offices.v1";
const ACTIVE_KEY = "unicrew.offices.active.v1";
const RUN_PREFIX = "unicrew.office.run.v1.";

/** 読めなかった保存（壊れた記録）を、消さずに別の名前で残した先。画面で知らせるために覚えておく。 */
const broken: string[] = [];
export function brokenStores(): string[] {
  return [...broken];
}

/**
 * 読む。保存が無ければ null。🚨 中身が壊れていて読めないときは、元の文字を別の名前で残してから null を返す
 * （このあと空の内容で上書きされても、直す手がかりが残るように）。
 */
function read<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    if (raw) keepBroken(key, raw);
    return null;
  }
}

/** 控えを書けなかった保存先。ここには上書きしない（元の文字を失わないため。画面は「保存できていない」と知らせる） */
const guarded = new Set<string>();

function keepBroken(key: string, raw: string): void {
  const backup = `${key}.broken`;
  try {
    // 前に残した控えは上書きしない（最初に壊れたときの中身がいちばん大事）
    if (window.localStorage.getItem(backup) === null) window.localStorage.setItem(backup, raw);
  } catch {
    guarded.add(key);
    return;
  }
  if (!broken.includes(backup)) broken.push(backup);
}

/** 試験用：覚えている控え・守っている保存先を忘れる。 */
export function __resetStoreForTest(): void {
  broken.length = 0;
  guarded.clear();
}

function write(key: string, value: unknown): boolean {
  if (typeof window === "undefined") return false;
  if (guarded.has(key)) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** 会社として使える形か（社員・部署の1人ずつまで見る。形の違う要素が混ざっていたら使わない）。 */
function isOffice(x: unknown): x is Office {
  if (!isRecord(x)) return false;
  const o = x as Partial<Office>;
  return typeof o.id === "string" && typeof o.name === "string" && Array.isArray(o.staff) && Array.isArray(o.departments)
    && o.staff.every((s) => isRecord(s) && typeof s.id === "string" && typeof s.name === "string" && typeof s.role === "string" && typeof s.provider === "string" && isRecord(s.look))
    && o.departments.every((d) => isRecord(d) && typeof d.id === "string" && typeof d.name === "string");
}

export function loadOffices(): Office[] {
  const list = read<unknown>(OFFICES_KEY);
  if (list === null) return [];
  if (!Array.isArray(list)) {
    // 読めるが会社の一覧の形ではない：これも元の文字を残す
    keepBroken(OFFICES_KEY, JSON.stringify(list));
    return [];
  }
  const good = list.filter(isOffice);
  // 形の違う会社が混ざっていたら、元の記録を残しておく（このあとの保存で、その会社は一覧から消えるため）
  if (good.length !== list.length) {
    try {
      keepBroken(OFFICES_KEY, JSON.stringify(list));
    } catch {
      /* 続ける */
    }
  }
  return good;
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

/** 回数として読めるものだけ使う（無い・変な値は 0）。 */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** 自動で通した操作の記録を読み戻す（形の合う物だけ・id が重なったら先の物だけ・上限の件数まで）。 */
function autoLogOf(v: unknown): NonNullable<OfficeRun["autoLog"]> {
  const out: NonNullable<OfficeRun["autoLog"]> = [];
  if (!Array.isArray(v)) return out;
  const seen = new Set<string>();
  for (const x of v) {
    if (out.length >= MAX_AUTO_LOG) break;
    if (!isRecord(x) || typeof x.id !== "string" || x.id === "" || seen.has(x.id)) continue;
    if (typeof x.text !== "string" || typeof x.staffId !== "string" || typeof x.at !== "number" || !Number.isFinite(x.at)) continue;
    seen.add(x.id);
    out.push({ id: x.id, staffId: x.staffId, at: x.at, text: x.text.slice(0, ASK_DETAIL_MAX + 400) });
  }
  return out;
}

/** 保存されていた「いま」を、欠けている所を既定の値で埋めて使える形にする。直せない形なら null。 */
export function repairRun(saved: unknown, office: Office): OfficeRun | null {
  if (!isRecord(saved) || saved.officeId !== office.id || !isRecord(saved.staff)) return null;
  const base = emptyRun(office);
  const s = saved as Partial<OfficeRun> & Record<string, unknown>;
  const staff: OfficeRun["staff"] = {};
  for (const [id, rt] of Object.entries(s.staff as Record<string, unknown>)) {
    if (!isRecord(rt)) continue;
    const merged = { ...base.staff[id] ?? emptyStaffRuntime(), ...(rt as object) } as OfficeRun["staff"][string];
    if (!["idle", "working", "waiting", "done"].includes(merged.status)) merged.status = "idle";
    if (!isRecord(merged.tools)) merged.tools = {};
    if (typeof merged.draft !== "string") merged.draft = "";
    staff[id] = merged;
  }
  const arr = <T,>(v: unknown, fallback: T[]): T[] => (Array.isArray(v) ? (v.filter((x) => isRecord(x)) as T[]) : fallback);
  const usage = isRecord(s.usage) ? { ...base.usage, ...(s.usage as object) } : base.usage;
  for (const k of ["leadTurns", "staffTurns", "inputTokens", "outputTokens", "activeMs"] as const) if (typeof usage[k] !== "number" || !Number.isFinite(usage[k])) usage[k] = 0;
  if (typeof usage.startedAt !== "number") usage.startedAt = null;
  if (typeof usage.activeSince !== "number") usage.activeSince = null;
  return {
    ...base,
    staff: { ...base.staff, ...staff },
    log: arr(s.log, base.log).filter((m) => typeof (m as { text?: unknown }).text === "string"),
    approval: isRecord(s.approval) && typeof s.approval.title === "string" && typeof s.approval.staffId === "string" ? (s.approval as unknown as OfficeRun["approval"]) : null,
    permissions: arr(s.permissions, base.permissions),
    deliveries: arr(s.deliveries, base.deliveries).filter((d) => isRecord((d as { artifact?: unknown }).artifact)),
    notices: arr(s.notices, base.notices),
    inbox: arr(s.inbox, base.inbox),
    cheerAt: typeof s.cheerAt === "number" ? s.cheerAt : 0,
    usage,
    awaiting: Array.isArray(s.awaiting) ? s.awaiting.filter((x): x is string => typeof x === "string") : [],
    reports: arr(s.reports, base.reports),
    pending: Array.isArray(s.pending) ? s.pending.filter((x): x is string => typeof x === "string") : [],
    busy: s.busy === true,
    briefed: s.briefed === true,
    // 自動で進めた回数と、自動で通した許可の記録（開き直しても上限と記録を引き継ぐ）
    autoAnswers: count(s.autoAnswers),
    autoApprovals: count(s.autoApprovals),
    autoLog: autoLogOf(s.autoLog),
  };
}

/** 開き直したときに読む。動いていた仕事は「止まっている」状態に直して返す。 */
export function loadRun(office: Office, locale: Locale = "ja"): OfficeRun {
  const key = RUN_PREFIX + office.id;
  const saved = read<unknown>(key);
  if (saved === null) return emptyRun(office);
  try {
    const repaired = repairRun(saved, office);
    if (repaired) return reconcileRun(repaired, office, { afterRestart: true, locale });
  } catch {
    /* 下で控えを残して、空から始める */
  }
  try {
    keepBroken(key, JSON.stringify(saved));
  } catch {
    /* 続ける */
  }
  return emptyRun(office);
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
