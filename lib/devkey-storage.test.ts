// ブラウザ経路（npm run dev）で使う APIキーの置き場の回帰テスト。
//
// 背景（CodeQL js/clear-text-storage-of-sensitive-data / alert #4 #5）:
//   getApiKey / setApiKey / getOpenAiApiKey / setOpenAiApiKey は
//   Tauri 実行時は OS のキーチェーンに入るが、!isTauri() のブラウザ経路では
//   localStorage に平文で書いていた。UNICREW は Tauri でしか配っていないので
//   実害は開発時に限られるが、`next build && next start` のような本番ブラウザ
//   実行でも同じ経路を通るため、本番では平文で残さない形に変えた。
//
// このテストが守るもの:
//   1. 開発時（NODE_ENV !== "production"）は今までどおり localStorage に残る
//      ＝リロードしても鍵を入れ直さなくてよい、という既存の使い勝手
//   2. 本番時（NODE_ENV === "production"）は localStorage に書かない
//      ＝ディスクに平文が残らない。ただしセッション中は読み書きできる

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEY = "unicrew.devApiKey";
const OPENAI_KEY = "unicrew.devOpenAiKey";

async function loadModuleWith(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  return await import("./tauri");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  // NODE_ENV は型上 read-only なので直接代入しない（tsc TS2540）。
  // vi.unstubAllEnvs() が stubEnv で入れた値を元に戻してくれる。
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("ブラウザ経路のAPIキー保管", () => {
  it("開発時は localStorage に保存され、読み戻せる（既存の挙動を維持）", async () => {
    const m = await loadModuleWith("development");
    await m.setApiKey("sk-ant-dev-example");
    expect(localStorage.getItem(KEY)).toBe("sk-ant-dev-example");
    await expect(m.getApiKey()).resolves.toBe("sk-ant-dev-example");
  });

  it("開発時は空文字を渡すと削除される（既存の挙動を維持）", async () => {
    const m = await loadModuleWith("development");
    await m.setApiKey("sk-ant-dev-example");
    await m.setApiKey("");
    expect(localStorage.getItem(KEY)).toBeNull();
    await expect(m.getApiKey()).resolves.toBeNull();
  });

  it("本番時は localStorage に平文で書かない（が、セッション中は読める）", async () => {
    const m = await loadModuleWith("production");
    await m.setApiKey("sk-ant-prod-example");
    expect(localStorage.getItem(KEY)).toBeNull();
    await expect(m.getApiKey()).resolves.toBe("sk-ant-prod-example");
  });

  it("本番時も空文字を渡せば消える", async () => {
    const m = await loadModuleWith("production");
    await m.setApiKey("sk-ant-prod-example");
    await m.setApiKey("");
    await expect(m.getApiKey()).resolves.toBeNull();
  });

  it("OpenAIキーも同じ規則で扱われる", async () => {
    const dev = await loadModuleWith("development");
    await dev.setOpenAiApiKey("sk-openai-dev");
    expect(localStorage.getItem(OPENAI_KEY)).toBe("sk-openai-dev");

    // dev で書いた値が残ったままだと本番側の検証にならないので、一度消す
    localStorage.clear();

    const prod = await loadModuleWith("production");
    await prod.setOpenAiApiKey("sk-openai-prod");
    expect(localStorage.getItem(OPENAI_KEY)).toBeNull();
    await expect(prod.getOpenAiApiKey()).resolves.toBe("sk-openai-prod");
  });

  it("APIキーとOpenAIキーは混ざらない", async () => {
    const m = await loadModuleWith("production");
    await m.setApiKey("sk-ant-x");
    await m.setOpenAiApiKey("sk-openai-y");
    await expect(m.getApiKey()).resolves.toBe("sk-ant-x");
    await expect(m.getOpenAiApiKey()).resolves.toBe("sk-openai-y");
  });
});
