"use client";

/** 壁のない手渡しデッキ。正投影・疑似影・毎秒30コマ上限。 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import OfficeDeck, { type DeckProps } from "./OfficeDeck";
import { useOfficeMotion } from "./useOfficeMotion";
import { allSeats, deckPoint, deckWorkHeight } from "@/lib/office/layout";
import { lookSample, type LookSample } from "@/lib/office/looks";
import type { StaffStatus } from "@/lib/office/types";

function material(color: string) { return new THREE.MeshStandardMaterial({ color, roughness: 0.82 }); }

/** 角丸の箱。人型のカプセルは使わない。 */
function box(w: number, h: number, d: number, color: string, r = 0.12) {
  r = Math.min(r, w / 3, h / 3);
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const geometry = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, steps: 1, curveSegments: 4 });
  geometry.translate(0, 0, -d / 2);
  return new THREE.Mesh(geometry, material(color));
}
function plate(w: number, d: number, thickness: number, color: string) {
  const mesh = box(w, d, thickness, color, 0.24);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function drawScreen(canvas: HTMLCanvasElement, look: LookSample, status: StaffStatus, image: HTMLImageElement | null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#0F172A"; ctx.fillRect(0, 0, 112, 88);
  if (image) {
    const ratio = Math.min(112 / image.naturalWidth, 88 / image.naturalHeight);
    const w = image.naturalWidth * ratio, h = image.naturalHeight * ratio;
    ctx.drawImage(image, (112 - w) / 2, (88 - h) / 2, w, h);
    return;
  }
  ctx.strokeStyle = look.accent; ctx.lineWidth = 10; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const path = (points: number[]) => {
    ctx.beginPath(); ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
    ctx.stroke();
  };
  if (status === "done") {
    path([20, 36, 32, 24, 44, 36]); path([68, 36, 80, 24, 92, 36]);
    ctx.beginPath(); ctx.moveTo(36, 64); ctx.quadraticCurveTo(56, 84, 76, 64); ctx.stroke();
  } else if (status === "working") {
    path([20, 28, 36, 40, 20, 52]); path([76, 28, 92, 40, 76, 52]); path([44, 72, 68, 72]);
  } else if (status === "waiting") {
    for (const x of [28, 84]) { ctx.beginPath(); ctx.arc(x, 36, 8, 0, Math.PI * 2); ctx.stroke(); }
    path([48, 68, 64, 68]);
  } else { path([24, 36, 24, 48]); path([88, 36, 88, 48]); path([44, 72, 68, 72]); }
}

function crew(look: LookSample) {
  const root = new THREE.Group();
  const width = look.shape === "wide" ? 1 : look.shape === "tall" ? 0.75 : 0.9;
  const height = look.shape === "tall" ? 0.95 : 0.8;
  const hull = box(width, height, 0.56, look.body);
  hull.position.y = 0.72;
  root.add(hull);
  const bezel = box(0.8, 0.65, 0.05, "#0F172A", 0.12);
  bezel.position.set(0, 0.75, 0.3);
  root.add(bezel);
  for (const sx of [-1, 1]) {
    const foot = box(0.15, 0.1, 0.32, look.accent, 0.03);
    foot.position.set(sx * 0.18, 0.22, 0);
    root.add(foot);
  }
  if (look.accessory === "antenna") {
    const stem = box(0.045, 0.22, 0.045, look.body, 0.01);
    stem.position.set(0, 0.85 + height / 2, 0);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), material(look.accent));
    tip.position.set(0, 0.98 + height / 2, 0);
    root.add(stem, tip);
  } else if (look.accessory === "handle") {
    const handle = box(0.48, 0.24, 0.09, look.accent, 0.08);
    handle.position.set(0, 0.8 + height / 2, 0);
    root.add(handle);
    const hole = box(0.28, 0.1, 0.1, look.body, 0.03);
    hole.position.copy(handle.position);
    root.add(hole);
  } else {
    for (const sx of [-1, 1]) {
      const ear = look.accessory === "ears" ? box(0.16, 0.38, 0.24, look.accent, 0.06) :
        new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 3), material(look.accent));
      ear.position.set(sx * (width / 2 + 0.08), 0.78, 0);
      if (look.accessory === "fins") ear.rotation.z = sx * -0.45;
      root.add(ear);
    }
  }
  const canvas = document.createElement("canvas"); canvas.width = 112; canvas.height = 88;
  drawScreen(canvas, look, "idle", null);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.55), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  screen.position.set(0, 0.75, 0.33);
  root.add(screen);
  return { root, canvas, texture, look, image: null as HTMLImageElement | null, status: "" as string };
}

function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(m);
      const texture = (m as THREE.MeshBasicMaterial).map;
      if (texture) textures.add(texture);
    }
  });
  geometries.forEach((g) => g.dispose()); textures.forEach((t) => t.dispose()); materials.forEach((m) => m.dispose());
}

export default function OfficeScene(props: DeckProps & { onUnsupported: () => void }) {
  const { layout, theme, avatarUrls } = props;
  const host = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef(props); latest.current = props;
  const motion = useOfficeMotion(props.active);
  const motionRef = useRef(motion); motionRef.current = motion;
  const wake = useRef<(() => void) | null>(null);
  const key = useMemo(() => JSON.stringify([layout, theme, avatarUrls]), [layout, theme, avatarUrls]);
  useEffect(() => { wake.current?.(); }, [motion.running, motion.reduced]);

  useEffect(() => {
    const element = host.current, surface = canvas.current;
    if (!element || !surface) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: surface, antialias: true, alpha: true, powerPreference: "low-power" }); }
    catch { latest.current.onUnsupported(); return; }
    let alive = true, raf = 0, last = 0;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-13, 13, 7, -7, 0.1, 200);
    camera.position.set(0, 80, 60); camera.lookAt(0, 0, 0);
    scene.add(new THREE.AmbientLight(theme.ambient, theme.ambientIntensity));
    const sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity); sun.position.set(-10, 18, 12); scene.add(sun);

    const upper = plate(25.3, 1, 0.22, theme.floor);
    const stem = plate(8.8, 1, 0.24, theme.floor);
    const edge = plate(25.4, 1, 0.16, theme.wallSide);
    upper.position.y = -0.15; stem.position.y = -0.15; edge.position.y = -0.34;
    scene.add(upper, stem, edge);
    const actors = allSeats(layout).map((seat, index) => {
      const look = lookSample(seat.staff.look.kind === "builtin" ? seat.staff.look.sample : "pearl");
      const actor = { ...crew(look), id: seat.staff.id, phase: index * 0.8 };
      const group = new THREE.Group();
      group.add(actor.root);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.65, 20), new THREE.MeshBasicMaterial({ color: "#0F172A", transparent: true, opacity: 0.07, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01; group.add(shadow);
      scene.add(group);
      const url = seat.staff.look.kind === "image" ? avatarUrls[seat.staff.id] : null;
      if (url) {
        const image = new Image();
        image.onload = () => { if (alive) { actor.image = image; actor.status = ""; } };
        image.src = url;
      }
      return { actor, group };
    });
    const tables = layout.islands.map((island) => {
      const group = new THREE.Group();
      const top = plate(Math.max(1.8, island.w), 0.8, 0.12, theme.desk);
      top.position.set(0, 0.34, 0.55);
      const rail = box(Math.max(1.6, island.w - 0.2), 0.045, 0.04, island.dept?.color ?? "#CBD5E1", 0.01);
      rail.position.set(0, 0.34, 0.98);
      group.add(top, rail); scene.add(group);
      return { island, group };
    });
    const leadTable = plate(2.4, 1.0, 0.16, theme.desk);
    leadTable.position.y = 0.32; scene.add(leadTable);
    const shelf = new THREE.Group();
    const shelfBase = plate(1.6, 1, 0.16, theme.desk);
    shelf.add(shelfBase);
    const stacks: THREE.Mesh[] = [];
    for (let i = 0; i < 100; i++) {
      const paper = plate(0.56, 0.66, 0.045, i % 5 === 0 ? "#C7D2FE" : "#FFFFFF");
      paper.position.set((i % 2 - 0.5) * 0.65, 0.14 + Math.floor(i / 2) * 0.035, 0);
      shelf.add(paper); stacks.push(paper);
    }
    scene.add(shelf);
    const bossTray = plate(2.0, 0.95, 0.12, "#E0E7FF");
    scene.add(bossTray);
    // 画面上の席を正投影の床座標へ戻す。HTML の名札と寸分違わず対応する。
    const place = (object: THREE.Object3D, id: string, dx = 0, dy = 0) => {
      const width = element.clientWidth || 1, height = element.clientHeight || 1;
      const p = deckPoint(layout, id, width, height);
      const scale = width / 26;
      object.position.x = (p.x + dx - width / 2) / scale;
      object.position.z = (p.y + dy - height / 2) / (0.8 * scale);
    };
    const resize = () => {
      const width = element.clientWidth || 1, height = element.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.top = 13 * height / width; camera.bottom = -camera.top; camera.updateProjectionMatrix();
      const scale = width / 26;
      const upperHeight = deckWorkHeight(height) + 6;
      upper.scale.y = upperHeight / (0.8 * scale);
      edge.scale.y = upper.scale.y;
      upper.position.z = edge.position.z = (upperHeight / 2 - height / 2) / (0.8 * scale);
      stem.scale.y = (height - upperHeight - 30) / (0.8 * scale);
      stem.position.x = 36 / scale;
      stem.position.z = (upperHeight + (height - upperHeight - 30) / 2 - height / 2) / (0.8 * scale);
      for (const item of actors) {
        place(item.group, item.actor.id, -68);
        item.group.scale.setScalar(Math.min(1, 44 / scale));
      }
      for (const { island, group } of tables) {
        const a = deckPoint(layout, island.seats[0].staff.id, width, height);
        const b = deckPoint(layout, island.seats[island.seats.length - 1].staff.id, width, height);
        group.position.set(((a.x + b.x) / 2 - width / 2) / scale, 0, (a.y - height / 2) / (0.8 * scale));
      }
      if (layout.lead) place(leadTable, layout.lead.staff.id, 0, 22);
      else leadTable.visible = false;
      place(shelf, "shelf", 0, -28); place(bossTray, "boss");
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(element);
    const tick = (now: number) => {
      raf = 0;
      if (!alive || !motionRef.current.running || document.visibilityState !== "visible") return;
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / 30) return;
      last = now;
      const current = latest.current;
      for (const { actor } of actors) {
        const status = current.needsBoss.has(actor.id) ? "waiting" : current.run.staff[actor.id]?.status ?? "idle";
        actor.root.position.y = motionRef.current.reduced || !current.animateIdle || status !== "idle" ? 0 : Math.sin(now / 2200 + actor.phase) * 0.008;
        if (actor.status !== status) {
          drawScreen(actor.canvas, actor.look, status, actor.image);
          actor.texture.needsUpdate = true; actor.status = status;
        }
      }
      for (let i = 0; i < stacks.length; i++) stacks[i].visible = i < current.run.deliveries.length;
      renderer.render(scene, camera);
    };
    const restart = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (motionRef.current.running) raf = requestAnimationFrame(tick);
    };
    wake.current = restart;
    restart();
    const lost = (event: Event) => { event.preventDefault(); latest.current.onUnsupported(); };
    surface.addEventListener("webglcontextlost", lost);
    return () => {
      alive = false; cancelAnimationFrame(raf); observer.disconnect(); wake.current = null;
      surface.removeEventListener("webglcontextlost", lost);
      disposeTree(scene); renderer.dispose();
    };
    // 席・筐体・画像・雰囲気の変更だけで立体を作り直す。進行状況は ref から読む。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <OfficeDeck {...props} hostRef={host}><canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden="true" /></OfficeDeck>;
}
