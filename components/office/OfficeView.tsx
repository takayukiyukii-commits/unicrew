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
import { OfficeAvatarContext } from "./OfficeCrew";
import OfficeFloor2D from "@/components/office/OfficeFloor2D";
import { CompanyPanel, OfficeSetup, StaffPanel, newStaff } from "@/components/office/OfficeDialogs";
import { BossDesk, OfficeBoard, OfficeSide, OfficeTopBar } from "@/components/office/OfficePanels";
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

// 保存済みの表示設定を、静かな待機モーションの設定として引き継ぐ。
const CHATTER_KEY = "unicrew.office.chatter.v1";


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
  const { t } = useOfficeT();
  const [hydrated, setHydrated] = useState(false);
  const [offices, setOffices] = useState<Office[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [run, setRun] = useState<OfficeRun | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "company" | "setup">("none");
  const [flat, setFlat] = useState(false);
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});
  const [chatter, setChatter] = useState(true);

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

  if (!hydrated) return <div className="absolute inset-0" style={{ background: theme.sky }} />;

  const selectedStaff: Staff | null = office && selected ? office.staff.find((s) => s.id === selected) ?? null : null;
  const sidePanelOpen = !!selectedStaff || panel === "company";

  return (
    <OfficeAvatarContext.Provider value={avatarUrls}>
    <div className="office-root relative h-full w-full overflow-hidden" style={{ background: theme.sky }} data-office-theme={theme.id} data-office-flat={flat} data-companies={offices.length > 1}>
      {office && run && layout ? (
        <>
          {flat ? (
            <OfficeFloor2D office={office} run={run} layout={layout} theme={theme} avatarUrls={avatarUrls} needsBoss={needsBoss} selectedStaffId={selected} onSelectStaff={setSelected} active={active} animateIdle={chatter} key={office.id} />
          ) : (
            <OfficeScene
              office={office}
              run={run}
              layout={layout}
              theme={theme}
              avatarUrls={avatarUrls}
              active={active}
              animateIdle={chatter}
              key={office.id}
              needsBoss={needsBoss}
              selectedStaffId={selected}
              onSelectStaff={setSelected}
              onUnsupported={() => setFlat(true)}
            />
          )}
          <OfficeTopBar office={office} run={run} theme={theme} onEditCompany={() => { setSelected(null); setPanel("company"); }} demo={!isTauri()} />
          <OfficeBoard office={office} run={run} onSelectStaff={setSelected} />

          {offices.length > 1 ? <select aria-label={t("list.title")} value={office.id} onChange={(event) => switchOffice(event.target.value)} className="office-company-switch">
            {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select> : null}

          <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex h-[min(40%,560px)] items-end">
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
            <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex h-[min(40%,480px)] items-end">
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
    </OfficeAvatarContext.Provider>
  );
}
