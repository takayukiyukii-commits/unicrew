"use client";
import { useEffect, useRef, type RefObject } from "react";
import { allSeats, type OfficeLayout } from "@/lib/office/layout";
import { SCENE, sceneDistance, sceneRoute, type ScenePoint } from "@/lib/office/scene-map";
import type { Office, OfficeRun } from "@/lib/office/types";
import { bossStaff, restingNodes, walkChanges, type WalkStep } from "./office-walk";
import { placeOfficeLabels } from "./office-labels";

interface Actor { node: string; point: ScenePoint; route: string[] }
interface Controller { update: (before: OfficeRun, after: OfficeRun) => void }
/** 移動中だけrequestAnimationFrameを予約する。停止・非表示時は予定も破棄する。 */
export function useOfficeWalk(host: RefObject<HTMLDivElement | null>, office: Office, run: OfficeRun, layout: OfficeLayout, running: boolean, reduced: boolean, chatter: boolean) {
  const latest = useRef(run); latest.current = run;
  const previous = useRef(run);
  const controller = useRef<Controller | null>(null);
  useEffect(() => {
    const surface = host.current;
    if (!surface) return;
    const seats = allSeats(layout);
    const actors = new Map<string, Actor>();
    const nodes = new Map<string, HTMLElement>();
    const labels = new Map<string, HTMLElement>();
    const lines = new Map<string, SVGLineElement>();
    const cheers = new Set<Animation>();
    surface.querySelectorAll<HTMLElement>("[data-actor]").forEach((node) => nodes.set(node.dataset.actor!, node));
    surface.querySelectorAll<HTMLElement>("[data-label]").forEach((node) => labels.set(node.dataset.label!, node));
    surface.querySelectorAll<SVGLineElement>("[data-line]").forEach((node) => lines.set(node.dataset.line!, node));
    let queue: WalkStep[] = [], current: WalkStep | null = null, frame = 0, timer = 0, idleTimer = 0, last = 0, alive = true;
    const reducedNow = () => reduced || !running;
    const reset = () => {
      const destinations = restingNodes(latest.current, layout);
      for (const seat of seats) {
        const node = destinations[seat.staff.id];
        actors.set(seat.staff.id, { node, point: { ...SCENE.points[node] }, route: [] });
      }
    };
    // 札だけを空いた位置へずらす。足元を動かさず、線で社員との対応を示す。
    const paint = () => {
      const width = surface.clientWidth, height = surface.clientHeight;
      const boxes = placeOfficeLabels(seats.flatMap((seat) => {
        const actor = actors.get(seat.staff.id), label = labels.get(seat.staff.id);
        return actor && label ? [{ id: seat.staff.id, x: actor.point.x * width, y: actor.point.y * height, w: label.offsetWidth, h: label.offsetHeight }] : [];
      }), width, height);
      for (const seat of seats) {
        const id = seat.staff.id, actor = actors.get(id), node = nodes.get(id), label = labels.get(id);
        if (!actor || !node || !label) continue;
        const x = actor.point.x * width, y = actor.point.y * height;
        node.style.transform = `translate(${x}px, ${y}px)`;
        node.style.zIndex = String(Math.round(actor.point.y * 100));
        node.dataset.walking = actor.route.length && !reducedNow() ? "true" : "false";
        node.dataset.action = current?.targets[id] ? current.kind : "";
        const atHome = actor.node === seat.node && !actor.route.length;
        node.dataset.working = atHome && latest.current.staff[id]?.status === "working" && !reducedNow() ? "true" : "false";
        const chosen = boxes.find((box) => box.id === id)!;
        label.style.transform = `translate(${chosen.x}px, ${chosen.y}px)`;
        const line = lines.get(id);
        if (line) {
          line.setAttribute("x1", String(x)); line.setAttribute("y1", String(y));
          line.setAttribute("x2", String(chosen.x + chosen.w / 2)); line.setAttribute("y2", String(chosen.y));
        }
      }
    };
    const cancel = () => {
      cancelAnimationFrame(frame); clearTimeout(timer); frame = 0; timer = 0;
      queue = []; current = null;
      for (const actor of actors.values()) actor.route = [];
    };
    const next = () => {
      if (!alive || !running || document.visibilityState !== "visible") return;
      current = queue.shift() ?? null;
      if (!current) { paint(); return; }
      for (const [id, target] of Object.entries(current.targets)) {
        const actor = actors.get(id);
        if (!actor) continue;
        if (reduced) { actor.node = target; actor.point = { ...SCENE.points[target] }; actor.route = []; }
        else {
          // 途中で確認が届いた場合も、いまの区間の端まで歩いてから経路を切り替える。
          const approach = sceneDistance(actor.point, SCENE.points[actor.node]) > .01 ? [actor.node] : [];
          actor.route = [...approach, ...sceneRoute(actor.node, target).slice(1)];
        }
      }
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const tick = (now: number) => {
      frame = 0;
      if (!alive || !running || document.visibilityState !== "visible") { cancel(); return; }
      const budget = Math.min(now - last, 64) * 0.23;
      last = now;
      let walking = false;
      for (const actor of actors.values()) {
        let remaining = budget;
        while (actor.route.length && remaining > 0) {
          const targetId = actor.route[0], target = SCENE.points[targetId];
          const distance = sceneDistance(actor.point, target);
          if (distance <= remaining) { actor.point = { ...target }; actor.node = targetId; actor.route.shift(); remaining -= distance; }
          else {
            const fraction = remaining / distance;
            actor.point = { x: actor.point.x + (target.x - actor.point.x) * fraction, y: actor.point.y + (target.y - actor.point.y) * fraction };
            remaining = 0;
          }
        }
        if (actor.route.length) walking = true;
      }
      paint();
      if (walking) frame = requestAnimationFrame(tick);
      else {
        const hold = current?.hold ?? 0;
        if (hold) timer = window.setTimeout(() => { timer = 0; next(); }, hold);
        else next();
      }
    };
    reset(); paint();
    const resize = new ResizeObserver(paint); resize.observe(surface);
    const api: Controller = { update: (before, after) => {
      if (!running || document.visibilityState !== "visible") { cancel(); reset(); paint(); return; }
      const beforeBoss = bossStaff(before), afterBoss = bossStaff(after);
      const waitingChanged = [...beforeBoss].some((id) => !afterBoss.has(id)) || [...afterBoss].some((id) => !beforeBoss.has(id));
      const stopped = before.busy && !after.busy && after.awaiting.length === 0 &&
        after.log.some((message) => message.kind === "system" && !before.log.some((old) => old.id === message.id)) &&
        Object.keys(after.staff).some((id) => (before.staff[id]?.status === "working" || before.staff[id]?.status === "waiting") && after.staff[id].status === "idle");
      if (stopped) { cancel(); reset(); paint(); return; }
      if (waitingChanged) {
        // 確認待ちを優先。現在地を飛ばさず、近いほうの中継点から通路をたどる。
        for (const actor of actors.values()) {
          const nextNode = actor.route[0];
          if (nextNode && sceneDistance(actor.point, SCENE.points[nextNode]) < sceneDistance(actor.point, SCENE.points[actor.node])) actor.node = nextNode;
        }
        cancel();
        const destinations = restingNodes(after, layout);
        // 同じ更新で届いた納品は棚へ運んでから受け渡し口へ向かう。
        const fresh = walkChanges(before, after, office, layout);
        const involved = new Set(fresh.flatMap((step) => Object.keys(step.targets)));
        queue.push(...fresh);
        for (const seat of seats) if (!involved.has(seat.staff.id)) queue.push({
          kind: afterBoss.has(seat.staff.id) ? "review" : "home", targets: { [seat.staff.id]: destinations[seat.staff.id] }, hold: 0,
        });
      } else queue.push(...walkChanges(before, after, office, layout));
      if (after.cheerAt > before.cheerAt && !reduced) for (const seat of seats) {
        if (after.staff[seat.staff.id]?.status !== "done") continue;
        const cheer = nodes.get(seat.staff.id)?.querySelector(".office-person-image")?.animate([
          { transform: "translateY(0)" }, { transform: "translateY(-9px)", offset: 0.45 }, { transform: "translateY(0)" },
        ], { duration: 480, easing: "ease-out" });
        if (cheer) { cheers.add(cheer); cheer.onfinish = () => cheers.delete(cheer); }
      }
      if (!current && !frame && !timer) next();
      paint();
    } };
    controller.current = api;
    // 待機中の毎コマ処理はしない。にぎやかしON時だけ、時々1人を休憩へ。
    let idleIndex = 0;
    const idle = () => {
      if (!alive || !running || !chatter || reduced || document.visibilityState !== "visible") return;
      if (!current && !queue.length && !latest.current.busy) {
        const available = seats.filter((s) => latest.current.staff[s.staff.id]?.status === "idle" && !bossStaff(latest.current).has(s.staff.id));
        const seat = available[idleIndex++ % Math.max(1, available.length)];
        if (seat) { queue.push({ kind: "break", targets: { [seat.staff.id]: "break" }, hold: 3000 }, { kind: "home", targets: { [seat.staff.id]: seat.node }, hold: 0 }); next(); }
      }
      idleTimer = window.setTimeout(idle, 45000);
    };
    if (running && chatter && !reduced) idleTimer = window.setTimeout(idle, 30000);
    return () => {
      alive = false; cancel(); clearTimeout(idleTimer); resize.disconnect();
      cheers.forEach((animation) => animation.cancel());
      if (controller.current === api) controller.current = null;
    };
  }, [host, office, layout, running, reduced, chatter]);
  useEffect(() => {
    controller.current?.update(previous.current, run);
    previous.current = run;
  }, [run]);
}
