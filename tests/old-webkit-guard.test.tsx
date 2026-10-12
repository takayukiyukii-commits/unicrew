// 古い WebKit で黙って壊れないための見張り（lib/old-webkit-guard.ts）の回帰テスト。
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import * as acorn from "acorn";
import { BOOT_TIMEOUT_MS, OLD_WEBKIT_ATTR, OLD_WEBKIT_GUARD, OLD_WEBKIT_NOTICE_ID } from "@/lib/old-webkit-guard";
import { OldWebkitNotice } from "@/components/OldWebkitNotice";
import { BootMarker } from "@/components/BootMarker";

// @ts-expect-error - React 19 act 環境フラグ
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type W = Window & { __UNICREW_BOOTED__?: boolean; CSSLayerBlockRule?: unknown };
const root = () => document.documentElement;

function runGuard() {
  // <script> にそのまま埋め込まれるのと同じく、文字列のまま実行する
  new Function(OLD_WEBKIT_GUARD)();
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  root().removeAttribute(OLD_WEBKIT_ATTR);
  delete (window as W).__UNICREW_BOOTED__;
  delete (window as W).CSSLayerBlockRule;
});

describe("OLD_WEBKIT_GUARD", () => {
  it("変換されずに古い WebKit で動くよう ES5 として構文解析できる", () => {
    expect(() => acorn.parse(OLD_WEBKIT_GUARD, { ecmaVersion: 5 })).not.toThrow();
  });

  it("@layer 非対応（CSSLayerBlockRule が無い）なら、すぐ <html> に css の印を付ける", () => {
    vi.useFakeTimers();
    runGuard();
    expect(root().getAttribute(OLD_WEBKIT_ATTR)).toBe("css");
  });

  it("@layer 対応で、プログラムが動き出したら印を付けない", () => {
    vi.useFakeTimers();
    (window as W).CSSLayerBlockRule = function () {};
    runGuard();
    (window as W).__UNICREW_BOOTED__ = true;
    vi.advanceTimersByTime(BOOT_TIMEOUT_MS + 1);
    expect(root().getAttribute(OLD_WEBKIT_ATTR)).toBeNull();
  });

  it("@layer 対応でも、時間内にプログラムが動き出さなければ timeout の印を付ける", () => {
    vi.useFakeTimers();
    (window as W).CSSLayerBlockRule = function () {};
    runGuard();
    vi.advanceTimersByTime(BOOT_TIMEOUT_MS - 1);
    expect(root().getAttribute(OLD_WEBKIT_ATTR)).toBeNull();
    vi.advanceTimersByTime(2);
    expect(root().getAttribute(OLD_WEBKIT_ATTR)).toBe("timeout");
  });
});

describe("OldWebkitNotice と BootMarker（hydration 後も案内が残るか）", () => {
  async function hydrateWith(attr: string | null) {
    const tree = (
      <>
        <OldWebkitNotice />
        <BootMarker />
        <main>app</main>
      </>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree); // 配布 HTML 相当（静的書き出し）
    document.body.appendChild(container);
    if (attr) root().setAttribute(OLD_WEBKIT_ATTR, attr); // 見張りが HTML の読み込み中に付けた印
    const errors: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, tree, { onRecoverableError: (e) => errors.push(e) });
    });
    return { container, errors };
  }

  it("案内の要素は静的に書き出され、普段は非表示（印が無ければ出ない）", async () => {
    const { container, errors } = await hydrateWith(null);
    const box = container.querySelector(`#${OLD_WEBKIT_NOTICE_ID}`) as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.display).toBe("none");
    expect(errors).toEqual([]);
  });

  it("css の印は、プログラムが動き出したあとも消えない（案内が残る）", async () => {
    const { container, errors } = await hydrateWith("css");
    expect(root().getAttribute(OLD_WEBKIT_ATTR)).toBe("css");
    expect(container.querySelector(`#${OLD_WEBKIT_NOTICE_ID}`)).not.toBeNull();
    expect(container.querySelector("style")?.textContent).toContain(`html[${OLD_WEBKIT_ATTR}] #${OLD_WEBKIT_NOTICE_ID}`);
    expect(errors).toEqual([]);
  });

  it("timeout の印は、遅れてプログラムが動き出したら外れる（@layer 対応の環境）", async () => {
    (window as W).CSSLayerBlockRule = function () {};
    await hydrateWith("timeout");
    expect(root().getAttribute(OLD_WEBKIT_ATTR)).toBeNull();
  });

  it("@layer 非対応なら、ルートの作り直しで印が消えていても BootMarker が css の印を付け直す", async () => {
    // jsdom には CSSLayerBlockRule が無い＝古い WebKit 相当。見張りの <script> は再実行されない前提
    expect((window as W).CSSLayerBlockRule).toBeUndefined();
    await hydrateWith(null);
    expect(root().getAttribute(OLD_WEBKIT_ATTR)).toBe("css");
  });

  it("案内の表示中は、裏の画面にキー入力（Shift+Tab 等）が届かない", () => {
    runGuard(); // jsdom＝@layer 非対応 → すぐ css の印
    expect(root().getAttribute(OLD_WEBKIT_ATTR)).toBe("css");
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener("keydown", onKey);
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
      expect(seen).toEqual([]);
      root().removeAttribute(OLD_WEBKIT_ATTR); // 案内が消えたら通常どおり届く
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
      expect(seen).toEqual(["Tab"]);
    } finally {
      document.removeEventListener("keydown", onKey);
    }
  });
});
