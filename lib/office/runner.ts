/**
 * 進行役（engine.ts）と、本物の AI（Tauri 経由の CLI）をつなぐ係。
 *
 * - 画面からの出来事と AI の実況を engine.step に渡し、返ってきた「外でやること」を実行する
 * - 社員1人＝AI のセッション1本。セッション ID は `office.<会社>.<社員>`
 * - ブラウザだけで開いたとき（Tauri でないとき）は、見本の実況（demo.ts）で動かす
 */
import type { Locale } from "../i18n";
import { reportWorkDone } from "../attention";
import { openPreviewSession } from "../preview-window";
import { pickPrimary } from "../turn-artifacts";
import {
  agentPermissionResponse,
  agentSend,
  agentStart,
  agentStop,
  getApiKey,
  isTauri,
  listenAgentEvents,
  type AgentEvent,
} from "../tauri";
import { cliModelFor, type AppSettings } from "../types";
import { createDemoDriver, type DemoDriver } from "./demo";
import { step } from "./engine";
import { leadSystemPrompt, memberSystemPrompt } from "./protocol";
import type { Office, OfficeAgentEvent, OfficeEffect, OfficeInput, OfficeRun } from "./types";

const SID_PREFIX = "office.";

export function officeSid(officeId: string, staffId: string): string {
  return `${SID_PREFIX}${officeId}.${staffId}`;
}

export function parseOfficeSid(sid: string): { officeId: string; staffId: string } | null {
  if (!sid.startsWith(SID_PREFIX)) return null;
  const rest = sid.slice(SID_PREFIX.length);
  const i = rest.indexOf(".");
  if (i <= 0 || i === rest.length - 1) return null;
  return { officeId: rest.slice(0, i), staffId: rest.slice(i + 1) };
}

export interface RunnerHost {
  getOffice(): Office | null;
  getRun(): OfficeRun | null;
  setRun(run: OfficeRun): void;
  getSettings(): AppSettings;
  getLocale(): Locale;
  /** 自動プレビューを出してよいか・通知を出してよいか は settings から読む */
}

export class OfficeRunner {
  private unlisten: (() => void) | null = null;
  private demo: DemoDriver | null = null;
  /** 社員ごとの「起動→送信」を順番に流す（起動が終わる前に送らない） */
  private chains = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private host: RunnerHost) {}

  async attach(): Promise<void> {
    if (isTauri()) {
      const un = await listenAgentEvents((ev) => this.onAgentEvent(ev));
      if (this.disposed) un();
      else this.unlisten = un;
    } else {
      this.demo = createDemoDriver((staffId, ev) => {
        this.dispatch({ t: "agent", staffId, ev, at: Date.now() });
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.demo?.dispose();
    this.demo = null;
  }

  private onAgentEvent(ev: AgentEvent): void {
    const sid = (ev as { session_id?: string }).session_id;
    if (!sid) return;
    const parsed = parseOfficeSid(sid);
    const office = this.host.getOffice();
    if (!parsed || !office || parsed.officeId !== office.id) return;
    const { session_id: _drop, ...rest } = ev as AgentEvent & { session_id?: string };
    void _drop;
    this.dispatch({ t: "agent", staffId: parsed.staffId, ev: rest as OfficeAgentEvent, at: Date.now() });
  }

  dispatch(input: OfficeInput): void {
    const office = this.host.getOffice();
    const run = this.host.getRun();
    if (!office || !run) return;
    const r = step(run, office, input, this.host.getLocale());
    this.host.setRun(r.run);
    for (const e of r.effects) this.perform(office, e);
  }

  private perform(office: Office, e: OfficeEffect): void {
    switch (e.t) {
      case "send":
        this.enqueue(e.staffId, () => this.send(office, e.staffId, e.text));
        return;
      case "stop":
        this.enqueue(e.staffId, async () => {
          if (this.demo) this.demo.stop(e.staffId);
          else await agentStop(officeSid(office.id, e.staffId)).catch(() => {});
        });
        return;
      case "permission":
        if (!this.demo) {
          void agentPermissionResponse(officeSid(office.id, e.staffId), e.requestId, e.allow ? "allow" : "deny").catch(() => {});
        }
        return;
      case "attention": {
        const s = this.host.getSettings();
        void reportWorkDone({ title: e.title, body: e.body, notify: s.notifyOnDone !== false }).catch(() => {});
        return;
      }
      case "preview": {
        const s = this.host.getSettings();
        if (s.autoPreview === false || e.artifacts.length === 0) return;
        const primary = pickPrimary(e.artifacts);
        void openPreviewSession(
          { title: office.name, workspace: office.workspace, items: e.artifacts, selected: primary?.target ?? null, at: Date.now() },
          { focus: false },
        ).catch(() => {});
        return;
      }
    }
  }

  private enqueue(staffId: string, job: () => Promise<void>): void {
    const prev = this.chains.get(staffId) ?? Promise.resolve();
    const next = prev.then(job, job);
    this.chains.set(staffId, next);
  }

  private async send(office: Office, staffId: string, text: string): Promise<void> {
    const staff = office.staff.find((s) => s.id === staffId);
    if (!staff) return;
    if (this.demo) {
      this.demo.send(office, staff, text, this.host.getLocale());
      return;
    }
    const sid = officeSid(office.id, staffId);
    try {
      const rt = this.host.getRun()?.staff[staffId];
      if (!rt?.started) {
        const settings = this.host.getSettings();
        const lead = office.staff.find((s) => s.lead) ?? null;
        const apiKey = settings.authMode === "apikey" ? await getApiKey() : null;
        await agentStart({
          sessionId: sid,
          workspace: office.workspace,
          systemPrompt: staff.lead ? leadSystemPrompt(office, staff) : memberSystemPrompt(office, staff, lead),
          model: cliModelFor(staff.provider, staff.model),
          authMode: settings.authMode,
          apiKey,
          provider: staff.provider,
          resumeCliSessionId: rt?.cliSessionId ?? null,
          permissionMode: "acceptEdits",
        });
        this.dispatch({ t: "started", staffId });
      }
      await agentSend(sid, text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatch({ t: "start_failed", staffId, message, at: Date.now() });
    }
  }

  /** 社員の「仕事のやり方」や AI を変えたとき：次の仕事から新しい決まりで起動し直す。 */
  restartStaff(officeId: string, staffId: string): void {
    this.enqueue(staffId, async () => {
      if (this.demo) return;
      await agentStop(officeSid(officeId, staffId)).catch(() => {});
    });
  }
}
