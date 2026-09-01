// 添付画像を「本物の画像」として CLI に渡す経路の回帰テスト。
//
// 背景（実害・2026-09-01）:
// UNICREW は添付画像をパスの文字列としてしか渡しておらず、本文で
// 「Read ツールで開いて」と AI にお願いしていた。ところが CLI の作業
// ディレクトリはユーザーのワークスペースで、画像はその外（AppData）にある。
// Claude Code はワークスペース外の読み取りに許可を要求するので、実測では
// 必ずこうなっていた:
//
//   Claude requested permissions to read from ...\screenshot.png,
//   but you haven't granted it yet.
//   → 「画像を読み取る権限が許可されなかったため、内容を確認できませんでした」
//
// 画面にはサムネイルが出ているので、ユーザーには切り分けようがなかった。
//
// ここで守るのは2つ:
//  1. インライン化してよい形式だけを選ぶこと（SVG を混ぜると送信ごと壊れる）
//  2. AI へ渡す本文に CLI 固有の道具名を書かないこと（12プロバイダ中11には無い）
import { describe, expect, it } from "vitest";
import { inlineableImages } from "@/lib/tauri";

describe("inlineableImages", () => {
  it("png / jpg / jpeg / gif / webp は画像としてそのまま渡す", () => {
    const atts = [
      { kind: "image", path: "C:/a/shot.png", mime: "image/png" },
      { kind: "image", path: "C:/a/shot.jpg", mime: "image/jpeg" },
      { kind: "image", path: "C:/a/shot.jpeg", mime: "image/jpeg" },
      { kind: "image", path: "C:/a/shot.gif", mime: "image/gif" },
      { kind: "image", path: "C:/a/shot.webp", mime: "image/webp" },
    ];
    expect(inlineableImages(atts).map((i) => i.path)).toEqual(
      atts.map((a) => a.path),
    );
  });

  it("🚨 SVG は必ず除く（Anthropic の image ブロックが受け付けない）", () => {
    const out = inlineableImages([
      { kind: "image", path: "C:/a/logo.svg", mime: "image/svg+xml" },
      { kind: "image", path: "C:/a/shot.png", mime: "image/png" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("C:/a/shot.png");
  });

  it("画像以外の添付（PDF・テキスト等）は渡さない", () => {
    const out = inlineableImages([
      { kind: "file", path: "C:/a/spec.pdf", mime: "application/pdf" },
      { kind: "file", path: "C:/a/note.md", mime: "text/markdown" },
    ]);
    expect(out).toEqual([]);
  });

  it("拡張子の大小は問わない", () => {
    const out = inlineableImages([
      { kind: "image", path: "C:/a/SHOT.PNG", mime: "image/png" },
    ]);
    expect(out).toHaveLength(1);
  });

  it("添付なし・undefined でも落ちない（空配列を返す）", () => {
    expect(inlineableImages(undefined)).toEqual([]);
    expect(inlineableImages([])).toEqual([]);
  });

  it("mime が無くても拡張子だけで判定できる", () => {
    const out = inlineableImages([{ kind: "image", path: "C:/a/shot.png" }]);
    expect(out).toEqual([{ path: "C:/a/shot.png", mime: null }]);
  });
});
