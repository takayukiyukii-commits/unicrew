import { describe, expect, it } from "vitest";
import {
  armVoiceSend,
  cutVoiceSend,
  disarmVoiceSend,
  isVoiceSendArmed,
  stripVoiceSend,
  VOICE_SEND_WINDOW_MS,
} from "./voice-send";

describe("stripVoiceSend", () => {
  it("最後の「送信」と句読点を取り除く", () => {
    expect(stripVoiceSend("ファイルを直して。送信。")).toBe("ファイルを直して。");
    expect(stripVoiceSend("ファイルを直して 送信")).toBe("ファイルを直して");
    expect(stripVoiceSend("直して送信してください。")).toBe("直して");
    expect(stripVoiceSend("送信")).toBe("");
  });
  it("途中の「送信」では送らない", () => {
    expect(stripVoiceSend("送信ボタンを直して")).toBeNull();
    expect(stripVoiceSend("送信の仕組みを教えて。")).toBeNull();
    expect(stripVoiceSend("こんにちは")).toBeNull();
  });
});

describe("cutVoiceSend", () => {
  it("1回で届いたら本文だけ流して送る", () => {
    expect(cutVoiceSend("", "直して。送信。")).toEqual({
      forward: "直して。",
      backspaces: 0,
      send: true,
    });
  });
  it("「送」が先に届いていたら、その1文字を消してから送る", () => {
    expect(cutVoiceSend("直して。送", "信。")).toEqual({
      forward: "",
      backspaces: 1,
      send: true,
    });
  });
  it("送信でなければそのまま流す", () => {
    expect(cutVoiceSend("", "こんにちは")).toEqual({
      forward: "こんにちは",
      backspaces: 0,
      send: false,
    });
  });
});

describe("arm", () => {
  it("マイクを押してから一定時間だけ有効", () => {
    disarmVoiceSend();
    expect(isVoiceSendArmed(1000)).toBe(false);
    armVoiceSend(1000);
    expect(isVoiceSendArmed(1000 + VOICE_SEND_WINDOW_MS - 1)).toBe(true);
    expect(isVoiceSendArmed(1000 + VOICE_SEND_WINDOW_MS)).toBe(false);
    disarmVoiceSend();
  });
});
