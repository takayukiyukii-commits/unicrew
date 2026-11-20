"use client";

/**
 * AIオフィスの画面全体。会社を選ぶ・作る → 部屋を出す → 指示を送る、までをまとめる。
 *
 * 状態の持ち方:
 * - 会社の名簿（offices）と、選んでいる会社の「いま」（run）をここで持ち、変わるたびに保存する
 * - AI とのやり取りは OfficeRunner に任せる（ここは画面だけ）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OfficeAvatarContext } from "./OfficeCrew";
import OfficeScene from "@/components/office/OfficeScene";
import { CompanyPanel, OfficeSetup, StaffPanel, newStaff } from "@/components/office/OfficeDialogs";
import { BossDesk, OfficeBoard, OfficeSide, OfficeTopBar } from "@/components/office/OfficePanels";
import { emptyRun, reconcileRun } from "@/lib/office/engine";
import { registerBossReceiver } from "@/lib/office/boss-bus";
import { useOfficeT } from "@/lib/office/i18n";
import { layoutOffice } from "@/lib/office/layout";
import { OfficeRunner } from "@/lib/office/runner";
import { deleteRun, loadActiveOfficeId, loadOffices, loadRun, saveActiveOfficeId, saveOffices, saveRun } from "@/lib/office/store";
import { officeTheme } from "@/lib/office/themes";
import type { Office, OfficeRun, Staff } from "@/lib/office/types";
import { openExternal, openPreviewWindow } from "@/lib/preview-window";
import { loadLastWorkspace, saveLastWorkspace } from "@/lib/storage";
import { avatarSrc, fileTail, isTauri, listDirectory, pathExists, pickWorkspace, revealInFileManager } from "@/lib/tauri";
import type { AppSettings } from "@/lib/types";
import { describeTool } from "@/lib/progress-text";
import { nextTerminalActivity, publishTerminal, subscribeTerminal, type TerminalActivity } from "@/lib/office/terminal-link";
import { RUN_DIR_CANDIDATES, RUN_LIVE_MS, RUN_LOG_NAME, RUN_PANE_BASE, RUN_SITE_URL, RUN_TAIL_BYTES, RunWatcher } from "@/lib/office/run-link";


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

/** ターミナルの道具の行（Read(src/a.ts) の括弧の中）を、進捗の文づくりが読める形にする */
function toolInput(detail: string): Record<string, unknown> {
  return { file_path: detail, command: detail, pattern: detail, query: detail, url: detail };
}

export default function OfficeView({ active, settings, onWorkspaceChange }: Props) {
  const { t, locale } = useOfficeT();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const [hydrated, setHydrated] = useState(false);
  const [offices, setOffices] = useState<Office[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [run, setRun] = useState<OfficeRun | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "company" | "setup">("none");
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
    setRun(cur ? loadRun(cur, localeRef.current) : null);
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
      getLocale: () => localeRef.current,
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
      const rec = reconcileRun(r, next, { locale: localeRef.current });
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
      const r = loadRun(next, localeRef.current);
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

  useEffect(() => registerBossReceiver((text) => {
    if (!hydrated || !runnerRef.current) return "notReady";
    const cur = officeRef.current;
    if (!cur) return "noOffice";
    if (!cur.workspace?.trim()) return "noWorkspace";
    if (!cur.staff.some((s) => s.lead)) return "noLead";
    if (runRef.current?.officeId !== cur.id) return "notReady";
    dispatch({ t: "boss", text, at: Date.now() });
    return "accepted";
  }), [hydrated, dispatch]);

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
  // ── ターミナルとの連動：ターミナルの AI の作業を、席順で対応する社員の動きに重ねる（仕事の進行には書き込まない）
  const [terminal, setTerminal] = useState<Record<number, TerminalActivity>>({});
  useEffect(() => {
    const timers = new Map<number, number>();
    const off = subscribeTerminal((ev) => {
      setTerminal((cur) => ({ ...cur, [ev.pane]: nextTerminalActivity(cur[ev.pane], ev) }));
      window.clearTimeout(timers.get(ev.pane));
      // 終わったら、報告に行って戻るまでのあいだ「完了」を見せてから消す
      if (ev.kind === "stop") timers.set(ev.pane, window.setTimeout(() => setTerminal((cur) => { const next = { ...cur }; delete next[ev.pane]; return next; }), 14000));
    });
    // ブラウザで開いたとき（見本の動き）だけ、ターミナルの知らせを手で流して動きを確かめられるようにする
    if (!isTauri()) (window as unknown as { __officeTerminal?: typeof publishTerminal }).__officeTerminal = publishTerminal;
    return () => { off(); timers.forEach((id) => window.clearTimeout(id)); };
  }, []);
  // ── RUNner との連動：RUNner の作業フォルダの記録（末尾だけ）を数秒おきに読み、動いているゴールを社員の動きにする。読むだけ
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let dir: string | null = null;
    const watcher = new RunWatcher();
    const tick = async () => {
      try {
        if (!dir) {
          for (const candidate of RUN_DIR_CANDIDATES) if (await pathExists(candidate)) { dir = candidate; break; }
          if (!dir) return; // RUNner を使っていないPC
        }
        const folders = (await listDirectory(dir)).filter((entry) => entry.is_dir && !entry.name.startsWith("_")).slice(0, 80);
        const now = Date.now();
        const readings = [];
        for (const folder of folders) {
          const log = `${folder.path.replace(/[\\/]+$/, "")}/${RUN_LOG_NAME}`;
          const meta = await fileTail(log, 0);
          if (!meta) continue;
          // 動いている記録だけ、末尾を読む
          const tail = now - meta.modified_ms < RUN_LIVE_MS ? (await fileTail(log, RUN_TAIL_BYTES))?.text ?? null : null;
          readings.push({ key: folder.name, modifiedMs: meta.modified_ms, tail });
        }
        if (!alive) return;
        for (const ev of watcher.feed(readings, now)) publishTerminal(ev);
      } catch {
        /* 読めなくても、オフィスは止めない（次の回でまた読む） */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  /** 動いている・返事を待っている RUNner の仕事の数（UNIHUB を開く入口に出す） */
  const runGoals = useMemo(() => Object.values(terminal).filter((act) => act.source === "runner" && act.status !== "done").length, [terminal]);
  /** 表示用の「いま」：オフィスの仕事で手が空いている社員に、ターミナルの作業を重ねる */
  const viewRun = useMemo(() => {
    if (!run || !office) return run;
    const members = office.staff.filter((member) => !member.lead);
    const panes = Object.values(terminal);
    if (members.length === 0 || panes.length === 0) return run;
    const staff = { ...run.staff };
    const permissions = [...run.permissions];
    for (const act of panes) {
      // ターミナルは席の前から順に、RUNner の仕事は後ろの席から順に割り当てる（同じ人に重なりにくくする）
      const runner = act.source === "runner";
      const who = runner ? members[members.length - 1 - ((act.pane - RUN_PANE_BASE) % members.length)] : members[(act.pane - 1) % members.length];
      const k = runner ? "run" : "term";
      const rt = staff[who.id];
      if (!rt || rt.status === "working" || rt.status === "waiting") continue; // オフィスの仕事の最中は、そちらを優先
      const doing = act.tool ? describeTool({ kind: "tool_use", toolUseId: act.tool.id, toolName: act.tool.name, input: toolInput(act.tool.detail), status: "pending" }, false) : null;
      const what = act.instruction ? act.instruction.replace(/\s+/g, " ").slice(0, 26) : "";
      const tools: OfficeRun["staff"][string]["tools"] = {};
      if (act.finished) tools[act.finished.id] = { name: act.finished.name, input: {}, done: true, error: false };
      if (act.tool) tools[act.tool.id] = { name: act.tool.name, input: {}, done: false, error: false };
      staff[who.id] = {
        ...rt,
        status: act.status === "done" ? "done" : act.status === "waiting" ? "waiting" : "working",
        task: what || t(`${k}.working`, { n: act.pane }),
        arrive: runner ? act.startedAt : rt.arrive,
        bubble: act.status === "waiting" ? t(`${k}.waiting`, { n: act.pane }) : act.status === "done" ? t(`${k}.done`, { n: act.pane }) : runner && what ? t("run.instruction", { text: what }) : doing ?? (what ? t(`${k}.instruction`, { n: act.pane, text: what }) : t(`${k}.working`, { n: act.pane })),
        said: act.status === "done" ? t(`${k}.done`, { n: act.pane }) : rt.said,
        tools,
      };
      if (act.status === "waiting") permissions.push({ id: `term-${act.pane}`, staffId: who.id, requestId: "", toolName: "terminal", text: t(`${k}.waiting`, { n: act.pane }), at: act.at });
    }
    return { ...run, staff, permissions };
  }, [run, office, terminal, t]);

  const needsBoss = useMemo(() => {
    const s = new Set<string>();
    if (!run) return s;
    for (const p of viewRun?.permissions ?? []) s.add(p.staffId);
    if (run.approval) s.add(run.approval.staffId);
    for (const p of run.permissions) s.add(p.staffId);
    for (const m of run.log) if (m.kind === "question" && !m.answered && m.staffId) s.add(m.staffId);
    return s;
  }, [run, viewRun]);

  if (!hydrated) return <div className="absolute inset-0" style={{ background: theme.sky }} />;

  const selectedStaff: Staff | null = office && selected ? office.staff.find((s) => s.id === selected) ?? null : null;
  const sidePanelOpen = !!selectedStaff || panel === "company";

  return (
    <OfficeAvatarContext.Provider value={avatarUrls}>
    <div className="office-root relative h-full w-full overflow-hidden" style={{ background: theme.sky }} data-office-theme={theme.id} data-companies={offices.length > 1}>
      {office && run && layout ? (
        <>
          <OfficeScene office={office} run={viewRun ?? run} layout={layout} theme={theme}
            avatarUrls={avatarUrls} active={active} animateIdle={chatter} key={office.id}
            needsBoss={needsBoss} selectedStaffId={selected} onSelectStaff={setSelected} />
          {runGoals > 0 ? <button type="button" className="office-run-chip" onClick={() => void openExternal(RUN_SITE_URL).catch(() => {})} title={t("run.openHint")}>
            {t("run.chip", { n: runGoals })}
          </button> : null}
          <OfficeTopBar office={office} run={run} theme={theme} onEditCompany={() => { setSelected(null); setPanel("company"); }} demo={!isTauri()} />
          <OfficeBoard office={office} run={viewRun ?? run} onSelectStaff={setSelected} />

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
                const r = next ? loadRun(next, localeRef.current) : null;
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
