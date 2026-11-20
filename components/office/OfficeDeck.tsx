"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Archive, ArrowDownToLine, Check, FileText, Inbox, Send, Undo2 } from "lucide-react";
import { LookFace } from "./OfficeCrew";
import { handoffsBetween, type Handoff } from "./office-handoffs";
import { useOfficeMotion } from "./useOfficeMotion";
import { allSeats, deckPoint, type OfficeLayout } from "@/lib/office/layout";
import { useOfficeT } from "@/lib/office/i18n";
import { waitingForBoss } from "@/lib/office/engine";
import type { OfficeTheme } from "@/lib/office/themes";
import type { Office, OfficeRun } from "@/lib/office/types";

export interface DeckProps {
  office: Office; run: OfficeRun; layout: OfficeLayout; theme: OfficeTheme;
  avatarUrls: Record<string, string>; active: boolean; animateIdle?: boolean; needsBoss: Set<string>;
  selectedStaffId: string | null; onSelectStaff: (id: string) => void;
}

/** 立体・平面で共有する名札、社長席、納品台と手渡し。文字の大きさは縮めない。 */
export default function OfficeDeck(props: DeckProps & { flat?: boolean; hostRef?: RefObject<HTMLDivElement | null>; children?: ReactNode }) {
  const { office, run, layout, theme, avatarUrls, needsBoss, selectedStaffId, onSelectStaff, flat, children } = props;
  const { t } = useOfficeT();
  const localHost = useRef<HTMLDivElement | null>(null);
  const host = props.hostRef ?? localHost;
  const [size, setSize] = useState({ width: 1200, height: 600 });
  const { running, reduced } = useOfficeMotion(props.active);
  const previous = useRef(run);
  const [packets, setPackets] = useState<(Handoff & { at: number })[]>([]);
  const packetRefs = useRef(new Map<string, HTMLDivElement>());
  const [announcement, setAnnouncement] = useState("");
  const point = (id: string) => deckPoint(layout, id, size.width, size.height);
  const boss = point("boss");
  const shelf = point("shelf");
  const waiting = waitingForBoss(run);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [host]);

  useEffect(() => {
    const fresh = handoffsBetween(previous.current, run, office);
    const stopped = previous.current.busy && !run.busy && !run.approval && Object.values(run.staff).every((s) => s.status === "idle");
    previous.current = run;
    if (!running || stopped) { setPackets([]); return; }
    if (!fresh.length) return;
    const now = performance.now();
    setPackets((items) => [...items.filter((p) => now - p.at < 1900), ...fresh.map((e, i) => ({ ...e, at: now + (i % 6) * 110 }))].slice(-36));
    const last = fresh[fresh.length - 1];
    const name = (id: string) => id === "boss" ? t("deck.boss") : id === "shelf" ? t("deck.shelf") : office.staff.find((s) => s.id === id)?.name ?? "";
    setAnnouncement(t("handoff.route", { kind: t(`handoff.${last.kind}`), from: name(last.from), to: name(last.to) }));
  }, [run, office, running, t]);

  useEffect(() => {
    if (!running || !packets.length) return;
    let frame = 0;
    let last = 0;
    const duration = reduced ? 160 : 1200;
    const routes = packets.map((packet) => ({
      packet,
      a: deckPoint(layout, packet.from, size.width, size.height),
      b: deckPoint(layout, packet.to, size.width, size.height),
    }));
    const tick = (now: number) => {
      if (document.visibilityState !== "visible") return;
      frame = requestAnimationFrame(tick);
      if (now - last < 1000 / 30) return;
      last = now;
      for (const { packet, a, b } of routes) {
        const node = packetRefs.current.get(packet.id);
        if (!node) continue;
        const raw = (now - packet.at) / duration;
        const p = Math.max(0, Math.min(1, raw));
        const ease = p * p * (3 - 2 * p);
        const x = reduced ? b.x : a.x + (b.x - a.x) * ease;
        const stamping = packet.kind === "approved";
        const y = reduced ? b.y : stamping ? b.y - 24 * (1 - Math.min(1, p * 4)) : a.y + (b.y - a.y) * ease - Math.sin(p * Math.PI) * 56;
        node.style.transform = `translate(${x}px, ${y - 35}px) translate(-50%, -50%) rotate(${reduced ? 0 : stamping ? -8 : Math.sin(p * Math.PI * 2) * 8}deg)`;
        node.style.opacity = raw < 0 || raw > 1.3 ? "0" : "1";
      }
    };
    frame = requestAnimationFrame(tick);
    const expiry = window.setTimeout(() => setPackets((items) => items.filter((p) => performance.now() - p.at < duration * 1.3)), duration * 1.3 + 700);
    return () => { cancelAnimationFrame(frame); clearTimeout(expiry); };
  }, [packets, layout, size, running, reduced]);

  return (
    <div ref={host} className={`office-deck ${flat ? "office-deck--flat" : ""}`} data-breathe={props.animateIdle} data-motion={running && !reduced ? "on" : "off"} style={{ background: theme.sky }}>
      {children}
      {flat ? <div className="office-flat-platform" style={{ background: theme.floor }} aria-hidden="true" /> : null}
      {layout.islands.map((island, i) => {
        const first = point(island.seats[0].staff.id);
        const last = point(island.seats[island.seats.length - 1].staff.id);
        return <div key={i}>
          {flat ? <div className="office-flat-table" aria-hidden="true" style={{ left: (first.x + last.x) / 2, top: first.y + 2, width: last.x - first.x + 108, borderBottomColor: island.dept?.color ?? "#CBD5E1", background: theme.desk }} /> : null}
          <div className="office-department" style={{ left: (first.x + last.x) / 2, top: first.y - 54, borderColor: island.dept?.color ?? "#CBD5E1", maxWidth: Math.max(120, last.x - first.x + 140) }}>
            {island.dept?.name ?? t("staff.noDept")}
          </div>
        </div>;
      })}
      {allSeats(layout).map((seat) => {
        const p = point(seat.staff.id);
        const rt = run.staff[seat.staff.id];
        const status = needsBoss.has(seat.staff.id) ? "waiting" : rt?.status ?? "idle";
        const stateText = needsBoss.has(seat.staff.id) ? t("status.waiting") : status === "waiting" ? t("deck.collecting") : t(`status.${status}`);
        const sample = seat.staff.look.kind === "builtin" ? seat.staff.look.sample : "pearl";
        const img = seat.staff.look.kind === "image" ? avatarUrls[seat.staff.id] : null;
        return <div key={seat.staff.id}>
          {flat ? <div className="office-flat-crew" data-status={status} style={{ left: p.x - 68, top: p.y - 46 }}><LookFace sample={sample} image={img} size={60} status={status} /></div> : null}
          <button type="button" onClick={() => onSelectStaff(seat.staff.id)} aria-pressed={selectedStaffId === seat.staff.id}
            title={`${seat.staff.name} · ${seat.staff.role}\n${stateText}\n${rt?.bubble ?? rt?.task ?? ""}`}
            className="office-seat-label" data-status={status} style={{ left: p.x + 26, top: p.y - 30, width: Math.min(144, size.width / 6 - 52) }}>
            <span className="office-seat-name"><LookFace sample={sample} image={img} size={30} status={status} /><strong>{seat.staff.name}</strong></span>
            <span className="office-seat-state"><i />{stateText}</span>
            <span className="office-seat-task">{rt?.bubble ?? rt?.task ?? seat.staff.role}</span>
          </button>
        </div>;
      })}
      <div className="office-boss-port" style={{ left: boss.x, top: boss.y }} data-waiting={waiting > 0}>
        <Inbox size={22} aria-hidden="true" /><strong>{t("deck.boss")}</strong>
        <span>{waiting ? t("deck.waiting", { n: waiting }) : t("deck.ready")}</span>
        {waiting ? <div className="office-review-paper" aria-hidden="true"><FileText size={22} /></div> : null}
      </div>
      <div className="office-shelf-port" style={{ left: shelf.x, top: shelf.y }}>
        {flat ? <div className="office-flat-stack" aria-hidden="true">{run.deliveries.map((d, i) => <i key={d.id} style={{ bottom: Math.floor(i / 2) * 1.2, left: (i % 2) * 32 }} />)}</div> : null}
        <Archive size={18} aria-hidden="true" /><strong>{t("deck.shelf")}</strong><span>{t("top.items", { n: run.deliveries.length })}</span>
      </div>
      <div className="office-deck-plaque"><span>UNICREW</span><strong>{office.name}</strong><span>{t("deck.signature")}</span></div>
      <div className="office-handoffs" aria-hidden="true">
        {packets.map((p) => <div key={p.id} ref={(el) => { if (el) packetRefs.current.set(p.id, el); else packetRefs.current.delete(p.id); }}
          className={`office-packet office-packet--${p.kind}`}>
          {p.kind === "approved" ? <Check size={22} /> : p.kind === "returned" ? <Undo2 size={20} /> : p.kind === "delivery" ? <ArrowDownToLine size={20} /> : p.kind === "request" ? <Send size={18} /> : <FileText size={20} />}
          <span>{t(`handoff.${p.kind}`)}</span>
        </div>)}
      </div>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
