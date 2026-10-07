/**
 * ターミナルの「モデル一括切替」（2026-10-07 追加）。
 *
 * 並べた Claude Code のペインへ、同じ `/model <別名>` を一度に流す。
 * 起動し直さない（会話を残したまま切り替える）ので、途中変更の手段はスラッシュコマンドだけ。
 *
 * 【対象は Claude Code だけ】
 * - Codex / Gemini などの `/model` は引数を取らず選択画面を開く作り。
 *   文字を流しても切り替わらず、画面が開いたまま止まるので送らない（件数として知らせる）
 * - シェルのペインに `/model ...` を流すとコマンドとして実行されてしまうので送らない
 *
 * 【送り方】文字と Enter を分けて送る（sequenceFor）。
 * 1回で「文字+Enter」を流すと、Claude Code は貼り付けと見なして
 * Enter を改行として入力欄に残すことがある（＝送信されない）。
 */

/** 選べるモデル。チャット側（lib/types.ts の ModelId）と同じく版数を書かない別名だけ。 */
export const TERMINAL_MODEL_CHOICES = ["opus", "sonnet", "haiku"] as const;
export type TerminalModelChoice = (typeof TERMINAL_MODEL_CHOICES)[number];

export interface PaneLike {
  kind: "claude" | "shell";
  cliId?: string;
}

/** Claude Code が動いているペインか（cliId 未指定は従来の Claude 既定ペイン）。 */
export function isClaudePane(p: PaneLike): boolean {
  return p.kind === "claude" && (p.cliId === undefined || p.cliId === "claude");
}

/** 切替の対象と、対象外（Claude 以外の AI・シェル）の数。 */
export function splitModelTargets<T extends PaneLike>(
  panes: readonly T[],
): { targets: T[]; skipped: number } {
  const targets = panes.filter(isClaudePane);
  return { targets, skipped: panes.length - targets.length };
}

/**
 * 画面の最後のあたりが「選んでください」の確認画面（許可ダイアログ）か。
 * 🚨 ここに `/model ...` と Enter を流すと、Enter が選択中の「はい」を押してしまう
 *    （AI がやろうとしていた操作を勝手に許可する）。だからそのペインには送らない。
 * tail は最近の出力（制御文字を含んでよい）。
 */
export function isAwaitingChoice(tail: string): boolean {
  const plain = stripAnsi(tail).slice(-1500);
  return (
    /Do you want to (proceed|make this edit|create|run|allow|use)/i.test(plain) ||
    /❯\s*1\.\s*Yes/.test(plain) ||
    /\b1\.\s*Yes\b[\s\S]{0,200}\b2\.\s*(Yes|No)/.test(plain) ||
    /Allow (once|always)|Approve|許可しますか/.test(plain)
  );
}

/** ESC 始まりの制御列（色・カーソル移動・OSC）を取り除く。 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/** 最近の出力の末尾を保つ（確認画面の見張り用）。長さは固定で、古いものから捨てる。 */
export function appendTail(prev: string, text: string, max = 4000): string {
  const next = prev + text;
  return next.length > max ? next.slice(next.length - max) : next;
}

/** PTY へ順に書き込む断片。間に少し待ちを入れる前提（呼び出し側）。 */
export function sequenceFor(model: TerminalModelChoice): string[] {
  if (!(TERMINAL_MODEL_CHOICES as readonly string[]).includes(model)) {
    throw new Error(`unknown model: ${model}`);
  }
  return [`/model ${model}`, "\r"];
}
