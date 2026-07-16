"use client";

/**
 * UNIHUB リモート受付（UNIPILOT P3-M3）
 *
 * UNIHUB の AI 秘書画面「PCリモート連携」で発行されたコードでペアリングし、
 * 本人が UNIHUB 側で承認したジョブをこの PC の claude CLI（`claude -p`）で実行して
 * 結果を返す。配送（マイチャット/LINE/通知/Push）はサーバー側の仕事。
 *
 * ## 設計（引継ぎ書 20260716_引継ぎ_UNICREWローカルノードP3-M3.md §2-§3）
 *  - 30秒ポーリングが正本。Supabase Realtime の kick はレイテンシ最適化の飾り
 *    （broadcast はオフライン中に喪失するため、Realtime 無しでも完全動作する）
 *  - GET /api/unicrew/jobs はそれ自体が heartbeat（UNIHUB 側の「オンライン」表示）
 *  - 401 = UNIHUB 側で解除（キルスイッチ）→ 受付を自動 OFF にして表示
 *  - 完了報告の 409 = 二重報告/期限切れ掃除との競合 → 正常系として握りつぶす
 *  - トグル既定 OFF。OFF で ポーリング/購読停止 + 実行中プロセス kill
 */

import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { isTauri, remoteExecClaude, remoteExecKillAll } from "./tauri";

export const HUB_BASE_URL =
  process.env.NEXT_PUBLIC_UNIHUB_BASE_URL ?? "https://hub.uni-core.jp";

const CONFIG_KEY = "unicrew.remoteNode.v1";
const LOG_KEY = "unicrew.remoteNodeLog.v1";
const LOG_MAX = 50;
/** サーバー仕様: result は最大 8000 字 */
const RESULT_MAX_CHARS = 8000;
const DEFAULT_POLL_INTERVAL_SEC = 30;

// ---------- 型 ----------

export interface RemoteNodeRealtimeConfig {
  topic: string;
  supabase_url: string;
  anon_key: string;
}

export interface RemoteNodeConfig {
  /** 受付トグル（既定 OFF） */
  enabled: boolean;
  nodeId: string;
  nodeName: string;
  /** ペアリング応答の1回だけ平文で返るトークン（サーバは SHA-256 のみ保持） */
  token: string;
  realtime: RemoteNodeRealtimeConfig | null;
  pollIntervalSec: number;
  /** UNIHUB 側で解除された（401）→ 再ペアリングが必要 */
  revoked?: boolean;
}

export type RemoteNodeStatus =
  | "off" // 未設定 or トグルOFF
  | "connecting" // 起動直後・初回ポーリング前
  | "online" // 直近のポーリング成功
  | "error" // ネットワーク等の一時エラー（ポーリングは継続）
  | "revoked"; // UNIHUB側で解除された（要・再ペアリング）

export interface RemoteJobLogEntry {
  jobId: string;
  prompt: string;
  ok: boolean;
  result: string;
  startedAt: number;
  finishedAt: number;
}

interface RemoteJob {
  id: string;
  prompt: string;
  cwd: string | null;
  created_at: string;
}

// ---------- 設定・ログの永続化 ----------

export function loadRemoteNodeConfig(): RemoteNodeConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as RemoteNodeConfig;
    if (!cfg.token || !cfg.nodeId) return null;
    return cfg;
  } catch {
    return null;
  }
}

function saveRemoteNodeConfig(cfg: RemoteNodeConfig | null) {
  if (typeof window === "undefined") return;
  try {
    if (cfg) localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CONFIG_KEY);
  } catch {
    /* noop */
  }
}

export function loadRemoteJobLog(): RemoteJobLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RemoteJobLogEntry[];
  } catch {
    return [];
  }
}

function appendRemoteJobLog(entry: RemoteJobLogEntry): RemoteJobLogEntry[] {
  const log = [entry, ...loadRemoteJobLog()].slice(0, LOG_MAX);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    /* noop */
  }
  return log;
}

// ---------- マネージャ本体（module singleton） ----------

type Listener = () => void;

class RemoteNodeManager {
  private config: RemoteNodeConfig | null = null;
  private status: RemoteNodeStatus = "off";
  private lastError: string | null = null;
  private runningJobId: string | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private kickPending = false;
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private listeners = new Set<Listener>();
  private initialized = false;

  // ---- 外部 API ----

  /** アプリ起動時に1回呼ぶ。有効設定が残っていれば受付を再開する。 */
  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.config = loadRemoteNodeConfig();
    if (this.config?.enabled && !this.config.revoked) {
      this.startLoop();
    } else if (this.config?.revoked) {
      this.status = "revoked";
    }
    this.emit();
  }

  getStatus(): RemoteNodeStatus {
    return this.status;
  }

  getConfig(): RemoteNodeConfig | null {
    return this.config;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getRunningJobId(): string | null {
    return this.runningJobId;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** ペアリング（初回1回）。成功したら受付 ON で開始する。 */
  async pair(code: string, nodeName: string): Promise<void> {
    const res = await fetch(`${HUB_BASE_URL}/api/unicrew/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim(), name: nodeName }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      node_id?: string;
      token?: string;
      realtime?: RemoteNodeRealtimeConfig;
      poll_interval_sec?: number;
      error?: string;
    } | null;
    if (!res.ok || !body?.ok || !body.token || !body.node_id) {
      throw new Error(
        body?.error ??
          "ペアリングに失敗しました。コードは10分有効・使い捨てです。UNIHUBで発行し直してください。",
      );
    }
    this.config = {
      enabled: true,
      nodeId: body.node_id,
      nodeName,
      token: body.token,
      realtime: body.realtime ?? null,
      pollIntervalSec: body.poll_interval_sec ?? DEFAULT_POLL_INTERVAL_SEC,
      revoked: false,
    };
    saveRemoteNodeConfig(this.config);
    this.startLoop();
    this.emit();
  }

  /** 受付トグル ON/OFF。OFF = ポーリング/購読停止＋実行中プロセス kill（緊急停止）。 */
  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.config) return;
    this.config = { ...this.config, enabled };
    saveRemoteNodeConfig(this.config);
    if (enabled && !this.config.revoked) {
      this.startLoop();
    } else {
      await this.stopLoop(true);
      this.status = this.config.revoked ? "revoked" : "off";
    }
    this.emit();
  }

  /** 連携を解除（ローカル設定を破棄）。サーバー側の失効は UNIHUB 画面から行う。 */
  async unpair(): Promise<void> {
    await this.stopLoop(true);
    this.config = null;
    saveRemoteNodeConfig(null);
    this.status = "off";
    this.lastError = null;
    this.emit();
  }

  /** UI の「今すぐ確認」用。 */
  pollNow() {
    void this.pollOnce();
  }

  // ---- 内部 ----

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private startLoop() {
    void this.stopLoop(false).then(() => {
      if (!this.config?.enabled) return;
      this.status = "connecting";
      this.lastError = null;
      this.emit();
      this.subscribeKick();
      this.scheduleNext(0);
    });
  }

  private async stopLoop(killRunning: boolean) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.channel) {
      try {
        await this.channel.unsubscribe();
      } catch {
        /* noop */
      }
      this.channel = null;
    }
    if (killRunning) {
      try {
        await remoteExecKillAll();
      } catch {
        /* noop */
      }
    }
  }

  private scheduleNext(delayMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.pollOnce();
    }, delayMs);
  }

  /**
   * Realtime キック購読（ベストエフォート）。
   * broadcast はオフライン中に喪失するため、これが繋がらなくても
   * 30秒ポーリングだけで完全動作する。エラーは黙って無視する。
   */
  private subscribeKick() {
    const rt = this.config?.realtime;
    if (!rt?.topic || !rt.supabase_url || !rt.anon_key) return;
    try {
      this.supabase = createClient(rt.supabase_url, rt.anon_key, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 2 } },
      });
      this.channel = this.supabase.channel(rt.topic, {
        config: { broadcast: { self: false } },
      });
      this.channel.on("broadcast", { event: "kick" }, () => {
        // kick 受信 → 即ジョブ取得
        void this.pollOnce();
      });
      this.channel.subscribe();
    } catch {
      this.channel = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const cfg = this.config;
    if (!cfg?.enabled || cfg.revoked) return;
    if (this.pollInFlight) {
      // 実行中に kick が来た場合は終わってからもう一周
      this.kickPending = true;
      return;
    }
    this.pollInFlight = true;
    try {
      const res = await fetch(`${HUB_BASE_URL}/api/unicrew/jobs`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        cache: "no-store",
      });
      if (res.status === 401) {
        // UNIHUB 側で解除された（キルスイッチ）→ 受付を自動 OFF
        this.config = { ...cfg, enabled: false, revoked: true };
        saveRemoteNodeConfig(this.config);
        await this.stopLoop(true);
        this.status = "revoked";
        this.lastError =
          "UNIHUB側で連携が解除されました。再度利用するにはペアリングし直してください。";
        this.emit();
        return;
      }
      if (!res.ok) throw new Error(`サーバーエラー（${res.status}）`);
      const body = (await res.json()) as { ok: boolean; jobs?: RemoteJob[] };
      this.status = "online";
      this.lastError = null;
      this.emit();

      const jobs = body.jobs ?? [];
      for (const job of jobs) {
        await this.runJob(job);
      }
      if (jobs.length > 0) {
        // 返ったジョブは claim 済み・1回1件。キューが残っている可能性があるので即もう一周
        this.kickPending = true;
      }
    } catch (e) {
      // ネットワーク断等は一時エラー。ポーリングは継続する
      this.status = "error";
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit();
    } finally {
      this.pollInFlight = false;
      if (this.config?.enabled && !this.config.revoked) {
        const interval = this.kickPending
          ? 500
          : (this.config.pollIntervalSec || DEFAULT_POLL_INTERVAL_SEC) * 1000;
        this.kickPending = false;
        this.scheduleNext(interval);
      }
    }
  }

  private async runJob(job: RemoteJob): Promise<void> {
    const startedAt = Date.now();
    this.runningJobId = job.id;
    this.emit();
    let ok = false;
    let result = "";
    try {
      if (!isTauri()) {
        throw new Error("リモート実行は UNICREW アプリ起動時のみ利用できます");
      }
      const r = await remoteExecClaude({
        jobId: job.id,
        prompt: job.prompt,
        cwd: job.cwd,
      });
      ok = r.ok;
      result = r.output;
    } catch (e) {
      ok = false;
      result = `実行に失敗しました: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (result.length > RESULT_MAX_CHARS) {
      result = `${result.slice(0, RESULT_MAX_CHARS - 20)}\n（以下省略）`;
    }
    this.runningJobId = null;
    appendRemoteJobLog({
      jobId: job.id,
      prompt: job.prompt,
      ok,
      result,
      startedAt,
      finishedAt: Date.now(),
    });
    await this.reportResult(job.id, ok, result);
    this.emit();
  }

  /** 完了報告。409 は二重報告/期限切れ掃除との競合＝正常系として握りつぶす。 */
  private async reportResult(
    jobId: string,
    ok: boolean,
    result: string,
  ): Promise<void> {
    const cfg = this.config;
    if (!cfg) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${HUB_BASE_URL}/api/unicrew/jobs/${jobId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.token}`,
          },
          body: JSON.stringify({ ok, result }),
        });
        if (res.ok || res.status === 409) return;
        if (res.status === 401) return; // 解除済み。次のポーリングで検知される
      } catch {
        /* ネットワーク断はリトライ */
      }
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

export const remoteNodeManager = new RemoteNodeManager();
