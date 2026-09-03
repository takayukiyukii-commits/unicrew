"use client";

/**
 * ターミナルのレイアウト（ページ／ペイン構成）の保存と復元。
 *
 * 【なぜ要るか】
 * ページとペインは React の useState だけで持っていたので、アプリを閉じると
 * 最大 24 セッションぶんの構成が丸ごと消えていた。毎回「シェルを開いて、
 * Codex を開いて、claude を開いて…」を作り直すことになる。
 *
 * 【壊さないための約束】
 * - 復元するのは**構成だけ**（何をどこに開いていたか）。プロセスもスクロールバックも復元しない
 * - 保存データが少しでも変なら**黙って初期状態（1ページ1ペイン）に戻す**。
 *   起動できなくなるくらいなら、今までどおりの空の状態で始める方がよい
 * - 復元しても PTY は「そのページを表示したとき」に開く（今と同じ遅延起動）。
 *   裏ページの 20 個のプロセスが起動時に一斉に立ち上がることはない
 */

const LAYOUT_KEY = "unicrew.terminal.layout.v1";

/** 保存するペイン 1 つぶん。 */
export interface SavedPane {
  key: string;
  kind: "claude" | "shell";
  cliId?: string;
  /** エフォート（思考の深さ）。妥当でなければ復元しない。 */
  effort?: string;
  /** 実際に PTY を開いていた作業ディレクトリ（復元時はここで開く）。 */
  cwd?: string | null;
}

export interface SavedPage {
  id: string;
  panes: SavedPane[];
  /** 列の比率（分割線をドラッグして変えた幅）。無ければ均等。 */
  colFr?: number[];
  /** 行の比率（2 段組みのときの高さ）。無ければ均等。 */
  rowFr?: number[];
}

export interface SavedLayout {
  pages: SavedPage[];
  /** 最後に見ていたページ（実在しなければ先頭に倒す）。 */
  activePageId?: string;
}

export interface SanitizeLimits {
  maxPages: number;
  maxPanes: number;
  /** 実在する CLI id（これ以外は「素のシェル」に落とす）。 */
  knownCliIds: readonly string[];
  /**
   * その CLI にとって妥当なエフォート値かを判定する関数。
   * 🚨 保存された値をそのまま起動引数に流さない（別バージョンで消えた値を
   * 渡すと、CLI によっては黙って無視され、画面のバッジだけが嘘になる）。
   */
  isValidEffort?: (cliId: string | undefined, level: string) => boolean;
}

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/**
 * 比率配列の検証。有限の正の数だけを通し、1 つでも変なら undefined（＝均等割り）。
 * 🚨 0 や NaN を通すと「幅ゼロのペイン」ができて、画面から触れなくなる。
 */
function sanitizeFractions(
  raw: unknown,
  max: number,
): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    return undefined;
  }
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
    out.push(v);
  }
  return out;
}

/**
 * 保存データを安全な形に整える。壊れていたら null を返す（＝初期状態で始める）。
 * 🚨 ここは「信用できない入力（過去の自分・別バージョン・手で編集された localStorage）」
 * の入口なので、必ず通してから state に入れる。
 */
export function sanitizeLayout(
  raw: unknown,
  limits: SanitizeLimits,
): SavedLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.pages)) return null;

  const seenPaneKeys = new Set<string>();
  const seenPageIds = new Set<string>();
  const pages: SavedPage[] = [];

  for (const p of obj.pages) {
    if (pages.length >= limits.maxPages) break;
    if (!p || typeof p !== "object") continue;
    const page = p as Record<string, unknown>;
    if (!isNonEmptyString(page.id) || seenPageIds.has(page.id)) continue;
    if (!Array.isArray(page.panes)) continue;

    const panes: SavedPane[] = [];
    for (const q of page.panes) {
      if (panes.length >= limits.maxPanes) break;
      if (!q || typeof q !== "object") continue;
      const pane = q as Record<string, unknown>;
      if (!isNonEmptyString(pane.key) || seenPaneKeys.has(pane.key)) continue;
      // kind は 2 種類だけ。remote-control 等は復元対象にしない。
      const kind: "claude" | "shell" =
        pane.kind === "shell" ? "shell" : "claude";
      // 知らない CLI id（別バージョンで消えた・手で書き換えられた）は落とす。
      // 落としても kind は変えない＝ kind:"shell" なら素のシェルになるだけで、
      // 勝手に別の AI が起動することはない。
      const cliId =
        isNonEmptyString(pane.cliId) && limits.knownCliIds.includes(pane.cliId)
          ? pane.cliId
          : undefined;
      const cwd =
        pane.cwd === null || pane.cwd === undefined
          ? null
          : isNonEmptyString(pane.cwd)
            ? pane.cwd
            : null;
      // エフォートは「その CLI にとって妥当なときだけ」復元する
      const effortCliId = cliId ?? (kind === "claude" ? "claude" : undefined);
      const effort =
        isNonEmptyString(pane.effort) &&
        (limits.isValidEffort?.(effortCliId, pane.effort) ?? false)
          ? pane.effort
          : undefined;
      seenPaneKeys.add(pane.key);
      panes.push({ key: pane.key, kind, cliId, effort, cwd });
    }
    if (panes.length === 0) continue; // 空ページは復元しない
    seenPageIds.add(page.id);
    pages.push({
      id: page.id,
      panes,
      colFr: sanitizeFractions(page.colFr, limits.maxPanes),
      rowFr: sanitizeFractions(page.rowFr, limits.maxPanes),
    });
  }

  if (pages.length === 0) return null;
  const activePageId =
    isNonEmptyString(obj.activePageId) && seenPageIds.has(obj.activePageId)
      ? obj.activePageId
      : pages[0].id;
  return { pages, activePageId };
}

export function loadTerminalLayout(
  limits: SanitizeLimits,
): SavedLayout | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    return sanitizeLayout(JSON.parse(raw), limits);
  } catch {
    return null;
  }
}

export function saveTerminalLayout(layout: SavedLayout): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* 保存できなくても動作は続ける（次回は初期状態で始まるだけ） */
  }
}

export function clearTerminalLayout(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch {
    /* noop */
  }
}

/**
 * 画面が持っているペイン情報のうち、**保存してよいもの**だけを写す。
 *
 * 🚨 ここを 1 か所に固めている理由:
 * ペインには「開いた直後に流すコマンド（initialInput）」のような
 * **保存してはいけない値**がある。保存してしまうと次の起動で勝手に走る。
 * 保存対象を型と関数で固定し、単体テストで見張る。
 */
export interface LayoutPaneInput {
  key: string;
  kind: "claude" | "shell";
  cliId?: string;
  effort?: string;
  /** 復元時に使う前回の作業ディレクトリ */
  savedCwd?: string | null;
}

export interface LayoutPageInput {
  id: string;
  panes: LayoutPaneInput[];
}

export function toSavedLayout(
  pages: readonly LayoutPageInput[],
  paneCwds: Readonly<Record<string, string | null>>,
  fractions: Readonly<Record<string, { colFr?: number[]; rowFr?: number[] }>>,
  activePageId: string,
): SavedLayout {
  return {
    pages: pages.map((pg) => ({
      id: pg.id,
      panes: pg.panes.map((pn) => ({
        key: pn.key,
        kind: pn.kind,
        cliId: pn.cliId,
        effort: pn.effort,
        // 実際に開いた cwd があればそれを、まだ開いていなければ前回値を残す
        cwd: paneCwds[pn.key] ?? pn.savedCwd ?? null,
      })),
      colFr: fractions[pg.id]?.colFr,
      rowFr: fractions[pg.id]?.rowFr,
    })),
    activePageId,
  };
}
