/**
 * Codex 公式 Remote Control（`codex remote-control`）連携。
 *
 * 実測（2026-08-27・codex-cli 0.150.0 / Linux）:
 * - `codex remote-control start --json`
 *     → {"mode":"daemon","status":"connected","serverName":"...","environmentId":"env_e_...",...}
 * - `codex remote-control pair --json`
 *     → {"pairingCode":"0221...","manualPairingCode":"4VPU-CU3B","environmentId":"...","expiresAt":1787788661}
 * - Windows では「codex app-server daemon lifecycle is only supported on Unix platforms」
 *   で拒否される（0.150.0 時点）。UI 側で OS 判定して案内を出す。
 * - npm 版 codex では standalone 版の導入
 *   （`curl -fsSL https://chatgpt.com/codex/install.sh | sh`）を促すテキストが出ることがある
 *   → JSON が取れない時は生出力をそのまま見せる。
 *
 * ここでは PTY 実行と JSON 抽出だけを行う。抽出部は純粋関数（テスト対象）。
 */

import { stripTerminalEscapes } from "./remote-control";
import { onPtyData, onPtyExit, ptyKill, ptyOpen } from "./pty";

/** `remote-control start --json` の応答（観測した範囲のみ型に起こす） */
export interface CodexRcStart {
  mode?: string;
  status?: string; // "connected" 等
  serverName?: string;
  environmentId?: string;
  [k: string]: unknown;
}

/** `remote-control pair --json` の応答 */
export interface CodexRcPair {
  pairingCode?: string;
  manualPairingCode?: string;
  environmentId?: string;
  /** UNIX 秒 */
  expiresAt?: number;
  [k: string]: unknown;
}

/**
 * 混在出力（警告行・ログ行 + JSON 行）から最後の JSON オブジェクトを取り出す。
 * bubblewrap 警告などが JSON の前後に出るため、行単位で試しに parse する。
 * 見つからなければ null（呼び出し側は生出力を表示する）。
 */
export function extractLastJsonObject(output: string): Record<string, unknown> | null {
  const plain = stripTerminalEscapes(output);
  let last: Record<string, unknown> | null = null;
  for (const line of plain.split(/\r?\n|\r/)) {
    const s = line.trim();
    if (!s.startsWith("{") || !s.endsWith("}")) continue;
    try {
      const v = JSON.parse(s) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        last = v as Record<string, unknown>;
      }
    } catch {
      /* JSON でない行は無視 */
    }
  }
  return last;
}

/** raw バッファの上限（末尾のみ保持）。JSON/エラーの表示には十分な量。 */
const MAX_RAW_LENGTH = 256 * 1024;

export interface CodexRcResult {
  /** 抽出できた JSON（無ければ null） */
  json: Record<string, unknown> | null;
  /** ANSI 除去済みの生出力（エラー表示用） */
  raw: string;
  /** プロセスが時間内に終了したか */
  exited: boolean;
}

/**
 * `codex remote-control <sub> --json` を PTY で 1 回実行して結果を返す。
 * daemon 自体はデタッチされるので、PTY の終了 = コマンドの完了。
 * timeoutMs を超えたら PTY を kill して打ち切る（その時点の出力で判定）。
 */
export async function runCodexRc(
  sub: "start" | "stop" | "pair" | "status",
  opts?: { cwd?: string | null; timeoutMs?: number },
): Promise<CodexRcResult> {
  const id = `codex-rc-${sub}-${Date.now().toString(36)}`;
  const args =
    sub === "status" ? ["remote-control", "--json"] : ["remote-control", sub, "--json"];
  const timeoutMs = opts?.timeoutMs ?? 90_000;

  let raw = "";
  let exited = false;
  const decoder = new TextDecoder();

  // クロージャ内での代入は TS の制御フロー解析に見えず null に絞り込まれるため、
  // 解除関数は配列に溜めて finally で全部呼ぶ。
  const cleanups: Array<() => void> = [];
  try {
    const done = new Promise<void>((resolve) => {
      void (async () => {
        cleanups.push(
          await onPtyData(id, (bytes) => {
            raw += decoder.decode(bytes, { stream: true });
            // 監査R1: 出力が異常に多い CLI でメモリが膨らまないよう末尾だけ保持
            // （JSON 行は末尾に出る。エラー表示にも末尾で十分）
            if (raw.length > MAX_RAW_LENGTH) {
              raw = raw.slice(-MAX_RAW_LENGTH);
            }
          }),
        );
        cleanups.push(
          await onPtyExit(id, () => {
            exited = true;
            resolve();
          }),
        );
        try {
          await ptyOpen({
            id,
            program: "codex",
            args,
            cwd: opts?.cwd ?? null,
            cols: 120,
            rows: 40,
          });
        } catch (e) {
          raw += `\n[起動失敗] ${String(e)}`;
          resolve();
        }
      })();
    });
    await Promise.race([
      done,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } finally {
    for (const fn of cleanups) fn();
    await ptyKill(id);
  }

  return { json: extractLastJsonObject(raw), raw: stripTerminalEscapes(raw), exited };
}
