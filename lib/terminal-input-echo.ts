/**
 * 「いま出した指示」を画面上部に貼り付けておくための入力の写し取り。
 *
 * ねらい: 文脈が伸びると、自分が何を頼んだのかが上へ流れて見えなくなる。
 * PTY へ送ったキー入力を組み立て直して、Enter で確定した 1 件を覚えておく。
 *
 * 【なぜ画面を読まないか】
 * 画面（xterm のバッファ）から読むと、CLI の描画に依存して壊れる。
 * 送った文字はこちらが持っているので、こちらを正本にする。
 *
 * 【扱う制御文字】
 * - `\r` / `\n` … 確定（1 件として記録し、バッファを空にする）
 * - `\x7f` / `\b` … 1 文字消す
 * - `\x03`(Ctrl+C) / `\x15`(Ctrl+U) / `\x1b`始まり … バッファを捨てる／無視する
 * 矢印キーでの編集や補完はここでは追いかけない（完全な再現は目的ではない）。
 */

export interface EchoState {
  /** 入力中の行 */
  buffer: string;
  /** 直近に Enter で確定した行（無ければ null） */
  last: string | null;
}

export const EMPTY_ECHO: EchoState = { buffer: "", last: null };

/** 1 行として記録する最大長（長すぎる貼り付けは頭だけ残す）。 */
export const MAX_ECHO_LEN = 2000;

/**
 * PTY へ送った文字列を食わせて状態を進める。
 * 純関数（同じ入力なら同じ出力）。
 */
export function feedInput(state: EchoState, data: string): EchoState {
  if (!data) return state;
  let { buffer, last } = state;

  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = data.charCodeAt(i);

    // エスケープ列（矢印・ファンクション・ブラケットペーストのマーカー等）は
    // 読み飛ばす。終端は英字か `~`。
    if (ch === "\x1b") {
      let j = i + 1;
      while (j < data.length && !/[A-Za-z~]/.test(data[j])) j++;
      i = j;
      continue;
    }
    // 確定
    if (ch === "\r" || ch === "\n") {
      const line = buffer.trim();
      if (line) last = line.slice(0, MAX_ECHO_LEN);
      buffer = "";
      continue;
    }
    // 1 文字消す
    if (ch === "\x7f" || ch === "\b") {
      buffer = buffer.slice(0, -1);
      continue;
    }
    // 行を捨てる（Ctrl+C / Ctrl+U）
    if (ch === "\x03" || ch === "\x15") {
      buffer = "";
      continue;
    }
    // タブは補完なので入力としては無視（余計な空白を残さない）
    if (ch === "\t") continue;
    // その他の制御文字は無視
    if (code < 0x20) continue;

    buffer += ch;
    if (buffer.length > MAX_ECHO_LEN * 2) {
      buffer = buffer.slice(0, MAX_ECHO_LEN * 2);
    }
  }

  if (buffer === state.buffer && last === state.last) return state;
  return { buffer, last };
}
