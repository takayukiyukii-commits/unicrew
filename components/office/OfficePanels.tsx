"use client";

/**
 * AIオフィスの部屋の上に重ねる札（上の数字・壁の案件ボードと看板・指示の欄・通知・納品・相談の受け箱）。
 * 文は lib/office/i18n.ts。色は部屋の雰囲気（theme.dark）に合わせる。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Check,
  ClipboardCopy,
  Eye,
  FolderOpen,
  Inbox,
  MessageSquare,
  PackageCheck,
  Send,
  Settings2,
  Square,
  Undo2,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { VoiceInputButton } from "@/components/VoiceInputButton";
import { activeMsOf, boardOf, waitingForBoss, type BoardColumn } from "@/lib/office/engine";
import { useOfficeT } from "@/lib/office/i18n";
import { lookSample } from "@/lib/office/looks";
import type { OfficeTheme } from "@/lib/office/themes";
import type { Office, OfficeRun, Staff } from "@/lib/office/types";
import { showToast } from "@/lib/toast";
import { readTextFile, writeClipboardText } from "@/lib/tauri";

const card = (dark: boolean) =>
  dark
    ? "border border-white/10 bg-slate-900/85 text-slate-100 shadow-xl backdrop-blur"
    : "border border-slate-200/80 bg-white/95 text-slate-900 shadow-xl backdrop-blur";
const sub = (dark: boolean) => (dark ? "text-slate-400" : "text-slate-500");

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function duration(ms: number, locale: string): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (locale === "ja") return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function StaffDot({ staff, office, theme, size = 28, img }: { staff: Staff; office: Office; theme: OfficeTheme; size?: number; img?: string | null }) {
  const color = staff.lead ? theme.ring : office.departments.find((d) => d.id === staff.deptId)?.color ?? "#94a3b8";
  const body = staff.look.kind === "builtin" ? lookSample(staff.look.sample).body : color;
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: body, boxShadow: `0 0 0 2px ${color}` }}
    >
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="" className="h-full w-full object-cover" />
      ) : (
        staff.name.slice(0, 1)
      )}
    </span>
  );
}

/* ───────── 上の帯：会社名・使った量・人数 ───────── */

export function OfficeTopBar({ office, run, theme, onEditCompany, demo }: { office: Office; run: OfficeRun; theme: OfficeTheme; onEditCompany: () => void; demo: boolean }) {
  const { t, locale } = useOfficeT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!run.busy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [run.busy]);
  const working = Object.values(run.staff).filter((s) => s.status === "working").length;
  const waiting = waitingForBoss(run);
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  const Stat = ({ label, value, strong, hint }: { label: string; value: string; strong?: boolean; hint?: string }) => (
    <div className="px-2 text-center" title={hint}>
      <div className={`text-[10.5px] ${sub(theme.dark)}`}>{label}</div>
      <div className={`text-[17px] font-extrabold tabular-nums leading-tight ${strong ? "text-rose-500" : ""}`}>{value}</div>
    </div>
  );
  return (
    <div className="pointer-events-none absolute left-0 right-0 top-3 z-20 flex flex-wrap items-start justify-center gap-2 px-3">
      <button
        type="button"
        onClick={onEditCompany}
        title={t("top.edit")}
        className={`pointer-events-auto flex items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-4 text-left ${card(theme.dark)}`}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full text-[15px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${theme.ring}, #6366f1)` }}>
          {office.name.replace(/^(株式会社|合同会社|有限会社)/, "").slice(0, 1) || "U"}
        </span>
        <span className="leading-tight">
          <span className="block max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap text-[14px] font-extrabold">{office.name}</span>
          <span className={`block text-[11px] ${sub(theme.dark)}`}>{office.tagline}</span>
        </span>
        <Settings2 size={15} className={sub(theme.dark)} aria-hidden="true" />
      </button>
      <div className={`pointer-events-auto flex items-center rounded-2xl px-2 py-1.5 ${card(theme.dark)}`}>
        <div className="px-2 text-[11px] font-bold leading-tight text-rose-500">{t("top.usage")}</div>
        <Stat label={t("top.leadTurns")} value={t("top.times", { n: run.usage.leadTurns })} />
        <Stat label={t("top.staffTurns")} value={t("top.times", { n: run.usage.staffTurns })} />
        <Stat label={t("top.tokens")} value={tokens.toLocaleString()} hint={t("top.tokensHint")} />
        <Stat label={t("top.time")} value={duration(activeMsOf(run.usage, now), locale)} />
      </div>
      <div className={`pointer-events-auto flex items-center rounded-2xl px-2 py-1.5 ${card(theme.dark)}`}>
        <Stat label={t("top.working")} value={t("top.people", { n: working })} />
        <Stat label={t("top.waiting")} value={t("top.items", { n: waiting })} strong={waiting > 0} />
      </div>
      {demo ? <div className="pointer-events-auto rounded-full bg-amber-100 px-3 py-1.5 text-[11.5px] font-semibold text-amber-900 shadow">{t("demo.note")}</div> : null}
    </div>
  );
}

/* ───────── 実況の帯：いちばん新しい通知を数秒だけ出す ───────── */

export function OfficeTicker({ office, run, theme }: { office: Office; run: OfficeRun; theme: OfficeTheme }) {
  const latest = run.notices[0];
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!latest) return;
    setShown(latest.id);
    const id = setTimeout(() => setShown((cur) => (cur === latest.id ? null : cur)), 4500);
    return () => clearTimeout(id);
  }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!latest || shown !== latest.id) return null;
  const who = office.staff.find((s) => s.id === latest.staffId);
  return (
    <div className="pointer-events-none absolute left-1/2 top-[76px] z-20 -translate-x-1/2">
      <div className={`office-pop flex items-center gap-2 rounded-full py-1.5 pl-2 pr-4 text-[12.5px] font-semibold ${card(theme.dark)}`}>
        {who ? <StaffDot staff={who} office={office} theme={theme} size={22} /> : <Bell size={14} aria-hidden="true" />}
        <span className="max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap">{latest.text}</span>
      </div>
    </div>
  );
}

/* ───────── 壁：案件ボード ───────── */

const COLS: { key: BoardColumn; label: "board.idle" | "board.working" | "board.waiting" | "board.done"; bar: string }[] = [
  { key: "idle", label: "board.idle", bar: "#94a3b8" },
  { key: "working", label: "board.working", bar: "#3b82f6" },
  { key: "waiting", label: "board.waiting", bar: "#ef4444" },
  { key: "done", label: "board.done", bar: "#22c55e" },
];

export function OfficeBoard({ office, run, theme, onSelectStaff, flat }: { office: Office; run: OfficeRun; theme: OfficeTheme; onSelectStaff: (id: string) => void; flat?: boolean }) {
  const { t } = useOfficeT();
  const cols = useMemo(() => boardOf(run, office), [run, office]);
  return (
    <div
      className={`rounded-xl p-3 ${theme.dark ? "bg-slate-900/90 text-slate-100 ring-1 ring-white/10" : "bg-white text-slate-900 ring-1 ring-slate-200"} ${flat ? "" : "shadow-lg"}`}
      style={{ width: flat ? "100%" : 590 }}
    >
      <div className="mb-2 flex items-baseline justify-between">
        <div className="flex items-center gap-2 text-[17px] font-extrabold">
          <span className="inline-block h-5 w-1.5 rounded-full" style={{ background: theme.ring }} />
          {t("board.title")}
        </div>
        <div className={`text-[12px] ${sub(theme.dark)}`}>{t("board.sub")}</div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {COLS.map((c) => (
          <div key={c.key} className="min-w-0">
            <div className="mb-1.5 rounded-md py-0.5 text-center text-[12.5px] font-extrabold text-white" style={{ background: c.bar }}>
              {t(c.label)}
            </div>
            <div className={c.key === "idle" ? "flex min-h-[64px] flex-wrap content-start gap-1" : "flex min-h-[64px] flex-col gap-1"}>
              {cols[c.key].map(({ staff, note }) => {
                const color = staff.lead ? theme.ring : office.departments.find((d) => d.id === staff.deptId)?.color ?? "#94a3b8";
                // 待機の人は小さな札にまとめる（人数が多くてもボードが縦に伸びない）
                if (c.key === "idle") {
                  return (
                    <button
                      key={staff.id}
                      type="button"
                      onClick={() => onSelectStaff(staff.id)}
                      title={`${staff.name}（${staff.role}）`}
                      className="office-note overflow-hidden rounded-[5px] px-1.5 py-0.5 text-[11.5px] font-bold"
                      style={{ borderLeft: `3px solid ${color}`, background: `${color}${theme.dark ? "33" : "26"}` }}
                    >
                      {staff.name.split(/[\s　]/)[0]}
                    </button>
                  );
                }
                return (
                  <button
                    key={staff.id}
                    type="button"
                    onClick={() => onSelectStaff(staff.id)}
                    className="office-note w-full overflow-hidden rounded-[5px] px-2 py-1 text-left"
                    style={{ borderLeft: `4px solid ${color}`, background: `${color}${theme.dark ? "33" : "26"}` }}
                  >
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-bold">{staff.name}</div>
                    {note ? <div className={`overflow-hidden text-ellipsis whitespace-nowrap text-[11px] ${sub(theme.dark)}`}>{note}</div> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── 壁：会社の看板と時計 ───────── */

export function OfficeSign({ office, theme }: { office: Office; theme: OfficeTheme }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);
  const short = office.name.replace(/^(株式会社|合同会社|有限会社)\s*/, "").replace(/\s*(株式会社|合同会社|有限会社)$/, "");
  return (
    <div className="flex items-stretch gap-2">
      <div
        className="office-neon flex items-center rounded-xl px-5 py-2 text-[26px] font-black tracking-wide"
        style={{ background: theme.signBg, color: theme.signText, textShadow: `0 0 6px ${theme.signGlow}, 0 0 18px ${theme.signGlow}`, boxShadow: `inset 0 0 0 2px ${theme.signGlow}, 0 6px 18px rgba(0,0,0,.18)` }}
      >
        <span className="max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap">{short || "UNICREW"}</span>
      </div>
      <div className={`flex items-center rounded-lg px-3 text-[26px] font-black tabular-nums ${theme.dark ? "bg-slate-950 text-slate-100 ring-2 ring-slate-600" : "bg-white text-slate-900 ring-2 ring-slate-900"}`}>
        {now === null ? "--:--" : hhmm(now)}
      </div>
    </div>
  );
}

/* ───────── 確認カードの中の小さな見本 ───────── */

function ApprovalPreview({ file, workspace }: { file: string; workspace: string | null }) {
  const [html, setHtml] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setHtml(null);
    setText(null);
    const abs = /^[a-zA-Z]:[\\/]|^[\\/]/.test(file) || !workspace ? file : `${workspace.replace(/[\\/]+$/, "")}/${file.replace(/^\.[\\/]/, "")}`;
    readTextFile(abs)
      .then((body) => {
        if (!alive) return;
        if (/\.x?html?$/i.test(abs)) setHtml(body.slice(0, 400_000));
        else if (/\.(md|markdown|txt|csv|json|ya?ml)$/i.test(abs)) setText(body.slice(0, 600));
      })
      .catch(() => {
        /* 読めないときは見本を出さない（「中身を見る」は使える） */
      });
    return () => {
      alive = false;
    };
  }, [file, workspace]);
  if (html !== null) {
    // 見本は動かさない（スクリプトを止める）。押せないようにして、縮めて上の部分だけ見せる
    return (
      <div className="relative mt-2 h-[132px] overflow-hidden rounded-lg border border-slate-200 bg-white">
        <iframe title="preview" sandbox="" srcDoc={html} className="pointer-events-none absolute left-0 top-0 origin-top-left border-0" style={{ width: 1200, height: 520, transform: "scale(0.255)" }} />
      </div>
    );
  }
  if (text !== null) {
    return <pre className="mt-2 max-h-[110px] overflow-hidden whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] leading-snug text-slate-700">{text}</pre>;
  }
  return null;
}

/* ───────── 左下：社長からの指示 ───────── */

export function BossDesk({
  office,
  run,
  theme,
  onSend,
  onApprove,
  onPermission,
  onStop,
  onOpenFile,
  onPickWorkspace,
}: {
  office: Office;
  run: OfficeRun;
  theme: OfficeTheme;
  onSend: (text: string) => void;
  onApprove: (ok: boolean, comment: string) => void;
  onPermission: (askId: string, allow: boolean) => void;
  onStop: () => void;
  onOpenFile: (file: string) => void;
  onPickWorkspace: () => void;
}) {
  const { t } = useOfficeT();
  const [text, setText] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectText, setRejectText] = useState("");
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const lead = office.staff.find((s) => s.lead) ?? office.staff[0];
  const openQuestion = run.log.some((m) => m.kind === "question" && !m.answered);
  const waiting = waitingForBoss(run);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.log.length, run.approval?.id, run.permissions.length]);
  useEffect(() => {
    setRejecting(false);
    setRejectText("");
  }, [run.approval?.id]);

  const send = () => {
    const v = text.trim();
    if (!v || !office.workspace) return;
    onSend(v);
    setText("");
  };
  const placeholder = !lead
    ? ""
    : run.approval
      ? t("boss.placeholder.approval")
      : openQuestion
        ? t("boss.placeholder.question")
        : run.busy
          ? t("boss.placeholder.busy", { lead: lead.name })
          : run.log.length > 0
            ? t("boss.placeholder.next")
            : t("boss.placeholder.idle");

  return (
    <section
      className={`pointer-events-auto flex max-h-full w-[380px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl ${card(theme.dark)} ${waiting > 0 ? "ring-2 ring-rose-400" : ""}`}
      aria-label={t("boss.title")}
    >
      <header className={`flex items-center gap-2 border-b px-4 py-2.5 ${theme.dark ? "border-white/10" : "border-slate-200"}`}>
        <MessageSquare size={16} className="text-rose-500" aria-hidden="true" />
        <h2 className="flex-1 text-[14px] font-extrabold">{t("boss.title")}</h2>
        {waiting > 0 ? <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[12px] font-bold text-white">{waiting}</span> : null}
      </header>

      <div ref={logRef} className="unipilot-scroll min-h-[120px] flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {!office.workspace ? (
          <div className="rounded-xl bg-amber-50 p-3 text-[13px] text-amber-900">
            <p>{t("boss.noWorkspace")}</p>
            <button type="button" onClick={onPickWorkspace} className="mt-2 rounded-lg bg-amber-500 px-3 py-1.5 text-[13px] font-bold text-white">
              {t("boss.pickWorkspace")}
            </button>
          </div>
        ) : run.log.length === 0 && lead ? (
          <div className={`text-[13px] leading-relaxed ${sub(theme.dark)}`}>
            <p>{t("boss.empty", { lead: lead.name })}</p>
            <p className="mt-3 text-[12px] font-bold">{t("boss.examples")}</p>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {(["boss.example1", "boss.example2", "boss.example3"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setText(t(k));
                    boxRef.current?.focus();
                  }}
                  className={`rounded-lg px-3 py-1.5 text-left text-[12.5px] ${theme.dark ? "bg-white/5 text-slate-200 hover:bg-white/10" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}
                >
                  {t(k)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {run.log.map((m) => {
          const who = m.staffId ? office.staff.find((s) => s.id === m.staffId) : null;
          if (m.kind === "boss") {
            return (
              <div key={m.id} className="flex flex-col items-end">
                <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-rose-500 px-3 py-2 text-[13px] text-white">{m.text}</div>
                <div className={`mt-0.5 text-[10.5px] ${sub(theme.dark)}`}>{hhmm(m.at)}</div>
              </div>
            );
          }
          if (m.kind === "system") {
            return (
              <div key={m.id} className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-[12px] ${theme.dark ? "bg-white/5 text-slate-300" : "bg-slate-100 text-slate-600"}`}>
                {m.text}
              </div>
            );
          }
          return (
            <div key={m.id} className="flex gap-2">
              {who ? <StaffDot staff={who} office={office} theme={theme} size={28} /> : null}
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-1.5 text-[11.5px] font-bold">
                  <span className={sub(theme.dark)}>{who ? `${who.role} ${who.name}` : ""}</span>
                  {m.kind === "question" ? <span className="rounded-full bg-amber-400 px-2 py-px text-[10.5px] text-amber-950">{t("boss.question")}</span> : null}
                </div>
                <div
                  className={`office-md break-words rounded-2xl rounded-tl-md px-3 py-2 text-[13px] leading-relaxed ${
                    m.kind === "question" ? (theme.dark ? "bg-amber-400/15 ring-1 ring-amber-400/40" : "bg-amber-50 ring-1 ring-amber-200") : theme.dark ? "bg-white/10" : "bg-slate-100"
                  }`}
                >
                  <Markdown>{m.text}</Markdown>
                </div>
                <div className={`mt-0.5 text-[10.5px] ${sub(theme.dark)}`}>
                  {m.kind === "question" && m.answered ? `${t("boss.answered")}・` : ""}
                  {hhmm(m.at)}
                </div>
              </div>
            </div>
          );
        })}

        {run.permissions.map((p) => {
          const who = office.staff.find((s) => s.id === p.staffId);
          return (
            <div key={p.id} className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-3 text-slate-900">
              <div className="text-[12.5px] font-bold">{t("perm.title", { name: who?.name ?? "" })}</div>
              <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-slate-700">{p.text}</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => onPermission(p.id, true)} className="rounded-full bg-emerald-500 px-4 py-1.5 text-[13px] font-bold text-white">
                  {t("perm.allow")}
                </button>
                <button type="button" onClick={() => onPermission(p.id, false)} className="rounded-full border border-slate-400 bg-white px-4 py-1.5 text-[13px] font-bold text-slate-700">
                  {t("perm.deny")}
                </button>
              </div>
            </div>
          );
        })}

        {run.approval
          ? (() => {
              const ap = run.approval;
              const who = office.staff.find((s) => s.id === ap.staffId);
              return (
                <div className="rounded-2xl border-2 border-rose-400 bg-white p-3 text-slate-900">
                  <div className="flex items-center gap-2 text-[12px] text-slate-500">
                    {who ? <StaffDot staff={who} office={office} theme={theme} size={24} /> : null}
                    <span className="flex-1">{t("approval.from", { role: who?.role ?? "", name: who?.name ?? "" })}</span>
                    <span>{hhmm(ap.at)}</span>
                  </div>
                  <div className="mt-1.5 text-[15px] font-extrabold">{ap.title}</div>
                  {ap.body ? <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-slate-700">{ap.body}</p> : null}
                  {ap.file ? <ApprovalPreview file={ap.file} workspace={office.workspace} /> : null}
                  {rejecting ? (
                    <div className="mt-2">
                      <textarea
                        value={rejectText}
                        onChange={(e) => setRejectText(e.target.value)}
                        placeholder={t("approval.rejectPlaceholder")}
                        rows={3}
                        autoFocus
                        className="w-full resize-none rounded-lg border border-slate-300 p-2 text-[13px] outline-none focus:border-rose-400"
                      />
                      <div className="mt-1.5 flex gap-2">
                        <button type="button" disabled={!rejectText.trim()} onClick={() => onApprove(false, rejectText)} className="rounded-full bg-slate-900 px-4 py-1.5 text-[13px] font-bold text-white disabled:opacity-40">
                          {t("approval.rejectSend")}
                        </button>
                        <button type="button" onClick={() => setRejecting(false)} className="rounded-full border border-slate-300 px-4 py-1.5 text-[13px] font-bold text-slate-600">
                          {t("approval.cancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {ap.file ? (
                        <button type="button" onClick={() => onOpenFile(ap.file!)} className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3.5 py-1.5 text-[13px] font-bold text-slate-700">
                          <Eye size={14} aria-hidden="true" />
                          {t("approval.view")}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => onApprove(true, "")} className="flex items-center gap-1.5 rounded-full bg-rose-500 px-4 py-1.5 text-[13px] font-bold text-white shadow">
                        <Check size={14} aria-hidden="true" />
                        {t("approval.ok")}
                      </button>
                      <button type="button" onClick={() => setRejecting(true)} className="flex items-center gap-1.5 rounded-full border-2 border-slate-800 bg-white px-3.5 py-1.5 text-[13px] font-bold text-slate-800">
                        <Undo2 size={14} aria-hidden="true" />
                        {t("approval.reject")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()
          : null}

        {run.busy && lead ? (
          <div className={`flex items-center gap-2 text-[12px] ${sub(theme.dark)}`}>
            <span className="office-dots office-dots--muted" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {t("boss.busy", { lead: lead.name })}
          </div>
        ) : null}
      </div>

      <footer className={`border-t px-3 pb-2.5 pt-2.5 ${theme.dark ? "border-white/10" : "border-slate-200"}`}>
        <div className="flex items-end gap-2">
          <textarea
            ref={boxRef}
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 4000))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            disabled={!office.workspace || !!run.approval}
            placeholder={placeholder}
            rows={2}
            className={`min-h-[52px] flex-1 resize-none rounded-xl border px-3 py-2 text-[13px] outline-none focus:border-rose-400 disabled:opacity-60 ${
              theme.dark ? "border-white/15 bg-slate-950/60 text-slate-100 placeholder:text-slate-500" : "border-slate-300 bg-slate-50 text-slate-900 placeholder:text-slate-400"
            }`}
          />
          <div className="flex flex-col items-center gap-1.5">
            <VoiceInputButton
              focusTarget={() => {
                boxRef.current?.focus();
                return document.activeElement === boxRef.current;
              }}
              disabled={!office.workspace || !!run.approval}
            />
            {run.busy && !text.trim() ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(t("boss.stopConfirm"))) onStop();
                }}
                className="flex items-center gap-1.5 rounded-full bg-slate-800 px-3.5 py-2 text-[13px] font-bold text-white"
              >
                <Square size={12} aria-hidden="true" />
                {t("boss.stop")}
              </button>
            ) : (
              <button type="button" onClick={send} disabled={!text.trim() || !office.workspace || !!run.approval} className="flex items-center gap-1.5 rounded-full bg-rose-500 px-3.5 py-2 text-[13px] font-bold text-white shadow disabled:opacity-40">
                <Send size={13} aria-hidden="true" />
                {t("boss.send")}
              </button>
            )}
          </div>
        </div>
        <div className={`mt-1 text-[10.5px] ${sub(theme.dark)}`}>{t("boss.hint")}</div>
      </footer>
    </section>
  );
}

/* ───────── 右：通知・納品・相談の受け箱 ───────── */

export function OfficeSide({
  office,
  run,
  theme,
  onOpenFile,
  onReveal,
  onInquiry,
}: {
  office: Office;
  run: OfficeRun;
  theme: OfficeTheme;
  onOpenFile: (file: string) => void;
  onReveal: (file: string) => void;
  onInquiry: (text: string) => void;
}) {
  const { t } = useOfficeT();
  const [tab, setTab] = useState<"deliveries" | "notices" | "inbox">("deliveries");
  const [inq, setInq] = useState("");
  const openInbox = run.inbox.filter((q) => q.reply === null).length;
  const tabs: { key: typeof tab; label: string; icon: React.ReactNode; count: number }[] = [
    { key: "deliveries", label: t("side.deliveries"), icon: <PackageCheck size={14} aria-hidden="true" />, count: run.deliveries.length },
    { key: "notices", label: t("side.notices"), icon: <Bell size={14} aria-hidden="true" />, count: 0 },
    { key: "inbox", label: t("inbox.title"), icon: <Inbox size={14} aria-hidden="true" />, count: openInbox },
  ];
  return (
    <section className={`pointer-events-auto flex max-h-full w-[300px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl ${card(theme.dark)}`}>
      <div className={`flex border-b ${theme.dark ? "border-white/10" : "border-slate-200"}`} role="tablist">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={tab === x.key}
            onClick={() => setTab(x.key)}
            className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[12.5px] font-bold ${tab === x.key ? "border-b-2 border-rose-500 text-rose-500" : sub(theme.dark)}`}
          >
            {x.icon}
            {x.label}
            {x.count > 0 ? <span className={`rounded-full px-1.5 text-[10.5px] ${theme.dark ? "bg-white/10" : "bg-slate-100"}`}>{x.count}</span> : null}
          </button>
        ))}
      </div>
      <div className="unipilot-scroll min-h-[120px] flex-1 overflow-y-auto p-3">
        {tab === "deliveries" ? (
          run.deliveries.length === 0 ? (
            <p className={`py-6 text-center text-[12.5px] ${sub(theme.dark)}`}>{t("side.noDeliveries")}</p>
          ) : (
            <ul className="space-y-2">
              {run.deliveries.map((d) => {
                const who = office.staff.find((s) => s.id === d.staffId);
                return (
                  <li key={d.id} className={`office-pop rounded-xl p-2.5 ${theme.dark ? "bg-white/5" : "bg-slate-50"}`}>
                    <div className="flex items-center gap-2">
                      {who ? <StaffDot staff={who} office={office} theme={theme} size={24} /> : null}
                      <div className="min-w-0 flex-1">
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-bold">{d.artifact.name}</div>
                        <div className={`text-[11px] ${sub(theme.dark)}`}>
                          {who?.name ?? ""}・{hhmm(d.at)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-1.5">
                      <button type="button" onClick={() => onOpenFile(d.artifact.target)} className="flex items-center gap-1 rounded-full bg-rose-500 px-3 py-1 text-[12px] font-bold text-white">
                        <Eye size={12} aria-hidden="true" />
                        {t("side.open")}
                      </button>
                      {d.artifact.kind !== "web" ? (
                        <button type="button" onClick={() => onReveal(d.artifact.target)} className={`flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-bold ${theme.dark ? "bg-white/10 text-slate-200" : "bg-slate-200 text-slate-700"}`}>
                          <FolderOpen size={12} aria-hidden="true" />
                          {t("side.folder")}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
        {tab === "notices" ? (
          run.notices.length === 0 ? (
            <p className={`py-6 text-center text-[12.5px] ${sub(theme.dark)}`}>{t("side.noNotices")}</p>
          ) : (
            <ul className="space-y-1.5">
              {run.notices.map((n) => {
                const color = office.staff.find((s) => s.id === n.staffId);
                const c = color ? (color.lead ? theme.ring : office.departments.find((d) => d.id === color.deptId)?.color ?? "#94a3b8") : "#94a3b8";
                return (
                  <li key={n.id} className="flex items-start gap-2 text-[12.5px]">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: c }} />
                    <span className="min-w-0 flex-1 break-words">{n.text}</span>
                    <span className={`shrink-0 text-[10.5px] ${sub(theme.dark)}`}>{hhmm(n.at)}</span>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
        {tab === "inbox" ? (
          <div>
            <p className={`text-[12px] ${sub(theme.dark)}`}>{t("inbox.sub")}</p>
            <textarea
              value={inq}
              onChange={(e) => setInq(e.target.value.slice(0, 3000))}
              placeholder={t("inbox.placeholder")}
              rows={3}
              disabled={!office.workspace}
              className={`mt-2 w-full resize-none rounded-xl border px-3 py-2 text-[12.5px] outline-none focus:border-teal-400 ${
                theme.dark ? "border-white/15 bg-slate-950/60 text-slate-100 placeholder:text-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder:text-slate-400"
              }`}
            />
            <button
              type="button"
              disabled={!inq.trim() || !office.workspace}
              onClick={() => {
                onInquiry(inq.trim());
                setInq("");
              }}
              className="mt-1.5 flex items-center gap-1.5 rounded-full bg-teal-500 px-3.5 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-40"
            >
              <Send size={12} aria-hidden="true" />
              {t("inbox.send")}
            </button>
            <p className={`mt-1 text-[10.5px] ${sub(theme.dark)}`}>{t("inbox.note")}</p>
            {run.inbox.length === 0 ? <p className={`py-4 text-center text-[12.5px] ${sub(theme.dark)}`}>{t("inbox.empty")}</p> : null}
            <ul className="mt-3 space-y-2.5">
              {run.inbox.map((q) => (
                <li key={q.id} className={`rounded-xl p-2.5 ${theme.dark ? "bg-white/5" : "bg-slate-50"}`}>
                  {q.text ? (
                    <>
                      <div className={`text-[11px] font-bold ${sub(theme.dark)}`}>
                        {t("inbox.customer")}・{hhmm(q.at)}
                      </div>
                      <p className="mt-0.5 max-h-[72px] overflow-hidden whitespace-pre-wrap break-words text-[12.5px]">{q.text}</p>
                    </>
                  ) : null}
                  <div className="mt-2 text-[11px] font-bold text-teal-600">{t("inbox.draft")}</div>
                  {q.reply === null ? (
                    <p className={`mt-0.5 text-[12.5px] ${sub(theme.dark)}`}>{t("inbox.writing")}</p>
                  ) : (
                    <>
                      <p className={`mt-0.5 whitespace-pre-wrap break-words rounded-lg p-2 text-[12.5px] ${theme.dark ? "bg-teal-400/10" : "bg-teal-50 text-slate-800"}`}>{q.reply}</p>
                      <button
                        type="button"
                        onClick={() => {
                          void writeClipboardText(q.reply ?? "").then(() => showToast(t("inbox.copied")));
                        }}
                        className={`mt-1.5 flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-bold ${theme.dark ? "bg-white/10 text-slate-200" : "bg-slate-200 text-slate-700"}`}
                      >
                        <ClipboardCopy size={12} aria-hidden="true" />
                        {t("inbox.copy")}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
