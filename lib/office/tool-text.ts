/** オフィスの道具の実況。AI が書いた文や入力の中身は翻訳しない。 */
import type { Locale } from "../i18n";
import { describeTool } from "../progress-text";
import { officeT, type OfficeKey } from "./i18n";

export function describeOfficeTool(name: string, input: Record<string, unknown>, locale: Locale): string {
  // 日本語の既存の詳しいコマンド説明を保つ。
  if (locale === "ja") return describeTool({ kind: "tool_use", toolUseId: "", toolName: name, input, status: "pending" }, false);
  const n = name.toLowerCase();
  const clip = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  const path = input.file_path ?? input.notebook_path ?? input.path ?? input.filePath;
  const file = typeof path === "string" && path ? path.split(/[\\/]/).pop()! : officeT("tool.file", locale);
  const say = (key: OfficeKey, detail = "") => officeT(key, locale, { file, detail });
  if (name === "Read" || n === "read_file" || n.endsWith("__read")) return say("tool.read");
  if (name === "Write" || n === "write_file" || n.includes("create_file")) return say("tool.write");
  if (["Edit", "MultiEdit", "NotebookEdit"].includes(name) || n.includes("edit") || n.includes("patch")) return say("tool.edit");
  if (name === "Bash" || n === "shell" || n.includes("exec") || n.includes("command")) return say("tool.command", clip(Array.isArray(input.command) ? input.command.join(" ") : input.command));
  if (["Glob", "Grep"].includes(name) || n.includes("search_files") || n.includes("grep") || n.includes("glob")) return say("tool.search", clip(input.pattern));
  if (name === "WebSearch" || n.includes("web_search")) return say("tool.web", clip(input.query));
  if (name === "WebFetch" || n.includes("fetch")) return say("tool.fetch", clip(input.url));
  if (name === "TodoWrite" || n.includes("todo")) return say("tool.plan");
  if (["Task", "Agent"].includes(name) || n.includes("subagent")) return say("tool.delegate");
  if (n.startsWith("mcp__")) return say("tool.external", name.split("__").pop());
  return say("tool.other", name);
}
