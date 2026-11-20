"use client";
import { useEffect, useRef, type RefObject } from "react";
import { allSeats, type OfficeLayout } from "@/lib/office/layout";
import { SCENE, sceneDistance, sceneRoute, type ScenePoint } from "@/lib/office/scene-map";
import type { Office, OfficeRun } from "@/lib/office/types";
import { bossStaff, restingNodes, walkChanges, type WalkLines, type WalkStep } from "./office-walk";
import { placeOfficeLabels } from "./office-labels";

interface Actor {
  node: string; point: ScenePoint; route: string[];
  /** 歩いている向き（止まっているときは、いる場所で決める） */
  facing: "front" | "back" | "side";
  /** 横向きのとき、左を向いているか */
  flip: boolean;
  /** 歩き出すまでの待ち（出社のとき、1人ずつ間をあけて入る） */
  delay: number;
  /** まだ扉の外にいる（描かない） */
  outside: boolean;
  /** 道の途中の「@wait:ミリ秒」で立ち止まっている間の終わりの時刻 */
  pauseUntil: number;
  /** 最後に調べものへ行った時刻（行ったり来たりを繰り返さない） */
  researchAt: number;
}
/** 止まっているときの姿。席では座る（奥の席＝こちら向き／手前の席・取りまとめ役＝背中）。会議室では机のほうを向く */
function restPose(node: string, actor: Actor): { pose: string; flip: boolean } {
  const seat = /^seat-\d+-(\d)$/.exec(node);
  if (seat) return { pose: Number(seat[1]) < 2 ? "sit-front" : "sit-back", flip: false };
  if (node === "lead") return { pose: "sit-back", flip: false };
  const meeting = /^meeting-(\d)$/.exec(node);
  if (meeting) return { pose: "side", flip: Number(meeting[1]) >= 4 };
  if (node === "report") return { pose: "side", flip: true };
  if (node.startsWith("books-")) return { pose: "back", flip: false };
  if (node.startsWith("waiting-") || node === "boss" || node === "shelf" || node === "break") return { pose: "front", flip: false };
  return { pose: actor.facing, flip: actor.flip };
}
/** この起動で「出社」を見せた会社（画面を切り替えるたびに入り直さない） */
const entered = new Set<string>();
/** 調べものの道具（読む・探す・Web）か。道具の名前は AI ごとに違うので、含まれる語で見る */
function isResearchTool(name: string): boolean {
  const n = name.toLowerCase();
  return /read|grep|glob|search|fetch|list|find|open/.test(n) && !/write|edit|patch/.test(n);
}
interface Controller { update: (before: OfficeRun, after: OfficeRun) => void }
/** 移動中だけrequestAnimationFrameを予約する。停止・非表示時は予定も破棄する。 */
export function useOfficeWalk(host: RefObject<HTMLDivElement | null>, office: Office, run: OfficeRun, layout: OfficeLayout, running: boolean, reduced: boolean, chatter: boolean, lines: WalkLines, smallTalk: string[]) {
  const linesRef = useRef(lines); linesRef.current = lines;
  const smallTalkRef = useRef(smallTalk); smallTalkRef.current = smallTalk;
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
    const speeches = new Map<string, HTMLElement>();
    const talkTimers = new Set<number>();
    const speechTimers = new Map<string, number>();
    surface.querySelectorAll<HTMLElement>("[data-actor]").forEach((node) => nodes.set(node.dataset.actor!, node));
    surface.querySelectorAll<HTMLElement>("[data-label]").forEach((node) => labels.set(node.dataset.label!, node));
    surface.querySelectorAll<SVGLineElement>("[data-line]").forEach((node) => lines.set(node.dataset.line!, node));
    surface.querySelectorAll<HTMLElement>("[data-speech]").forEach((node) => speeches.set(node.dataset.speech!, node));
    /** 頭の上に、会話の吹き出しを数秒だけ出す */
    const say = (id: string, text: string, ms = 2300) => {
      const el = speeches.get(id);
      if (!el || !text) return;
      el.textContent = text;
      el.dataset.show = "true";
      clearTimeout(speechTimers.get(id));
      speechTimers.set(id, window.setTimeout(() => { el.dataset.show = "false"; }, ms));
    };
    const hush = () => {
      talkTimers.forEach((t) => clearTimeout(t)); talkTimers.clear();
      speechTimers.forEach((t) => clearTimeout(t)); speechTimers.clear();
      speeches.forEach((el) => { el.dataset.show = "false"; });
    };
    let queue: WalkStep[] = [], current: WalkStep | null = null, frame = 0, timer = 0, idleTimer = 0, last = 0, alive = true;
    const reducedNow = () => reduced || !running;
    const reset = () => {
      const destinations = restingNodes(latest.current, layout);
      for (const seat of seats) {
        const node = destinations[seat.staff.id];
        actors.set(seat.staff.id, { node, point: { ...SCENE.points[node] }, route: [], facing: "front", flip: false, delay: 0, outside: false, pauseUntil: 0, researchAt: 0 });
      }
    };
    // 札だけを空いた位置へずらす。足元を動かさず、線で社員との対応を示す。
    const paint = () => {
      const width = surface.clientWidth, height = surface.clientHeight;
      // 社員の絵・吹き出しは、部屋の大きさに合わせて伸び縮みさせる（席と絵がずれない）
      surface.style.setProperty("--s", String(width / SCENE.width));
      const boxes = placeOfficeLabels(seats.flatMap((seat) => {
        const actor = actors.get(seat.staff.id), label = labels.get(seat.staff.id);
        return actor && label ? [{ id: seat.staff.id, x: actor.point.x * width, y: actor.point.y * height, w: label.offsetWidth, h: label.offsetHeight }] : [];
      }), width, height);
      for (const seat of seats) {
        const id = seat.staff.id, actor = actors.get(id), node = nodes.get(id), label = labels.get(id);
        if (!actor || !node || !label) continue;
        const x = actor.point.x * width, y = actor.point.y * height;
        // どの絵を出すか：歩いているときは進む向き、止まっているときは「そこで何をしているか」で決める
        const moving = actor.route.length > 0 && !actor.delay && !actor.pauseUntil;
        const pose = moving ? { pose: actor.facing, flip: actor.flip } : restPose(actor.node, actor);
        if (node.dataset.pose !== pose.pose) {
          node.dataset.pose = pose.pose;
          const img = node.querySelector<HTMLImageElement>("img.office-crew-face");
          const base = node.dataset.sprite;
          if (img && base) {
            // 向きの絵が無い見本（あとから足した見本など）は、正面の絵のままにする
            img.onerror = () => { img.onerror = null; img.src = `${base}.png`; };
            img.src = pose.pose === "front" ? `${base}.png` : `${base}-${pose.pose}.png`;
          }
        }
        node.dataset.flip = pose.flip ? "true" : "false";
        // 座っているときは、腰が椅子の座面に来るように絵をずらす（背中向き＝椅子の背もたれから頭と肩が出る／こちら向き＝画面の向こうに体が隠れる）。
        // 前後関係（z-index）は足元の y のまま＝椅子と机にはさまれる順番は変えない
        const lift = pose.pose === "sit-back" ? -36 : pose.pose === "sit-front" ? 14 : 0;
        node.style.transform = `translate(${x}px, ${y + lift * (width / SCENE.width)}px)`;
        node.style.visibility = actor.outside ? "hidden" : "visible";
        // 歩いている間は名札を出さない（線が部屋じゅうに伸びて見づらくなる）。着いたら出す
        const walkingNow = actor.route.length > 0 && !actor.pauseUntil;
        label.style.visibility = actor.outside || walkingNow ? "hidden" : "visible";
        const lineEl = lines.get(id);
        if (lineEl) lineEl.style.visibility = actor.outside || walkingNow ? "hidden" : "visible";
        // 前後関係：足元の y が大きい（手前にいる）ほど上に描く。家具の重ね絵（scene-front.ts）も同じ物差しを使う
        node.style.zIndex = String(Math.round(actor.point.y * 1000));
        node.dataset.walking = actor.route.length && !actor.delay && !actor.pauseUntil && !reducedNow() ? "true" : "false";
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
      hush();
      surface.dataset.door = "closed";
      for (const actor of actors.values()) { actor.route = []; actor.delay = 0; actor.outside = false; actor.pauseUntil = 0; }
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
          actor.pauseUntil = 0;
        }
      }
      if (current.kind === "enter" && !reduced) {
        // 出社：扉が開いて、1人ずつ間をあけて入ってくる
        surface.dataset.door = "open";
        Object.keys(current.targets).forEach((id, i) => { const actor = actors.get(id); if (actor) { actor.delay = 350 + i * 520; actor.outside = true; } });
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
      const elapsed = budget / 0.23;
      for (const actor of actors.values()) {
        if (actor.delay > 0) {
          actor.delay = Math.max(0, actor.delay - elapsed);
          if (actor.delay === 0) actor.outside = false;
          walking = true;
          continue;
        }
        let remaining = budget;
        while (actor.route.length && remaining > 0) {
          if (actor.route[0].startsWith("@wait:")) {
            // 道の途中で立ち止まる（棚の前で資料を見る、など）
            if (!actor.pauseUntil) actor.pauseUntil = now + Number(actor.route[0].slice(6));
            if (now < actor.pauseUntil) break;
            actor.pauseUntil = 0; actor.route.shift();
            continue;
          }
          const targetId = actor.route[0], target = SCENE.points[targetId];
          const distance = sceneDistance(actor.point, target);
          const dx = (target.x - actor.point.x) * SCENE.width, dy = (target.y - actor.point.y) * SCENE.height;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            if (Math.abs(dx) >= Math.abs(dy)) { actor.facing = "side"; actor.flip = dx < 0; }
            else { actor.facing = dy > 0 ? "front" : "back"; actor.flip = false; }
          }
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
      // 予定に入っている人が着いたら、ほかの人（調べものの途中など）を待たずに会話・次の予定へ進む
      const stepWalking = current ? Object.keys(current.targets).some((id) => { const a = actors.get(id); return !!a && (a.route.length > 0 || a.delay > 0); }) : false;
      if (current && !stepWalking && !timer) {
        if (current.kind === "enter") surface.dataset.door = "closed";
        for (const line of current.talk ?? []) {
          const t = window.setTimeout(() => { talkTimers.delete(t); say(line.id, line.text); }, line.delay);
          talkTimers.add(t);
        }
        const hold = current.hold;
        current = null;
        timer = window.setTimeout(() => { timer = 0; next(); }, hold);
      }
      if (walking) frame = requestAnimationFrame(tick);
      else if (!current && !timer) next();
    };
    reset(); paint();
    // 出社：この起動で初めて開いた会社は、扉から入ってくるところを見せる（仕事の途中・確認待ちのときは出さない）
    if (running && !reduced && !entered.has(office.id) && !latest.current.busy && bossStaff(latest.current).size === 0 && document.visibilityState === "visible") {
      entered.add(office.id);
      const targets: Record<string, string> = {};
      for (const seat of seats) {
        const actor = actors.get(seat.staff.id);
        if (!actor) continue;
        actor.node = "door"; actor.point = { ...SCENE.points.door };
        targets[seat.staff.id] = seat.node;
      }
      queue.push({ kind: "enter", targets, hold: 0 });
      paint();
      timer = window.setTimeout(() => { timer = 0; next(); }, 600);
    } else entered.add(office.id);
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
        const fresh = walkChanges(before, after, office, layout, linesRef.current);
        const involved = new Set(fresh.flatMap((step) => Object.keys(step.targets)));
        queue.push(...fresh);
        for (const seat of seats) if (!involved.has(seat.staff.id)) queue.push({
          kind: afterBoss.has(seat.staff.id) ? "review" : "home", targets: { [seat.staff.id]: destinations[seat.staff.id] }, hold: 0,
        });
      } else queue.push(...walkChanges(before, after, office, layout, linesRef.current));
      // 作業に応じて動く：資料を読む・探す・Web で調べる道具を使い始めたら、いちばん近い資料の棚まで見に行って戻る
      if (!reduced) for (const seat of seats) {
        const id = seat.staff.id, actor = actors.get(id);
        const rt = after.staff[id];
        if (!actor || !rt || rt.status !== "working" || afterBoss.has(id)) continue;
        if (actor.node !== seat.node || actor.route.length || actor.delay) continue;
        if (queue.some((s) => s.targets[id]) || current?.targets[id]) continue;
        const now = performance.now();
        if (now - actor.researchAt < 9000) continue;
        const fresh = Object.entries(rt.tools).find(([toolId, t]) => !t.done && !before.staff[id]?.tools[toolId] && isResearchTool(t.name));
        if (!fresh) continue;
        let best = SCENE.books[0];
        for (const b of SCENE.books) if (Math.abs(SCENE.points[b].x - seat.x) < Math.abs(SCENE.points[best].x - seat.x)) best = b;
        const go = sceneRoute(seat.node, best).slice(1);
        const back = sceneRoute(best, seat.node).slice(1);
        if (!go.length || !back.length) continue;
        actor.researchAt = now;
        actor.route = [...go, "@wait:1500", ...back];
        if (!frame) { last = now; frame = requestAnimationFrame(tick); }
      }
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
        const chat = smallTalkRef.current;
        if (seat) { queue.push({ kind: "break", targets: { [seat.staff.id]: "break" }, hold: 3000, talk: chat.length ? [{ id: seat.staff.id, text: chat[idleIndex % chat.length], delay: 300 }] : undefined }, { kind: "home", targets: { [seat.staff.id]: seat.node }, hold: 0 }); next(); }
      }
      idleTimer = window.setTimeout(idle, 45000);
    };
    if (running && chatter && !reduced) idleTimer = window.setTimeout(idle, 30000);
    return () => {
      // 出社の途中で作り直しになったら、次にもう一度入り直せるようにする（途中で消えて、席に瞬間移動して終わるのを防ぐ）
      if (current?.kind === "enter" || queue.some((step) => step.kind === "enter")) entered.delete(office.id);
      alive = false; cancel(); hush(); clearTimeout(idleTimer); resize.disconnect();
      cheers.forEach((animation) => animation.cancel());
      if (controller.current === api) controller.current = null;
    };
  }, [host, office, layout, running, reduced, chatter]);
  useEffect(() => {
    controller.current?.update(previous.current, run);
    previous.current = run;
  }, [run]);
}
