#!/usr/bin/env node
/**
 * 配布ビルド（out/）の JS が「古い macOS の WKWebView（Safari 14〜16.3 相当）」で読めるかを検査する。
 *
 * なぜ要るか（2026-10-13 実測）:
 *   macOS 12.7.6 の Mac で UNICREW を開くと、画面は出るのにボタンが一切効かなかった。
 *   起動時に読む JS に Safari 16.4 未満では「構文エラー」になる書き方が入っていたため、
 *   ファイルごと読み込みに失敗し、静的に書き出された HTML だけが表示されていた。
 *     - Next.js 本体の chunk に class の static ブロック（Safari 16.4〜）
 *     - remark-gfm（mdast-util-gfm-autolink-literal）の正規表現の後読み (?<=…)（Safari 16.4〜）
 *   Windows（WebView2＝最新 Chromium）では再現しないので、手元の動作確認では気づけない。
 *
 * 判定（3値）:
 *   OK      … 全 JS が ES2021 として構文解析でき、起動時に読む JS に後読みが無い
 *   NG      … 上のどちらかを満たさない（ファイル名と位置を出す）
 *   判定不能 … out/ が無い・index.html から起動時の JS が1本も拾えない
 *
 * 使い方:
 *   node scripts/verify_webkit_compat.mjs            # out/ を検査（先に UNICREW_TAURI=1 next build が要る）
 *   node scripts/verify_webkit_compat.mjs <outDir>
 *   node scripts/verify_webkit_compat.mjs --selftest # 毒味（わざと壊したビルドで NG が出るか）
 * 終了コード: OK=0 / NG=1 / 判定不能=2
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import { parse as parseHtml } from "parse5";

// Safari 14 が読める構文の上限。ES2022（class fields / static ブロック / #x in obj）は Safari 14.0 では読めない。
const ECMA_VERSION = 2021;
const LOOKBEHIND = /\(\?<[=!]/;
// 後読みを許すのは remark-gfm（mdast-util-gfm-autolink-literal）の chunk だけ（目印で特定する）。
// 🚨 この検査は「その chunk が起動直後に無条件で読まれていないか」までは追えない。
//    読み込み元が lib/remark-plugins.ts（後読み対応を確かめてから import する）だけであることは
//    tests/markdown-old-webkit.test.tsx がソースで守っている（2026-10-13 監査の指摘）。
const GFM_MARKER = "literalAutolinkEmail";

function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// 起動時の JS ＝ out/ 配下の全 HTML（index / editor / preview / 404 …）が <script> で読むもの。
// index.html だけを見ると、別ウィンドウ（エディタ・プレビュー）だけが読む chunk を見落とす。
function listHtml(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== "_next") out.push(...listHtml(p));
    } else if (ent.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// HTML の仕様で「JavaScript として実行される」type（大文字小文字・前後の空白は無視）。
// 無い・空なら JavaScript。"module" はモジュールとして実行。それ以外（JSON 等）は実行されない。
const JS_MIME = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript",
]);

// parse5 の木から script 要素を集める（<template> の中身は実行されないので入らない）
// 属性は名前空間なしのものだけを見る（SVG の xlink:type を type と取り違えない）。
// 外部参照は HTML の script＝src、SVG の script＝href / xlink:href（parse5 は文字参照を復号済み）
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
function scriptElements(node, out = []) {
  if (node.nodeName === "script") {
    const plain = new Map((node.attrs || []).filter((a) => !a.namespace).map((a) => [a.name.toLowerCase(), a.value]));
    const xlinkHref = (node.attrs || []).find((a) => a.namespace === XLINK_NS && a.name === "href")?.value;
    const isSvg = node.namespaceURI === SVG_NS;
    const ref = isSvg ? (plain.get("href") ?? xlinkHref ?? null) : (plain.get("src") ?? null);
    const text = (node.childNodes || []).filter((c) => c.nodeName === "#text").map((c) => c.value).join("");
    out.push({ getAttribute: (n) => (plain.has(n) ? plain.get(n) : null), ref, text });
  }
  for (const c of node.childNodes || []) scriptElements(c, out);
  return out;
}

// 外部 script の参照先を、実際に読まれるパス（クエリ・フラグメントを除いた pathname）で判定する。
// 同じアプリ内の /_next/static/**.js だけを返し、それ以外（別オリジン・別の場所）は null＝検査できない
function localNextChunk(ref) {
  let u;
  try {
    u = new URL(ref, "http://unicrew.local/");
  } catch {
    return null;
  }
  if (u.origin !== "http://unicrew.local") return null;
  let p;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  return /^\/_next\/static\/.+\.js$/.test(p) ? path.normalize(p.slice(1)) : null;
}

function scriptKind(el) {
  const raw = el.getAttribute("type");
  if (raw === null || raw.trim() === "") return "script";
  const t = raw.trim().toLowerCase();
  if (t === "module") return "module";
  return JS_MIME.has(t) ? "script" : null;
}

function startupScripts(outDir) {
  if (!fs.existsSync(path.join(outDir, "index.html"))) return null;
  const set = new Set();
  const inline = [];
  const unknown = []; // _next/static 以外を指す外部 script（中身を検査できない）
  for (const html of listHtml(outDir)) {
    const src = fs.readFileSync(html, "utf-8");
    // preload 等も含めて広めに拾う（起動時扱いを広げる側に倒す＝偽の OK を出さない）
    for (const m of src.matchAll(/["'(]\/?(_next\/static\/[^"')\s]+\.js)/g)) set.add(path.normalize(m[1]));
    // script 要素は HTML パーサで読む（正規表現では data-src・終了タグの空白・属性中の > を取り違える）。
    // 実際のアプリは JavaScript 有効なので scriptingEnabled: true で読む（<noscript> の解釈が変わる）
    for (const el of scriptElements(parseHtml(src, { scriptingEnabled: true }))) {
      const kind = scriptKind(el);
      if (!kind) continue;
      if (el.ref !== null) {
        const rel = localNextChunk(el.ref);
        if (rel) set.add(rel);
        else unknown.push(`${path.relative(outDir, html)}: ${el.ref}`);
        continue;
      }
      const code = el.text;
      if (!code.trim()) continue;
      inline.push({ page: path.relative(outDir, html), code, module: kind === "module" });
    }
  }
  return { files: set, inline, unknown };
}

function checkFile(file) {
  return checkCode(fs.readFileSync(file, "utf-8"));
}

function checkCode(code, sourceType = "script") {
  const problems = [];
  let lookbehind = false;
  try {
    acorn.parse(code, {
      ecmaVersion: ECMA_VERSION,
      sourceType,
      allowHashBang: true,
      onToken(tok) {
        if (tok.type === acorn.tokTypes.regexp && LOOKBEHIND.test(tok.value.pattern)) lookbehind = true;
      },
    });
  } catch (e) {
    problems.push(`ES${ECMA_VERSION} として読めない: ${e.message}`);
  }
  // 構文エラーで止まった場合でも後読みは拾っておく（原因の特定用）
  if (!lookbehind && LOOKBEHIND.test(code)) {
    for (const t of tryTokens(code)) if (LOOKBEHIND.test(t)) lookbehind = true;
  }
  return { problems, lookbehind, isGfm: code.includes(GFM_MARKER) };
}

function* tryTokens(code) {
  try {
    for (const tok of acorn.tokenizer(code, { ecmaVersion: "latest" })) {
      if (tok.type === acorn.tokTypes.regexp) yield tok.value.pattern;
    }
  } catch {
    /* 解析不能なら諦める（NG は構文側で出ている） */
  }
}

export function verify(outDir) {
  const staticDir = path.join(outDir, "_next", "static");
  if (!fs.existsSync(staticDir)) return { verdict: "判定不能", lines: [`${staticDir} が無い（先にビルドする）`] };
  const found = startupScripts(outDir);
  if (!found || found.files.size === 0) return { verdict: "判定不能", lines: ["index.html から起動時の JS を拾えない"] };
  const startup = found.files;

  const lines = [];
  let ng = false;
  const files = listJs(staticDir);
  for (const f of files) {
    const rel = path.normalize(path.relative(outDir, f));
    const isStartup = startup.has(rel);
    const { problems, lookbehind, isGfm } = checkFile(f);
    for (const p of problems) {
      ng = true;
      lines.push(`NG ${rel}${isStartup ? "（起動時）" : ""}: ${p}`);
    }
    if (lookbehind) {
      if (isStartup) {
        ng = true;
        lines.push(`NG ${rel}（起動時）: 正規表現の後読み (?<=…) がある＝Safari 16.4 未満で画面全体が動かなくなる`);
      } else if (isGfm) {
        lines.push(`注意 ${rel}: 後読みあり（remark-gfm の chunk。lib/remark-plugins.ts が後読み対応を確かめてから読む）`);
      } else {
        ng = true;
        lines.push(`NG ${rel}: remark-gfm 以外の JS に後読みがある＝読み込まれる経路を確かめられない（起動直後に読まれると画面全体が動かなくなる）`);
      }
    }
  }
  for (const { page, code, module } of found.inline) {
    const { problems, lookbehind } = checkCode(code, module ? "module" : "script");
    for (const p of problems) {
      ng = true;
      lines.push(`NG ${page} の埋め込みスクリプト（起動時）: ${p}`);
    }
    if (lookbehind) {
      ng = true;
      lines.push(`NG ${page} の埋め込みスクリプト（起動時）: 正規表現の後読み (?<=…) がある`);
    }
  }
  for (const u of found.unknown) lines.push(`判定不能 検査できない外部 script: ${u}`);
  const missing = [...startup].filter((r) => !fs.existsSync(path.join(outDir, r)));
  if (missing.length) {
    ng = true;
    lines.push(`NG index.html が参照する JS が無い: ${missing.join(", ")}`);
  }
  lines.unshift(`JS ${files.length} 本（起動時 ${startup.size} 本）＋埋め込みスクリプト ${found.inline.length} 個を ES${ECMA_VERSION} で検査`);
  return { verdict: ng ? "NG" : found.unknown.length ? "判定不能" : "OK", lines };
}

function selftest() {
  const parent = process.env.UNICREW_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const base = fs.mkdtempSync(path.join(parent, "webkit-compat-selftest-"));
  const make = (name, startupJs, lazyJs = "") => {
    const dir = path.join(base, name);
    fs.mkdirSync(path.join(dir, "_next", "static", "chunks"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), `<script src="/_next/static/chunks/a.js"></script>`);
    fs.writeFileSync(path.join(dir, "_next", "static", "chunks", "a.js"), startupJs);
    if (lazyJs) fs.writeFileSync(path.join(dir, "_next", "static", "chunks", "lazy.js"), lazyJs);
    return dir;
  };
  const cases = [
    ["正常", make("ok", "var a=1;a??=2;"), "OK"],
    ["static ブロック", make("static", "class A{static{this.x=1}}"), "NG"],
    ["class fields", make("fields", "class A{x=1}"), "NG"],
    ["起動時の後読み", make("lb", "var r=/(?<=a)b/u;"), "NG"],
    ["後から読む GFM の後読み", make("lazy", "var a=1;", "var k=\"literalAutolinkEmail\";var r=/(?<=a)b/u;"), "OK"],
    ["由来不明の後から読む後読み", make("lazy2", "var a=1;", "var r=/(?<=a)b/u;"), "NG"],
    ["別ページだけが読む後読み", (() => {
      const dir = make("subpage", "var a=1;", "var r=/(?<=a)b/u;");
      fs.writeFileSync(path.join(dir, "editor.html"), `<script src="/_next/static/chunks/lazy.js"></script>`);
      return dir;
    })(), "NG"],
    ["埋め込みスクリプトの static ブロック", (() => {
      const dir = make("inline", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), "<script>class App{static{window.x=1}}</script>");
      return dir;
    })(), "NG"],
    ["別ページの埋め込みスクリプトの後読み", (() => {
      const dir = make("inline2", "var a=1;");
      fs.writeFileSync(path.join(dir, "editor.html"), "<script>window.r=/(?<=a)b/u;</script>");
      return dir;
    })(), "NG"],
    ["type=text/ecmascript の埋め込みも対象", (() => {
      const dir = make("ecma", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<script type="text/ecmascript">window.r=/(?<=a)b/u;</script>');
      return dir;
    })(), "NG"],
    ["data-src は src ではない", (() => {
      const dir = make("datasrc", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<script data-src="guard">window.r=/(?<=a)b/u;</script>');
      return dir;
    })(), "NG"],
    ["終了タグに空白がある埋め込み", (() => {
      const dir = make("endtag", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), "<script>window.r=/(?<=a)b/u;</script >");
      return dir;
    })(), "NG"],
    ["属性の中の > で偽の NG にしない", (() => {
      const dir = make("gt", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<script data-note="a > b">window.x=1;</script>');
      return dir;
    })(), "OK"],
    ["noscript の解釈（JavaScript 有効時に実行される script）", (() => {
      const dir = make("noscript", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<noscript><div title="</noscript><script>class App{static{window.x=1}}</script>"></div></noscript>');
      return dir;
    })(), "NG"],
    ["SVG の xlink:type を type と取り違えない", (() => {
      const dir = make("svgtype", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<svg><script xlink:type="simple">class App{static{window.x=1}}</script></svg>');
      return dir;
    })(), "NG"],
    ["SVG の href（文字参照入り）で起動時に読む JS", (() => {
      const dir = make("svghref", "var a=1;", 'var k="literalAutolinkEmail";var r=/(?<=a)b/u;');
      fs.appendFileSync(path.join(dir, "index.html"), '<svg><script href="/&#95;next/static/chunks/lazy.js"></script></svg>');
      return dir;
    })(), "NG"],
    ["フラグメントに _next/static を書いても実際のパスで判定", (() => {
      const dir = make("frag", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<script src="/vendor.js#/_next/static/chunks/a.js"></script>');
      return dir;
    })(), "判定不能"],
    ["別オリジンの _next/static は判定不能", (() => {
      const dir = make("origin", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<script src="https://example.com/_next/static/chunks/a.js"></script>');
      return dir;
    })(), "判定不能"],
    ["_next/static 以外の外部 script は判定不能", (() => {
      const dir = make("otherjs", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<script src="/vendor/x.js"></script>');
      return dir;
    })(), "判定不能"],
    ["実行されない JSON の script は対象外", (() => {
      const dir = make("json", "var a=1;");
      fs.appendFileSync(path.join(dir, "index.html"), '<script type="application/json">{"a":"(?<=x)"}</script>');
      return dir;
    })(), "OK"],
    ["out が無い", path.join(base, "none"), "判定不能"],
  ];
  let fail = 0;
  for (const [label, dir, want] of cases) {
    const { verdict } = verify(dir);
    const ok = verdict === want;
    if (!ok) fail++;
    console.log(`${ok ? "PASS" : "FAIL"} ${label}: 期待=${want} 実際=${verdict}`);
  }
  fs.rmSync(base, { recursive: true, force: true });
  console.log(fail ? `毒味 失敗 ${fail} 件` : `毒味 ${cases.length}/${cases.length} PASS`);
  process.exit(fail ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = process.argv[2];
  if (arg === "--selftest") selftest();
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = path.resolve(arg || path.join(repo, "out"));
  const { verdict, lines } = verify(outDir);
  for (const l of lines) console.log(l);
  console.log(`判定: ${verdict}（${outDir}）`);
  process.exit(verdict === "OK" ? 0 : verdict === "NG" ? 1 : 2);
}
