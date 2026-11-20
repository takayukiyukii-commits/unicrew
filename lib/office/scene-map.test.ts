import { describe, expect, it } from "vitest";
import { SCENE, sceneRoute } from "./scene-map";
import { allSeats, layoutOffice } from "./layout";
import { lookSample, LOOK_SAMPLES } from "./looks";
import { buildOffice, OFFICE_TEMPLATES } from "./templates";
import { emptyRun } from "./engine";
import { bossStaff, restingNodes, walkChanges } from "../../components/office/office-walk";
import { placeOfficeLabels } from "../../components/office/office-labels";

const company = () => buildOffice({ template: OFFICE_TEMPLATES[0], name: "座標の試験", workspace: "D:/work", now: 1000 });
describe("背景の座標と通路", () => {
  it("全部の座標が背景の内側にある", () => {
    for (const p of Object.values(SCENE.points)) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(1);
    }
  });
  it("6島24席、会議室8席、取りまとめ席が重ならない", () => {
    expect(SCENE.islands).toHaveLength(6);
    SCENE.islands.forEach((island) => expect(island).toHaveLength(4));
    expect(SCENE.meeting).toHaveLength(8);
    const seats = [...SCENE.islands.flat(), ...SCENE.meeting, "lead"];
    expect(new Set(seats.map((id) => JSON.stringify(SCENE.points[id]))).size).toBe(33);
  });
  it("どの席からも会議室・受け渡し口・棚・取りまとめ席へ通路だけで行ける", () => {
    const targets = [...SCENE.meeting, ...SCENE.waiting, "boss", "shelf", "lead", "break"];
    for (const from of [...SCENE.islands.flat(), ...SCENE.meeting, "lead"]) for (const to of targets) {
      const route = sceneRoute(from, to);
      expect(route[0]).toBe(from); expect(route[route.length - 1]).toBe(to);
      for (let i = 1; i < route.length; i++) expect(SCENE.links.some(([a, b]) =>
        (a === route[i - 1] && b === route[i]) || (b === route[i - 1] && a === route[i]))).toBe(true);
    }
    expect(sceneRoute("ない席", "boss")).toEqual([]);
  });
  it("会議室はガラスの外周を横切らず、開いた入口を通る", () => {
    for (const seat of SCENE.meeting) expect(sceneRoute("lead", seat)).toContain("meeting-door");
  });
  it("部署が7つあっても6島に相乗りし、12人全員に違う席を割り当てる", () => {
    const office = company(), base = office.staff[0];
    office.departments = Array.from({ length: 7 }, (_, i) => ({ id: "d" + i, name: "部署" + i, color: "#6366F1" }));
    office.staff = Array.from({ length: 12 }, (_, i) => ({ ...base, id: "s" + i, lead: i === 0, deptId: i < 8 ? "d" + (i - 1) : null }));
    const layout = layoutOffice(office), seats = allSeats(layout);
    expect(layout.islands).toHaveLength(6); expect(seats).toHaveLength(12);
    expect(new Set(seats.map((s) => s.node)).size).toBe(12);
    expect(layout.islands[0].departments.map((d) => d.id)).toContain("d6");
  });
  it("2世代前・前世代・未知の見本IDでも画像が出る", () => {
    expect(LOOK_SAMPLES).toHaveLength(12);
    expect(lookSample("relay").id).toBe("aoi");
    expect(lookSample("navy-short").id).toBe("aoi");
    expect(lookSample("gray-side").id).toBe("haru");
    expect(lookSample("未知").image).toMatch(/\.png$/);
  });
  it("12人の札が受け渡し口に集まっても、重ならず画面内に入る", () => {
    for (const width of [1400, 1920]) {
      const height = width * 9 / 16;
      const boxes = placeOfficeLabels(SCENE.waiting.slice(0, 12).map((id) => ({
        id, x: SCENE.points[id].x * width, y: SCENE.points[id].y * height, w: 112, h: 64,
      })), width, height);
      boxes.forEach((a, i) => {
        expect(a.x).toBeGreaterThanOrEqual(0); expect(a.x + a.w).toBeLessThanOrEqual(width);
        expect(a.y).toBeGreaterThanOrEqual(0); expect(a.y + a.h).toBeLessThanOrEqual(height);
        boxes.slice(i + 1).forEach((b) => expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true));
      });
    }
  });
});
describe("仕事の出来事と移動予定", () => {
  it("依頼の打ち合わせは最大3人、全員到着後に2.5秒、席に戻る", () => {
    const office = company(), member = office.staff.find((s) => !s.lead)!;
    office.staff = [office.staff.find((s) => s.lead)!, ...Array.from({ length: 7 }, (_, i) => ({ ...member, id: "member-" + i }))];
    const layout = layoutOffice(office), before = emptyRun(office);
    const ids = office.staff.filter((s) => !s.lead).map((s) => s.id);
    const after = { ...before, awaiting: ids, staff: { ...before.staff } };
    ids.forEach((id) => { after.staff[id] = { ...before.staff[id], status: "working" }; });
    const steps = walkChanges(before, after, office, layout);
    expect(steps.length).toBeGreaterThan(0);
    steps.filter((s) => s.kind === "meeting").forEach((s) => {
      expect(Object.keys(s.targets).length).toBeLessThanOrEqual(3); expect(s.hold).toBe(2500);
    });
    expect(steps[steps.length - 1].kind).toBe("home");
    expect(walkChanges(after, after, office, layout)).toEqual([]);
  });
  it("許可への返事は打ち合わせをやり直さず席へ戻る", () => {
    const office = company(), layout = layoutOffice(office), base = emptyRun(office);
    const id = office.staff.find((s) => !s.lead)!.id;
    const before = { ...base, permissions: [{ id: "p", staffId: id, requestId: "r", toolName: "tool", text: "許可", at: 10 }],
      staff: { ...base.staff, [id]: { ...base.staff[id], status: "waiting" as const } } };
    const after = { ...base, staff: { ...base.staff, [id]: { ...base.staff[id], status: "working" as const } } };
    expect(walkChanges(before, after, office, layout).map((s) => s.kind)).toEqual(["home"]);
  });
  it("納品と報告が重なると棚→取りまとめ役→席", () => {
    const office = company(), layout = layoutOffice(office), before = emptyRun(office);
    const id = office.staff.find((s) => !s.lead)!.id;
    const after = { ...before, staff: { ...before.staff, [id]: { ...before.staff[id], status: "done" as const } },
      deliveries: [{ id: "d", staffId: id, at: 20, artifact: { path: "out.txt", name: "納品", kind: "file" } } as unknown as typeof before.deliveries[number]] };
    expect(walkChanges(before, after, office, layout).map((s) => s.kind)).toEqual(["delivery", "report", "home"]);
  });
  it("確認・質問・許可待ちを受け渡し口に並べ、返事後は席へ戻す", () => {
    const office = company(), layout = layoutOffice(office), before = emptyRun(office);
    const id = office.staff[0].id;
    const after = { ...before, approval: { id: "a", staffId: id, title: "確認", body: "", file: null, at: 10 },
      log: [{ id: "q", kind: "question" as const, staffId: id, text: "質問", at: 10, answered: false }],
      permissions: [{ id: "p", staffId: id, requestId: "r", toolName: "tool", text: "許可", at: 10 }] };
    expect(bossStaff(after).has(id)).toBe(true);
    expect(restingNodes(after, layout)[id]).toMatch(/^waiting-/);
    expect(walkChanges(before, after, office, layout).some((s) => s.kind === "review")).toBe(true);
    expect(walkChanges(after, before, office, layout)[0].kind).toBe("home");
  });
});
