/**
 * ワークスペースから「実行できるタスク」を見つける。
 *
 * ねらい: `npm run dev` を打つために黒い画面の作法を覚えなくていいようにする
 * （UNICREW の存在理由）。見つけたタスクはクリックで**新しいシェルのペイン**に流す。
 *
 * 【安全のための約束】
 * - ここは**読むだけ**。実行はユーザーがクリックしたときだけ
 * - 出すのは「そのファイルに書いてあるコマンド」そのもの。こちらで足さない
 * - パッケージマネージャはロックファイルから判定する（npm と書いてあるのに
 *   pnpm のプロジェクト、という食い違いを起こさない）
 */

export type TaskSource = "package.json" | "Makefile" | "Cargo.toml";

export interface DetectedTask {
  /** 表示名（scripts のキー / make のターゲット名 など） */
  name: string;
  /** 実際に流すコマンド */
  command: string;
  source: TaskSource;
  /** 補足（package.json の scripts 本文など。無ければ undefined） */
  detail?: string;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * ロックファイルの一覧からパッケージマネージャを決める。
 * 複数あるときは pnpm > yarn > bun > npm の順（より特徴的なものを優先）。
 */
export function packageManagerFrom(fileNames: readonly string[]): PackageManager {
  const set = new Set(fileNames.map((f) => f.toLowerCase()));
  if (set.has("pnpm-lock.yaml")) return "pnpm";
  if (set.has("yarn.lock")) return "yarn";
  if (set.has("bun.lockb") || set.has("bun.lock")) return "bun";
  return "npm";
}

/** そのマネージャでの「スクリプト実行」コマンド。 */
export function runScriptCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case "pnpm":
      return `pnpm run ${script}`;
    case "yarn":
      // yarn は run を省略できるが、スクリプト名が組み込みコマンドと衝突しうるので付ける
      return `yarn run ${script}`;
    case "bun":
      return `bun run ${script}`;
    case "npm":
    default:
      return `npm run ${script}`;
  }
}

/**
 * package.json の scripts を取り出す。壊れた JSON は空配列（例外にしない）。
 */
export function parsePackageScripts(
  text: string,
  pm: PackageManager = "npm",
): DetectedTask[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const scripts = (data as Record<string, unknown>).scripts;
  if (!scripts || typeof scripts !== "object") return [];
  const out: DetectedTask[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (!name || typeof body !== "string") continue;
    out.push({
      name,
      command: runScriptCommand(pm, name),
      source: "package.json",
      detail: body,
    });
  }
  return out;
}

/**
 * Makefile のターゲットを取り出す。
 * - `target: deps` の形だけを拾う（変数代入・コメント・特殊ターゲットは除く）
 * - `.PHONY` などドットで始まるものは出さない
 * - パターンルール（%）は実行できないので出さない
 */
export function parseMakefileTargets(text: string): DetectedTask[] {
  const out: DetectedTask[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    // タブ始まりはレシピ本文（コマンド行）なので対象外
    if (rawLine.startsWith("\t")) continue;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:(?!=)/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, command: `make ${name}`, source: "Makefile" });
  }
  return out;
}

/**
 * Cargo プロジェクトの定番コマンド。
 * Cargo.toml の中身は読まない（[package] があるかだけ見る）。
 */
export function cargoTasks(text: string): DetectedTask[] {
  if (!/^\s*\[package\]/m.test(text) && !/^\s*\[workspace\]/m.test(text)) {
    return [];
  }
  return [
    { name: "check", command: "cargo check", source: "Cargo.toml" },
    { name: "test", command: "cargo test", source: "Cargo.toml" },
    { name: "build", command: "cargo build", source: "Cargo.toml" },
    { name: "run", command: "cargo run", source: "Cargo.toml" },
  ];
}

/** よく使う順に並べる（dev / start / build / test を上に）。 */
const PRIORITY = ["dev", "start", "build", "test", "lint", "check"];

export function sortTasks(tasks: readonly DetectedTask[]): DetectedTask[] {
  return [...tasks].sort((a, b) => {
    const ia = PRIORITY.indexOf(a.name);
    const ib = PRIORITY.indexOf(b.name);
    const ra = ia < 0 ? PRIORITY.length : ia;
    const rb = ib < 0 ? PRIORITY.length : ib;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}
