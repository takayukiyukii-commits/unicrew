// 添付つきメッセージの本文組み立ての回帰テスト。
//
// 背景（実害・2026-09-01）:
// 旧実装は AI へ「Read ツールで開いてください」と指示していた。`Read` は
// Claude Code の道具で、UNICREW が載せている他のプロバイダには存在しない。
//
// 🚨 ただし「だから他経路では必ず失敗する」は誤りだった（2026-09-01 実測で否定）。
//    codex 0.150.1 は旧文面でも道具名を無視して画像を開き、正答した。
//    直す理由は「壊れるから」ではなく「モデルの気の利きに寄りかからないため」。
//
// もう1つの実害は、指示していた読み取り自体が Claude 経路でも通らなかったこと。
// 画像はワークスペース外（AppData）にあり、Claude Code はそこの読み取りに
// 許可を要求する。実測では毎回こう返っていた:
//   "Claude requested permissions to read from ...png, but you haven't granted it yet."
//
// いまは画像そのものを image ブロックで渡すようになったので、本文の役割は
// 「ラベル」と「フォールバック」だけ。
import { describe, expect, it } from "vitest";
import {
  buildAttachmentPrompt,
  IMAGE_NOTE,
  DOC_NOTE,
  type PromptAttachment,
} from "@/lib/attachment-prompt";

const img = (name: string, path: string): PromptAttachment => ({
  kind: "image",
  name,
  path,
});
const doc = (name: string, path: string): PromptAttachment => ({
  kind: "file",
  name,
  path,
});

describe("buildAttachmentPrompt", () => {
  it("🚨 CLI 固有の道具名を本文に入れない（12プロバイダ中11には無い道具）", () => {
    const out = buildAttachmentPrompt("これ何？", [
      img("s.png", "C:/a/s.png"),
      doc("spec.pdf", "C:/a/spec.pdf"),
    ]);
    for (const toolName of ["Read ツール", "Read tool", "read_file", "view_image"]) {
      expect(out).not.toContain(toolName);
    }
  });

  it("添付が無いときは本文をそのまま返す（余計な指示文を足さない）", () => {
    expect(buildAttachmentPrompt("こんにちは", [])).toBe("こんにちは");
  });

  it("画像1枚は番号を振らない", () => {
    const out = buildAttachmentPrompt("これ何？", [img("s.png", "C:/a/s.png")]);
    expect(out).toContain("添付画像（s.png）: C:/a/s.png");
    expect(out).not.toContain("添付画像 1");
    expect(out).toContain(IMAGE_NOTE);
  });

  it("画像が複数なら番号を振る（AI が どれ の話か指せるように）", () => {
    const out = buildAttachmentPrompt("違いは？", [
      img("a.png", "C:/a/a.png"),
      img("b.png", "C:/a/b.png"),
    ]);
    expect(out).toContain("添付画像 1（a.png）: C:/a/a.png");
    expect(out).toContain("添付画像 2（b.png）: C:/a/b.png");
  });

  it("画像と書類は別々に数え、指示文も別々に足す", () => {
    const out = buildAttachmentPrompt("確認して", [
      img("s.png", "C:/a/s.png"),
      doc("spec.pdf", "C:/a/spec.pdf"),
    ]);
    expect(out).toContain("添付画像（s.png）");
    expect(out).toContain("添付ファイル（spec.pdf）");
    expect(out).toContain(IMAGE_NOTE);
    expect(out).toContain(DOC_NOTE);
  });

  it("書類だけのときに画像用の指示文を足さない", () => {
    const out = buildAttachmentPrompt("読んで", [doc("a.md", "C:/a/a.md")]);
    expect(out).toContain(DOC_NOTE);
    expect(out).not.toContain(IMAGE_NOTE);
  });

  it("本文が空でも添付だけで送れる（画像を貼っただけの送信）", () => {
    const out = buildAttachmentPrompt("", [img("s.png", "C:/a/s.png")]);
    expect(out.startsWith("添付画像（s.png）")).toBe(true);
  });

  it("画像の指示文は「見えていない場合のみ開く」と伝える（inline 済みを二重に開かせない）", () => {
    expect(IMAGE_NOTE).toContain("画像として内容を確認");
    expect(IMAGE_NOTE).toContain("見えていない場合のみ");
  });
});
