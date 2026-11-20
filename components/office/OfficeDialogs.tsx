"use client";

/**
 * AIオフィスの設定まわり：社員の設定（机を押すと開く）・会社の設定・最初の会社づくり。
 * ここで直したものは全部その場で保存される。「仕事のやり方」は次の仕事から使われる。
 */
import { useEffect, useState } from "react";
import { FolderOpen, ImageUp, Plus, Trash2, X } from "lucide-react";
import { useOfficeT } from "@/lib/office/i18n";
import { LOOK_SAMPLES, lookSample } from "@/lib/office/looks";
import { buildOffice, newDepartment, newStaff, OFFICE_TEMPLATES } from "@/lib/office/templates";
import { OFFICE_THEMES } from "@/lib/office/themes";
import type { Office, OfficeRun, Staff } from "@/lib/office/types";
import { CATEGORY_LABELS, CATEGORY_ORDER, PROVIDER_CATEGORY } from "@/lib/providerCategories";
import { loadLastWorkspace, saveLastWorkspace } from "@/lib/storage";
import { isTauri, pickAndSaveAvatar, pickWorkspace } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import { MODEL_LABELS, PROVIDER_LABELS, type ModelId, type Provider } from "@/lib/types";

const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-rose-400";
const label = "mb-1 block text-[12px] font-bold text-slate-600";

function ProviderSelect({ value, onChange }: { value: Provider; onChange: (p: Provider) => void }) {
  const all = Object.keys(PROVIDER_LABELS) as Provider[];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Provider)} className={field}>
      {CATEGORY_ORDER.slice()
        .sort((a, b) => (a === "claude_family" ? -1 : b === "claude_family" ? 1 : 0))
        .map((cat) => (
          <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
            {all
              .filter((p) => PROVIDER_CATEGORY[p] === cat)
              .map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
          </optgroup>
        ))}
    </select>
  );
}

/** 見本の絵（平面）。名札や見た目選びで使う。 */
export function LookFace({ sample, size = 44 }: { sample: string; size?: number }) {
  const l = lookSample(sample);
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="24" fill={`${l.body}33`} />
      <path d="M8 48c0-10 7-15 16-15s16 5 16 15z" fill={l.body} />
      <circle cx="24" cy="22" r="11" fill={l.skin} />
      {l.hairStyle === "long" ? <path d="M12 22c0-9 5-14 12-14s12 5 12 14v12h-5V22H17v12h-5z" fill={l.hair} /> : null}
      {l.hairStyle === "bob" ? <path d="M11.5 25c-1-11 5-17 12.5-17s13.500 6 12.500 17l-3.500 2V20H15v7z" fill={l.hair} /> : null}
      {l.hairStyle === "curly" ? (
        <g fill={l.hair}>
          {[14, 19, 24, 29, 34].map((x) => (
            <circle key={x} cx={x} cy={x === 24 ? 11 : x === 19 || x === 29 ? 12 : 15} r="5" />
          ))}
        </g>
      ) : null}
      {l.hairStyle === "spiky" ? <path d="M12 20l2-9 4 5 2-8 4 7 3-8 3 8 4-5 2 10c-4-4-20-4-24 0z" fill={l.hair} /> : null}
      {l.hairStyle === "cap" ? (
        <g>
          <path d="M12 19c0-7 5-11 12-11s12 4 12 11z" fill={l.body} />
          <rect x="22" y="17" width="18" height="3.500" rx="1.700" fill={l.body} />
        </g>
      ) : null}
      {l.hairStyle === "short" || l.hairStyle === "bun" ? <path d="M12.500 21c0-8 5-13 11.500-13s11.500 5 11.500 13c-4-5-19-5-23 0z" fill={l.hair} /> : null}
      {l.hairStyle === "side" ? <path d="M12.500 22c-1-9 5-14 11.500-14s12 4 11.500 12c-6-1-12-3-15-7-1 4-4 7-8 9z" fill={l.hair} /> : null}
      {l.hairStyle === "bun" ? <circle cx="24" cy="7" r="4.500" fill={l.hair} /> : null}
      <circle cx="20" cy="23" r="1.400" fill="#1f2937" />
      <circle cx="28" cy="23" r="1.400" fill="#1f2937" />
      {l.accessory === "glasses" ? (
        <g fill="none" stroke="#111827" strokeWidth="1.200">
          <circle cx="20" cy="23" r="3.400" />
          <circle cx="28" cy="23" r="3.400" />
          <path d="M23.400 23h1.200" />
        </g>
      ) : null}
      {l.accessory === "headset" ? <path d="M12 23a12 12 0 0 1 24 0" fill="none" stroke="#0f172a" strokeWidth="2.200" /> : null}
      {l.accessory === "ribbon" ? <path d="M31 9l5-3v7zM31 9l-4-3v7z" fill="#f43f5e" /> : null}
    </svg>
  );
}

/* ───────── 社員の設定 ───────── */

export function StaffPanel({
  office,
  run,
  staff,
  avatarUrl,
  onSave,
  onDelete,
  onClose,
}: {
  office: Office;
  run: OfficeRun;
  staff: Staff;
  avatarUrl: string | null;
  onSave: (next: Staff) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useOfficeT();
  const [draft, setDraft] = useState<Staff>(staff);
  useEffect(() => setDraft(staff), [staff]);
  const rt = run.staff[staff.id];
  const dirty = JSON.stringify(draft) !== JSON.stringify(staff);
  const set = (patch: Partial<Staff>) => setDraft((d) => ({ ...d, ...patch }));
  const busy = rt?.status === "working";

  return (
    <aside className="pointer-events-auto absolute bottom-3 right-3 top-3 z-40 flex w-[400px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl" aria-label={t("staff.title")}>
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
        <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-slate-100">
          {draft.look.kind === "image" && avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <LookFace sample={draft.look.kind === "builtin" ? draft.look.sample : LOOK_SAMPLES[0].id} size={48} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[15px] font-extrabold">{draft.name}</div>
          <div className="text-[12px] text-slate-500">{draft.role}</div>
        </div>
        <button type="button" onClick={onClose} title={t("staff.close")} aria-label={t("staff.close")} className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100">
          <X size={18} />
        </button>
      </header>

      <div className="unipilot-scroll flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="rounded-xl bg-slate-50 p-3 text-[12.5px]">
          <div className="font-bold text-slate-600">{t("staff.now")}</div>
          <div className="mt-0.5">{rt?.bubble ?? rt?.task ?? t("staff.nothing")}</div>
          <div className="mt-2 font-bold text-slate-600">{t("staff.thisJob")}</div>
          <div className="mt-0.5 text-slate-600">
            {t("staff.turns", { n: rt?.turns ?? 0 })}・{t("staff.tokens", { n: ((rt?.inputTokens ?? 0) + (rt?.outputTokens ?? 0)).toLocaleString() })}
          </div>
          {busy ? <div className="mt-2 text-amber-700">{t("staff.busyNote")}</div> : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className={label}>{t("staff.name")}</span>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value.slice(0, 24) })} className={field} />
          </label>
          <label>
            <span className={label}>{t("staff.role")}</span>
            <input value={draft.role} onChange={(e) => set({ role: e.target.value.slice(0, 24) })} className={field} />
          </label>
        </div>

        {draft.lead ? (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] font-bold text-rose-700">{t("staff.lead")}</div>
        ) : (
          <label className="block">
            <span className={label}>{t("staff.dept")}</span>
            <select value={draft.deptId ?? ""} onChange={(e) => set({ deptId: e.target.value || null })} className={field}>
              <option value="">{t("staff.noDept")}</option>
              {office.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className={label}>{t("staff.ai")}</span>
            <ProviderSelect value={draft.provider} onChange={(p) => set({ provider: p })} />
          </label>
          {draft.provider === "claude" ? (
            <label>
              <span className={label}>{t("staff.model")}</span>
              <select value={draft.model} onChange={(e) => set({ model: e.target.value as ModelId })} className={field}>
                {(Object.keys(MODEL_LABELS) as ModelId[]).map((m) => (
                  <option key={m} value={m}>
                    {MODEL_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <p className="-mt-2 text-[11.5px] leading-relaxed text-slate-500">{t("staff.aiHint")}</p>

        <label className="block">
          <span className={label}>{t("staff.manual")}</span>
          <textarea value={draft.manual} onChange={(e) => set({ manual: e.target.value.slice(0, 8000) })} placeholder={t("staff.manualPlaceholder")} rows={9} className={`${field} resize-y leading-relaxed`} />
        </label>

        <div>
          <span className={label}>{t("staff.look")}</span>
          <div className="text-[11.5px] text-slate-500">{t("staff.lookSamples")}</div>
          <div className="mt-1.5 grid grid-cols-6 gap-1.5">
            {LOOK_SAMPLES.map((l) => {
              const on = draft.look.kind === "builtin" && draft.look.sample === l.id;
              return (
                <button key={l.id} type="button" title={l.label} aria-label={l.label} aria-pressed={on} onClick={() => set({ look: { kind: "builtin", sample: l.id } })} className={`rounded-xl p-1 ${on ? "bg-rose-50 ring-2 ring-rose-400" : "hover:bg-slate-100"}`}>
                  <LookFace sample={l.id} size={44} />
                </button>
              );
            })}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                const path = await pickAndSaveAvatar();
                if (path) set({ look: { kind: "image", path } });
              }}
              className="flex items-center gap-1.5 rounded-full border border-slate-300 px-3.5 py-1.5 text-[12.5px] font-bold text-slate-700 hover:bg-slate-50"
            >
              <ImageUp size={14} aria-hidden="true" />
              {t("staff.lookUpload")}
            </button>
            {draft.look.kind === "image" ? (
              <button type="button" onClick={() => set({ look: { kind: "builtin", sample: LOOK_SAMPLES[0].id } })} className="text-[12px] font-bold text-slate-500 underline">
                {t("staff.lookReset")}
              </button>
            ) : null}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">{t("staff.lookUploadHint")}</p>
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-slate-200 px-4 py-3">
        <button
          type="button"
          disabled={!dirty || !draft.name.trim()}
          onClick={() => {
            onSave({ ...draft, name: draft.name.trim(), role: draft.role.trim() || staff.role });
            showToast(t("staff.saved"));
          }}
          className="rounded-full bg-rose-500 px-5 py-2 text-[13px] font-bold text-white shadow disabled:opacity-40"
        >
          {t("staff.save")}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          disabled={staff.lead}
          title={staff.lead ? t("staff.cantDeleteLead") : undefined}
          onClick={() => {
            if (window.confirm(t("staff.deleteConfirm", { name: staff.name }))) onDelete(staff.id);
          }}
          className="flex items-center gap-1.5 rounded-full px-3 py-2 text-[12.5px] font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-40"
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("staff.delete")}
        </button>
      </footer>
    </aside>
  );
}

/* ───────── 会社の設定 ───────── */

export function CompanyPanel({
  office,
  chatter,
  onChatter,
  onChange,
  onAddStaff,
  onDeleteOffice,
  onNewOffice,
  onClose,
}: {
  office: Office;
  chatter: boolean;
  onChatter: (on: boolean) => void;
  onChange: (next: Office) => void;
  onAddStaff: (deptId: string | null) => void;
  onDeleteOffice: () => void;
  onNewOffice: () => void;
  onClose: () => void;
}) {
  const { t } = useOfficeT();
  const patch = (p: Partial<Office>) => onChange({ ...office, ...p, updatedAt: Date.now() });
  return (
    <aside className="pointer-events-auto absolute bottom-3 right-3 top-3 z-40 flex w-[400px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl" aria-label={t("company.title")}>
      <header className="flex items-center border-b border-slate-200 px-4 py-3">
        <h2 className="flex-1 text-[15px] font-extrabold">{t("company.title")}</h2>
        <button type="button" onClick={onClose} aria-label={t("staff.close")} className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100">
          <X size={18} />
        </button>
      </header>
      <div className="unipilot-scroll flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <label className="block">
          <span className={label}>{t("company.name")}</span>
          <input value={office.name} onChange={(e) => patch({ name: e.target.value.slice(0, 40) })} className={field} />
        </label>
        <label className="block">
          <span className={label}>{t("company.tagline")}</span>
          <input value={office.tagline} onChange={(e) => patch({ tagline: e.target.value.slice(0, 40) })} className={field} />
        </label>
        <div>
          <span className={label}>{t("company.workspace")}</span>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg bg-slate-100 px-3 py-2 text-[12.5px] text-slate-700" title={office.workspace ?? ""}>
              {office.workspace ?? t("company.workspaceNone")}
            </div>
            <button
              type="button"
              onClick={async () => {
                const p = await pickWorkspace({ defaultPath: office.workspace ?? loadLastWorkspace() });
                if (p) {
                  saveLastWorkspace(p);
                  patch({ workspace: p });
                }
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-300 px-3 py-1.5 text-[12.5px] font-bold text-slate-700 hover:bg-slate-50"
            >
              <FolderOpen size={14} aria-hidden="true" />
              {t("company.change")}
            </button>
          </div>
        </div>
        <div>
          <span className={label}>{t("company.theme")}</span>
          <div className="grid grid-cols-3 gap-2">
            {OFFICE_THEMES.map((th) => (
              <button key={th.id} type="button" aria-pressed={office.theme === th.id} onClick={() => patch({ theme: th.id })} className={`overflow-hidden rounded-xl border-2 text-left ${office.theme === th.id ? "border-rose-400" : "border-slate-200"}`}>
                <span className="flex h-12 items-end gap-1 p-1.5" style={{ background: th.sky }}>
                  <span className="h-5 flex-1 rounded" style={{ background: th.floor }} />
                  <span className="h-7 w-3 rounded" style={{ background: th.ring }} />
                  <span className="h-4 w-6 rounded" style={{ background: th.signBg }} />
                </span>
                <span className="block px-2 py-1 text-[11.5px] font-bold">{th.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className={label}>{t("company.depts")}</span>
          <ul className="space-y-2">
            {office.departments.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <input type="color" value={d.color} aria-label={d.name} onChange={(e) => patch({ departments: office.departments.map((x) => (x.id === d.id ? { ...x, color: e.target.value } : x)) })} className="h-8 w-9 shrink-0 cursor-pointer rounded border border-slate-300 bg-white p-0.5" />
                <input value={d.name} onChange={(e) => patch({ departments: office.departments.map((x) => (x.id === d.id ? { ...x, name: e.target.value.slice(0, 16) } : x)) })} className={field} />
                <button type="button" onClick={() => onAddStaff(d.id)} title={t("company.addStaff")} aria-label={`${d.name} ${t("company.addStaff")}`} className="shrink-0 rounded-full border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-50">
                  <Plus size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm(t("company.removeDeptConfirm", { name: d.name }))) return;
                    patch({ departments: office.departments.filter((x) => x.id !== d.id), staff: office.staff.map((s) => (s.deptId === d.id ? { ...s, deptId: null } : s)) });
                  }}
                  title={t("company.removeDept")}
                  aria-label={`${d.name} ${t("company.removeDept")}`}
                  className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" onClick={() => patch({ departments: [...office.departments, newDepartment(office)] })} className="flex items-center gap-1.5 rounded-full border border-slate-300 px-3.5 py-1.5 text-[12.5px] font-bold text-slate-700 hover:bg-slate-50">
              <Plus size={14} aria-hidden="true" />
              {t("company.addDept")}
            </button>
            <button type="button" onClick={() => onAddStaff(null)} className="flex items-center gap-1.5 rounded-full bg-slate-900 px-3.5 py-1.5 text-[12.5px] font-bold text-white">
              <Plus size={14} aria-hidden="true" />
              {t("company.addStaff")}
            </button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={chatter} onChange={(e) => onChatter(e.target.checked)} className="h-4 w-4" />
          {t("chatter.setting")}
        </label>
        <button type="button" onClick={onNewOffice} className="flex items-center gap-1.5 rounded-full border border-slate-300 px-3.5 py-1.5 text-[12.5px] font-bold text-slate-700 hover:bg-slate-50">
          <Plus size={14} aria-hidden="true" />
          {t("list.new")}
        </button>
      </div>
      <footer className="flex items-center gap-2 border-t border-slate-200 px-4 py-3">
        <button type="button" onClick={onClose} className="rounded-full bg-rose-500 px-5 py-2 text-[13px] font-bold text-white shadow">
          {t("company.done")}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t("company.deleteConfirm", { name: office.name }))) onDeleteOffice();
          }}
          className="flex items-center gap-1.5 rounded-full px-3 py-2 text-[12.5px] font-bold text-slate-500 hover:bg-slate-100"
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("company.delete")}
        </button>
      </footer>
    </aside>
  );
}

/* ───────── 最初の会社づくり ───────── */

export function OfficeSetup({ canCancel, onCreate, onCancel }: { canCancel: boolean; onCreate: (office: Office) => void; onCancel: () => void }) {
  const { t } = useOfficeT();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState(() => OFFICE_TEMPLATES.find((x) => x.recommended)?.id ?? OFFICE_TEMPLATES[0].id);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>("claude");
  // ブラウザで開いたとき（見本の動き）はフォルダを選べないので、仮の場所で作れるようにする
  const demo = !isTauri();
  const ready = demo || !!workspace;
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto bg-slate-100/80 p-4 backdrop-blur-sm">
      <div className="my-auto w-full max-w-[720px] rounded-3xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl">
        <h1 className="text-[22px] font-black">{t("setup.title")}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-600">{t("setup.lead")}</p>

        <label className="mt-5 block">
          <span className="mb-1.5 block text-[13px] font-extrabold">{t("setup.step1")}</span>
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} placeholder={t("setup.namePlaceholder")} className={field} autoFocus />
        </label>

        <div className="mt-5">
          <span className="mb-1.5 block text-[13px] font-extrabold">{t("setup.step2")}</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {OFFICE_TEMPLATES.map((tp) => {
              const on = tp.id === templateId;
              return (
                <button key={tp.id} type="button" aria-pressed={on} onClick={() => setTemplateId(tp.id)} className={`rounded-2xl border-2 p-3 text-left ${on ? "border-rose-400 bg-rose-50" : "border-slate-200 hover:bg-slate-50"}`}>
                  <span className="flex items-center gap-2">
                    <span className="text-[14px] font-extrabold">{tp.label}</span>
                    <span className="rounded-full bg-slate-200 px-2 py-px text-[11px] font-bold text-slate-700">{t("setup.people", { n: tp.staff.length })}</span>
                    {tp.recommended ? <span className="rounded-full bg-rose-500 px-2 py-px text-[11px] font-bold text-white">{t("setup.recommended")}</span> : null}
                  </span>
                  <span className="mt-1 block text-[12px] leading-relaxed text-slate-600">{tp.description}</span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {tp.departments.map((d) => (
                      <span key={d.key} className="rounded-full px-2 py-px text-[11px] font-bold text-white" style={{ background: d.color }}>
                        {d.name}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[12px] text-slate-500">{t("setup.editable")}</p>
        </div>

        <div className="mt-5">
          <span className="mb-1.5 block text-[13px] font-extrabold">{t("setup.step3")}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                const p = await pickWorkspace({ defaultPath: workspace ?? loadLastWorkspace() });
                if (p) {
                  saveLastWorkspace(p);
                  setWorkspace(p);
                }
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-slate-900 px-4 py-2 text-[13px] font-bold text-white"
            >
              <FolderOpen size={15} aria-hidden="true" />
              {t("setup.pick")}
            </button>
            <div className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-slate-700" title={workspace ?? ""}>
              {workspace ?? ""}
            </div>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">{t("setup.pickHint")}</p>
        </div>

        <label className="mt-5 block max-w-[320px]">
          <span className="mb-1.5 block text-[13px] font-extrabold">{t("setup.step4")}</span>
          <ProviderSelect value={provider} onChange={setProvider} />
        </label>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              const template = OFFICE_TEMPLATES.find((x) => x.id === templateId) ?? OFFICE_TEMPLATES[0];
              onCreate(buildOffice({ template, name, workspace: workspace ?? (demo ? "C:/demo-workspace" : null), provider }));
            }}
            className="rounded-full bg-rose-500 px-6 py-2.5 text-[14px] font-extrabold text-white shadow-lg disabled:opacity-40"
          >
            {t("setup.create")}
          </button>
          {!ready ? <span className="text-[12.5px] text-slate-500">{t("setup.needFolder")}</span> : null}
          <span className="flex-1" />
          {canCancel ? (
            <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-[13px] font-bold text-slate-500 hover:bg-slate-100">
              {t("setup.cancel")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { newStaff };
