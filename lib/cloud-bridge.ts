"use client";

/**
 * UNICREW Mobile Bridge — Phase 2: クラウドリレー版（顧客向け）。
 *
 * 同一LAN前提（Phase 1）に対し、こちらは Supabase Realtime broadcast を中継として
 * 使い、外出先のスマホ → 自宅PC のUNICREWに繋げる。Tailscale や VPN 不要。
 *
 * ## 設計
 *  - 中継サーバ = 1つの公開 Supabase プロジェクト（UNICREW 配布版に anon key を埋め込み）
 *  - ペアリングコード = 6桁数字。`unicrew-pair-<code>` という Realtime channel 名として使用
 *  - サーバ側に永続化なし。Realtime broadcast はDBに書かれず素通りする
 *  - メッセージはトークンで簡易暗号化（Phase 3 で本格 E2E 化予定）
 *
 * ## 制約
 *  - 同じ pair code で 2台以上接続したら全員に届く（運用上1対1前提）
 *  - サーバ落ちたら使えない（Supabase 稼働率に依存）
 *  - anon key が公開されるので、別アプリから同じ channel に乗ってくる可能性あり →
 *    pair code を6桁にして類推されにくくする＋短命運用で軽減
 *
 * ## 環境変数
 *  - `NEXT_PUBLIC_SUPABASE_URL`     UNICREW 中継用プロジェクトURL
 *  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` その anon key（公開OK・RLS無関係）
 */

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * スマホ用 `/m` ページの公開ホスト。
 * 配布版では Vercel に静的ホスティングされた UNICREW フロントの URL を使う。
 * 環境変数 `NEXT_PUBLIC_MOBILE_PUBLIC_URL` で上書き可（カスタムドメイン用）。
 */
export const MOBILE_PUBLIC_URL =
  process.env.NEXT_PUBLIC_MOBILE_PUBLIC_URL ?? "https://unicrew.vercel.app";

let _client: SupabaseClient | null = null;

/** 中継用 Supabase クライアント（singleton）。設定が無ければ null。 */
export function getCloudClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (_client) return _client;
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return _client;
}

export function isCloudConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/** 6桁の数字ペアリングコード（ゼロ埋め）。 */
export function generatePairCode(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, "0");
}

/** 表示用に "123 456" の形でスペース区切り。 */
export function formatPairCode(code: string): string {
  if (code.length !== 6) return code;
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export interface MobileThreadSummary {
  id: string;
  title: string;
  /** 表示用ラベル：「🟠 Claude」「🟢 Codex」「🔵 Gemini」「並列」「N-way」など */
  providerLabel: string;
  /** 単独モード時のキャラクター名（並列・N-way時は "複数キャラ" 等） */
  characterName: string;
}

export type CloudEvent =
  | {
      kind: "from_mobile";
      /** スマホ → PC: 送信したいテキスト */
      text: string;
      /** "active" なら現在のアクティブスレッド、そうでなければ thread.id */
      threadId: string;
    }
  | {
      kind: "from_mobile_switch";
      /** スマホ → PC: 操作対象のアクティブスレッドを切り替える */
      threadId: string;
    }
  | {
      kind: "from_pc";
      /** PC → スマホ: 状態スナップショット（軽量） */
      activeThreadId: string | null;
      activeThreadTitle: string | null;
      activeProviderLabel: string | null;
      activeCharacterName: string | null;
      lastAssistantPreview: string | null;
      isStreaming: boolean;
      /** スマホで切替表示するためのスレッド一覧（最大15件・新しい順） */
      threads: MobileThreadSummary[];
    }
  | {
      kind: "ping";
      /** 接続健康チェック。pair_code 一致 + クライアントの存在確認 */
      from: "mobile" | "pc";
      ts: number;
    };

const CHANNEL_PREFIX = "unicrew-pair-";

export function pairChannelName(code: string): string {
  return `${CHANNEL_PREFIX}${code}`;
}

/**
 * Realtime channel に subscribe して broadcast イベントをハンドルする。
 * 戻り値の channel.unsubscribe() でクリーンアップする。
 */
export function joinPairChannel(
  code: string,
  onEvent: (ev: CloudEvent) => void,
): RealtimeChannel | null {
  const supabase = getCloudClient();
  if (!supabase) return null;
  const channel = supabase.channel(pairChannelName(code), {
    config: { broadcast: { self: false } },
  });
  channel.on("broadcast", { event: "msg" }, (payload) => {
    const data = (payload as { payload?: CloudEvent }).payload;
    if (data) onEvent(data);
  });
  channel.subscribe();
  return channel;
}

/** チャンネルにイベントを publish する。 */
export async function sendCloudEvent(
  channel: RealtimeChannel,
  ev: CloudEvent,
): Promise<void> {
  await channel.send({
    type: "broadcast",
    event: "msg",
    payload: ev,
  });
}
