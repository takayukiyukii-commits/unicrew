/**
 * フィードバック・サーベイの状態管理。
 *
 * UNICREW を使い始めたユーザーに、たまに「使い心地どうですか？」を聞いて、
 * 改善要望・新機能リクエストを集める。集計はメール+ローカルJSON。
 *
 * 表示ロジック:
 *  - ユーザーが累計5メッセージ以上送ったら候補入り
 *  - 一度も表示してない or 前回表示から14日以上経過 → 表示
 *  - 提出済みの場合は次回まで60日空ける
 *  - ユーザーが「あとで」を押したら14日後に再出現
 */

const STORAGE_KEY = "unicrew_feedback_state_v1";
const HISTORY_KEY = "unicrew_feedback_history_v1";

/**
 * リモート集計エンドポイント（Vercel Function → Supabase）。
 * 未デプロイの間は POST が失敗するが、try/catch で握りつぶして mailto 経路にだけ依存させる。
 * デプロイ後は環境変数 NEXT_PUBLIC_FEEDBACK_ENDPOINT で上書き可能。
 */
const REMOTE_ENDPOINT =
  (typeof process !== "undefined" &&
    (process.env.NEXT_PUBLIC_FEEDBACK_ENDPOINT as string | undefined)) ||
  "https://drop.uni-core.jp/api/unicrew-feedback";

const MIN_MESSAGES_BEFORE_FIRST_PROMPT = 5;
const COOLDOWN_DAYS_AFTER_DISMISS = 14;
const COOLDOWN_DAYS_AFTER_SUBMIT = 60;

export type FeedbackRating = "very_bad" | "bad" | "neutral" | "good" | "great";

export const RATING_OPTIONS: {
  id: FeedbackRating;
  emoji: string;
  label: string;
}[] = [
  { id: "very_bad", emoji: "😞", label: "残念" },
  { id: "bad", emoji: "😐", label: "いまいち" },
  { id: "neutral", emoji: "🙂", label: "ふつう" },
  { id: "good", emoji: "😄", label: "気に入ってる" },
  { id: "great", emoji: "🤩", label: "最高" },
];

export interface FeedbackPayload {
  rating: FeedbackRating;
  improvement: string;
  feature_request: string;
  email?: string;
  /** UNICREW のバージョン */
  app_version: string;
  /** ユーザーが送信した累計メッセージ数（参考値） */
  user_message_count: number;
  /** 送信日時（ISO 8601） */
  submitted_at: string;
}

interface FeedbackState {
  /** ISO 8601 文字列。最後に表示した時刻。 */
  last_shown_at: string | null;
  /** ISO 8601 文字列。最後に提出した時刻。 */
  last_submitted_at: string | null;
  /** 提出回数（累計） */
  submitted_count: number;
  /** 永続的に出さない設定（フッターで切替可） */
  opted_out: boolean;
}

function readState(): FeedbackState {
  if (typeof window === "undefined")
    return {
      last_shown_at: null,
      last_submitted_at: null,
      submitted_count: 0,
      opted_out: false,
    };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
      return {
        last_shown_at: null,
        last_submitted_at: null,
        submitted_count: 0,
        opted_out: false,
      };
    return {
      last_shown_at: null,
      last_submitted_at: null,
      submitted_count: 0,
      opted_out: false,
      ...(JSON.parse(raw) as Partial<FeedbackState>),
    };
  } catch {
    return {
      last_shown_at: null,
      last_submitted_at: null,
      submitted_count: 0,
      opted_out: false,
    };
  }
}

function writeState(state: FeedbackState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage 書き込み失敗は黙殺
  }
}

function readHistory(): FeedbackPayload[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(items: FeedbackPayload[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(-50))); // 直近50件のみ保持
  } catch {
    // ignore
  }
}

function daysBetween(a: string, b: number): number {
  return (b - new Date(a).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * 累計ユーザーメッセージ数を全スレッドから数える。
 */
export function countUserMessages(
  threads: { messages: { role: string }[] }[],
): number {
  let count = 0;
  for (const t of threads) {
    for (const m of t.messages) {
      if (m.role === "user") count++;
    }
  }
  return count;
}

export function shouldShowFeedback(userMessageCount: number): boolean {
  if (userMessageCount < MIN_MESSAGES_BEFORE_FIRST_PROMPT) return false;

  const state = readState();
  if (state.opted_out) return false;

  const now = Date.now();

  if (state.last_submitted_at) {
    const days = daysBetween(state.last_submitted_at, now);
    if (days < COOLDOWN_DAYS_AFTER_SUBMIT) return false;
  }

  if (state.last_shown_at) {
    const days = daysBetween(state.last_shown_at, now);
    if (days < COOLDOWN_DAYS_AFTER_DISMISS) return false;
  }

  return true;
}

export function markFeedbackShown(): void {
  const state = readState();
  writeState({ ...state, last_shown_at: new Date().toISOString() });
}

export function markFeedbackDismissed(): void {
  // 表示時刻を更新するだけ。次は14日後。
  markFeedbackShown();
}

export function recordFeedback(payload: FeedbackPayload): {
  mailtoUrl: string;
} {
  const state = readState();
  writeState({
    ...state,
    last_submitted_at: payload.submitted_at,
    submitted_count: state.submitted_count + 1,
    last_shown_at: payload.submitted_at,
  });
  const history = readHistory();
  history.push(payload);
  writeHistory(history);

  // リモート集計に投げる（失敗しても mailto 経路があるので無視）
  void postFeedbackRemote(payload).catch(() => {});

  return { mailtoUrl: buildMailtoUrl(payload) };
}

async function postFeedbackRemote(payload: FeedbackPayload): Promise<void> {
  if (typeof fetch === "undefined") return;
  await fetch(REMOTE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // CORS で弾かれた場合に投げ捨てるため `keepalive` を有効化（送信完了をブロックしない）
    keepalive: true,
  });
}

export function setOptedOut(opted_out: boolean): void {
  const state = readState();
  writeState({ ...state, opted_out });
}

export function isOptedOut(): boolean {
  return readState().opted_out;
}

export function getFeedbackHistory(): FeedbackPayload[] {
  return readHistory();
}

function buildMailtoUrl(payload: FeedbackPayload): string {
  const ratingLabel =
    RATING_OPTIONS.find((r) => r.id === payload.rating)?.label ??
    payload.rating;
  const subject = `[UNICREW] フィードバック (${ratingLabel})`;
  const body =
    `UNICREW の使い心地アンケートからの回答です。\n\n` +
    `■ 評価: ${ratingLabel}\n\n` +
    `■ もっとこうして欲しいこと\n${payload.improvement || "(なし)"}\n\n` +
    `■ 欲しい新機能\n${payload.feature_request || "(なし)"}\n\n` +
    `■ 連絡先（任意）\n${payload.email || "(任意・未記入)"}\n\n` +
    `――――――――――――――――――――\n` +
    `UNICREW: ${payload.app_version}\n` +
    `累計メッセージ数: ${payload.user_message_count}\n` +
    `送信日時: ${payload.submitted_at}\n`;
  return `mailto:support@uni-core.jp?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
