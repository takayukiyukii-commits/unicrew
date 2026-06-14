"use client";

/**
 * ツール実行ブロックから「プレビュー可能な成果物」を検出する。
 *
 * - Bash の出力にローカル開発サーバ URL（localhost / 127.0.0.1 / 0.0.0.0）が
 *   あれば、その URL を別ウィンドウでプレビュー
 * - Write / Edit / MultiEdit で .html / 画像を作ったら、その file を別ウィンドウで
 *   プレビュー
 * - PDF / Office / md などは OS 既定アプリ（= 必要な時はブラウザ）で開く
 */

import type { ToolUseBlock } from "./types";

export type PreviewAction =
  | { mode: "window"; target: { url: string } | { file: string }; label: string }
  | { mode: "external"; target: string; label: string };

const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const HTML = /\.(html?|xhtml)$/i;
const EXTERNAL = /\.(pdf|md|markdown|docx?|pptx?|xlsx?|csv|txt|rtf|odt)$/i;
// localhost 系の開発サーバ URL（公開URLの誤検出を避けるため意図的に限定）
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'`)]*)?/i;

function fileExt(p: string): string {
  return p.toLowerCase();
}

export function detectPreview(block: ToolUseBlock): PreviewAction | null {
  const tool = block.toolName;
  const input = (block.input ?? {}) as Record<string, unknown>;

  if (tool === "Bash") {
    const out = block.result ?? "";
    const m = out.match(LOCAL_URL);
    if (m) {
      // 0.0.0.0 はブラウザ/WebView で開けないので localhost に寄せる
      const url = m[0].replace("0.0.0.0", "localhost");
      return { mode: "window", target: { url }, label: "プレビュー" };
    }
    return null;
  }

  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const path = String(input.file_path ?? "");
    if (!path) return null;
    const p = fileExt(path);
    if (HTML.test(p) || IMG.test(p)) {
      return { mode: "window", target: { file: path }, label: "プレビュー" };
    }
    if (EXTERNAL.test(p)) {
      return { mode: "external", target: path, label: "開く" };
    }
    return null;
  }

  return null;
}

import { resolveFilePath } from "./file-link";

const LINK_IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const LINK_HTML = /\.(html?|xhtml)$/i;
const LINK_LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i;

export type LinkAction =
  | { kind: "preview-url"; url: string }
  | { kind: "preview-file"; file: string }
  | { kind: "external"; target: string };

/**
 * マークダウンリンクの href を UNICREW のクリック挙動へ分類する純関数。
 *  - localhost 系URL → 別ウィンドウでプレビュー(url)
 *  - ローカルの画像/HTML(file:// や絶対/相対パス) → 別ウィンドウでプレビュー(file)
 *  - それ以外(外部http / pdf等) → OS 既定アプリ/ブラウザ
 */
export function classifyMarkdownLink(
  href: string,
  workspace: string | null | undefined,
): LinkAction {
  // file:// を実パスへ（Windows の file:///C:/... も考慮）
  let raw = href;
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(raw.replace(/^file:\/\//i, ""));
    } catch {
      raw = raw.replace(/^file:\/\//i, "");
    }
    raw = raw.replace(/^\/(?=[a-zA-Z]:)/, "");
  }

  if (/^https?:\/\//i.test(raw)) {
    if (LINK_LOCAL_HOST.test(raw)) {
      return { kind: "preview-url", url: raw.replace("0.0.0.0", "localhost") };
    }
    return { kind: "external", target: raw };
  }

  const abs = resolveFilePath(raw, workspace);
  if (LINK_IMG.test(abs) || LINK_HTML.test(abs)) {
    return { kind: "preview-file", file: abs };
  }
  return { kind: "external", target: abs };
}
