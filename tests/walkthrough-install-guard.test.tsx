// 初回セットアップ（Walkthrough）のインストールボタン多重起動ガードの回帰テスト。
//
// バグ（〜v0.2.48）:
//   install_claude_code は Rust 側で spawn して即 Ok を返すため、フロントが
//   `await installClaudeCode()` の直後に busy を解除していた。結果、
//   ①押しても一瞬でボタンが元に戻る ②進捗も失敗理由も出ない（この画面は
//   claude_install:* を購読していなかった）→ ユーザーは連打する →
//   install.ps1 と winget が同時に走り、winget の固定 Temp パスを取り合って
//   「The process cannot access the file because it is being used by another
//     process」で落ちる（実ユーザー環境で発生）。
//
// 修正: done イベントを受けるまで busy を解除しない（＝ボタンを押せない）。
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

let installCalls = 0;
let claudeInstallDone: ((success: boolean) => void) | null = null;

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  claudeStatus: async () => ({ installed: false, logged_in: false, version: null, hint: "" }),
  codexStatus: async () => ({ installed: false, logged_in: false, version: null, hint: "" }),
  installClaudeCode: async () => {
    installCalls += 1;
    // Rust 側と同じく「即返る」= ここで完了を待たない
  },
  installCodex: async () => {},
  startClaudeLogin: async () => {},
  startCodexLogin: async () => {},
  listenInstallProgress: async (h: { onDone?: (s: boolean) => void }) => {
    claudeInstallDone = (s: boolean) => h.onDone?.(s);
    return () => {};
  },
  listenCodexInstallProgress: async () => () => {},
}));

vi.mock("@/lib/walkthrough", () => ({ markWalkthroughDone: () => {} }));

import { setLocale } from "@/lib/i18n";
import { Walkthrough } from "@/components/Walkthrough";

// jsdom の navigator.language は en-US。文言で要素を探すため日本語に固定する。
setLocale("ja");

// @ts-expect-error - React 19 act 環境フラグ
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** ステップ1「CLI をインストール済」行のアクションボタン */
function installButton(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    /インストール/.test(b.textContent || ""),
  ) as HTMLButtonElement | undefined;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

describe("Walkthrough インストールボタンの多重起動ガード", () => {
  afterEach(() => {
    installCalls = 0;
    claudeInstallDone = null;
    vi.clearAllMocks();
  });

  it("完了イベントが来るまでボタンは押せず、連打してもインストールは1回だけ", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(Walkthrough, {
          open: true,
          onClose: () => {},
          onPickFirstCharacter: () => {},
        }),
      );
    });
    await settle();

    const btn = installButton(container);
    expect(btn).toBeDefined();
    expect(btn!.disabled).toBe(false);

    // 1回目のクリック
    await act(async () => {
      btn!.click();
    });
    await settle();
    expect(installCalls).toBe(1);

    // 🚨 ここがバグの核心。完了前はボタンが押せない状態で居続けること。
    const during = installButton(container)!;
    expect(during.disabled).toBe(true);

    // 連打しても2回目は走らない
    await act(async () => {
      during.click();
      during.click();
    });
    await settle();
    expect(installCalls).toBe(1);

    // 進捗表示が出ていること（「何も起きない」に見えない）
    expect(container.textContent).toContain("インストール中です");

    // done(false) を受けたら解除され、救済 UI（手動コマンド）が出る
    expect(claudeInstallDone).toBeTypeOf("function");
    await act(async () => {
      claudeInstallDone!(false);
    });
    await settle();

    const after = installButton(container)!;
    expect(after.disabled).toBe(false);
    // 手動コマンドは公式ネイティブインストーラを案内する。
    // （jsdom の UA は Windows ではないので install.sh 側が出る。
    //   重要なのは、事故の元だった winget を案内しなくなったこと）
    expect(container.textContent).toContain("claude.ai/install");
    expect(container.textContent).not.toContain("winget install");

    root.unmount();
    container.remove();
  });
});
