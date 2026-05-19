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
