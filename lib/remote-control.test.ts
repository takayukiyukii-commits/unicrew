import { describe, expect, it } from "vitest";
import {
  extractRemoteControlUrl,
  RemoteControlOutputParser,
  stripTerminalEscapes,
} from "./remote-control";

describe("stripTerminalEscapes", () => {
  it("CSI カラー・カーソル制御を除去する", () => {
    expect(stripTerminalEscapes("\x1b[32mhello\x1b[0m \x1b[2K\x1b[1Gworld")).toBe(
      "hello world",
    );
  });

  it("OSC8 ハイパーリンクは URL を残す", () => {
    const s =
      "\x1b]8;;https://claude.ai/remote/abc123\x07開く\x1b]8;;\x07 done";
    const out = stripTerminalEscapes(s);
    expect(out).toContain("https://claude.ai/remote/abc123");
    expect(out).toContain("done");
  });

  it("OSC タイトル設定を丸ごと除去する", () => {
    expect(stripTerminalEscapes("\x1b]0;my title\x07visible")).toBe("visible");
  });
});

describe("extractRemoteControlUrl", () => {
  it("プレーンテキストから claude.ai URL を拾う", () => {
    const text = "Session URL: https://claude.ai/code/session/abc-123\n";
    expect(extractRemoteControlUrl(text)).toBe(
      "https://claude.ai/code/session/abc-123",
    );
  });

  it("ANSI 装飾つきでも拾う", () => {
    const text =
      "\x1b[1mConnect:\x1b[0m \x1b[36mhttps://claude.ai/remote/xyz789\x1b[0m\r\n";
    expect(extractRemoteControlUrl(text)).toBe(
      "https://claude.ai/remote/xyz789",
    );
  });

  it("URL が無ければ null", () => {
    expect(extractRemoteControlUrl("starting server...")).toBeNull();
  });

  it("複数あれば最後を返す・末尾の句読点は削る", () => {
    const text =
      "old https://claude.ai/remote/old1 ... new https://claude.ai/remote/new2.";
    expect(extractRemoteControlUrl(text)).toBe("https://claude.ai/remote/new2");
  });

  it("claude.ai 以外のドメインは拾わない", () => {
    expect(
      extractRemoteControlUrl("see https://example.com/claude.ai/fake"),
    ).toBeNull();
  });
});

describe("RemoteControlOutputParser", () => {
  it("チャンク分割された URL も溜めて検出する", () => {
    const p = new RemoteControlOutputParser();
    p.push("Connect: https://claude.ai/rem");
    expect(p.url).toBeNull();
    p.push("ote/split-abc\r\n");
    expect(p.url).toBe("https://claude.ai/remote/split-abc");
  });

  it("URL 検出後もより新しい URL で更新される", () => {
    const p = new RemoteControlOutputParser();
    p.push("https://claude.ai/remote/first ");
    p.push("https://claude.ai/remote/second ");
    expect(p.url).toBe("https://claude.ai/remote/second");
  });

  it("末尾スペースなどで境界が確定していれば1チャンクでも採用する", () => {
    const p = new RemoteControlOutputParser();
    p.push("Connect: https://claude.ai/remote/one-shot\r\n");
    expect(p.url).toBe("https://claude.ai/remote/one-shot");
  });

  it("ログイン案内の緩い検出", () => {
    const p = new RemoteControlOutputParser();
    expect(p.sawLoginHint).toBe(false);
    p.push("Please run /login to sign in\r\n");
    expect(p.sawLoginHint).toBe(true);
  });
});
