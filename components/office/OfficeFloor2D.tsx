"use client";

/**
 * 平らな表示。立体の部屋を出せないPC（WebGL が使えない）で、同じ席順を上から見た形で出す。
 * 使える機能は立体のときと同じ（席を押すと社員の設定・いまの作業が見える）。
 */
import { LookFace } from "@/components/office/OfficeDialogs";
import { useOfficeT } from "@/lib/office/i18n";
import type { OfficeLayout, Seat } from "@/lib/office/layout";
import type { OfficeTheme } from "@/lib/office/themes";
import type { Office, OfficeRun } from "@/lib/office/types";

interface Props {
  office: Office;
  run: OfficeRun;
  layout: OfficeLayout;
  theme: OfficeTheme;
  avatarUrls: Record<string, string>;
  needsBoss: Set<string>;
  selectedStaffId: string | null;
  onSelectStaff: (id: string) => void;
  wallLeft: React.ReactNode;
  wallRight: React.ReactNode;
}

export default function OfficeFloor2D({ office, run, layout, theme, avatarUrls, needsBoss, selectedStaffId, onSelectStaff, wallLeft, wallRight }: Props) {
  const { t } = useOfficeT();
  const desk = (seat: Seat) => {
    const rt = run.staff[seat.staff.id];
    const status = rt?.status ?? "idle";
    const raised = needsBoss.has(seat.staff.id);
    const img = seat.staff.look.kind === "image" ? avatarUrls[seat.staff.id] : null;
    return (
      <button
        key={seat.staff.id}
        type="button"
        onClick={() => onSelectStaff(seat.staff.id)}
        className={`flex w-[150px] flex-col items-center rounded-2xl border p-2 text-center ${theme.dark ? "border-white/10 bg-slate-900/70 text-slate-100" : "border-slate-200 bg-white text-slate-900"} ${
          selectedStaffId === seat.staff.id ? "ring-2 ring-rose-400" : ""
        }`}
      >
        <span className={`mb-1 min-h-[22px] max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${raised ? "bg-rose-500 text-white" : status === "working" ? "bg-slate-900 text-white" : status === "done" ? "bg-emerald-500 text-white" : "opacity-0"}`}>
          {rt?.bubble ?? "-"}
        </span>
        <span className={`flex h-14 w-14 items-center justify-center overflow-hidden rounded-full ${status === "working" ? "office-typing" : ""}`}>
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img} alt="" className="h-full w-full object-cover" />
          ) : (
            <LookFace sample={seat.staff.look.kind === "builtin" ? seat.staff.look.sample : "gray-side"} size={56} />
          )}
        </span>
        <span className="mt-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-bold">{seat.staff.name}</span>
        <span className={`max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[11px] ${theme.dark ? "text-slate-400" : "text-slate-500"}`}>
          {seat.staff.role}・{raised ? t("status.waiting") : status === "working" || status === "waiting" ? t("status.working") : status === "done" ? t("status.done") : t("status.idle")}
        </span>
      </button>
    );
  };
  return (
    <div className="unipilot-scroll absolute inset-0 overflow-auto px-6 pb-[340px] pt-[120px]" style={{ background: theme.sky }}>
      <p className={`mb-3 text-center text-[12px] ${theme.dark ? "text-slate-400" : "text-slate-500"}`}>{t("fallback.note")}</p>
      <div className="mx-auto flex max-w-[1100px] flex-wrap items-start justify-center gap-4">
        <div className="w-full max-w-[600px]">{wallLeft}</div>
        <div>{wallRight}</div>
      </div>
      {layout.lead ? <div className="mt-6 flex justify-center">{desk(layout.lead)}</div> : null}
      <div className="mx-auto mt-6 flex max-w-[1200px] flex-wrap justify-center gap-4">
        {layout.islands.map((isl) => (
          <div key={`${isl.dept?.id ?? "none"}:${isl.cx}`} className="rounded-3xl p-3" style={{ background: `${isl.dept?.color ?? "#94a3b8"}2e`, boxShadow: `inset 0 0 0 2px ${isl.dept?.color ?? "#94a3b8"}88` }}>
            {isl.dept ? (
              <div className="mb-2 inline-block rounded-full px-3 py-0.5 text-[12.5px] font-bold text-white" style={{ background: isl.dept.color }}>
                {isl.dept.name}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">{isl.seats.map(desk)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
