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

/** 起動のときに「会社の決まり（役割・名簿・合図）」を受け取らない AI。最初の伝言の頭に付けて渡す。 */
const RULES_IN_MESSAGE = new Set(["goose", "opencode", "codex-acp", "kiro", "kimi"]);

/** 前の続きから始めてよいかを決める印（AI か作業フォルダが変わったら、前の会話の続きにはしない）。 */
export function sessionKeyOf(provider: string, workspace: string | null): string {
  return `${provider}|${workspace ?? ""}`;
}

/**
 * 次の送信の前に、起動し直しが要るか・伝言の頭に決まりを付けるかを決める。
 * running＝いま動いているセッションを起動したときの決まり（無ければ、このアプリを開いてからは起動していない）。
 */
export function planSend(args: { started: boolean; running: { key: string; rules: string } | null; savedKey: string | undefined; key: string; rules: string; provider: string; hasResume: boolean }): { restart: boolean; resume: boolean; prefixRules: boolean } {
  const changed = !!args.running && (args.running.key !== args.key || args.running.rules !== args.rules);
  const restart = !args.started || changed;
  // 続きから始めるのは、AI と作業フォルダが前と同じときだけ
  const resume = restart && args.hasResume && (args.savedKey === undefined || args.savedKey === args.key) && (!args.running || args.running.key === args.key);
  // 決まりを伝言に付ける：起動で受け取らない AI／続きから始めるのに決まりが変わったとき（続きでは新しい決まりを読まない AI がある）
  const prefixRules = restart && (RULES_IN_MESSAGE.has(args.provider) || (resume && !!args.running && args.running.rules !== args.rules));
  return { restart, resume, prefixRules };
}

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
  /** 社員ごとの、いま動いているセッションを起動したときの決まり */
  private running = new Map<string, { key: string; rules: string }>();
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
          this.running.delete(officeSid(office.id, e.staffId));
        });
        return;
      case "permission":
        if (!this.demo) {
          // 答えが届かなかったら（AI がもう止まっている等）、動いているふりをさせない
          void agentPermissionResponse(officeSid(office.id, e.staffId), e.requestId, e.allow ? "allow" : "deny").catch((err) => {
            this.dispatch({ t: "agent", staffId: e.staffId, ev: { kind: "error", message: err instanceof Error ? err.message : String(err) }, at: Date.now() });
          });
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
      const lead = office.staff.find((s) => s.lead) ?? null;
      const systemPrompt = staff.lead ? leadSystemPrompt(office, staff) : memberSystemPrompt(office, staff, lead);
      const model = cliModelFor(staff.provider, staff.model);
      const key = sessionKeyOf(staff.provider, office.workspace);
      const rules = `${model ?? ""}\n${systemPrompt}`;
      // 作業フォルダ・AI・仕事のやり方・名簿が変わっていたら、いまのセッションを止めて新しい決まりで起動し直す
      const plan = planSend({ started: !!rt?.started, running: this.running.get(sid) ?? null, savedKey: rt?.sessionKey, key, rules, provider: staff.provider, hasResume: !!rt?.cliSessionId });
      let body = text;
      if (plan.restart) {
        if (rt?.started) await agentStop(sid).catch(() => {});
        const settings = this.host.getSettings();
        const apiKey = settings.authMode === "apikey" ? await getApiKey() : null;
        await agentStart({
          sessionId: sid,
          workspace: office.workspace,
          systemPrompt,
          model,
          authMode: settings.authMode,
          apiKey,
          provider: staff.provider,
          resumeCliSessionId: plan.resume ? rt?.cliSessionId ?? null : null,
          permissionMode: "acceptEdits",
        });
        this.running.set(sid, { key, rules });
        this.dispatch({ t: "started", staffId, sessionKey: key });
        if (plan.prefixRules) body = `【この会社での決まり（必ず守ってください）】\n${systemPrompt}\n\n――――\n\n${text}`;
      }
      await agentSend(sid, body);
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
      this.running.delete(officeSid(officeId, staffId));
    });
  }
}
