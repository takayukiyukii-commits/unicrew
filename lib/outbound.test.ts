import { describe, expect, it } from "vitest";
import { withTracking, UNILINKS } from "./outbound";

describe("withTracking", () => {
  it("utm を4つとも付ける", () => {
    const u = new URL(withTracking("https://hub.uni-core.jp", "addons_uni"));
    expect(u.searchParams.get("utm_source")).toBe("unicrew");
    expect(u.searchParams.get("utm_medium")).toBe("app");
    expect(u.searchParams.get("utm_campaign")).toBe("uni_funnel");
    expect(u.searchParams.get("utm_content")).toBe("addons_uni");
  });

  it("置き場所（utm_content）が呼び出しごとに変わる", () => {
    const a = new URL(withTracking("https://zuboland.jp/unilinks", "addons_membership"));
    const b = new URL(withTracking("https://post.uni-core.jp/api-keys", "mcp_apikey"));
    expect(a.searchParams.get("utm_content")).toBe("addons_membership");
    expect(b.searchParams.get("utm_content")).toBe("mcp_apikey");
  });

  it("既存のクエリとハッシュを壊さない", () => {
    const u = new URL(
      withTracking("https://zuboland.jp/x?a=1&b=2#sec", "addons_uni"),
    );
    expect(u.searchParams.get("a")).toBe("1");
    expect(u.searchParams.get("b")).toBe("2");
    expect(u.hash).toBe("#sec");
    expect(u.searchParams.get("utm_source")).toBe("unicrew");
  });

  it("すでに utm_source があるURLは二重に付けない", () => {
    const src = "https://zuboland.jp/unilinks?utm_source=kuzira&utm_medium=app";
    expect(withTracking(src, "addons_membership")).toBe(src);
  });

  it("相対パス・空文字・非HTTPはそのまま返す（壊さない）", () => {
    expect(withTracking("", "addons_uni")).toBe("");
    expect(withTracking("/local/page", "addons_uni")).toBe("/local/page");
    expect(withTracking("mailto:a@example.com", "addons_uni")).toBe(
      "mailto:a@example.com",
    );
    expect(withTracking("javascript:alert(1)", "addons_uni")).toBe(
      "javascript:alert(1)",
    );
  });

  it("🚨 個人・端末を指す値をURLに載せない（載せたら送客先のログに残る）", () => {
    const url = withTracking("https://zuboland.jp/unilinks", "addons_membership");
    for (const banned of ["install", "uuid", "user", "workspace", "token", "key"]) {
      expect(url.toLowerCase()).not.toContain(banned + "=");
    }
    // utm_* 以外のパラメータを足していないこと
    const params = [...new URL(url).searchParams.keys()];
    expect(params.every((k) => k.startsWith("utm_"))).toBe(true);
  });
});

describe("UNILINKS", () => {
  it("販売ページの実測値と一致している（2026-08-28 zuboland.jp/unilinks 確認）", () => {
    expect(UNILINKS.price).toBe(9800);
    expect(UNILINKS.compare).toBe(17400);
    expect(UNILINKS.trial).toBe("14日間無料");
    expect(UNILINKS.url).toBe("https://zuboland.jp/unilinks");
  });

  it("🚨 販売ページに書かれていない限定・締切を語らない", () => {
    const text = JSON.stringify(UNILINKS);
    for (const banned of ["先着", "限定", "残り", "締切", "値上げ"]) {
      expect(text).not.toContain(banned);
    }
  });
});
