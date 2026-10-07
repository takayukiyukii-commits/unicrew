import { describe, expect, it } from "vitest";
import { describeTool, summarizeProgress } from "./progress-text";
import type { Block, ToolUseBlock } from "./types";

const tool = (
  toolName: string,
  input: Record<string, unknown>,
  status: ToolUseBlock["status"] = "completed",
): ToolUseBlock => ({ kind: "tool_use", toolUseId: toolName + Math.random(), toolName, input, status });

describe("いま何をしているかを日本語にする", () => {
  it("生の道具名を出さず、何を・どこにで言う", () => {
    expect(describeTool(tool("Read", { file_path: "D:\\a\\page.tsx" }), false)).toBe("page.tsx を読んでいます");
    expect(describeTool(tool("Write", { file_path: "/p/index.html" }), true)).toBe("index.html を作りました");
    expect(describeTool(tool("WebSearch", { query: "東京 天気" }), false)).toBe("「東京 天気」を Web で調べています");
    expect(describeTool(tool("WebFetch", { url: "https://example.com/a" }), false)).toBe("example.com のページを読んでいます");
    for (const s of [
      describeTool(tool("Read", { file_path: "/x" }), false),
      describeTool(tool("Grep", { pattern: "foo" }), false),
      describeTool(tool("Bash", { command: "npm install" }), false),
    ]) {
      expect(s).not.toMatch(/\b(Read|Grep|Bash)\b/);
    }
  });

  it("よく打つコマンドは目的で言う（終わったら過去形）", () => {
    expect(describeTool(tool("Bash", { command: "npm install react" }), false)).toBe("必要な部品をインストールしています");
    expect(describeTool(tool("Bash", { command: "npm test" }), true)).toBe("テストを動かして確かめました");
    expect(describeTool(tool("Bash", { command: "python tool.py --x" }), false)).toBe("コマンドを実行しています（python tool.py --x）");
  });

  it("AI が付けたコマンドの説明があれば、それを使う", () => {
    expect(describeTool(tool("Bash", { command: "x", description: "画像を縮小する" }), false)).toBe("画像を縮小する");
  });
});

describe("進み具合のまとめ", () => {
  it("いまの作業・終わった手順・段取り表の進捗を出す", () => {
    const blocks: Block[] = [
      { kind: "text", text: "やります" },
      tool("TodoWrite", {
        todos: [
          { content: "調べる", status: "completed" },
          { content: "書く", activeForm: "ページを書いています", status: "in_progress" },
          { content: "確かめる", status: "pending" },
        ],
      }),
      tool("Read", { file_path: "/p/a.md" }),
      tool("Edit", { file_path: "/p/b.ts" }, "errored"),
      tool("Write", { file_path: "/p/index.html" }, "pending"),
    ];
    const s = summarizeProgress(blocks);
    expect(s.current).toBe("index.html を書いています");
    expect(s.steps).toEqual([
      { text: "a.md を読みました", state: "done" },
      { text: "b.ts を直しました", state: "failed" },
    ]);
    expect(s.plan).toEqual({ done: 1, total: 3, now: "ページを書いています" });
  });

  it("手順が多いときは新しいものだけ残す", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => tool("Read", { file_path: `/f${i}.txt` }));
    const s = summarizeProgress(blocks, 3);
    expect(s.steps.map((x) => x.text)).toEqual(["f7.txt を読みました", "f8.txt を読みました", "f9.txt を読みました"]);
  });
});
