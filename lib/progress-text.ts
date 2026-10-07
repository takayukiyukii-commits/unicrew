/**
 * AI がいま何をしているかを、初心者にも分かる日本語の1行にする（2026-10-07 追加）。
 *
 * 初心者モードでは道具の吹き出し（Read / Bash などの生の名前）を隠しているため、
 * 考え中は「…」しか出ず、何をしているのか分からなかった（結城さん指摘）。
 * 道具の呼び出しを「何を・どこに」で言い換え、終わったものには ✓ を付けて並べる。
 *
 * - 道具名は Claude Code のもの＋他社 AI の似た名前（小文字の部分一致）で拾う
 * - 段取り表（TodoWrite）があれば「3/7 完了・いま◯◯」を出す（いちばん進捗らしい情報）
 */
import type { Block, ToolUseBlock } from "./types";

export interface ProgressStep {
  text: string;
  state: "doing" | "done" | "failed";
}

export interface ProgressSummary {
  /** いまやっていること（無ければ null＝考え中／返事を書いている） */
  current: string | null;
  /** 終わった・失敗した手順（新しいものが後ろ） */
  steps: ProgressStep[];
  /** 段取り表の進み具合（無ければ null） */
  plan: { done: number; total: number; now: string | null } | null;
}

function baseName(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function clip(s: string, n = 40): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function host(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    return new URL(url).hostname;
  } catch {
    return clip(url, 30);
  }
}

/** よく打つコマンドは、何のためのものかを言葉にする。 */
function describeCommand(cmd: string): string {
  const c = cmd.trim();
  if (/^(npm|pnpm|yarn|bun)\s+(i|install|add)\b/.test(c) || /^pip3?\s+install\b/.test(c))
    return "必要な部品をインストールしています";
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b/.test(c) || /\b(pytest|cargo test)\b/.test(c))
    return "テストを動かして確かめています";
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/.test(c) || /\bcargo build\b/.test(c))
    return "組み立て（ビルド）しています";
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/.test(c))
    return "プレビュー用のサーバーを起動しています";
  if (/^git\s+(commit|add)\b/.test(c)) return "変更を記録しています";
  if (/^git\s+(status|diff|log|show)\b/.test(c)) return "変更内容を確認しています";
  if (/^git\s+push\b/.test(c)) return "変更を送っています";
  if (/^(ls|dir|tree|find)\b/.test(c)) return "フォルダの中身を見ています";
  if (/^(mkdir)\b/.test(c)) return "フォルダを作っています";
  if (/^(cat|type|head|tail|less)\b/.test(c)) return "ファイルの中身を見ています";
  return `コマンドを実行しています（${clip(c, 36)}）`;
}

/** 1つの道具の呼び出しを日本語にする。doing=今やっている／done=やった。 */
export function describeTool(b: ToolUseBlock, done: boolean): string {
  const name = b.toolName ?? "";
  const n = name.toLowerCase();
  const input = (b.input ?? {}) as Record<string, unknown>;
  const file = baseName(input.file_path ?? input.notebook_path ?? input.path ?? input.filePath);
  const say = (doing: string, did: string) => (done ? did : doing);

  if (name === "Read" || n === "read_file" || n.endsWith("__read"))
    return say(`${file || "ファイル"} を読んでいます`, `${file || "ファイル"} を読みました`);
  if (name === "Write" || n === "write_file" || n.includes("create_file"))
    return say(`${file || "ファイル"} を書いています`, `${file || "ファイル"} を作りました`);
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit" || n.includes("edit") || n.includes("patch"))
    return say(`${file || "ファイル"} を直しています`, `${file || "ファイル"} を直しました`);
  if (name === "Bash" || n === "shell" || n.includes("exec") || n.includes("command")) {
    const cmd = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : "";
    const d = typeof input.description === "string" && input.description.trim() ? clip(input.description, 40) : "";
    if (d) return done ? `${d}（済）` : d;
    const text = cmd ? describeCommand(cmd) : "コマンドを実行しています";
    return done ? text.replace(/しています/, "しました").replace(/ています/, "ました") : text;
  }
  if (name === "Glob" || name === "Grep" || n.includes("search_files") || n.includes("grep") || n.includes("glob")) {
    const q = typeof input.pattern === "string" ? `「${clip(input.pattern, 20)}」` : "";
    return say(`${q}を含むファイルを探しています`, `${q}を含むファイルを探しました`);
  }
  if (name === "WebSearch" || n.includes("web_search")) {
    const q = typeof input.query === "string" ? `「${clip(input.query, 24)}」` : "";
    return say(`${q}を Web で調べています`, `${q}を Web で調べました`);
  }
  if (name === "WebFetch" || n.includes("fetch")) {
    const h = host(input.url);
    return say(`${h ? `${h} の` : ""}ページを読んでいます`, `${h ? `${h} の` : ""}ページを読みました`);
  }
  if (name === "TodoWrite" || n.includes("todo")) return say("作業の段取りを立てています", "作業の段取りを立てました");
  if (name === "Task" || name === "Agent" || n.includes("subagent"))
    return say("手分けして調べています", "手分けして調べました");
  if (n.startsWith("mcp__")) {
    const tool = name.split("__").slice(-1)[0];
    return say(`外部の道具（${tool}）を使っています`, `外部の道具（${tool}）を使いました`);
  }
  return say(`道具（${name}）を使っています`, `道具（${name}）を使いました`);
}

interface Todo {
  content?: string;
  activeForm?: string;
  status?: string;
}

/** ターンのブロックから進み具合をまとめる。 */
export function summarizeProgress(blocks: readonly Block[], maxSteps = 6): ProgressSummary {
  const tools = blocks.filter((b): b is ToolUseBlock => b.kind === "tool_use");
  let current: string | null = null;
  const steps: ProgressStep[] = [];
  let plan: ProgressSummary["plan"] = null;
  for (const b of tools) {
    if (b.toolName === "TodoWrite") {
      const todos = ((b.input ?? {}) as { todos?: Todo[] }).todos;
      if (Array.isArray(todos) && todos.length > 0) {
        const doing = todos.find((x) => x.status === "in_progress");
        plan = {
          done: todos.filter((x) => x.status === "completed").length,
          total: todos.length,
          now: doing ? clip(doing.activeForm || doing.content || "", 50) : null,
        };
      }
      continue; // 段取り表そのものは手順の列に出さない（plan で出す）
    }
    const running = b.status === "pending" || b.status === "approved";
    if (running) {
      current = describeTool(b, false);
    } else {
      steps.push({
        text: describeTool(b, true),
        state: b.status === "errored" || b.status === "denied" || b.isError ? "failed" : "done",
      });
    }
  }
  return { current, steps: steps.slice(-maxSteps), plan };
}
