import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  detectModel,
  detectEffortRejected,
  appendTail,
} from "./terminal-status";
import { feedInput, EMPTY_ECHO, MAX_ECHO_LEN } from "./terminal-input-echo";

const ESC = "\x1b";

describe("stripAnsi", () => {
  it("色・カーソル移動を落として本文だけ残す", () => {
    expect(stripAnsi(`${ESC}[31merror${ESC}[0m`)).toBe("error");
    expect(stripAnsi(`${ESC}[2J${ESC}[H hello`)).toBe(" hello");
  });

  it("OSC（タイトル設定など）も落とす", () => {
    expect(stripAnsi(`${ESC}]0;title\x07body`)).toBe("body");
  });

  it("普通の文字列はそのまま", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("detectModel", () => {
  it("claude の表示からモデルを読む", () => {
    expect(detectModel("Model: Sonnet 4.5 ready", "claude")).toBe("Sonnet 4.5");
    expect(detectModel("switched to Opus 4.1", "claude")).toBe("Opus 4.1");
  });

  it("codex / gemini / grok も読める", () => {
    expect(detectModel("model gpt-5.6-sol loaded", "codex")).toBe("gpt-5.6-sol");
    expect(detectModel("using gemini-2.5-pro", "gemini")).toBe("gemini-2.5-pro");
    expect(detectModel("grok-4 ready", "grok")).toBe("grok-4");
  });

  it("色付きの表示でも読める（ANSI を落としてから見る）", () => {
    expect(detectModel(`${ESC}[36mSonnet 4.5${ESC}[0m`, "claude")).toBe(
      "Sonnet 4.5",
    );
  });

  it("🚨 最後に出てきたものを採る（/model で切り替えた後を優先）", () => {
    expect(detectModel("Sonnet 4.5 ... later Opus 4.1", "claude")).toBe(
      "Opus 4.1",
    );
  });

  it("🚨 読めなければ null（推測しない）", () => {
    expect(detectModel("なにも書いていない出力", "claude")).toBeNull();
    expect(detectModel("gpt-5.6-sol", "claude")).toBeNull(); // CLI が違えば拾わない
    expect(detectModel("", "codex")).toBeNull();
  });

  it("CLI が分からないときは全部のパターンで探す", () => {
    expect(detectModel("model gpt-5.5 here", null)).toBe("gpt-5.5");
  });

  it("知らない CLI では何も返さない（勝手に当てない）", () => {
    expect(detectModel("Sonnet 4.5", "opencode")).toBeNull();
  });
});

describe("detectEffortRejected", () => {
  it("claude の「不正な --effort を無視した」警告を拾う", () => {
    expect(
      detectEffortRejected(
        "Warning: Unknown --effort value 'x' — ignoring it and using the default effort.",
      ),
    ).toBe(true);
  });

  it("普通の出力では false", () => {
    expect(detectEffortRejected("effort: high")).toBe(false);
    expect(detectEffortRejected("")).toBe(false);
  });
});

describe("appendTail", () => {
  it("末尾だけを保持する（長時間セッションで膨らませない）", () => {
    const tail = appendTail("", "a".repeat(50), 20);
    expect(tail.length).toBe(20);
    expect(appendTail("xy", "z", 10)).toBe("xyz");
  });
});

describe("feedInput（送った指示の写し取り）", () => {
  it("Enter で 1 件確定し、バッファは空になる", () => {
    let st = feedInput(EMPTY_ECHO, "npm run dev");
    expect(st.buffer).toBe("npm run dev");
    expect(st.last).toBeNull();
    st = feedInput(st, "\r");
    expect(st.last).toBe("npm run dev");
    expect(st.buffer).toBe("");
  });

  it("\\n でも確定する", () => {
    const st = feedInput(EMPTY_ECHO, "ls\n");
    expect(st.last).toBe("ls");
  });

  it("バックスペースで消える", () => {
    const st = feedInput(EMPTY_ECHO, "abc\x7f\x7fZ");
    expect(st.buffer).toBe("aZ");
  });

  it("Ctrl+C / Ctrl+U で入力中の行を捨てる", () => {
    expect(feedInput(EMPTY_ECHO, "abc\x03").buffer).toBe("");
    expect(feedInput(EMPTY_ECHO, "abc\x15").buffer).toBe("");
  });

  it("矢印キー等のエスケープ列は無視する（変な記号を混ぜない）", () => {
    const st = feedInput(EMPTY_ECHO, `a${ESC}[Ab${ESC}[Dc`);
    expect(st.buffer).toBe("abc");
  });

  it("ブラケットペーストのマーカーを本文に混ぜない", () => {
    const st = feedInput(EMPTY_ECHO, `${ESC}[200~貼り付けた文${ESC}[201~\r`);
    expect(st.last).toBe("貼り付けた文");
  });

  it("空 Enter は記録しない（直前の指示を消さない）", () => {
    let st = feedInput(EMPTY_ECHO, "hello\r");
    st = feedInput(st, "\r");
    st = feedInput(st, "   \r");
    expect(st.last).toBe("hello");
  });

  it("日本語もそのまま記録する", () => {
    const st = feedInput(EMPTY_ECHO, "この関数を直して\r");
    expect(st.last).toBe("この関数を直して");
  });

  it("長すぎる入力は切り詰める（画面を占領させない）", () => {
    const st = feedInput(EMPTY_ECHO, "x".repeat(5000) + "\r");
    expect(st.last?.length).toBe(MAX_ECHO_LEN);
  });

  it("変化が無ければ同じオブジェクトを返す（無駄な再描画を起こさない）", () => {
    const st = feedInput(EMPTY_ECHO, "a");
    expect(feedInput(st, "")).toBe(st);
    expect(feedInput(st, "\t")).toBe(st);
  });
});
