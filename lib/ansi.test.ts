import { describe, it, expect } from "vitest";
import { ansiToLines } from "./ansi";

const text = (line: { text: string }[]) => line.map((s) => s.text).join("");

describe("ansiToLines — VSCode-terminal fidelity", () => {
  it("plain text → one line, default style", () => {
    const lines = ansiToLines("hello world");
    expect(lines).toHaveLength(1);
    expect(text(lines[0])).toBe("hello world");
    expect(lines[0][0].style.fg).toBeUndefined();
  });

  it("basic SGR color + reset", () => {
    const lines = ansiToLines("\x1b[31mred\x1b[0mplain");
    expect(text(lines[0])).toBe("redplain");
    expect(lines[0][0].style.fg).toBe("#cd3131");
    expect(lines[0][1].style.fg).toBeUndefined();
  });

  it("bold + bright color", () => {
    const lines = ansiToLines("\x1b[1;92mok\x1b[0m");
    expect(lines[0][0].style.bold).toBe(true);
    expect(lines[0][0].style.fg).toBe("#23d18b");
  });

  it("carriage return fully overwrites (progress bar)", () => {
    expect(text(ansiToLines("50%\rDONE")[0])).toBe("DONE");
  });

  it("carriage return partial overwrite keeps tail (cell buffer)", () => {
    expect(text(ansiToLines("abcdef\rXYZ")[0])).toBe("XYZdef");
  });

  it("tab expands to 8-col stops", () => {
    const line = text(ansiToLines("a\tb")[0]);
    expect(line).toBe("a       b"); // 'a' + 7 spaces + 'b'
    expect(line[8]).toBe("b");
  });

  it("xterm-256 color", () => {
    const lines = ansiToLines("\x1b[38;5;196mX");
    expect(lines[0][0].style.fg).toBe("#ff0000");
  });

  it("truecolor (24-bit)", () => {
    const lines = ansiToLines("\x1b[38;2;10;20;30mX");
    expect(lines[0][0].style.fg).toBe("rgb(10,20,30)");
  });

  it("no escape/control bytes leak into rendered text", () => {
    const joined = text(ansiToLines("hi\x1b[31mthere\x1b[0m")[0]);
    expect(joined).toBe("hithere");
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("[");
  });

  it("strips OSC (window title) sequences", () => {
    expect(text(ansiToLines("\x1b]0;my title\x07hello")[0])).toBe("hello");
  });

  it("newlines split into multiple lines", () => {
    const lines = ansiToLines("line1\nline2\nline3");
    expect(lines).toHaveLength(3);
    expect(text(lines[1])).toBe("line2");
  });

  it("background color via 4x codes", () => {
    const lines = ansiToLines("\x1b[41mE\x1b[49mN");
    expect(lines[0][0].style.bg).toBe("#cd3131");
    expect(lines[0][1].style.bg).toBeUndefined();
  });
});
