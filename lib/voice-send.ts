/**
 * 音声入力で「送信」と言ったら送る（2026-10-08 追加）。
 *
 * 音声入力は Windows 標準の Win+H が、入力欄やターミナルへ文字を直接打ち込む。
 * こちらは「打ち込まれた文字の最後が『送信』かどうか」を見て、その言葉を消してから送る。
 *
 * 🚨 マイクのボタンを押してから一定時間だけ有効にする（arm）。キーボードで
 *    「…を送信」と打っただけで勝手に送られないようにするため。
 */

/** マイクを押してから「送信」を聞き取る時間。話している間は延長する。 */
export const VOICE_SEND_WINDOW_MS = 5 * 60 * 1000;

let armedUntil = 0;

export function armVoiceSend(now = Date.now()): void {
  armedUntil = now + VOICE_SEND_WINDOW_MS;
}

export function disarmVoiceSend(): void {
  armedUntil = 0;
}

export function isVoiceSendArmed(now = Date.now()): boolean {
  return now < armedUntil;
}

/**
 * 末尾の「送信」（「送信して」「送信してください」も可）と、その前後の空白・句読点。
 * 音声入力は自動で「。」を付けるので、句読点は落とす。
 */
const SEND_SUFFIX = /[\s　]*送信(?:して(?:ください)?)?[\s　。．.、,!！]*$/;

/** 入力欄の中身全体を見て、最後が「送信」なら取り除いた本文を返す。違えば null。 */
export function stripVoiceSend(text: string): string | null {
  const m = SEND_SUFFIX.exec(text);
  if (!m) return null;
  return text.slice(0, m.index);
}

export interface VoiceSendCut {
  /** 端末へそのまま流す文字（「送信」を除いた部分） */
  forward: string;
  /** すでに端末へ流してしまった「送信」の文字数（その数だけ1文字消しを送る） */
  backspaces: number;
  /** 送信（Enter）するか */
  send: boolean;
}

/**
 * ターミナル用。端末に届く文字は1回でまとめて来るとは限らない（「送」と「信」が
 * 別々に来ることがある）ので、直前に流した文字の末尾（tail）と合わせて判定する。
 * tail に入っている分はもう端末へ送ってあるので、その分は1文字消しで取り消す。
 */
export function cutVoiceSend(tail: string, chunk: string): VoiceSendCut {
  const combined = tail + chunk;
  const m = SEND_SUFFIX.exec(combined);
  if (!m) return { forward: chunk, backspaces: 0, send: false };
  const cut = combined.length - m.index;
  if (cut <= chunk.length) {
    return { forward: chunk.slice(0, chunk.length - cut), backspaces: 0, send: true };
  }
  // 文字数は UTF-16 ではなく見た目の1文字（コードポイント）で数える
  const already = Array.from(tail.slice(m.index)).length;
  return { forward: "", backspaces: already, send: true };
}

/** tail に残す文字数（「送信してください。」が収まる長さ） */
export const VOICE_TAIL_MAX = 16;
