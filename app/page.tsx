"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, SquareTerminal, FolderTree as IconFolderTree, Settings as IconSettings, Puzzle as IconPuzzle, Smartphone, CalendarClock, Network, Github, Bug, Sparkles, HelpCircle } from "lucide-react";
import { Sidebar, type MainView } from "@/components/Sidebar";
import { TerminalPanes, type WorkDoneDetail } from "@/components/TerminalPanes";
import { ExplorerPanel } from "@/components/ExplorerPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { AppMenuBar, type MenuDef } from "@/components/AppMenuBar";
import { AddonsSection } from "@/components/AddonsSection";
import { PastConversation } from "@/components/PastConversation";
import { SettingsModal } from "@/components/SettingsModal";
import { FreeModeWizard } from "@/components/FreeModeWizard";
import { Walkthrough } from "@/components/Walkthrough";
import { WhatsNewModal } from "@/components/WhatsNewModal";
import { LanguagePickerModal } from "@/components/LanguagePickerModal";
import { TrustPromptModal } from "@/components/TrustPromptModal";
import { UniMcpModal } from "@/components/UniMcpModal";
import { RoutinesModal } from "@/components/RoutinesModal";
import { RemoteControlModal } from "@/components/RemoteControlModal";
import OfficeView from "@/components/office/OfficeView";
import { sendBossInstruction, type BossDelivery } from "@/lib/office/boss-bus";
import { loadOffices } from "@/lib/office/store";
import type { Command } from "@/lib/commands";
import type { AppSettings, Thread } from "@/lib/types";
import { deletePastThread, loadLastWorkspace, loadSettings, loadThreadsAsync, saveLastWorkspace, saveSettings } from "@/lib/storage";
import { fireDueRoutines, loadRoutines, saveRoutines } from "@/lib/routines";
import { isWalkthroughDone, resetWalkthrough } from "@/lib/walkthrough";
import { markFirstRunSeen, resetWhatsNew, shouldShowWhatsNew, UNICREW_VERSION } from "@/lib/whatsnew";
import { isLocaleUnset, useLocaleInit, useTranslation } from "@/lib/i18n";
import { isWorkspaceTrusted, trustWorkspace } from "@/lib/trust";
import { openFileInEditorWindow } from "@/lib/editor-window";
import { applyAppearance } from "@/lib/appearance";
import { applyTrayResident, clearUnread, reportWorkDone } from "@/lib/attention";
import { summarizeInstruction } from "@/lib/claude-title";
import { useAppVersion } from "@/lib/app-version";
import { sendLaunchPing } from "@/lib/telemetry";
import { showToast } from "@/lib/toast";
import { checkUnicrewUpdate, claudeStatus, defaultWorkspacePath, getApiKey, isTauri, pickWorkspace } from "@/lib/tauri";

export default function Page() {
  const { t: tr } = useTranslation();
  const appVersion = useAppVersion();
  useLocaleInit();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>({ defaultCharacterId: "tmpl-claude-normal", authMode: "subscription", showActivity: false });
  const [hydrated, setHydrated] = useState(false);
  const [mainView, setMainView] = useState<MainView>("office");
  const mainViewRef = useRef(mainView);
  mainViewRef.current = mainView;
  const [officeWorkspace, setOfficeWorkspace] = useState<string | null>(null);
  const [hasOffice, setHasOffice] = useState(false);
  const [lastWorkspace, setLastWorkspace] = useState<string | null>(null);
  const handleOfficeWorkspaceChange = useCallback((path: string | null) => {
    setOfficeWorkspace(path);
    setHasOffice(loadOffices().length > 0);
    setLastWorkspace(loadLastWorkspace());
  }, []);
  // エクスプローラだけで別のフォルダを読む場合も、会社とターミナルの作業先は変えない。
  const [explorerWorkspace, setExplorerWorkspace] = useState<string | null>(null);
  const workspace = officeWorkspace ?? (hasOffice ? null : lastWorkspace);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [sidebarManuallyExpanded, setSidebarManuallyExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [freeModeOpen, setFreeModeOpen] = useState(false);
  const [uniMcpOpen, setUniMcpOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [rcOpen, setRcOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deliveryError, setDeliveryError] = useState<Exclude<BossDelivery, "accepted"> | null>(null);
  const [pendingTerminalText, setPendingTerminalText] = useState<string | null>(null);
  const [trustPrompt, setTrustPrompt] = useState<{
    path: string;
    resolve: (value: "trusted" | "restricted" | "cancel") => void;
  } | null>(null);
  const [restrictedWorkspaces, setRestrictedWorkspaces] = useState<Set<string>>(new Set());

  // 外観設定を画面へ反映（初期ロード・保存・モーダル変更すべてに追従）
  useEffect(() => {
    applyAppearance(settings.appearance);
  }, [settings.appearance]);

  // 作業完了の通知はイベントの中から読むので、最新の設定を ref に置く。
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // × で閉じても常駐（Rust 側は画面からの指示があるまで OFF＝画面が壊れていても終われる）
  useEffect(() => {
    void applyTrayResident(settings.trayResident ?? true);
  }, [settings.trayResident]);

  // 窓が前に来た＝見たので、通知領域・タスクバーの「終わった作業あり」の印を消す
  useEffect(() => {
    const onSeen = () => {
      if (document.visibilityState === "visible") void clearUnread();
    };
    window.addEventListener("focus", onSeen);
    document.addEventListener("visibilitychange", onSeen);
    return () => {
      window.removeEventListener("focus", onSeen);
      document.removeEventListener("visibilitychange", onSeen);
    };
  }, []);

  /** ターミナルの AI の作業が止まった（終わった・確認待ち）とき。 */
  const handleTerminalWorkDone = useCallback(
    (label: string, workedMs: number, detail?: WorkDoneDetail) => {
      const s = settingsRef.current;
      const sec = Math.round(workedMs / 1000);
      const dur =
        sec >= 60
          ? tr("attention.durMin", { n: Math.round(sec / 60) })
          : tr("attention.durSec", { n: sec });
      if (!detail) {
        // Claude Code 以外の AI（終わりを出力の止まり方で推測している）
        void reportWorkDone({
          title: tr("attention.terminalDoneTitle", { label }),
          body: tr("attention.terminalDoneBody", { sec }),
          notify: s.notifyOnDone ?? true,
        });
        return;
      }
      // Claude Code（止まった瞬間をタイトルで取っている）。何の作業かを本文に書く
      const what = summarizeInstruction(detail.instruction);
      const title = detail.waiting
        ? tr("attention.terminalWaitingTitle", { label })
        : tr("attention.terminalFinishedTitle", { label });
      const body = detail.waiting
        ? what
          ? tr("attention.terminalWaitingBody", { what })
          : tr("attention.terminalWaitingBodyPlain")
        : what
          ? tr("attention.terminalFinishedBody", { what, dur })
          : tr("attention.terminalFinishedBodyPlain", { dur });
      void reportWorkDone({ title, body, notify: s.notifyOnDone ?? true });
    },
    [tr],
  );

  // 匿名の起動記録（インストール数を数えるためだけ・設定でオフにできる）。
  // 🚨 送るのは乱数ID・バージョン・OSの3つだけ。PRIVACY.md と必ず一致させること。
  useEffect(() => {
    void sendLaunchPing();
  }, []);


  useEffect(() => {
    let alive = true;
    const s = loadSettings();
    setSettings(s);
    setLastWorkspace(loadLastWorkspace());
    setExplorerOpen(localStorage.getItem("unicrew.explorerOpen") === "1");
    void loadThreadsAsync(isTauri()).then((result) => {
      if (!alive) return;
      setThreads(result.threads);
      if (result.broken.length) showToast(tr("storage.broken", { count: result.broken.length, names: result.broken.join(", ") }), "error");
      if (result.exitErrors.length) showToast(tr("storage.exitErrors", {
        count: result.exitErrors.length,
        names: result.exitErrors.map((error) => result.threads.find((thread) => thread.id === error.id)?.title ?? error.id).join("、"),
      }), "error");
    }).catch(() => {
      if (alive) showToast(tr("past.loadError"), "error");
    }).finally(() => { if (alive) setHydrated(true); });
    if (isLocaleUnset()) setLanguagePickerOpen(true);
    else if (!isWalkthroughDone()) { markFirstRunSeen(); setWalkthroughOpen(true); }
    else if (shouldShowWhatsNew()) setWhatsNewOpen(true);
    void (async () => {
      if (!isTauri()) return;
      try {
        const def = await defaultWorkspacePath();
        if (def && !(await isWorkspaceTrusted(def))) await trustWorkspace(def);
        if (isLocaleUnset() || !isWalkthroughDone()) return;
        const needsSetup = s.authMode === "apikey"
          ? !(await getApiKey())
          : await claudeStatus().then((status) => !status.installed || !status.logged_in);
        if (alive && needsSetup) setSettingsOpen(true);
      } catch { /* 導入は設定からも行える */ }
    })();
    return () => { alive = false; };
    // 初回の読み込みのみ。表示文の言語は開いた時点のものを使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem("unicrew.explorerOpen", explorerOpen ? "1" : "0");
  }, [explorerOpen, hydrated]);

  // ターミナルの選択文字は、準備不足のときも再送できるように画面に保持する。
  const deliverToOffice = useCallback((text: string, opts: { quiet?: boolean } = {}): boolean => {
    // 自分で押したときだけ AIオフィスへ切り替える（定期実行の自動の届けでは、見ている画面を変えない）
    if (!opts.quiet) setMainView("office");
    const result = sendBossInstruction(text);
    setDeliveryError(result === "accepted" ? null : result);
    return result === "accepted";
  }, []);

  const handleTerminalTextToAi = (text: string, meta: { cwd: string | null; label: string }) => {
    const body = [pendingTerminalText, tr("officeDelivery.terminalPrompt", { label: meta.label, cwd: meta.cwd || tr("palette.workspace.unset"), text })].filter(Boolean).join("\n\n");
    if (deliverToOffice(body)) setPendingTerminalText(null);
    else setPendingTerminalText(body);
  };

  useEffect(() => {
    if (!hydrated) return;
    const tick = () => {
      const all = loadRoutines();
      const next = fireDueRoutines(all, (text) => deliverToOffice(text, { quiet: true }));
      // 受け取れなければ実行済みにしない。準備後の次の確認で再試行する。
      if (next !== all) saveRoutines(next);
    };
    const initial = setTimeout(tick, 5000);
    const timer = setInterval(tick, 60_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [hydrated, deliverToOffice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k" || (event.shiftKey && key === "p")) {
        if (mainViewRef.current === "terminal" && !event.shiftKey) return;
        event.preventDefault();
        setPaletteOpen((value) => !value);
      } else if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const handlePickExplorerFolder = async () => {
    try {
      const path = await pickWorkspace({ defaultPath: explorerWorkspace ?? workspace });
      if (!path) return;
      if (!(await isWorkspaceTrusted(path))) {
        const decision = await new Promise<"trusted" | "restricted" | "cancel">((resolve) => setTrustPrompt({ path, resolve }));
        setTrustPrompt(null);
        if (decision === "cancel") return;
        if (decision === "trusted") await trustWorkspace(path);
        setRestrictedWorkspaces((current) => {
          const next = new Set(current);
          if (decision === "restricted") next.add(path);
          else next.delete(path);
          return next;
        });
      }
      setExplorerWorkspace(path);
      saveLastWorkspace(path);
      setLastWorkspace(path);
    } catch { showToast(tr("officeDelivery.folderError"), "error"); }
  };

  const handleDelete = async () => {
    if (!deleteId || deleting) return;
    setDeleting(true);
    try {
      await deletePastThread(deleteId);
      setThreads((current) => current.filter((thread) => thread.id !== deleteId));
      if (activeId === deleteId) setActiveId(null);
      setDeleteId(null);
    } catch { showToast(tr("past.deleteError"), "error"); }
    finally { setDeleting(false); }
  };
  const paletteCommands: Command[] = [
    { id: "view.office", label: tr("sidebar.office"), category: tr("palette.category.view"), icon: Building2, run: () => setMainView("office") },
    { id: "view.terminal", label: tr("sidebar.terminal"), category: tr("palette.category.view"), icon: SquareTerminal, run: () => setMainView("terminal") },
    { id: "setup.free", label: tr("officeDelivery.freeSetup"), category: tr("palette.category.action"), icon: Sparkles, run: () => setFreeModeOpen(true) },
      {
        id: "explorer.toggle",
        label: explorerOpen
          ? tr("palette.explorer.close")
          : tr("palette.explorer.open"),
        category: tr("palette.category.view"),
        icon: IconFolderTree,
        keywords: ["explorer", "tree", "ファイル"],
        run: () => setExplorerOpen((v) => !v),
      },
      {
        id: "view.addons",
        label: tr("palette.view.addons"),
        category: tr("palette.category.view"),
        icon: IconPuzzle,
        keywords: ["plugin", "skill", "mcp", "addons"],
        run: () => setMainView("addons"),
        enabled: mainView !== "addons",
      },
      {
        id: "settings.open",
        label: tr("palette.settings.open"),
        category: tr("palette.category.action"),
        icon: IconSettings,
        shortcut: "Ctrl+,",
        keywords: ["settings", "config", "せってい"],
        run: () => setSettingsOpen(true),
      },
      {
        id: "uni-mcp.open",
        label: tr("palette.uniMcp.open"),
        category: tr("palette.category.action"),
        icon: Network,
        keywords: ["uni", "mcp", "connect"],
        run: () => setUniMcpOpen(true),
      },
      {
        id: "routines.open",
        label: tr("palette.routines.open"),
        category: tr("palette.category.action"),
        icon: CalendarClock,
        keywords: ["routine", "schedule", "cron", "ていきじっこう"],
        run: () => setRoutinesOpen(true),
      },
      {
        id: "rc.open",
        label: tr("palette.rc.open"),
        category: tr("palette.category.action"),
        icon: Smartphone,
        keywords: ["remote", "control", "phone", "official"],
        run: () => setRcOpen(true),
      },
      {
        id: "walkthrough.replay",
        label: tr("palette.walkthrough.replay"),
        category: tr("palette.category.help"),
        description: tr("palette.walkthrough.replay.desc"),
        icon: Sparkles,
        keywords: ["walkthrough", "tutorial", "onboarding", "オンボ"],
        run: () => {
          resetWalkthrough();
          setWalkthroughOpen(true);
        },
      },
      {
        id: "whatsnew.show",
        label: tr("palette.whatsnew.show", { version: UNICREW_VERSION }),
        category: tr("palette.category.help"),
        icon: Sparkles,
        keywords: ["whats new", "release", "リリース", "新機能"],
        run: () => {
          resetWhatsNew();
          setWhatsNewOpen(true);
        },
      },
      {
        id: "trust.list",
        label: tr("palette.trust.list"),
        category: tr("palette.category.help"),
        description: tr("palette.trust.list.desc"),
        icon: HelpCircle,
        keywords: ["trust", "trusted", "workspace", "信頼"],
        run: async () => {
          const list = await import("@/lib/trust").then((m) =>
            m.listTrustedWorkspaces(),
          );
          if (list.length === 0) {
            alert(tr("page.alert.noTrustedFolders"));
          } else {
            alert(tr("page.alert.trustedFoldersList", { list: list.join("\n") }));
          }
        },
      },
      {
        id: "otel.status",
        label: tr("palette.otel.status"),
        category: tr("palette.category.help"),
        description: tr("palette.otel.status.desc"),
        icon: HelpCircle,
        keywords: ["otel", "observability", "telemetry", "観測", "ログ"],
        run: async () => {
          const s = await import("@/lib/observability").then((m) =>
            m.observabilityStatus(),
          );
          alert(
            tr("page.alert.otelStatus", {
              state: s.active
                ? tr("page.alert.otelActive")
                : tr("page.alert.otelInactive"),
              endpoint: s.endpoint ?? tr("page.alert.otelEndpointUnset"),
              note: s.note,
            }),
          );
        },
      },
      {
        id: "github.open",
        label: tr("palette.github.open"),
        category: tr("palette.category.help"),
        icon: Github,
        run: () =>
          window.open(
            "https://github.com/takayukiyukii-commits/unicrew",
            "_blank",
          ),
      },
      {
        id: "issues.open",
        label: tr("palette.issues.open"),
        category: tr("palette.category.help"),
        icon: Bug,
        run: () =>
          window.open(
            "https://github.com/takayukiyukii-commits/unicrew/issues",
            "_blank",
          ),
      },
    ];


  const menuDefs: MenuDef[] = [
    { id: "file", label: tr("menu.file"), items: [
      { label: tr("menu.file.openWorkspace"), onSelect: () => { setExplorerOpen(true); void handlePickExplorerFolder(); } },
      { label: tr("menu.file.uniMcp"), onSelect: () => setUniMcpOpen(true) },
      { label: tr("menu.file.routines"), onSelect: () => setRoutinesOpen(true) },
      { label: tr("menu.file.remoteControl"), onSelect: () => setRcOpen(true) },
      { divider: true },
      { label: tr("officeDelivery.freeSetup"), onSelect: () => setFreeModeOpen(true) },
      { label: tr("menu.file.settings"), shortcut: "Ctrl+,", onSelect: () => setSettingsOpen(true) },
    ] },
    { id: "edit", label: tr("menu.edit"), items: [
      { label: tr("menu.edit.copy"), shortcut: "Ctrl+C", onSelect: () => { document.execCommand("copy"); } },
      { label: tr("menu.edit.paste"), shortcut: "Ctrl+V", onSelect: () => { document.execCommand("paste"); } },
      { label: tr("menu.edit.selectAll"), shortcut: "Ctrl+A", onSelect: () => { document.execCommand("selectAll"); } },
    ] },
    { id: "view", label: tr("menu.view"), items: [
      { label: tr("sidebar.office"), onSelect: () => setMainView("office") },
      { label: tr("sidebar.terminal"), onSelect: () => setMainView("terminal") },
      { label: tr("sidebar.addons"), onSelect: () => setMainView("addons") },
      { label: tr("sidebar.explorer"), onSelect: () => setExplorerOpen((value) => !value) },
    ] },
    { id: "help", label: tr("menu.help"), items: [
      { label: tr("palette.walkthrough.replay"), onSelect: () => { resetWalkthrough(); setWalkthroughOpen(true); } },
      { label: tr("palette.whatsnew.show", { version: UNICREW_VERSION }), onSelect: () => setWhatsNewOpen(true) },
      { label: tr("menu.help.github"), onSelect: () => { window.open("https://github.com/takayukiyukii-commits/unicrew", "_blank"); } },
      { label: tr("menu.help.issues"), onSelect: () => { window.open("https://github.com/takayukiyukii-commits/unicrew/issues", "_blank"); } },
      { label: tr("menu.help.version"), onSelect: () => alert(`UNICREW v${appVersion}\n\n${tr("page.alert.versionInfo")}`) },
    ] },
  ];
  const explorerPath = explorerWorkspace ?? workspace;

  return (
    <div className="h-screen w-screen flex flex-col bg-white overflow-hidden">
      <AppMenuBar menus={menuDefs} onOpenSettings={() => setSettingsOpen(true)} onCheckUpdates={async () => {
        const result = await checkUnicrewUpdate();
        if (!result) return { hasUpdate: false, message: tr("appmenu.checkFailed") };
        return result.available ? { hasUpdate: true, message: tr("appmenu.newVersion", { version: result.version }) } : { hasUpdate: false };
      }} />
      {(deliveryError || pendingTerminalText) && <div role="alert" className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm flex flex-wrap items-center gap-3">
        <span>{deliveryError ? tr(`officeDelivery.${deliveryError}`) : tr("officeDelivery.pending")}</span>
        {pendingTerminalText && <button type="button" className="underline" onClick={() => { if (deliverToOffice(pendingTerminalText)) setPendingTerminalText(null); }}>{tr("officeDelivery.retry")}</button>}
        <button type="button" className="underline" onClick={() => setMainView("office")}>{tr("past.openOffice")}</button>
        <button type="button" className="underline" onClick={() => { setDeliveryError(null); setPendingTerminalText(null); }}>{tr("common.close")}</button>
      </div>}
      <div className="flex-1 min-h-0 flex">
        <Sidebar threads={threads} activeThreadId={activeId} mainView={mainView}
          onSelect={(id) => { setActiveId(id); setMainView("past"); }}
          onOpenOffice={() => setMainView("office")} onOpenTerminal={() => setMainView("terminal")}
          onOpenAddons={() => setMainView("addons")} onOpenSettings={() => setSettingsOpen(true)}
          onDelete={setDeleteId} explorerOpen={explorerOpen}
          onToggleExplorer={() => { setExplorerOpen(!explorerOpen); if (explorerOpen) setSidebarManuallyExpanded(false); }}
          collapsed={(explorerOpen || mainView === "office") && !sidebarManuallyExpanded}
          onExpand={() => setSidebarManuallyExpanded(true)} />
        {explorerOpen && <ExplorerPanel workspace={explorerPath} restricted={!!explorerPath && restrictedWorkspaces.has(explorerPath)}
          onPickWorkspace={() => void handlePickExplorerFolder()} onClose={() => setExplorerOpen(false)}
          onSelectFile={(path) => void openFileInEditorWindow(path)} />}
        {/* AIオフィスとターミナルは画面を切り替えても取り外さず、進行中の仕事と端末を保つ。 */}
        <div className={mainView === "office" ? "relative flex-1 min-w-0 min-h-0" : "hidden"}>
          <OfficeView active={mainView === "office"} settings={settings} onWorkspaceChange={handleOfficeWorkspaceChange} />
        </div>
        <div className={mainView === "terminal" ? "flex-1 flex min-w-0 min-h-0 bg-[#faf9f6]" : "hidden"}>
          <TerminalPanes workspace={workspace} worktrees={[]} onSendToAi={handleTerminalTextToAi} onWorkDone={handleTerminalWorkDone} />
        </div>
        {mainView === "past" && <PastConversation thread={threads.find((thread) => thread.id === activeId) ?? null} onOpenOffice={() => setMainView("office")} />}
        {mainView === "addons" && <main className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-white">
          <div className="max-w-5xl mx-auto px-6 py-8">
            <header className="mb-6"><h1 className="text-[22px] font-bold">{tr("page.addons.title")}</h1>
              <p className="text-sm text-[var(--color-muted)]">{tr("page.addons.subtitle1")}<br />{tr("page.addons.subtitle2")}</p></header>
            <AddonsSection initialTab="claude-plugin" workspace={workspace} advancedMode={settings.advancedMode ?? false}
              autoCheckAddonUpdates={settings.autoCheckAddonUpdates ?? true} autoApplyAddonUpdates={settings.autoApplyAddonUpdates ?? false}
              onAdvancedModeChange={(advancedMode) => { const next = { ...settings, advancedMode }; setSettings(next); saveSettings(next); }} />
          </div>
        </main>}
      </div>
      <SettingsModal open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onSave={(next) => { setSettings(next); saveSettings(next); }} />
      <FreeModeWizard open={freeModeOpen} onClose={() => setFreeModeOpen(false)} onCompleted={() => { setFreeModeOpen(false); setMainView("office"); }} />
      <UniMcpModal open={uniMcpOpen} onClose={() => setUniMcpOpen(false)} />
      <RoutinesModal open={routinesOpen} onRunNow={(text) => deliverToOffice(text)} onClose={() => setRoutinesOpen(false)} />
      <RemoteControlModal open={rcOpen} onClose={() => setRcOpen(false)} workspace={workspace} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
      <LanguagePickerModal open={languagePickerOpen} onClose={() => {
        setLanguagePickerOpen(false);
        if (!isWalkthroughDone()) setWalkthroughOpen(true);
        else if (shouldShowWhatsNew()) setWhatsNewOpen(true);
      }} />
      <Walkthrough open={walkthroughOpen} onClose={() => setWalkthroughOpen(false)} onOpenOffice={() => setMainView("office")} />
      <WhatsNewModal open={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
      <TrustPromptModal open={!!trustPrompt} path={trustPrompt?.path ?? null}
        onTrust={() => trustPrompt?.resolve("trusted")} onRestricted={() => trustPrompt?.resolve("restricted")} onCancel={() => trustPrompt?.resolve("cancel")} />
      {deleteId && <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="past-delete-title">
        <div className="bg-white rounded-xl p-6 max-w-md space-y-4">
          <h2 id="past-delete-title" className="font-bold">{tr("past.deleteTitle")}</h2>
          <p className="break-words">{tr("past.deleteConfirm", { title: threads.find((thread) => thread.id === deleteId)?.title ?? "" })}</p>
          <div className="flex justify-end gap-3">
            <button type="button" disabled={deleting} onClick={() => setDeleteId(null)}>{tr("common.cancel")}</button>
            <button type="button" disabled={deleting} onClick={() => void handleDelete()} className="rounded bg-red-600 text-white px-3 py-2">{tr("sidebar.deleteThread")}</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
