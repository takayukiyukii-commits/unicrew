/**
 * 「`--resume <死んだ sid>` で CLI が黙り込む」ケースの自動回復を、発動してよいか判定する。
 *
 * 判定材料は「送信してから、その CLI プロセスが 1 行でも何か出したか」。
 *
 * 旧判定は「30 秒以内に本文かツール実行（blocks）が出たか」だった。これだと
 * 考え中（thinking はフロントへ流していない）・起動待ち・長い履歴の読み込み中の
 * **健康なセッションを殺す**。殺すと会話 ID を捨てて新規起動になり、指示ファイルと
 * 履歴をまるごとキャッシュし直す（2026-09-19 実測＝「ok」1 往復で 56,662 トークン・
 * 最初の本文まで 19.2 秒。閾値 30 秒まで余裕 10.8 秒しか無かった）。
 *
 * 生きている CLI は毎ターン、送信から 1 秒以内に `system init` を出し、考え中も
 * `system thinking_tokens` を出し続ける（2026-09-20 実測。Rust 側はこれを `ready` /
 * `cli_session_id` として流す）。本当に黙り込んだプロセスだけが、何も出さない。
 */

/** 何も届かない状態がこれだけ続いたら「黙り込んだ」とみなす。 */
export const RESUME_STUCK_MS = 60_000;

export interface ResumeWatchInput {
  now: number;
  /** この送信（下書き）を始めた時刻 */
  startedAt: number;
  /** この送信のあと最初に何かが届いた時刻。まだ何も届いていなければ null */
  firstEventAt: number | null;
  /** 画面に出ている本文・ツール実行の数 */
  blockCount: number;
  /** 再開用の CLI セッション ID を持っているか（持っていなければ「再開の失敗」ではない） */
  hasCliSessionId: boolean;
  /** このセッションで既に 1 度回復を試したか（無限ループ防止） */
  alreadyRecovered: boolean;
}

export function shouldRecoverStuckResume(i: ResumeWatchInput): boolean {
  if (i.alreadyRecovered) return false;
  if (!i.hasCliSessionId) return false;
  if (i.blockCount > 0) return false;
  // 1 行でも届いていれば生きている。考え中・起動待ち・承認待ちを「黙り込み」と読まない。
  if (i.firstEventAt !== null) return false;
  return i.now - i.startedAt >= RESUME_STUCK_MS;
}
