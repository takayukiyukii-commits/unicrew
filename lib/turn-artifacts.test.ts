import { describe, expect, it } from "vitest";
import { collectArtifacts, pickPrimary } from "./turn-artifacts";
import type { ToolUseBlock } from "./types";

const tool = (
  toolName: string,
  input: Record<string, unknown>,
  extra: Partial<ToolUseBlock> = {},
): ToolUseBlock => ({
  kind: "tool_use",
  toolUseId: Math.random().toString(36),
  toolName,
  input,
  status: "completed",
  ...extra,
});

describe("ターンの成果物を集める", () => {
  it("書いたファイルを、フォルダとファイル名に分けて拾う", () => {
    const arts = collectArtifacts(
      [
        { kind: "text" },
        tool("Write", { file_path: "D:\\work\\site\\index.html" }),
        tool("Edit", { file_path: "D:\\work\\site\\README.md" }),
        tool("Read", { file_path: "D:\\work\\site\\secret.txt" }),
      ],
      "D:\\work\\site",
    );
    expect(arts.map((a) => [a.kind, a.name, a.dir])).toEqual([
      ["html", "index.html", "D:\\work\\site"],
      ["doc", "README.md", "D:\\work\\site"],
    ]);
  });

  it("失敗・拒否された書き込みは拾わない（作れていないものを開かない）", () => {
    const arts = collectArtifacts([
      tool("Write", { file_path: "/a/x.html" }, { status: "errored" }),
      tool("Write", { file_path: "/a/y.html" }, { status: "denied" }),
      tool("Write", { file_path: "/a/z.html" }, { isError: true }),
    ]);
    expect(arts).toEqual([]);
  });

  it("相対パスは作業フォルダから解決する", () => {
    const [a] = collectArtifacts([tool("Write", { file_path: "docs/plan.md" })], "D:/proj");
    expect(a.target).toBe("D:/proj/docs/plan.md");
    expect(a.dir).toBe("D:/proj/docs");
  });

  it("開発サーバーの URL を拾い、0.0.0.0 は localhost に寄せる", () => {
    const arts = collectArtifacts([
      tool("Bash", { command: "npm run dev" }, { result: "ready on http://0.0.0.0:3000/." }),
    ]);
    expect(arts).toEqual([
      { target: "http://localhost:3000/", kind: "web", name: "http://localhost:3000/", dir: "" },
    ]);
  });

  it("同じファイルを何度も直しても1つにまとめる", () => {
    const arts = collectArtifacts([
      tool("Write", { file_path: "/p/a.md" }),
      tool("Edit", { file_path: "/p/a.md" }),
    ]);
    expect(arts).toHaveLength(1);
  });

  it("他社 AI の書き込み道具（path 引数）も拾う", () => {
    const arts = collectArtifacts([tool("apply_patch_edit", { path: "/p/b.txt" })]);
    expect(arts.map((a) => a.name)).toEqual(["b.txt"]);
  });
});

describe("自動で開くもの", () => {
  it("Webページ > HTML > 文章 > 画像 の順で選ぶ", () => {
    const arts = collectArtifacts([
      tool("Write", { file_path: "/p/a.png" }),
      tool("Write", { file_path: "/p/b.md" }),
      tool("Write", { file_path: "/p/c.html" }),
    ]);
    expect(pickPrimary(arts)?.name).toBe("c.html");
    expect(pickPrimary(arts.filter((a) => a.kind !== "html"))?.name).toBe("b.md");
  });

  it("プログラムのファイルだけなら自動では開かない", () => {
    const arts = collectArtifacts([tool("Edit", { file_path: "/p/main.rs" })]);
    expect(arts).toHaveLength(1);
    expect(pickPrimary(arts)).toBeNull();
  });
});
