/**
 * 1ターン（AI の1回の作業）で作った・直したもの（成果物）を集める。
 *
 * 作業が終わったときに、プレビュー窓へ「何を・どのフォルダに」作ったかを並べて、
 * いちばん見たいもの（Webページ → 文章 → 画像）を自動で開くために使う。
 *
 * 拾うもの:
 * - Write / Edit / MultiEdit / NotebookEdit の file_path（Claude Code の道具名）
 * - Codex など他の AI は道具名が違うので、入力に file_path / path を持つ書き込み系も拾う
 * - Bash の出力に出た localhost の URL（開発サーバー）
 *
 * 🚨 失敗した道具（status=errored / isError）は拾わない。作れていないものを開かない。
 */
import type { ToolUseBlock } from "./types";

export type ArtifactKind = "web" | "html" | "doc" | "image" | "other";

export interface Artifact {
  /** 絶対パス（file）か URL（web） */
  target: string;
  kind: ArtifactKind;
  /** 表示用のファイル名（web は URL） */
  name: string;
  /** 置き場所のフォルダ（web は空） */
  dir: string;
}

const HTML = /\.(html?|xhtml)$/i;
const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const DOC = /\.(md|markdown|mdx|txt|text|csv|json|ya?ml|log)$/i;
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"'`)\]<>]*)?/gi;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** 他社 AI の書き込み系の道具名に含まれがちな語（小文字で比較） */
const WRITE_HINTS = ["write", "edit", "patch", "create", "replace"];

export function kindOf(path: string): ArtifactKind {
  if (HTML.test(path)) return "html";
  if (IMG.test(path)) return "image";
  if (DOC.test(path)) return "doc";
  return "other";
}

function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
}

function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

/** 相対パスは作業フォルダから解決する（作業フォルダが無ければそのまま）。 */
function resolve(p: string, workspace: string | null | undefined): string {
  if (isAbsolute(p) || !workspace) return p;
  const sep = workspace.includes("\\") && !workspace.includes("/") ? "\\" : "/";
  return `${workspace.replace(/[\\/]+$/, "")}${sep}${p.replace(/^\.[\\/]/, "")}`;
}

function filePathOf(b: ToolUseBlock): string | null {
  const input = (b.input ?? {}) as Record<string, unknown>;
  const name = b.toolName ?? "";
  const lower = name.toLowerCase();
  const looksWrite =
    WRITE_TOOLS.has(name) || WRITE_HINTS.some((h) => lower.includes(h));
  if (!looksWrite) return null;
  for (const k of ["file_path", "notebook_path", "path", "filePath"]) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** ターンのブロックから成果物を集める（重複は最後の1つに寄せ、出てきた順を保つ）。 */
export function collectArtifacts(
  blocks: readonly { kind: string }[],
  workspace?: string | null,
): Artifact[] {
  const seen = new Map<string, Artifact>();
  for (const raw of blocks) {
    if (raw.kind !== "tool_use") continue;
    const b = raw as ToolUseBlock;
    if (b.status === "errored" || b.status === "denied" || b.isError) continue;
    if (b.toolName === "Bash" || b.toolName?.toLowerCase().includes("shell")) {
      for (const m of (b.result ?? "").matchAll(LOCAL_URL)) {
        const url = m[0].replace("0.0.0.0", "localhost").replace(/[.,;:]+$/, "");
        seen.delete(url);
        seen.set(url, { target: url, kind: "web", name: url, dir: "" });
      }
      continue;
    }
    const fp = filePathOf(b);
    if (!fp) continue;
    const abs = resolve(fp, workspace);
    const key = abs.replace(/\\/g, "/").toLowerCase();
    const { dir, name } = splitPath(abs);
    seen.delete(key);
    seen.set(key, { target: abs, kind: kindOf(abs), name, dir });
  }
  return [...seen.values()];
}

/** 自動で開く1つ（Webページ＞HTML＞文章＞画像。同じ種類なら後に作ったもの）。無ければ null。 */
export function pickPrimary(arts: readonly Artifact[]): Artifact | null {
  for (const k of ["web", "html", "doc", "image"] as ArtifactKind[]) {
    const hit = [...arts].reverse().find((a) => a.kind === k);
    if (hit) return hit;
  }
  return null;
}
