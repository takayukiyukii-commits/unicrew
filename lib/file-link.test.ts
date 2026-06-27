import { describe, it, expect } from "vitest";
import {
  segmentText,
  findPathMatches,
  pathStartOffset,
  resolveFilePath,
} from "./file-link";

// バックスラッシュをテスト文字列にそのまま埋めるためのヘルパ。
// （\\ をソース内に書くより事故りにくい）
const BS = "\\";
const winPath = `D:${BS}secrets${BS}APIキー一覧.md`;

describe("pathStartOffset", () => {
  it("ドライブレターが先頭にあれば 0", () => {
    expect(pathStartOffset(winPath)).toBe(0);
    expect(pathStartOffset("C:/Users/foo/x.md")).toBe(0);
  });

  it("日本語の地の文が手前にくっついていればドライブレター位置を返す", () => {
    const glued = `お見せします${winPath}`;
    expect(pathStartOffset(glued)).toBe("お見せします".length);
  });

  it("ドライブレターを含まなければ 0", () => {
    expect(pathStartOffset("components/MessageItem.tsx")).toBe(0);
    expect(pathStartOffset("config.md")).toBe(0);
  });
});

describe("segmentText - 日本語直結パスの再アンカー（報告された不具合）", () => {
  it("句点をはさんでも Windows パスだけが file セグメントになる", () => {
    const text = `結城さんご自身の認証情報なので、お見せします。${winPath} の cost-dashboard`;
    const segs = segmentText(text);
    const file = segs.find((s) => s.kind === "file");
    expect(file?.path).toBe(winPath);
    // クリック領域がパス手前の地の文に乗らないこと
    expect(segs[0].kind).toBe("text");
    expect(segs[0].text.endsWith("お見せします。")).toBe(true);
  });

  it("空白も句読点もなく地の文とパスが直結していてもパスだけを切り出す", () => {
    const text = `結城さんご自身の認証情報なのでお見せします${winPath}`;
    const segs = segmentText(text);
    const file = segs.find((s) => s.kind === "file");
    // ここが不具合の核心：以前は地の文ごと file 化してクリック位置がずれていた
    expect(file?.path).toBe(winPath);
    expect(segs[0].kind).toBe("text");
    expect(segs[0].text).toBe("結城さんご自身の認証情報なのでお見せします");
  });

  it("スラッシュ区切りの Windows パスでも同様", () => {
    const text = "パスはC:/Users/takay/config.jsonです";
    const segs = segmentText(text);
    const file = segs.find((s) => s.kind === "file");
    expect(file?.path).toBe("C:/Users/takay/config.json");
    expect(segs[0].text).toBe("パスは");
  });
});

describe("segmentText - 既存挙動の維持（回帰防止）", () => {
  it("相対パスは従来どおり検出", () => {
    const segs = segmentText("詳細は components/MessageItem.tsx を見て");
    const file = segs.find((s) => s.kind === "file");
    expect(file?.path).toBe("components/MessageItem.tsx");
  });

  it("拡張子のみ・バージョン文字列は検出しない", () => {
    expect(segmentText(".md だけ").every((s) => s.kind === "text")).toBe(true);
    expect(segmentText("v4.7 にする").every((s) => s.kind === "text")).toBe(true);
  });
});

describe("findPathMatches - ターミナル側も同じ再アンカー", () => {
  it("日本語直結の Windows パスでも openPath はパス本体だけ", () => {
    const line = `編集しました${winPath}:12`;
    const matches = findPathMatches(line);
    expect(matches.length).toBe(1);
    expect(matches[0].openPath).toBe(winPath);
    // 行内開始位置がドライブレター位置になっていること
    expect(line.slice(matches[0].start, matches[0].start + 2)).toBe("D:");
  });
});

describe("§ や記号を含むパスも全体がリンクになる（報告された不具合）", () => {
  const sectionPath = `D:${BS}company${BS}CDO（技術責任者）${BS}作業中${BS}20260627_提案_UNIHUBマネージドAI料金_§12統合最終プラン表.md`;

  it("segmentText: § で切れず全体が file セグメントになる", () => {
    const segs = segmentText(`保存しました ${sectionPath} を確認`);
    const file = segs.find((x) => x.kind === "file");
    expect(file?.path).toBe(sectionPath);
  });

  it("findPathMatches: § を含んでも openPath はパス全体", () => {
    const matches = findPathMatches(`開きました${sectionPath}`);
    expect(matches.length).toBe(1);
    expect(matches[0].openPath).toBe(sectionPath);
  });
});

describe("resolveFilePath", () => {
  it("Windows 絶対パスはそのまま返す", () => {
    expect(resolveFilePath(winPath, "C:/ws")).toBe(winPath);
  });
  it("相対パスは workspace と結合する", () => {
    expect(resolveFilePath("a.md", "C:/ws")).toBe("C:/ws/a.md");
  });
});
