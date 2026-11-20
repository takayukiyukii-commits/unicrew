"use client";

/**
 * AIオフィスの部屋（3D）。three.js で床・机・社員を描き、名札と吹き出しは HTML を重ねる
 * （文字は HTML のほうがくっきり出る・押せる・読み上げにも乗る）。
 *
 * - 見ていないとき（active=false・窓が隠れている）は描画を止める
 * - 毎秒30コマまで。画素の倍率は 1.5 まで（重くしない）
 * - WebGL が使えないPCでは onUnsupported を呼ぶ（呼び出し側が平面の表示に切り替える）
 *
 * 🚨 three は 0.170.0 に固定（0.187 は古い Mac で読めない書き方が入っている。scripts/verify_webkit_compat.mjs）
 */
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { allSeats, type OfficeLayout, type Seat } from "@/lib/office/layout";
import { lookSample, type LookSample } from "@/lib/office/looks";
import type { OfficeTheme } from "@/lib/office/themes";
import type { Office, OfficeRun, StaffStatus } from "@/lib/office/types";

export interface WallAnchor {
  /** 画面上の位置（左上基準の px）と、1単位あたりの px（重ねる HTML の拡大率に使う） */
  x: number;
  y: number;
  scale: number;
}

interface Props {
  office: Office;
  run: OfficeRun;
  layout: OfficeLayout;
  theme: OfficeTheme;
  /** 画像に差し替えた社員の絵（staffId → 表示できる URL） */
  avatarUrls: Record<string, string>;
  active: boolean;
  /** 札（指示の欄・納品）が重なっている幅（px）。部屋はその間に収める */
  insets: { left: number; right: number };
  /** 社長の番で待たせている社員（手を挙げさせる） */
  needsBoss: Set<string>;
  selectedStaffId: string | null;
  onSelectStaff: (id: string) => void;
  onUnsupported: () => void;
  /** 奥の壁に重ねるもの（案件ボード・看板）。位置は毎コマ合わせる */
  wallLeft: React.ReactNode;
  wallRight: React.ReactNode;
  labels: { working: string; waiting: string; done: string; idle: string; resetView: string };
}

interface Actor {
  seat: Seat;
  root: THREE.Group;
  body: THREE.Object3D;
  head: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  screen: THREE.MeshStandardMaterial;
  phase: number;
  doneAt: number;
  lastStatus: StaffStatus;
}

const DESIGN_PX_PER_UNIT = 64;

function mat(color: string, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts });
}

function roundedRectShape(w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function buildHair(look: LookSample): THREE.Group {
  const g = new THREE.Group();
  const m = mat(look.hair, { roughness: 0.7 });
  const cap = (scale = 1.06, phi = Math.PI * 0.56) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.27 * scale, 20, 14, 0, Math.PI * 2, 0, phi), m);
    mesh.position.y = 0.01;
    return mesh;
  };
  switch (look.hairStyle) {
    case "short":
      g.add(cap());
      break;
    case "side": {
      const c = cap(1.07, Math.PI * 0.52);
      c.rotation.z = 0.22;
      g.add(c);
      break;
    }
    case "bob": {
      g.add(cap(1.1, Math.PI * 0.66));
      break;
    }
    case "bun": {
      g.add(cap());
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), m);
      bun.position.set(0, 0.3, -0.04);
      g.add(bun);
      break;
    }
    case "long": {
      g.add(cap(1.09, Math.PI * 0.6));
      const back = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.26, 6, 12), m);
      back.position.set(0, -0.2, -0.13);
      g.add(back);
      break;
    }
    case "spiky": {
      g.add(cap(1.04, Math.PI * 0.5));
      for (let i = 0; i < 5; i++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.17, 8), m);
        const a = (i / 5) * Math.PI * 2;
        cone.position.set(Math.cos(a) * 0.13, 0.27, Math.sin(a) * 0.13);
        cone.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
        g.add(cone);
      }
      break;
    }
    case "curly": {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), m);
        ball.position.set(Math.cos(a) * 0.19, 0.14 + (i % 2) * 0.05, Math.sin(a) * 0.19 - 0.02);
        g.add(ball);
      }
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), m);
      top.position.y = 0.2;
      g.add(top);
      break;
    }
    case "cap": {
      const capM = mat(look.body, { roughness: 0.6 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.285, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), capM);
      dome.position.y = 0.03;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 20, 1, false, 0, Math.PI), capM);
      brim.position.set(0, 0.05, 0.2);
      brim.rotation.y = -Math.PI / 2;
      g.add(dome, brim, cap(1.02, Math.PI * 0.62));
      (g.children[2] as THREE.Mesh).position.y = -0.02;
      break;
    }
  }
  return g;
}

function buildAccessory(look: LookSample): THREE.Object3D | null {
  if (!look.accessory) return null;
  const g = new THREE.Group();
  if (look.accessory === "glasses") {
    const m = mat("#111827", { roughness: 0.4 });
    for (const sx of [-0.1, 0.1]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.012, 8, 20), m);
      ring.position.set(sx, 0.02, 0.245);
      g.add(ring);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 0.012), m);
    bridge.position.set(0, 0.03, 0.25);
    g.add(bridge);
  } else if (look.accessory === "headset") {
    const m = mat("#0f172a", { roughness: 0.5 });
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.285, 0.02, 8, 24, Math.PI), m);
    band.position.y = 0.02;
    const ear = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 14), m);
    ear.rotation.z = Math.PI / 2;
    ear.position.set(0.28, 0, 0);
    const ear2 = ear.clone();
    ear2.position.x = -0.28;
    g.add(band, ear, ear2);
  } else {
    const m = mat("#f43f5e", { roughness: 0.6 });
    for (const sx of [-1, 1]) {
      const bow = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.13, 8), m);
      bow.rotation.z = (sx * Math.PI) / 2;
      bow.position.set(0.14 + sx * 0.06, 0.24, 0.05);
      g.add(bow);
    }
  }
  return g;
}

function buildPerson(look: LookSample, imageTexture: THREE.Texture | null): { root: THREE.Group; body: THREE.Object3D; head: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D } {
  const root = new THREE.Group();
  const bodyM = mat(look.body, { roughness: 0.75 });
  const body = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.3, 8, 16), bodyM);
  torso.position.y = 0.95;
  body.add(torso);
  const mkArm = (sx: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.29, 1.08, 0.04);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.3, 6, 10), bodyM);
    arm.position.set(0, -0.14, 0.14);
    arm.rotation.x = -1.05;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), mat(look.skin));
    hand.position.set(0, -0.24, 0.32);
    pivot.add(arm, hand);
    return pivot;
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);
  body.add(armL, armR);

  const head = new THREE.Group();
  head.position.y = 1.5;
  if (imageTexture) {
    // 差し替えた絵は、丸い札にして顔の位置に立てる（カメラのほうを向かせる）
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.34, 40), new THREE.MeshBasicMaterial({ map: imageTexture, toneMapped: false }));
    const rim = new THREE.Mesh(new THREE.CircleGeometry(0.37, 40), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
    rim.position.z = -0.005;
    const holder = new THREE.Group();
    holder.name = "billboard";
    holder.add(rim, disc);
    head.add(holder);
  } else {
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 18), mat(look.skin, { roughness: 0.9 }));
    head.add(skull);
    const eyeM = mat("#1f2937", { roughness: 0.3 });
    for (const sx of [-0.095, 0.095]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), eyeM);
      eye.position.set(sx, 0.01, 0.238);
      head.add(eye);
    }
    for (const sx of [-0.15, 0.15]) {
      const cheek = new THREE.Mesh(new THREE.CircleGeometry(0.035, 12), new THREE.MeshBasicMaterial({ color: "#ff9db0", transparent: true, opacity: 0.55 }));
      cheek.position.set(sx, -0.06, 0.245);
      cheek.lookAt(sx * 2, -0.06, 2);
      head.add(cheek);
    }
    head.add(buildHair(look));
    const acc = buildAccessory(look);
    if (acc) head.add(acc);
  }
  root.add(body, head);
  return { root, body, head, armL, armR };
}

function buildDesk(theme: OfficeTheme, round: boolean): { group: THREE.Group; screen: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const top = round
    ? new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.08, 40), mat(theme.desk, { roughness: 0.5 }))
    : new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.07, 0.8), mat(theme.desk, { roughness: 0.5 }));
  top.position.set(0, 0.72, round ? 0.75 : 0.62);
  g.add(top);
  if (round) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.035, 10, 48), mat(theme.ring, { emissive: theme.ring, emissiveIntensity: 0.35 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.76, 0.75);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.3, 0.7, 16), mat(theme.deskLeg));
    stem.position.set(0, 0.36, 0.75);
    g.add(ring, stem);
  } else {
    for (const [lx, lz] of [[-0.68, 0.28], [0.68, 0.28], [-0.68, 0.96], [0.68, 0.96]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 8), mat(theme.deskLeg));
      leg.position.set(lx, 0.35, lz);
      g.add(leg);
    }
  }
  // ノートPC
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.025, 0.34), mat("#d7dde7", { roughness: 0.4, metalness: 0.2 }));
  base.position.set(0, 0.775, 0.56);
  const screen = mat("#cbd5e1", { emissive: "#7dd3fc", emissiveIntensity: 0, roughness: 0.3 });
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.02), screen);
  lid.position.set(0, 0.93, 0.74);
  lid.rotation.x = 0.22;
  g.add(base, lid);
  // 椅子
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 20), mat(theme.chair));
  seat.position.set(0, 0.5, -0.02);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.07), mat(theme.chair));
  back.position.set(0, 0.86, -0.3);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.46, 8), mat(theme.deskLeg));
  pole.position.set(0, 0.25, -0.02);
  g.add(seat, back, pole);
  return { group: g, screen };
}

function buildPlant(): THREE.Group {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.32, 14), mat("#e2e8f0"));
  pot.position.y = 0.16;
  g.add(pot);
  const leaf = mat("#34d399", { roughness: 0.7 });
  for (const [x, y, z, r] of [[0, 0.62, 0, 0.3], [0.2, 0.5, 0.05, 0.22], [-0.18, 0.52, -0.06, 0.24], [0.02, 0.86, 0.02, 0.2]]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), leaf);
    b.position.set(x, y, z);
    g.add(b);
  }
  return g;
}

function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else if (m) {
      const map = (m as THREE.MeshBasicMaterial).map;
      if (map) map.dispose();
      m.dispose();
    }
  });
}

export default function OfficeScene(props: Props) {
  const { office, layout, theme, avatarUrls, active, selectedStaffId, onSelectStaff, onUnsupported, labels } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tagRefs = useRef(new Map<string, HTMLDivElement>());
  const bubbleRefs = useRef(new Map<string, HTMLDivElement>());
  const deptRefs = useRef(new Map<string, HTMLDivElement>());
  const wallLeftRef = useRef<HTMLDivElement | null>(null);
  const wallRightRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef(props.run);
  runRef.current = props.run;
  const needsBossRef = useRef(props.needsBoss);
  needsBossRef.current = props.needsBoss;
  const activeRef = useRef(active);
  activeRef.current = active;
  const viewRef = useRef({ yaw: 0, zoom: 1 });
  const insetsRef = useRef(props.insets);
  insetsRef.current = props.insets;
  const placeCameraRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    placeCameraRef.current?.();
  }, [props.insets.left, props.insets.right]);
  const onUnsupportedRef = useRef(onUnsupported);
  onUnsupportedRef.current = onUnsupported;

  const seats = useMemo(() => allSeats(layout), [layout]);
  // 部屋を作り直すきっかけ（人・席・見た目・色が変わったとき）
  const sceneKey = useMemo(
    () =>
      JSON.stringify([
        theme.id,
        layout.width,
        layout.depth,
        seats.map((s) => [s.staff.id, s.x, s.z, s.staff.look, avatarUrls[s.staff.id] ?? ""]),
        layout.islands.map((i) => [i.dept?.id ?? "", i.dept?.color ?? "", i.cx, i.cz, i.w]),
      ]),
    [theme.id, layout, seats, avatarUrls],
  );

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    } catch {
      onUnsupportedRef.current();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    scene.add(new THREE.AmbientLight(theme.ambient, theme.ambientIntensity));
    const sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity);
    sun.position.set(-6, 12, 8);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(theme.ambient, 0.35);
    fill.position.set(8, 6, -4);
    scene.add(fill);

    const W = layout.width;
    const D = layout.depth;
    const backZ = -D / 2 - 0.6;
    // 床・壁
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(roundedRectShape(W + 1.5, D + 1.5, 0.9), 24), mat(theme.floor, { roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -0.1);
    scene.add(floor);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(W + 1.5, 5.4, 0.25), mat(theme.wall, { roughness: 1 }));
    wall.position.set(0, 2.7, backZ - 0.2);
    scene.add(wall);
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.2, D * 0.55), mat(theme.wallSide, { roughness: 1 }));
      side.position.set(sx * (W / 2 + 0.85), 1.6, backZ + D * 0.27);
      scene.add(side);
    }
    // 小物
    const plantSpots: [number, number][] = [[-W / 2 + 0.4, backZ + 1], [W / 2 - 0.4, backZ + 1], [-W / 2 + 0.3, D / 2 - 0.9], [W / 2 - 0.3, D / 2 - 0.9]];
    for (const [px, pz] of plantSpots) {
      const p = buildPlant();
      p.position.set(px, 0, pz);
      scene.add(p);
    }
    // 島の敷物
    for (const isl of layout.islands) {
      const color = isl.dept?.color ?? "#94a3b8";
      const rug = new THREE.Mesh(
        new THREE.ShapeGeometry(roundedRectShape(isl.w, isl.d, 0.45), 16),
        new THREE.MeshStandardMaterial({ color, transparent: true, opacity: theme.dark ? 0.22 : 0.28, roughness: 1 }),
      );
      rug.rotation.x = -Math.PI / 2;
      rug.position.set(isl.cx, 0.012, isl.cz + 0.35);
      const edge = new THREE.Mesh(
        new THREE.ShapeGeometry(roundedRectShape(isl.w + 0.12, isl.d + 0.12, 0.5), 16),
        new THREE.MeshStandardMaterial({ color, transparent: true, opacity: theme.dark ? 0.5 : 0.55, roughness: 1 }),
      );
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(isl.cx, 0.006, isl.cz + 0.35);
      scene.add(edge, rug);
    }
    if (layout.lead) {
      const rug = new THREE.Mesh(new THREE.CircleGeometry(1.75, 48), new THREE.MeshStandardMaterial({ color: theme.ring, transparent: true, opacity: 0.16, roughness: 1 }));
      rug.rotation.x = -Math.PI / 2;
      rug.position.set(layout.lead.x, 0.012, layout.lead.z + 0.6);
      scene.add(rug);
    }

    // 社員と机
    const loader = new THREE.TextureLoader();
    const actors: Actor[] = [];
    const pickables: THREE.Object3D[] = [];
    seats.forEach((seat, i) => {
      const isLead = seat.staff.lead;
      const look = seat.staff.look.kind === "builtin" ? lookSample(seat.staff.look.sample) : { ...lookSample("gray-side"), body: "#64748b" };
      const url = avatarUrls[seat.staff.id];
      let tex: THREE.Texture | null = null;
      if (seat.staff.look.kind === "image" && url) {
        tex = loader.load(url);
        tex.colorSpace = THREE.SRGBColorSpace;
      }
      const group = new THREE.Group();
      group.position.set(seat.x, 0, seat.z);
      const { group: desk, screen } = buildDesk(theme, isLead);
      const person = buildPerson(look, tex);
      person.root.position.set(0, -0.28, -0.02);
      group.add(desk, person.root);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.62, 24), new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: theme.dark ? 0.28 : 0.09 }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(0, 0.02, 0.1);
      group.add(shadow);
      group.userData.staffId = seat.staff.id;
      // 押せる範囲（見えない箱）
      const hit = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.9, 1.4), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.set(0, 0.95, 0.3);
      hit.userData.staffId = seat.staff.id;
      group.add(hit);
      pickables.push(hit);
      scene.add(group);
      actors.push({ seat, root: person.root, body: person.body, head: person.head, armL: person.armL, armR: person.armR, screen, phase: i * 1.7, doneAt: 0, lastStatus: "idle" });
    });

    // カメラ：部屋全体が入る距離に置く
    const target = new THREE.Vector3(0, 0.9, -0.6);
    const placeCamera = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // 札が重なる分を除いた幅に部屋を収め、その真ん中に寄せる（狭い画面では重なりを許す）
      const ins = insetsRef.current;
      const useInsets = w - ins.left - ins.right >= 520;
      const freeW = useInsets ? w - ins.left - ins.right : w;
      const shift = useInsets ? (ins.left - ins.right) / 2 : 0;
      // 画面の下の左右は札が重なるので、部屋を少し上に寄せる（上の帯のぶんは空ける）
      camera.setViewOffset(w, h, -shift, -h * 0.035, w, h);
      const vFov = (camera.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (freeW / h));
      const needW = (W + 2.2) / 2 / Math.tan(hFov / 2);
      const needH = (D + 8.5) / 2 / Math.tan(vFov / 2);
      const dist = Math.max(needW, needH * 0.82) / viewRef.current.zoom;
      const pitch = 0.62;
      const yaw = viewRef.current.yaw;
      camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
      camera.lookAt(target);
      camera.updateProjectionMatrix();
    };
    placeCamera();
    placeCameraRef.current = placeCamera;
    const ro = new ResizeObserver(placeCamera);
    ro.observe(host);

    // 視点：ドラッグで少し回す・ホイールで寄る
    let drag: { x: number; yaw: number } | null = null;
    let moved = 0;
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, yaw: viewRef.current.yaw };
      moved = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      moved = Math.max(moved, Math.abs(e.clientX - drag.x));
      viewRef.current.yaw = Math.max(-0.5, Math.min(0.5, drag.yaw - (e.clientX - drag.x) * 0.004));
      placeCamera();
    };
    const ray = new THREE.Raycaster();
    const onUp = (e: PointerEvent) => {
      const wasDrag = moved > 5;
      drag = null;
      if (wasDrag) return;
      const rect = canvas.getBoundingClientRect();
      const p = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(p, camera);
      const hit = ray.intersectObjects(pickables, false)[0];
      const id = hit?.object.userData.staffId as string | undefined;
      if (id) onSelectRef.current(id);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      viewRef.current.zoom = Math.max(0.8, Math.min(1.9, viewRef.current.zoom * (e.deltaY > 0 ? 0.93 : 1.07)));
      placeCamera();
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    resetRef.current = () => {
      viewRef.current = { yaw: 0, zoom: 1 };
      placeCamera();
    };

    const v = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const place = (el: HTMLElement | null | undefined, x: number, y: number, z: number, opts: { scale?: boolean; anchor?: string; min?: number; max?: number } = {}) => {
      if (!el) return;
      v.set(x, y, z).project(camera);
      const w = host.clientWidth;
      const h = host.clientHeight;
      const px = (v.x * 0.5 + 0.5) * w;
      const py = (-v.y * 0.5 + 0.5) * h;
      let scale = 1;
      if (opts.scale) {
        v2.set(x + 1, y, z).project(camera);
        scale = Math.abs((v2.x * 0.5 + 0.5) * w - px) / DESIGN_PX_PER_UNIT;
        if (opts.min !== undefined) scale = Math.max(opts.min, scale);
        if (opts.max !== undefined) scale = Math.min(opts.max, scale);
      }
      el.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(${opts.anchor ?? "-50%, -50%"}) scale(${scale.toFixed(3)})`;
      el.style.visibility = v.z < 1 ? "visible" : "hidden";
    };

    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!activeRef.current || document.visibilityState !== "visible") return;
      if (now - last < 33) return;
      last = now;
      const t = now / 1000;
      const run = runRef.current;
      for (let ai = 0; ai < actors.length; ai++) {
        const a = actors[ai];
        const rt = run.staff[a.seat.staff.id];
        const status: StaffStatus = rt?.status ?? "idle";
        const raised = needsBossRef.current.has(a.seat.staff.id);
        if (status === "done" && a.lastStatus !== "done") a.doneAt = t;
        a.lastStatus = status;
        const p = t + a.phase;
        let bob = Math.sin(p * 1.4) * 0.012;
        let lean = 0;
        let headYaw = Math.sin(p * 0.37) * 0.18;
        let headTilt = 0;
        let la = 0;
        let ra = 0;
        let glow = 0;
        if (status === "working") {
          bob = Math.sin(p * 5) * 0.012;
          lean = 0.1;
          headYaw = Math.sin(p * 0.9) * 0.06;
          headTilt = 0.12;
          la = Math.sin(p * 17) * 0.12;
          ra = Math.sin(p * 17 + 2.1) * 0.12;
          glow = 0.75 + Math.sin(p * 3) * 0.2;
        } else if (raised) {
          ra = -2.2 + Math.sin(p * 6) * 0.18;
          headYaw = 0;
          glow = 0.25;
        } else if (status === "waiting") {
          headYaw = Math.sin(p * 0.6) * 0.3;
          glow = 0.35;
        } else if (status === "done") {
          const since = t - a.doneAt;
          if (since < 1.6) {
            bob = Math.abs(Math.sin(since * 7)) * 0.16 * (1 - since / 1.6);
            la = -2.3;
            ra = -2.3;
          }
          glow = 0.15;
        }
        a.root.position.y = -0.28 + bob;
        a.body.rotation.x = lean;
        a.head.rotation.set(headTilt, headYaw, 0);
        a.armL.rotation.x = la;
        a.armR.rotation.x = ra;
        a.screen.emissiveIntensity = glow;
        const bb = a.head.getObjectByName("billboard");
        if (bb) bb.quaternion.copy(camera.quaternion).premultiply(a.head.getWorldQuaternion(new THREE.Quaternion()).invert());
        place(tagRefs.current.get(a.seat.staff.id), a.seat.x, 0.05, a.seat.z + 1.42, { anchor: "-50%, 0%", scale: true, min: 0.62, max: 1 });
        // 隣どうしの吹き出しが重ならないよう、1つおきに高さをずらす
        place(bubbleRefs.current.get(a.seat.staff.id), a.seat.x, 1.72 + (ai % 2) * 0.42 + bob, a.seat.z, { anchor: "-50%, -100%", scale: true, min: 0.7, max: 1.05 });
      }
      for (const isl of layout.islands) {
        if (isl.dept) place(deptRefs.current.get(`${isl.dept.id}:${isl.cx}`), isl.cx, 0.05, isl.cz - isl.d / 2 + 0.25, { anchor: "-50%, -50%", scale: true, min: 0.65, max: 1.1 });
      }
      place(wallLeftRef.current, -W / 2 + 0.6, 5.0, backZ, { scale: true, anchor: "0%, 0%", min: 0.72, max: 1.1 });
      place(wallRightRef.current, W / 2 - 0.6, 5.0, backZ, { scale: true, anchor: "-100%, 0%", min: 0.72, max: 1.1 });
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      resetRef.current = null;
      placeCameraRef.current = null;
      disposeTree(scene);
      renderer.dispose();
    };
    // sceneKey が変わったときだけ作り直す（run は ref で読む）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey]);

  const onSelectRef = useRef(onSelectStaff);
  onSelectRef.current = onSelectStaff;
  const resetRef = useRef<(() => void) | null>(null);

  const statusLabel = (s: StaffStatus, raised: boolean) => (raised ? labels.waiting : s === "working" || s === "waiting" ? labels.working : s === "done" ? labels.done : labels.idle);

  return (
    <div ref={hostRef} className="office-scene absolute inset-0 overflow-hidden select-none" style={{ background: theme.sky }}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing" aria-hidden="true" />
      <div className="pointer-events-none absolute left-0 top-0 h-0 w-0">
        <div ref={wallLeftRef} className="pointer-events-auto absolute left-0 top-0 origin-top-left will-change-transform">
          {props.wallLeft}
        </div>
        <div ref={wallRightRef} className="pointer-events-auto absolute left-0 top-0 origin-top-right will-change-transform">
          {props.wallRight}
        </div>
        {layout.islands.map((isl) =>
          isl.dept ? (
            <div
              key={`${isl.dept.id}:${isl.cx}`}
              ref={(el) => {
                const k = `${isl.dept!.id}:${isl.cx}`;
                if (el) deptRefs.current.set(k, el);
                else deptRefs.current.delete(k);
              }}
              className="absolute left-0 top-0 whitespace-nowrap rounded-full px-3 py-1 text-[14px] font-bold text-white shadow-md will-change-transform"
              style={{ background: isl.dept.color }}
            >
              {isl.dept.name}
            </div>
          ) : null,
        )}
        {seats.map((seat) => {
          const rt = props.run.staff[seat.staff.id];
          const status = rt?.status ?? "idle";
          const raised = props.needsBoss.has(seat.staff.id);
          const color = seat.staff.lead ? theme.ring : office.departments.find((d) => d.id === seat.staff.deptId)?.color ?? "#94a3b8";
          const img = seat.staff.look.kind === "image" ? avatarUrls[seat.staff.id] : null;
          const look = seat.staff.look.kind === "builtin" ? lookSample(seat.staff.look.sample) : null;
          const showBubble = !!rt?.bubble && status !== "idle";
          return (
            <div key={seat.staff.id}>
              <div
                ref={(el) => {
                  if (el) bubbleRefs.current.set(seat.staff.id, el);
                  else bubbleRefs.current.delete(seat.staff.id);
                }}
                className={`office-bubble absolute left-0 top-0 origin-bottom will-change-transform ${showBubble ? "" : "opacity-0"}`}
                aria-hidden={!showBubble}
              >
                <div
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-semibold shadow-lg ${
                    raised ? "bg-rose-500 text-white" : status === "done" ? "bg-emerald-500 text-white" : "bg-slate-900/90 text-white"
                  }`}
                >
                  {status === "working" && !raised ? (
                    <span className="office-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : null}
                  <span className="max-w-[168px] overflow-hidden text-ellipsis">{rt?.bubble ?? ""}</span>
                </div>
              </div>
              <button
                type="button"
                ref={(el) => {
                  if (el) tagRefs.current.set(seat.staff.id, el as unknown as HTMLDivElement);
                  else tagRefs.current.delete(seat.staff.id);
                }}
                onClick={() => onSelectStaff(seat.staff.id)}
                title={`${seat.staff.name}（${seat.staff.role}）— ${statusLabel(status, raised)}`}
                className={`pointer-events-auto absolute left-0 top-0 flex origin-top items-center gap-2 whitespace-nowrap rounded-full border py-1 pl-1 pr-3 text-left shadow-md transition-shadow will-change-transform hover:shadow-lg ${
                  theme.dark ? "border-white/10 bg-slate-900/85 text-slate-100" : "border-slate-200/80 bg-white/95 text-slate-900"
                } ${selectedStaffId === seat.staff.id ? "ring-2 ring-offset-1" : ""}`}
                style={selectedStaffId === seat.staff.id ? ({ "--tw-ring-color": color } as React.CSSProperties) : undefined}
              >
                <span
                  className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-[13px] font-bold text-white"
                  style={{ background: look?.body ?? color, boxShadow: `0 0 0 2px ${theme.dark ? "#0f172a" : "#fff"}, 0 0 0 4px ${color}` }}
                >
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt="" className="h-full w-full object-cover" />
                  ) : (
                    seat.staff.name.slice(0, 1)
                  )}
                </span>
                <span className="leading-tight">
                  <span className="block text-[13px] font-bold">{seat.staff.name}</span>
                  <span className={`block max-w-[104px] overflow-hidden text-ellipsis text-[11px] ${theme.dark ? "text-slate-400" : "text-slate-500"}`}>{seat.staff.role}</span>
                </span>
                {raised ? <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[12px] font-bold text-white">!</span> : null}
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => resetRef.current?.()}
        className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border px-3 py-1.5 text-[12px] font-semibold shadow-md ${
          theme.dark ? "border-white/10 bg-slate-900/80 text-slate-200" : "border-slate-200 bg-white/90 text-slate-700"
        }`}
      >
        {labels.resetView}
      </button>
    </div>
  );
}
