import { describe, it, expect } from "vitest";
import {
  packageManagerFrom,
  runScriptCommand,
  parsePackageScripts,
  parseMakefileTargets,
  cargoTasks,
  sortTasks,
} from "./task-runner";

describe("packageManagerFrom", () => {
  it("ロックファイルから判定する", () => {
    expect(packageManagerFrom(["package-lock.json"])).toBe("npm");
    expect(packageManagerFrom(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(packageManagerFrom(["yarn.lock"])).toBe("yarn");
    expect(packageManagerFrom(["bun.lockb"])).toBe("bun");
  });

  it("ロックファイルが無ければ npm に倒す", () => {
    expect(packageManagerFrom([])).toBe("npm");
    expect(packageManagerFrom(["README.md"])).toBe("npm");
  });

  it("複数あるときは特徴的な方を優先する", () => {
    expect(packageManagerFrom(["package-lock.json", "pnpm-lock.yaml"])).toBe(
      "pnpm",
    );
    expect(packageManagerFrom(["yarn.lock", "package-lock.json"])).toBe("yarn");
  });

  it("大文字小文字は無視する", () => {
    expect(packageManagerFrom(["PNPM-LOCK.YAML"])).toBe("pnpm");
  });
});

describe("runScriptCommand", () => {
  it("マネージャごとの書き方になる", () => {
    expect(runScriptCommand("npm", "dev")).toBe("npm run dev");
    expect(runScriptCommand("pnpm", "dev")).toBe("pnpm run dev");
    expect(runScriptCommand("yarn", "dev")).toBe("yarn run dev");
    expect(runScriptCommand("bun", "dev")).toBe("bun run dev");
  });
});

describe("parsePackageScripts", () => {
  const pkg = JSON.stringify({
    name: "x",
    scripts: { dev: "next dev", build: "next build", lint: "eslint ." },
  });

  it("scripts をタスクにする（本文も添える）", () => {
    const tasks = parsePackageScripts(pkg, "npm");
    expect(tasks.map((t) => t.name)).toEqual(["dev", "build", "lint"]);
    expect(tasks[0].command).toBe("npm run dev");
    expect(tasks[0].detail).toBe("next dev");
    expect(tasks[0].source).toBe("package.json");
  });

  it("パッケージマネージャが変わればコマンドも変わる", () => {
    expect(parsePackageScripts(pkg, "pnpm")[0].command).toBe("pnpm run dev");
  });

  it("壊れた JSON・scripts 無しは空（例外を投げない）", () => {
    expect(parsePackageScripts("{ぶっ壊れ", "npm")).toEqual([]);
    expect(parsePackageScripts("null", "npm")).toEqual([]);
    expect(parsePackageScripts("[]", "npm")).toEqual([]);
    expect(parsePackageScripts(JSON.stringify({ name: "x" }), "npm")).toEqual([]);
  });

  it("文字列でない値は無視する（オブジェクト形式の scripts 等）", () => {
    const weird = JSON.stringify({ scripts: { ok: "echo 1", ng: { a: 1 } } });
    expect(parsePackageScripts(weird, "npm").map((t) => t.name)).toEqual(["ok"]);
  });
});

describe("parseMakefileTargets", () => {
  it("ターゲットだけを拾う", () => {
    const mk = [
      "# コメント",
      "CC = gcc",
      "CFLAGS := -O2",
      "",
      "build: deps",
      "\tgcc -o out main.c",
      "test:",
      "\t./out",
      ".PHONY: build test",
      "%.o: %.c",
      "\tgcc -c $<",
    ].join("\n");
    expect(parseMakefileTargets(mk).map((t) => t.name)).toEqual([
      "build",
      "test",
    ]);
  });

  it("変数代入（:=）をターゲットと間違えない", () => {
    expect(parseMakefileTargets("CFLAGS := -O2")).toEqual([]);
  });

  it("レシピ行（タブ始まり）は見ない", () => {
    expect(parseMakefileTargets("\tsomething: not a target")).toEqual([]);
  });

  it("同じターゲットは 1 回だけ", () => {
    expect(parseMakefileTargets("a:\nb:\na:").map((t) => t.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("コマンドは make <target>", () => {
    expect(parseMakefileTargets("deploy:")[0].command).toBe("make deploy");
  });
});

describe("cargoTasks", () => {
  it("[package] があれば定番コマンドを出す", () => {
    const tasks = cargoTasks('[package]\nname = "x"\n');
    expect(tasks.map((t) => t.command)).toEqual([
      "cargo check",
      "cargo test",
      "cargo build",
      "cargo run",
    ]);
  });

  it("[workspace] だけでも出す", () => {
    expect(cargoTasks("[workspace]\nmembers = []").length).toBe(4);
  });

  it("Cargo.toml らしくなければ出さない", () => {
    expect(cargoTasks("これはただのテキスト")).toEqual([]);
  });
});

describe("sortTasks", () => {
  it("よく使うものを上に、それ以外は名前順", () => {
    const t = (name: string) => ({
      name,
      command: name,
      source: "package.json" as const,
    });
    const out = sortTasks([t("zzz"), t("test"), t("aaa"), t("dev")]);
    expect(out.map((x) => x.name)).toEqual(["dev", "test", "aaa", "zzz"]);
  });
});
