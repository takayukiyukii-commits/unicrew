import { describe, it, expect } from "vitest";
import {
  applyEffort,
  paneLaunchCommand,
  supportsEffort,
  effortLevelsFor,
  isValidEffort,
  effortLabel,
  EFFORT_SUPPORT,
  showsDefaultEffortBadge,
} from "./terminal-effort";
import { TERMINAL_CLIS } from "./terminal-clis";

describe("エフォート対応表", () => {
  it("対応表の CLI id は、実在する CLI カタログの id である", () => {
    const known = new Set(TERMINAL_CLIS.map((c) => c.id));
    for (const id of Object.keys(EFFORT_SUPPORT)) {
      expect(known.has(id), `${id} が terminal-clis.ts に無い`).toBe(true);
    }
  });

  it("🚨 フラグを持たない CLI は対応表に載せない（無い機能を出さない）", () => {
    for (const id of ["gemini", "qwen", "opencode", "goose", "cursor"]) {
      expect(supportsEffort(id)).toBe(false);
      expect(effortLevelsFor(id)).toEqual([]);
    }
  });

  it("実測どおりの値を持っている", () => {
    expect(effortLevelsFor("claude")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // codex は max/ultra がモデル依存なので、共通部分だけ
    expect(effortLevelsFor("codex")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortLevelsFor("grok")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortLevelsFor("kimi")).toEqual(["think", "fast"]);
  });

  it("claude だけが「不正値で黙る」＝バッジを信用してはいけない CLI", () => {
    expect(EFFORT_SUPPORT.claude.silentOnInvalid).toBe(true);
    expect(EFFORT_SUPPORT.codex.silentOnInvalid).toBe(false);
    expect(EFFORT_SUPPORT.grok.silentOnInvalid).toBe(false);
  });
});

describe("applyEffort", () => {
  it("🚨 指定なしなら引数を 1 つも足さない（＝従来と完全に同じ起動）", () => {
    expect(applyEffort("claude", null)).toEqual([]);
    expect(applyEffort("claude", undefined)).toEqual([]);
    expect(applyEffort("codex", null, ["--foo"])).toEqual(["--foo"]);
  });

  it("フラグ型（claude / grok）", () => {
    expect(applyEffort("claude", "high")).toEqual(["--effort", "high"]);
    expect(applyEffort("grok", "xhigh")).toEqual([
      "--reasoning-effort",
      "xhigh",
    ]);
  });

  it("設定キー型（codex）", () => {
    expect(applyEffort("codex", "high")).toEqual([
      "-c",
      "model_reasoning_effort=high",
    ]);
  });

  it("2 値型（kimi）は on/off のフラグになる", () => {
    expect(applyEffort("kimi", "think")).toEqual(["--thinking"]);
    expect(applyEffort("kimi", "fast")).toEqual(["--no-thinking"]);
  });

  it("既存の引数の後ろに足す（元の引数を壊さない）", () => {
    expect(applyEffort("goose", null, ["session"])).toEqual(["session"]);
    expect(applyEffort("claude", "low", ["--foo", "bar"])).toEqual([
      "--foo",
      "bar",
      "--effort",
      "low",
    ]);
  });

  it("🚨 知らない値・知らない CLI は無視する（推測で送らない）", () => {
    expect(applyEffort("claude", "bananaXX")).toEqual([]);
    expect(applyEffort("codex", "max")).toEqual([]); // モデル依存なので出さない値
    expect(applyEffort("gemini", "high")).toEqual([]);
    expect(applyEffort(undefined, "high")).toEqual([]);
  });
});

describe("isValidEffort / effortLabel", () => {
  it("妥当な組み合わせだけ true", () => {
    expect(isValidEffort("claude", "max")).toBe(true);
    expect(isValidEffort("codex", "max")).toBe(false);
    expect(isValidEffort("gemini", "high")).toBe(false);
    expect(isValidEffort("claude", null)).toBe(false);
  });

  it("バッジ表示は妥当なときだけ文字を返す", () => {
    expect(effortLabel("claude", "high")).toBe("high");
    expect(effortLabel("claude", "bananaXX")).toBeNull();
    expect(effortLabel("gemini", "high")).toBeNull();
  });
});

describe("paneLaunchCommand（起動経路を静かに変えないための固定）", () => {
  const lookup = (id: string) => TERMINAL_CLIS.find((c) => c.id === id);

  it("🚨 claude ＋エフォート未指定は undefined（＝従来の起動経路そのまま）", () => {
    expect(paneLaunchCommand("claude", "claude", undefined, lookup)).toBeUndefined();
    expect(paneLaunchCommand("claude", undefined, undefined, lookup)).toBeUndefined();
  });

  it("claude ＋エフォート指定のときだけコマンドを組み立てる", () => {
    expect(paneLaunchCommand("claude", "claude", "high", lookup)).toEqual({
      program: "claude",
      args: ["--effort", "high"],
    });
  });

  it("claude に無効な値を渡しても、引数は足さない（undefined に戻る）", () => {
    expect(
      paneLaunchCommand("claude", "claude", "bananaXX", lookup),
    ).toBeUndefined();
  });

  it("他の CLI は従来どおり常にコマンドを渡す", () => {
    expect(paneLaunchCommand("shell", "codex", undefined, lookup)).toEqual({
      program: "codex",
      args: [],
    });
    expect(paneLaunchCommand("shell", "goose", undefined, lookup)).toEqual({
      program: "goose",
      args: ["session"],
    });
    expect(paneLaunchCommand("shell", "codex", "high", lookup)).toEqual({
      program: "codex",
      args: ["-c", "model_reasoning_effort=high"],
    });
  });

  it("素のシェル（cliId なし）は undefined", () => {
    expect(paneLaunchCommand("shell", undefined, undefined, lookup)).toBeUndefined();
  });

  it("カタログに無い CLI は undefined（存在しないプログラムを起動しない）", () => {
    expect(paneLaunchCommand("shell", "ghost", undefined, lookup)).toBeUndefined();
  });
});

describe("showsDefaultEffortBadge（おまかせの薄い表示）", () => {
  it("既定のまま開いた claude ペインでは出す（cliId が無くても kind で補う）", () => {
    expect(showsDefaultEffortBadge({ kind: "claude" })).toBe(true);
    expect(showsDefaultEffortBadge({ kind: "claude", cliId: "claude" })).toBe(
      true,
    );
  });

  it("深さを指定して開いたペインでは出さない（本物のバッジが出るため）", () => {
    expect(
      showsDefaultEffortBadge({ kind: "claude", cliId: "claude", effort: "high" }),
    ).toBe(false);
  });

  it("素のシェルには出さない（エフォートという概念が無い）", () => {
    expect(showsDefaultEffortBadge({ kind: "shell" })).toBe(false);
    expect(showsDefaultEffortBadge({ kind: "shell", cliId: undefined })).toBe(
      false,
    );
  });

  it("エフォート非対応の CLI には出さない（無い機能の話をしない）", () => {
    for (const id of ["gemini", "qwen", "goose"]) {
      expect(showsDefaultEffortBadge({ kind: "shell", cliId: id })).toBe(false);
    }
  });

  it("claude 以外の AI CLI は kind:\"shell\" で開かれるが、それでも出す", () => {
    // 🚨 実装の実体（TerminalPanes.handleSplitCli）: claude だけ kind:"claude"、
    // codex / grok / kimi は kind:"shell" + cliId で開く。
    // kind で弾く実装にすると、この 3 つだけバッジが消える。
    for (const id of ["codex", "grok", "kimi"]) {
      expect(showsDefaultEffortBadge({ kind: "shell", cliId: id })).toBe(true);
    }
  });

  it("remote-control（Claude リモートコントロール）には出さない", () => {
    expect(showsDefaultEffortBadge({ kind: "remote-control" })).toBe(false);
  });

  it("空文字の effort は「指定なし」として扱う", () => {
    expect(
      showsDefaultEffortBadge({ kind: "claude", cliId: "claude", effort: "" }),
    ).toBe(true);
  });
});
