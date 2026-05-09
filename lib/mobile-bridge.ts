/**
 * UNICREW Mobile Bridge（A案・リモコン型）。
 *
 * PC上のUNICREW（Tauri デスクトップ）と、スマホブラウザ（PWA）との橋渡し。
 *
 * 通信方式: Next.js の API Route 経由ポーリング（最小MVP）。
 *   - スマホ → PC: スマホUIで入力されたテキストを POST /api/mobile/inbox に送る
 *   - PC: 5秒ごとに GET /api/mobile/inbox でキューから引き出し、handleSendForThread で実行
 *   - PC → スマホ: PC側React が POST /api/mobile/state で現在の thread一覧と最新応答を流し込む
 *   - スマホ: GET /api/mobile/state で表示する
 *
 * 注: この方式は Next.js dev モードのみで動く（Tauri build 時の static export では API Route は無効）。
 * 本格運用には Phase 2 で Rust 側に axum HTTP server を立てる必要がある。
 *
 * セキュリティ: 1台のトークン認証のみ。Tailscale 内の信頼できるネットワーク経由を前提。
 *   - 初回起動時に React が token 生成 → POST /api/mobile/auth で server に登録
 *   - スマホは ?t=<token> クエリで認証
 *   - 全 API は X-Mobile-Token または ?t= で照合
 */

export type MobileInboxItem = {
  id: string;
  /** 投稿時刻 (ms) */
  createdAt: number;
  /** 送信先スレッドID。"active" なら PC側でアクティブスレッドに送る */
  threadId: string;
  text: string;
};

/** PC → スマホに見せる現在状態（軽量サマリーだけ。長文は要求時にだけ取り出す）。 */
export type MobileStateSnapshot = {
  /** 最終更新時刻 (ms)。スマホが差分検出に使う */
  updatedAt: number;
  /** 現アクティブスレッドの ID と タイトル */
  activeThreadId: string | null;
  activeThreadTitle: string | null;
  /** スレッド一覧（最大15件・新しい順） */
  threads: { id: string; title: string; updatedAt: number }[];
  /** 直近 assistant 応答テキスト（先頭2000字に切る） */
  lastAssistantPreview: string | null;
  /** 現在ストリーミング中か */
  isStreaming: boolean;
};

export const MOBILE_TOKEN_LS_KEY = "unicrew.mobile.token.v1";
export const MOBILE_TOKEN_HEADER = "X-Mobile-Token";

/**
 * 安全なランダムトークンを生成する。
 * crypto.getRandomValues が使えない環境では Math.random フォールバック。
 */
export function generateMobileToken(): string {
  const bytes = new Uint8Array(20);
  if (typeof globalThis !== "undefined" && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
