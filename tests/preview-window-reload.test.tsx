// プレビュー再クリック（同一URL/同一パス）で確実に再読込される修正の回帰テスト。
// バグ: navigate 受信時に reloadKey を進めず、iframe の src/srcDoc 同値で
//       React が要素を再利用 → 内容が更新されず「変わらない」。
// 修正: navigate 受信で reloadKey を bump → iframe の key が変わり強制リマウント。
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// ---- 依存をモック ----
let navigateCb: ((e: { payload: unknown }) => void) | null = null;

vi.mock("next/navigation", () => ({
  // url/file クエリ無しで初期表示（最初は「読み込み中…」）
  useSearchParams: () => ({ get: (_: string) => null }),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  // PreviewWindow が listen() で登録するコールバックを捕捉する
  listen: (_event: string, cb: (e: { payload: unknown }) => void) => {
    navigateCb = cb;
    return Promise.resolve(() => {});
  },
}));

import { PreviewWindow } from "@/components/PreviewWindow";

// @ts-expect-error - React 19 act 環境フラグ
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function getIframeKeySrc(container: HTMLElement) {
  const iframe = container.querySelector("iframe");
  // React は key を DOM に出さないため、src と「要素の同一性」で再マウントを判定する
  return iframe;
}

describe("PreviewWindow 再navigateで強制リロード", () => {
  afterEach(() => {
    navigateCb = null;
    vi.clearAllMocks();
  });

  it("同一URLで2回navigateしても iframe 要素が作り直される（強制リマウント）", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(PreviewWindow));
    });
    // listen 登録（dynamic import）の解決を待つ
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigateCb).toBeTypeOf("function");

    const SAME = "http://localhost:3000/";

    // 1回目: 同一URLでnavigate
    await act(async () => {
      navigateCb!({ payload: { url: SAME } });
    });
    const first = getIframeKeySrc(container);
    expect(first).not.toBeNull();
    expect(first!.getAttribute("src")).toBe(SAME);

    // 2回目: まったく同じURLで再navigate（バグ時は同一要素が再利用され変化なし）
    await act(async () => {
      navigateCb!({ payload: { url: SAME } });
    });
    const second = getIframeKeySrc(container);
    expect(second).not.toBeNull();
    expect(second!.getAttribute("src")).toBe(SAME);

    // 修正の核心: key が変わるため iframe は別の DOM 要素に作り直される
    // （= ブラウザが src を読み直す）。バグ版だと first === second になる。
    expect(second).not.toBe(first);

    root.unmount();
    container.remove();
  });
});
