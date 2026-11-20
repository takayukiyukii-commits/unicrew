"use client";

/**
 * AIオフィスの画面全体。会社を選ぶ・作る → 部屋を出す → 指示を送る、までをまとめる。
 *
 * 状態の持ち方:
 * - 会社の名簿（offices）と、選んでいる会社の「いま」（run）をここで持ち、変わるたびに保存する
 * - AI とのやり取りは OfficeRunner に任せる（ここは画面だけ）
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2 } from "lucide-react";
import OfficeFloor2D from "@/components/office/OfficeFloor2D";
import { CompanyPanel, OfficeSetup, StaffPanel, newStaff } from "@/components/office/OfficeDialogs";
import { BossDesk, OfficeBoard, OfficeSide, OfficeSign, OfficeTicker, OfficeTopBar } from "@/components/office/OfficePanels";
import { emptyRun, reconcileRun } from "@/lib/office/engine";
import { useOfficeT } from "@/lib/office/i18n";
import { layoutOffice } from "@/lib/office/layout";
import { OfficeRunner } from "@/lib/office/runner";
import { deleteRun, loadActiveOfficeId, loadOffices, loadRun, saveActiveOfficeId, saveOffices, saveRun } from "@/lib/office/store";
import { officeTheme } from "@/lib/office/themes";
import type { Office, OfficeRun, Staff } from "@/lib/office/types";
import { openPreviewWindow } from "@/lib/preview-window";
import { loadLastWorkspace, saveLastWorkspace } from "@/lib/storage";
import { avatarSrc, isTauri, pickWorkspace, revealInFileManager } from "@/lib/tauri";
import type { AppSettings } from "@/lib/types";

const OfficeScene = dynamic(() => import("@/components/office/OfficeScene"), { ssr: false });

const CHATTER_KEY = "unicrew.office.chatter.v1";
const CHATTER_JA = ["コーヒー淹れてこよ", "今日はいい天気だな", "お昼なに食べよう", "肩こったなあ", "この前の件、うまくいってよかった", "机、片づけようかな"];
const CHATTER_EN = ["Coffee time", "Nice weather today", "What's for lunch?", "Time to stretch", "Glad that last one worked out", "Should tidy my desk"];

interface Props {
  /** いまこの画面が表に出ているか（隠れている間は部屋の描画を止める） */
  active: boolean;
  settings: AppSettings;
  /** 選んでいる会社の作業フォルダが変わったら知らせる（ターミナルの作業フォルダに使う） */
  onWorkspaceChange?: (workspace: string | null) => void;
}

function absPath(file: string, workspace: string | null): string {
  if (/^[a-zA-Z]:[\\/]|^[\\/]|^https?:/.test(file) || !workspace) return file;
  return `${workspace.replace(/[\\/]+$/, "")}/${file.replace(/^\.[\\/]/, "")}`;
}

export default function OfficeView({ active, settings, onWorkspaceChange }: Props) {
  const { t, locale } = useOfficeT();
  const [hydrated, setHydrated] = useState(false);
  const [offices, setOffices] = useState<Office[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [run, setRun] = useState<OfficeRun | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "company" | "setup">("none");
  const [flat, setFlat] = useState(false);
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});
  const [chatter, setChatter] = useState(true);
  const [chatterBubble, setChatterBubble] = useState<{ staffId: string; text: string } | null>(null);

  const office = useMemo(() => offices.find((o) => o.id === activeId) ?? null, [offices, activeId]);
  const officeRef = useRef(office);
  officeRef.current = office;
  const runRef = useRef(run);
  runRef.current = run;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const runnerRef = useRef<OfficeRunner | null>(null);

  // 読み込み
  useEffect(() => {
    const list = loadOffices();
    const id = loadActiveOfficeId();
    const cur = list.find((o) => o.id === id) ?? list[0] ?? null;
    setOffices(list);
    setActiveId(cur?.id ?? null);
    setRun(cur ? loadRun(cur) : null);
    if (list.length === 0) setPanel("setup");
    try {
      setChatter(window.localStorage.getItem(CHATTER_KEY) !== "0");
    } catch {
      /* 読めなければ既定のまま */
    }
    setHydrated(true);
  }, []);

  // AI とつなぐ係
  useEffect(() => {
    const runner = new OfficeRunner({
      getOffice: () => officeRef.current,
      getRun: () => runRef.current,
      setRun: (next) => {
        runRef.current = next;
        setRun(next);
      },
      getSettings: () => settingsRef.current,
    });
    runnerRef.current = runner;
    void runner.attach();
    return () => {
      runner.dispose();
      runnerRef.current = null;
    };
  }, []);

  // 保存（「いま」は細かく変わるので、少しまとめて書く）
  useEffect(() => {
    if (!hydrated || !run) return;
    const id = setTimeout(() => saveRun(run), 400);
    return () => clearTimeout(id);
  }, [run, hydrated]);
  useEffect(() => {
    if (hydrated) saveOffices(offices);
  }, [offices, hydrated]);
  useEffect(() => {
    if (hydrated) saveActiveOfficeId(activeId);
  }, [activeId, hydrated]);
  useEffect(() => {
    onWorkspaceChange?.(office?.workspace ?? null);
  }, [office?.workspace, onWorkspaceChange]);

  // 差し替えた絵を表示できる形にする
  const lookKey = office ? office.staff.map((s) => (s.look.kind === "image" ? `${s.id}=${s.look.path}` : "")).join("|") : "";
  useEffect(() => {
    let alive = true;
    const cur = officeRef.current;
    if (!cur) return;
    void Promise.all(
      cur.staff
        .filter((s) => s.look.kind === "image")
        .map(async (s) => {
          try {
            return [s.id, await avatarSrc((s.look as { path: string }).path)] as const;
          } catch {
            return [s.id, ""] as const;
          }
        }),
    ).then((pairs) => {
      if (alive) setAvatarUrls(Object.fromEntries(pairs.filter(([, url]) => !!url)));
    });
    return () => {
      alive = false;
    };
  }, [lookKey]);

  // にぎやかしの独り言（手が空いている社員が、ときどき一言）。仕事の実況とは別物
  useEffect(() => {
    if (!chatter || !active) return;
    const id = setInterval(() => {
      const cur = officeRef.current;
      const r = runRef.current;
      if (!cur || !r || document.visibilityState !== "visible") return;
      const idle = cur.staff.filter((s) => (r.staff[s.id]?.status ?? "idle") === "idle");
      if (idle.length === 0 || Math.random() < 0.45) return;
      const who = idle[Math.floor(Math.random() * idle.length)];
      const lines = locale === "ja" ? CHATTER_JA : CHATTER_EN;
      setChatterBubble({ staffId: who.id, text: lines[Math.floor(Math.random() * lines.length)] });
      setTimeout(() => setChatterBubble((b) => (b?.staffId === who.id ? null : b)), 4200);
    }, 14_000);
    return () => clearInterval(id);
  }, [chatter, active, locale]);

  const updateOffice = useCallback((next: Office) => {
    setOffices((list) => list.map((o) => (o.id === next.id ? next : o)));
    officeRef.current = next;
    const r = runRef.current;
    if (r && r.officeId === next.id) {
      const rec = reconcileRun(r, next);
      runRef.current = rec;
      setRun(rec);
    }
  }, []);

  const switchOffice = useCallback((id: string) => {
    const cur = runRef.current;
    if (cur?.busy) runnerRef.current?.dispatch({ t: "stop", at: Date.now() });
    if (cur) saveRun(runRef.current ?? cur);
    const next = loadOffices().find((o) => o.id === id);
    setActiveId(id);
    setSelected(null);
    setPanel("none");
    if (next) {
      const r = loadRun(next);
      runRef.current = r;
      setRun(r);
    }
  }, []);

  const createOffice = useCallback((o: Office) => {
    const cur = runRef.current;
    if (cur?.busy) runnerRef.current?.dispatch({ t: "stop", at: Date.now() });
    if (runRef.current) saveRun(runRef.current);
    setOffices((list) => [...list, o]);
    officeRef.current = o;
    const r = emptyRun(o);
    runRef.current = r;
    setRun(r);
    setActiveId(o.id);
    setSelected(null);
    setPanel("none");
  }, []);

  const dispatch = useCallback((input: Parameters<OfficeRunner["dispatch"]>[0]) => runnerRef.current?.dispatch(input), []);

  const openFile = useCallback((file: string) => {
    const target = absPath(file, officeRef.current?.workspace ?? null);
    void openPreviewWindow(/^https?:/.test(target) ? { url: target } : { file: target }).catch(() => {});
  }, []);

  const pickFolder = useCallback(async () => {
    const cur = officeRef.current;
    if (!cur) return;
    const p = await pickWorkspace({ defaultPath: cur.workspace ?? loadLastWorkspace() });
    if (p) {
      saveLastWorkspace(p);
      updateOffice({ ...cur, workspace: p, updatedAt: Date.now() });
    }
  }, [updateOffice]);

  const layout = useMemo(() => (office ? layoutOffice(office) : null), [office]);
  const theme = officeTheme(office?.theme ?? "day");
  const needsBoss = useMemo(() => {
    const s = new Set<string>();
    if (!run) return s;
    if (run.approval) s.add(run.approval.staffId);
    for (const p of run.permissions) s.add(p.staffId);
    for (const m of run.log) if (m.kind === "question" && !m.answered && m.staffId) s.add(m.staffId);
    return s;
  }, [run]);

  // 部屋に渡す「いま」：独り言と、OK が出た直後の喜ぶ動きを重ねる（保存する状態は汚さない）
  const [cheering, setCheering] = useState(false);
  useEffect(() => {
    if (!run?.cheerAt || Date.now() - run.cheerAt > 3000) return;
    setCheering(true);
    const id = setTimeout(() => setCheering(false), 2400);
    return () => clearTimeout(id);
  }, [run?.cheerAt]);
  const sceneRun = useMemo(() => {
    if (!run) return null;
    if (!chatterBubble && !cheering) return run;
    const staff = { ...run.staff };
    if (chatterBubble && staff[chatterBubble.staffId]?.status === "idle") {
      staff[chatterBubble.staffId] = { ...staff[chatterBubble.staffId], bubble: chatterBubble.text, status: "waiting" };
    }
    if (cheering) {
      for (const [id, s] of Object.entries(staff)) if (s.status === "done") staff[id] = { ...s, bubble: locale === "ja" ? "やった！" : "Yay!" };
    }
    return { ...run, staff };
  }, [run, chatterBubble, cheering, locale]);

  if (!hydrated) return <div className="absolute inset-0" style={{ background: theme.sky }} />;

  const selectedStaff: Staff | null = office && selected ? office.staff.find((s) => s.id === selected) ?? null : null;
  const wallLeft = office && run ? <OfficeBoard office={office} run={run} theme={theme} onSelectStaff={setSelected} flat={flat} /> : null;
  const wallRight = office ? <OfficeSign office={office} theme={theme} /> : null;
  const sceneLabels = { working: t("status.working"), waiting: t("status.waiting"), done: t("status.done"), idle: t("status.idle"), resetView: t("scene.resetView") };
  const sidePanelOpen = !!selectedStaff || panel === "company";

  return (
    <div className="office-root relative h-full w-full overflow-hidden" style={{ background: theme.sky }} data-office-theme={theme.id}>
      {office && run && sceneRun && layout ? (
        <>
          {flat ? (
            <OfficeFloor2D office={office} run={sceneRun} layout={layout} theme={theme} avatarUrls={avatarUrls} needsBoss={needsBoss} selectedStaffId={selected} onSelectStaff={setSelected} wallLeft={wallLeft} wallRight={wallRight} />
          ) : (
            <OfficeScene
              office={office}
              run={sceneRun}
              layout={layout}
              theme={theme}
              avatarUrls={avatarUrls}
              active={active}
              insets={{ left: 170, right: sidePanelOpen ? 424 : 0 }}
              needsBoss={needsBoss}
              selectedStaffId={selected}
              onSelectStaff={setSelected}
              onUnsupported={() => setFlat(true)}
              wallLeft={wallLeft}
              wallRight={wallRight}
              labels={sceneLabels}
            />
          )}
          <OfficeTopBar office={office} run={run} theme={theme} onEditCompany={() => { setSelected(null); setPanel("company"); }} demo={!isTauri()} />
          <OfficeTicker office={office} run={run} theme={theme} />

          {/* 会社の切り替え（2つ以上あるとき）と、新しい会社 */}
          <div className="pointer-events-none absolute left-3 top-[76px] z-20 flex max-w-[220px] flex-col gap-1.5">
            {offices.length > 1
              ? offices.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => o.id !== office.id && switchOffice(o.id)}
                    aria-current={o.id === office.id}
                    className={`pointer-events-auto flex items-center gap-1.5 overflow-hidden rounded-full border px-3 py-1.5 text-left text-[12px] font-bold shadow ${
                      o.id === office.id ? "border-rose-400 bg-rose-500 text-white" : theme.dark ? "border-white/10 bg-slate-900/80 text-slate-200" : "border-slate-200 bg-white/90 text-slate-700"
                    }`}
                  >
                    <Building2 size={13} aria-hidden="true" className="shrink-0" />
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">{o.name}</span>
                  </button>
                ))
              : null}
          </div>

          <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex h-[min(56%,560px)] items-end">
            <BossDesk
              office={office}
              run={run}
              theme={theme}
              onSend={(text) => dispatch({ t: "boss", text, at: Date.now() })}
              onApprove={(ok, comment) => dispatch({ t: "approve", ok, comment, at: Date.now() })}
              onPermission={(askId, allow) => dispatch({ t: "permission", askId, allow, at: Date.now() })}
              onStop={() => dispatch({ t: "stop", at: Date.now() })}
              onOpenFile={openFile}
              onPickWorkspace={pickFolder}
            />
          </div>
          {!sidePanelOpen ? (
            <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex h-[min(50%,480px)] items-end">
              <OfficeSide
                office={office}
                run={run}
                theme={theme}
                onOpenFile={openFile}
                onReveal={(file) => void revealInFileManager(absPath(file, office.workspace)).catch(() => {})}
                onInquiry={(text) => dispatch({ t: "inquiry", text, at: Date.now() })}
              />
            </div>
          ) : null}

          {selectedStaff ? (
            <StaffPanel
              office={office}
              run={run}
              staff={selectedStaff}
              avatarUrl={avatarUrls[selectedStaff.id] ?? null}
              onSave={(next) => {
                updateOffice({ ...office, staff: office.staff.map((s) => (s.id === next.id ? next : s)), updatedAt: Date.now() });
                // 仕事のやり方や AI を変えたら、次の仕事から新しい決まりで起動し直す
                if (run.staff[next.id]?.status !== "working") {
                  runnerRef.current?.restartStaff(office.id, next.id);
                  const r = runRef.current;
                  if (r) {
                    const patched = { ...r, staff: { ...r.staff, [next.id]: { ...r.staff[next.id], started: false, cliSessionId: next.provider === selectedStaff.provider ? r.staff[next.id]?.cliSessionId ?? null : null } } };
                    runRef.current = patched;
                    setRun(patched);
                  }
                }
              }}
              onDelete={(id) => {
                runnerRef.current?.restartStaff(office.id, id);
                updateOffice({ ...office, staff: office.staff.filter((s) => s.id !== id), updatedAt: Date.now() });
                setSelected(null);
              }}
              onClose={() => setSelected(null)}
            />
          ) : null}
          {panel === "company" && !selectedStaff ? (
            <CompanyPanel
              office={office}
              chatter={chatter}
              onChatter={(on) => {
                setChatter(on);
                try {
                  window.localStorage.setItem(CHATTER_KEY, on ? "1" : "0");
                } catch {
                  /* 保存できなくても続ける */
                }
              }}
              onChange={updateOffice}
              onAddStaff={(deptId) => {
                const s = newStaff(office, deptId);
                updateOffice({ ...office, staff: [...office.staff, s], updatedAt: Date.now() });
                setSelected(s.id);
              }}
              onDeleteOffice={() => {
                if (run.busy) dispatch({ t: "stop", at: Date.now() });
                deleteRun(office.id);
                const rest = offices.filter((o) => o.id !== office.id);
                setOffices(rest);
                setPanel(rest.length === 0 ? "setup" : "none");
                const next = rest[0] ?? null;
                officeRef.current = next;
                setActiveId(next?.id ?? null);
                const r = next ? loadRun(next) : null;
                runRef.current = r;
                setRun(r);
              }}
              onNewOffice={() => setPanel("setup")}
              onClose={() => setPanel("none")}
            />
          ) : null}
        </>
      ) : null}
      {panel === "setup" ? <OfficeSetup canCancel={offices.length > 0} onCreate={createOffice} onCancel={() => setPanel("none")} /> : null}
    </div>
  );
}
