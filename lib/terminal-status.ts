/**
 * ターミナル下部のステータス行に出す情報の抽出。
 *
 * 出すのは 2 つ:
 *  1. エフォート（起動時にこちらが渡した値なので確実）
 *  2. モデル名（**CLI の画面表示から読み取った値**。読めたときだけ出す）
 *
 * 【嘘をつかないための約束】
 * - モデル名は「分かったときだけ」出す。分からないときは何も出さない（推測しない）
 * - claude は不正な --effort を渡しても落ちず、警告を出して既定で走る。
 *   その警告を検出したらエフォート表示を取り消す（＝バッジが嘘になるのを防ぐ）
 * - 画面の読み取りは CLI の UI 変更で効かなくなる。効かなくなったら
 *   「出ない」だけで、間違った値は出ない作りにする
 */

/** ANSI エスケープを落とす（色や画面制御が混ざった生の出力を読むため）。 */
export function stripAnsi(text: string): string {
  // CSI / OSC / 単発エスケープをまとめて除去する
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/**
 * claude が「不正な --effort だったので無視した」と言っているか。
 * 実測（2026-09-04）:
 *   Warning: Unknown --effort value 'x' — ignoring it and using the default effort.
 */
export function detectEffortRejected(text: string): boolean {
  return /Unknown\s+--effort\s+value/i.test(stripAnsi(text));
}

/** CLI ごとのモデル名の見え方（保守的に・確実なものだけ）。 */
const MODEL_PATTERNS: Record<string, RegExp[]> = {
  claude: [/\b(Opus|Sonnet|Haiku)\s+([0-9][0-9.]*)\b/gi],
  codex: [/\bgpt-[0-9][\w.-]*\b/gi],
  gemini: [/\bgemini-[0-9][\w.-]*\b/gi],
  grok: [/\bgrok-[0-9][\w.-]*\b/gi],
  qwen: [/\bqwen[0-9][\w.-]*\b/gi],
  kimi: [/\bkimi-[\w.-]+\b/gi, /\bk[0-9](?:\.[0-9]+)?\b/g],
};

/** どの CLI か分からないときに使う、全部盛りのパターン。 */
const ANY_PATTERNS: RegExp[] = [
  /\b(Opus|Sonnet|Haiku)\s+([0-9][0-9.]*)\b/gi,
  /\bgpt-[0-9][\w.-]*\b/gi,
  /\bgemini-[0-9][\w.-]*\b/gi,
  /\bgrok-[0-9][\w.-]*\b/gi,
  /\bclaude-[0-9][\w.-]*\b/gi,
];

/**
 * 出力からモデル名を読み取る。**最後に出てきたもの**を返す
 * （`/model` で切り替えた直後の表示を拾いたいので、古い方は上書きする）。
 * 見つからなければ null。
 */
export function detectModel(
  text: string,
  cliId?: string | null,
): string | null {
  const clean = stripAnsi(text);
  // cliId が空文字のときに && が "" を返して型が崩れるので、明示的に分ける。
  let patterns: RegExp[];
  if (cliId) {
    patterns = MODEL_PATTERNS[cliId] ?? [];
  } else {
    patterns = ANY_PATTERNS;
  }
  let found: string | null = null;
  for (const re of patterns) {
    // 直前の実行位置が残らないよう毎回リセットする（g フラグの罠）
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      found = m[0].trim();
      if (m.index === re.lastIndex) re.lastIndex++; // 空マッチの無限ループ防止
    }
  }
  return found;
}

/**
 * 出力の末尾だけを保持するためのバッファ更新。
 * 全部ためると長時間セッションで際限なく増えるので、末尾 limit 文字だけ持つ。
 * チャンクの切れ目で語が割れても拾えるよう、少し重ねて保持する。
 */
export function appendTail(tail: string, chunk: string, limit = 4000): string {
  const merged = tail + chunk;
  return merged.length <= limit ? merged : merged.slice(merged.length - limit);
}
