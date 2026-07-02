"use client";

/**
 * ファイルパスのスマート解決＋エディタ起動（設計書③）。
 *
 * 背景: 従来は resolveFilePath()（workspace 直下への単純結合）だけだったため、
 * Claude が `file-link.ts` のようにサブディレクトリを省いた短い名前を出すと
 * 実体（lib/file-link.ts）を開けず、失敗も無言で握り潰されていた。
 *
 * 本関数は:
 *  1. 絶対パス（D:\... / /... / ~）は従来通りそのまま開く（探索スキップ）
 *  2. 相対/裸ファイル名は Rust `resolve_file_candidate` で workspace（無ければ cwd）
 *     配下を深さ・件数制限付きで探索し、実体の絶対パスを解決する
 *  3. 見つからない場合は「ファイルが見つかりません」トーストで可視化する
 */

import { openFileInEditorWindow } from "./editor-window";
import { isExternalOpenPath, resolveFilePath } from "./file-link";
import { openExternal } from "./preview-window";
import { showToast } from "./toast";
import { t } from "./i18n";

/** 絶対パス（Windows ドライブ / Unix ルート / ホーム `~`）かどうか。 */
function isAbsoluteLike(raw: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]|~(?:[\\/]|$))/.test(raw);
}

export async function openFileSmart(
  raw: string,
  workspace: string | null,
  cwd?: string | null,
): Promise<void> {
  const base = workspace ?? cwd ?? null;
  let target = resolveFilePath(raw, base);
  if (isAbsoluteLike(raw)) {
    // 絶対パスは実在を事前チェック。AI が実在しないパスを出力した場合に
    // 「読み込み失敗」の壊れたエディタ画面を開かず、トーストで明示する。
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const exists = await invoke<boolean>("path_exists", { path: target });
      if (!exists) {
        showToast(t("fileOpen.notFoundAbs", { path: raw }), "error");
        return;
      }
    } catch {
      /* チェック不可の環境では従来どおり開きに行く */
    }
  } else if (base) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const found = await invoke<string | null>("resolve_file_candidate", {
        workspace: base,
        rel: raw,
      });
      if (found) {
        target = found;
      } else {
        // 直下結合も配下探索も外れた＝開けない。無言で消えず明示する。
        showToast(t("fileOpen.notFound", { path: raw }), "error");
        return;
      }
    } catch {
      /* 探索コマンド自体が使えない環境では従来解決で続行 */
    }
  }
  // PDF・画像・Office 等はテキストエディタでなく OS 既定アプリで開く
  if (isExternalOpenPath(target)) {
    await openExternal(target);
    return;
  }
  try {
    await openFileInEditorWindow(target);
  } catch (err) {
    showToast(t("fileOpen.notFound", { path: raw }), "error");
    throw err;
  }
}
