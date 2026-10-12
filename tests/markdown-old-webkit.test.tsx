// 古い macOS（Safari 16.4 未満の WKWebView）でボタンが一切効かなかった不具合の回帰テスト。
// 原因: remark-gfm の正規表現の後読み (?<=…) が起動時の JS に入っていて、古い WebKit では
//       JS ファイルごと構文エラーになり、画面は出るのに React が動いていなかった。
// 修正: remark-gfm は lib/remark-plugins.ts から後で読み込む。後読みが使えない環境では GFM なしで表示。
// 配布物そのものの検査は scripts/verify_webkit_compat.mjs（こちらはロジックの検査）。
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// @ts-expect-error - React 19 act 環境フラグ
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TABLE = "| a | b |\n| - | - |\n| 1 | 2 |";

async function render(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  // 後読み込みの完了そのものを待つ（時間で待つと、全テストを並列で回して混んだときに間に合わない）
  const { loadRemarkPlugins } = await import("@/lib/remark-plugins");
  await act(async () => {
    await loadRemarkPlugins();
    await new Promise((r) => setTimeout(r, 0));
  });
  return { container, root };
}

// remark-gfm の初回の読み込み（変換）は、全テスト並列時に数秒かかることがある
const SLOW = 30_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.innerHTML = "";
});

describe("Markdown（remark-gfm の後読み込み）", () => {
  it("後読みが使える環境では表（GFM）が表示される", async () => {
    const { Markdown } = await import("@/components/Markdown");
    const { container, root } = await render(<Markdown>{TABLE}</Markdown>);
    expect(container.querySelector("table")).not.toBeNull();
    act(() => root.unmount());
  }, SLOW);

  it("後読みが使えない環境でも落ちずに本文を表示する（表は崩れてよい）", async () => {
    const RealRegExp = globalThis.RegExp;
    const FakeRegExp = function (this: unknown, pattern: string | RegExp, flags?: string) {
      if (typeof pattern === "string" && /\(\?<[=!]/.test(pattern)) {
        throw new SyntaxError("Invalid regular expression: invalid group specifier name");
      }
      return new RealRegExp(pattern, flags);
    } as unknown as RegExpConstructor;
    vi.stubGlobal("RegExp", FakeRegExp);
    try {
      const mod = await import("@/lib/remark-plugins");
      expect(mod.supportsRegexLookbehind()).toBe(false);
      expect(await mod.loadRemarkPlugins()).toEqual([]);
    } finally {
      vi.stubGlobal("RegExp", RealRegExp);
    }
    const { Markdown } = await import("@/components/Markdown");
    const { container, root } = await render(<Markdown>{"本文 **太字**"}</Markdown>);
    expect(container.textContent).toContain("本文");
    expect(container.querySelector("strong")).not.toBeNull();
    act(() => root.unmount());
  }, SLOW);

  it("remark-gfm（と GFM の部品）を読むのは lib/remark-plugins.ts だけ（起動時の JS に後読みを戻さない）", () => {
    // scripts/verify_webkit_compat.mjs は remark-gfm の chunk の後読みを「後から読む」として許すので、
    // 「後読み対応を確かめてから読む経路しか無い」ことはこのテストが守る。
    // 正規表現ではコメント付き import(/* x */ "…")・テンプレート文字列・require を見落とすので、構文木で調べる。
    const repo = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    for (const d of ["app", "components", "lib"]) {
      const walk = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(ent.name) && !ent.name.includes(".test.")) {
            const rel = path.relative(repo, p).split(path.sep).join("/");
            if (rel === "lib/remark-plugins.ts") continue;
            for (const spec of runtimeImports(fs.readFileSync(p, "utf-8"), p)) {
              if (isGfmModule(spec) || spec === UNRESOLVED) offenders.push(`${rel}: ${spec}`);
            }
          }
        }
      };
      walk(path.join(repo, d));
    }
    expect(offenders).toEqual([]);
  });

  it("（検査の毒味）抜け道になりやすい書き方を runtimeImports が拾う", () => {
    const src = [
      'void import(/* boot */ "remark-gfm");',
      "void import(`remark-gfm`);",
      'const g = require("mdast-util-gfm-autolink-literal");',
      'export { default } from "micromark-extension-gfm";',
      'import remarkGfm from "remark-gfm";',
      'import type { Options } from "remark-gfm";',
      'import { type Options as A } from "remark-gfm";',
      'export { type Options as B } from "remark-gfm";',
      'void import(("remark-gfm"));',
      'void import("remark-gfm" as string);',
      'void import("remark-" + "gfm");',
      "const name = pick(); void import(name);",
      '(require)("remark-gfm");',
      '(require as typeof require)("remark-gfm");',
    ].join("\n");
    const found = runtimeImports(src, "x.ts").filter((s) => isGfmModule(s) || s === UNRESOLVED);
    expect(found).toEqual([
      "remark-gfm",
      "remark-gfm",
      "mdast-util-gfm-autolink-literal",
      "micromark-extension-gfm",
      "remark-gfm",
      // 型だけの import / export（3つ）は実行時に消えるので拾わない
      "remark-gfm",
      "remark-gfm",
      "remark-gfm",
      UNRESOLVED,
      "remark-gfm",
      "remark-gfm",
    ]);
  });
});

// 中身を決められない動的 import / require（検査できないので違反として扱う）
const UNRESOLVED = "<中身を決められない動的 import>";

// 括弧・型注釈を外す
function unwrap(n: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) {
    n = n.expression;
  }
  return n;
}

// 括弧・型注釈を外し、文字列の連結は計算してモジュール名を決める。決められなければ null
function staticString(n: ts.Node | undefined): string | null {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) {
    return staticString(n.expression);
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = staticString(n.left);
    const r = staticString(n.right);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

// 実行時に読み込むモジュール名を構文木から集める（import type・型だけの指定子・型だけの export は除外）
function runtimeImports(code: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const allTypeOnly = (els: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>) =>
    els.length > 0 && els.every((e) => e.isTypeOnly);
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const typeOnly =
        !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) && allTypeOnly(c.namedBindings.elements)));
      if (!typeOnly) out.push(staticString(n.moduleSpecifier) ?? UNRESOLVED);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const typeOnly = n.isTypeOnly || (!!n.exportClause && ts.isNamedExports(n.exportClause) && allTypeOnly(n.exportClause.elements));
      if (!typeOnly) out.push(staticString(n.moduleSpecifier) ?? UNRESOLVED);
    } else if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const callee = unwrap(n.expression); // (require)(…)・(require as X)(…) も require として扱う
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isImport || isRequire) out.push(staticString(n.arguments[0]) ?? UNRESOLVED);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function isGfmModule(spec: string): boolean {
  return /^(remark-gfm|micromark-extension-gfm[\w-]*|mdast-util-gfm[\w-]*)(\/|$)/.test(spec);
}
