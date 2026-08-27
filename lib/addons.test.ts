import { describe, expect, it } from "vitest";
import { CURATED_ADDONS, UNI_PRODUCTS } from "./addons";

/**
 * 🚨 2026-08-28 の事故を繰り返さないためのテスト。
 *
 * CURATED_ADDONS（おすすめ）は手書きの一覧なので、上流で名前が変わっても
 * こちらは気づかない。実際に security-review（→ security-guidance）と
 * browser-use（→ chrome）の2件が古いまま残り、「押すと必ず失敗するボタン」
 * になっていた。
 *
 * 実在チェックそのものは実行時に行う（AddonsSection がカタログと突き合わせる）。
 * ここでは、そこへ至る前提——id の形が壊れていないこと——を機械で守る。
 */
describe("CURATED_ADDONS", () => {
  it("id が重複していない", () => {
    const ids = CURATED_ADDONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("プラグインの id は <name>@<marketplaceId> と一致している", () => {
    for (const c of CURATED_ADDONS) {
      if (c.kind !== "plugin") continue;
      expect(c.marketplaceId, `${c.id} に marketplaceId が無い`).toBeTruthy();
      expect(c.id).toBe(`${c.name}@${c.marketplaceId}`);
    }
  });

  it("🚨 改名済みの古い id が復活していない（2026-08-28 実測で消えたもの）", () => {
    const retired = ["security-review", "browser-use"];
    for (const c of CURATED_ADDONS) {
      expect(retired, `${c.name} は上流で改名済み`).not.toContain(c.name);
    }
  });

  it("必須項目が空でない", () => {
    for (const c of CURATED_ADDONS) {
      expect(c.label.trim().length, `${c.id} の label`).toBeGreaterThan(0);
      expect(c.description.trim().length, `${c.id} の description`).toBeGreaterThan(0);
      expect(c.benefit.trim().length, `${c.id} の benefit`).toBeGreaterThan(0);
    }
  });
});

describe("UNI_PRODUCTS", () => {
  it("id が重複していない", () => {
    const ids = UNI_PRODUCTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("live の製品には必ず行き先の URL がある（押せるのに開かない、を作らない）", () => {
    for (const p of UNI_PRODUCTS) {
      if (p.status !== "live") continue;
      expect(p.url, `${p.id} が live なのに url が無い`).toBeTruthy();
      expect(p.url!).toMatch(/^https:\/\//);
    }
  });

  it("URL は自社ドメインか GitHub に限る（外部への誤送客を防ぐ）", () => {
    for (const p of UNI_PRODUCTS) {
      if (!p.url) continue;
      expect(p.url).toMatch(
        /^https:\/\/([a-z0-9-]+\.)*(uni-core\.jp|zuboland\.jp)|^https:\/\/github\.com\/zuboland\//,
      );
    }
  });
});
