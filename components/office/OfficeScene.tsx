"use client";
import { useMemo, useRef } from "react";
import { BookOpen, Coffee, DoorOpen, FileText, LogIn, PackageCheck, Presentation, Users } from "lucide-react";
import { LookFace } from "./OfficeCrew";
import { useOfficeMotion } from "./useOfficeMotion";
import { useOfficeWalk } from "./useOfficeWalk";
import { allSeats, type OfficeLayout } from "@/lib/office/layout";
import { useOfficeT } from "@/lib/office/i18n";
import { lookSample } from "@/lib/office/looks";
import type { OfficeTheme } from "@/lib/office/themes";
import type { Office, OfficeRun } from "@/lib/office/types";

interface Props {
  office: Office; run: OfficeRun; layout: OfficeLayout; theme: OfficeTheme;
  avatarUrls: Record<string, string>; active: boolean; animateIdle: boolean; needsBoss: Set<string>;
  selectedStaffId: string | null; onSelectStaff: (id: string) => void;
}
/** 静止背景1枚と、通路を歩く社員。WebGLや背景の描画ループは使わない。 */
export default function OfficeScene(props: Props) {
  const { office, run, layout, theme, avatarUrls, needsBoss, selectedStaffId, onSelectStaff } = props;
  const { t } = useOfficeT();
  const host = useRef<HTMLDivElement | null>(null);
  const { running, reduced } = useOfficeMotion(props.active);
  const lines = useMemo(() => ({ ask: (task: string) => (task ? t("talk.ask", { task }) : t("talk.askPlain")), ok: t("talk.ok"), report: t("talk.report"), thanks: t("talk.thanks") }), [t]);
  const smallTalk = useMemo(() => [t("talk.small1"), t("talk.small2"), t("talk.small3"), t("talk.small4")], [t]);
  useOfficeWalk(host, office, run, layout, running, reduced, props.animateIdle, lines, smallTalk);
  const seats = allSeats(layout);
  const placed = new Set(seats.map((s) => s.staff.id));
  return <div className="office-scene-scroll" tabIndex={0} aria-label={t("scene.label")}>
    <div ref={host} className="office-pixel-scene" data-motion={running && !reduced ? "on" : "off"}>
      <div className="office-scene-background" style={{ filter: theme.filter }} />
      <div className="office-scene-tint" style={{ background: theme.overlay }} />
      <div className="office-door" aria-hidden="true"><i /><i /></div>
      <div className="office-place-sign" style={{ left: "29.5%", top: "74%" }}><LogIn size={13} />{t("scene.door")}</div>
      <div className="office-place-sign" style={{ left: "49.5%", top: "9.5%" }}><BookOpen size={13} />{t("scene.books")}</div>
      <div className="office-place-sign" style={{ left: "11%", top: "10%" }}><Presentation size={13} />{t("scene.meeting")}</div>
      <div className="office-place-sign" style={{ left: "88%", top: "13%" }}><Coffee size={13} />{t("scene.break")}</div>
      <div className="office-place-sign" style={{ left: "51%", top: "67%" }}><Users size={13} />{t("scene.lead")}</div>
      <div className="office-place-sign" style={{ left: "47.5%", top: "96%" }}><DoorOpen size={13} />{t("scene.boss")}</div>
      <div className="office-place-sign" style={{ left: "68%", top: "91%" }}><PackageCheck size={13} />{t("scene.shelf", { n: run.deliveries.length })}</div>
      {layout.islands.filter((island) => island.departments.length > 0 || island.seats.length > 0).map((island) => <div key={island.index} className="office-island-sign"
        title={island.departments.map((d) => d.name).join("・")}
        style={{ left: `${[32, 50.5, 69][island.index % 3]}%`, top: island.index < 3 ? "29%" : "53%",
          borderColor: island.departments[0]?.color ?? "#CBD5E1" }}>
        {island.departments.length ? island.departments.map((d) => d.name).join("・") : t("scene.island", { n: island.index + 1 })}
      </div>)}
      <svg className="office-label-lines" aria-hidden="true">{seats.map(({ staff }) => <line key={staff.id} data-line={staff.id} stroke="#64748B" strokeWidth="1" opacity=".5" />)}</svg>
      {seats.map(({ staff }) => {
        const status = needsBoss.has(staff.id) ? "waiting" : run.staff[staff.id]?.status ?? "idle";
        const sample = lookSample(staff.look.kind === "builtin" ? staff.look.sample : "");
        const task = run.staff[staff.id]?.bubble ?? run.staff[staff.id]?.task;
        const title = `${staff.name} · ${staff.role}\n${task ?? t("staff.nothing")}`;
        return <div key={staff.id}>
          <button type="button" data-actor={staff.id} data-waiting={needsBoss.has(staff.id)} className="office-person" aria-label={title}
            onClick={() => onSelectStaff(staff.id)} aria-pressed={selectedStaffId === staff.id}>
            <span className="office-person-image"><LookFace sample={sample.id} size={72}
              image={staff.look.kind === "image" ? avatarUrls[staff.id] : null} status={status} /></span>
            <span className="office-carry-paper" aria-hidden="true"><FileText size={16} /></span>
            {needsBoss.has(staff.id) ? <span className="office-person-alert" aria-hidden="true">!</span> : null}
            <span className="office-speech" data-speech={staff.id} data-show="false" />
          </button>
          <button type="button" data-label={staff.id} className="office-person-label" title={title} aria-label={title}
            aria-pressed={selectedStaffId === staff.id} data-status={status}
            onClick={() => onSelectStaff(staff.id)} style={{ borderLeftColor: sample.color }}>
            <strong><LookFace sample={sample.id} size={18} image={staff.look.kind === "image" ? avatarUrls[staff.id] : null} />{staff.name}</strong><span>{staff.role}</span>
            {status !== "idle" ? <span className="office-person-bubble">{task ?? t(`status.${status}`)}</span> : null}
          </button>
        </div>;
      })}
    </div>
    {office.staff.some((s) => !placed.has(s.id)) ? <div className="office-overflow-staff">
      <p>{t("scene.extra")}</p>
      {office.staff.filter((s) => !placed.has(s.id)).map((s) => <button key={s.id} onClick={() => onSelectStaff(s.id)}>{s.name} · {s.role}</button>)}
    </div> : null}
  </div>;
}
