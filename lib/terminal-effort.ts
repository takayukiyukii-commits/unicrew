/**
 * ターミナルで起動する AI CLI の「エフォート（思考の深さ）」の効かせ方カタログ。
 *
 * 値の正本は各 CLI 自身（実測して照合する検査が scripts/verify_effort_route.py）。
 *
 * 【最重要】エフォートは共通概念ではない。
 * 実測（2026-09-04・このPCの実物）で、①フラグ名 ②取れる値 ③不正値のときの壊れ方 が
 * CLI ごとに全部違った。だから「UI では 1 つに見せる／実体は CLI ごと」に分ける。
 *
 * 【壊さないための約束】
 * - 既定は **指定しない**（level=null）。そのとき args は空＝今までと 1 バイトも同じ起動になる
 * - 対応していない CLI（gemini / qwen / 未確認のもの）は**メニューに出さない**。
 *   無い機能を「medium」と表示しない
 * - 値の一覧は「全モデルで共通して存在するものだけ」を載せる（下の注記）
 */

/** エフォートの効かせ方。 */
export type EffortMode =
  /** 引数フラグ（claude: --effort / grok: --reasoning-effort） */
  | { kind: "flag"; flag: string }
  /** 設定キー（codex: -c model_reasoning_effort=<v>） */
  | { kind: "config"; key: string }
  /** on/off の 2 値だけ（kimi: --thinking / --no-thinking） */
  | { kind: "toggle"; on: string; off: string };

export interface EffortSupport {
  mode: EffortMode;
  /** UI に出す値（並び順そのまま）。 */
  levels: readonly string[];
  /**
   * 🚨 不正値のとき CLI が黙るか。
   * true = 落ちずに既定のまま走る（＝画面のバッジが嘘になりうる）。
   * claude だけが true（実測: "Warning: Unknown --effort value ... ignoring it"）。
   */
  silentOnInvalid: boolean;
  /** セッション途中で変えられるか（現状は使っていない。将来の途中変更用）。 */
  midSession: "slash" | "restart";
  /** 途中変更に流す文字列（claude のみ）。 */
  slash?: (level: string) => string;
  /**
   * levels に載せていない値がある場合の注記（UI には出さない・レビュー用）。
   */
  note?: string;
}

/**
 * CLI id → エフォートの効かせ方。
 * ここに無い CLI は「エフォート非対応」＝ UI にメニューを出さない。
 */
export const EFFORT_SUPPORT: Readonly<Record<string, EffortSupport>> = {
  claude: {
    mode: { kind: "flag", flag: "--effort" },
    levels: ["low", "medium", "high", "xhigh", "max"],
    silentOnInvalid: true,
    midSession: "slash",
    slash: (level) => `/effort ${level}`,
    note: "ultracode / auto もあるが、意味が段階ではないので UI には出さない",
  },
  codex: {
    mode: { kind: "config", key: "model_reasoning_effort" },
    // 🚨 codex の取れる値は**モデルごとに違う**（gpt-5.5 に max は無い／
    // gpt-5.6-sol には ultra がある）。ここに載せるのは
    // 「実測した全モデルに共通して存在する値」だけにしてある。
    // 値の正本は `codex debug models`。ズレたら scripts/verify_effort_route.py が落ちる。
    levels: ["low", "medium", "high", "xhigh"],
    silentOnInvalid: false,
    midSession: "restart",
    note: "max / ultra はモデル依存のため意図的に出さない（不正値は最初のターンで API 400）",
  },
  grok: {
    mode: { kind: "flag", flag: "--reasoning-effort" },
    levels: ["low", "medium", "high", "xhigh"],
    silentOnInvalid: false,
    midSession: "restart",
  },
  kimi: {
    // 段階が無い。深く考える／すぐ答える の 2 値だけ。
    mode: { kind: "toggle", on: "--thinking", off: "--no-thinking" },
    levels: ["think", "fast"],
    silentOnInvalid: false,
    midSession: "restart",
  },
};

/** その CLI がエフォート指定に対応しているか。 */
export function supportsEffort(cliId: string | undefined): boolean {
  return !!cliId && cliId in EFFORT_SUPPORT;
}

/** UI に出す値の一覧（非対応なら空配列）。 */
export function effortLevelsFor(cliId: string | undefined): readonly string[] {
  if (!cliId) return [];
  return EFFORT_SUPPORT[cliId]?.levels ?? [];
}

/** その CLI にとって妥当な値か。 */
export function isValidEffort(
  cliId: string | undefined,
  level: string | undefined | null,
): boolean {
  if (!cliId || !level) return false;
  return effortLevelsFor(cliId).includes(level);
}

/**
 * 起動引数にエフォートを反映する。
 *
 * 🚨 level が null / 未対応 / 不正値なら **何も足さない**。
 * 「たぶん medium だろう」と推測して送らない（送ると CLI 側の既定を壊す）。
 */
export function applyEffort(
  cliId: string | undefined,
  level: string | undefined | null,
  baseArgs: readonly string[] = [],
): string[] {
  const args = [...baseArgs];
  if (!cliId || !level) return args;
  const sup = EFFORT_SUPPORT[cliId];
  if (!sup) return args;
  if (!sup.levels.includes(level)) return args;
  switch (sup.mode.kind) {
    case "flag":
      args.push(sup.mode.flag, level);
      return args;
    case "config":
      args.push("-c", `${sup.mode.key}=${level}`);
      return args;
    case "toggle":
      // levels[0] が「深く考える」側という約束（think / fast）
      args.push(level === sup.levels[0] ? sup.mode.on : sup.mode.off);
      return args;
  }
}

/**
 * バッジ等に出す短い表示名。
 * kimi のように段階でないものは、値そのままではなく意味で出す。
 */
export function effortLabel(
  cliId: string | undefined,
  level: string | undefined | null,
): string | null {
  if (!isValidEffort(cliId, level)) return null;
  return level as string;
}

/**
 * ペインの起動コマンドを決める（ターミナル本体へ渡す command prop）。
 *
 * 🚨 claude でエフォート未指定のときは **undefined を返す**。
 * これは「command を渡さない＝従来の起動経路そのまま」を意味する。
 * ここを常に返す実装にすると、既存ユーザーの claude ペインの起動が静かに変わる。
 */
export function paneLaunchCommand(
  kind: "claude" | "shell",
  cliId: string | undefined,
  effort: string | undefined,
  lookup: (id: string) => { program: string; args?: string[] } | undefined,
): { program: string; args: string[] } | undefined {
  const id = cliId ?? (kind === "claude" ? "claude" : undefined);
  if (!id) return undefined; // 素のシェル
  const def = lookup(id);
  if (!def) return undefined;
  const args = applyEffort(id, effort, def.args ?? []);
  if (id === "claude" && args.length === 0) return undefined;
  return { program: def.program, args };
}
