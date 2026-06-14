// マークダウンリンクのクリック先分類（初心者がプレビューリンクを開けなかった修正）の回帰テスト。
import { describe, expect, it } from "vitest";
import { classifyMarkdownLink } from "./preview";

const WS = "D:\\company\\ナレッジ\\アイコン";

describe("classifyMarkdownLink", () => {
  it("相対パスの画像PNG → 別ウィンドウでプレビュー(file)", () => {
    const a = classifyMarkdownLink("phone-soft.png", WS);
    expect(a).toEqual({ kind: "preview-file", file: "D:\\company\\ナレッジ\\アイコン\\phone-soft.png" });
  });

  it("./付き相対の画像 → workspace解決してプレビュー", () => {
    const a = classifyMarkdownLink("./camera-circle.png", WS);
    expect(a).toEqual({ kind: "preview-file", file: "D:\\company\\ナレッジ\\アイコン\\camera-circle.png" });
  });

  it("絶対Windowsパスの画像 → そのままプレビュー(file)", () => {
    const a = classifyMarkdownLink("D:\\out\\preview.png", null);
    expect(a).toEqual({ kind: "preview-file", file: "D:\\out\\preview.png" });
  });

  it("file:///C:/... の画像URL → 実パスへ変換してプレビュー", () => {
    const a = classifyMarkdownLink("file:///C:/Users/x/a.png", null);
    expect(a).toEqual({ kind: "preview-file", file: "C:/Users/x/a.png" });
  });

  it("HTMLファイル → プレビュー(file)", () => {
    const a = classifyMarkdownLink("/tmp/site/index.html", null);
    expect(a).toEqual({ kind: "preview-file", file: "/tmp/site/index.html" });
  });

  it("localhost 開発URL → プレビュー(url)", () => {
    const a = classifyMarkdownLink("http://localhost:3000/preview", null);
    expect(a).toEqual({ kind: "preview-url", url: "http://localhost:3000/preview" });
  });

  it("0.0.0.0 はlocalhostへ寄せてプレビュー(url)", () => {
    const a = classifyMarkdownLink("http://0.0.0.0:8080/", null);
    expect(a).toEqual({ kind: "preview-url", url: "http://localhost:8080/" });
  });

  it("外部URL → 既定アプリ/ブラウザ(external)", () => {
    const a = classifyMarkdownLink("https://example.com/x", null);
    expect(a).toEqual({ kind: "external", target: "https://example.com/x" });
  });

  it("画像でもHTMLでもないローカルファイル(pdf) → external", () => {
    const a = classifyMarkdownLink("report.pdf", WS);
    expect(a).toEqual({ kind: "external", target: "D:\\company\\ナレッジ\\アイコン\\report.pdf" });
  });

  it("URLエンコードされたfile:// の日本語パス → デコードしてプレビュー", () => {
    const a = classifyMarkdownLink("file:///D:/%E3%83%86%E3%82%B9%E3%83%88/a.png", null);
    expect(a).toEqual({ kind: "preview-file", file: "D:/テスト/a.png" });
  });
});
