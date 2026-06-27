"use client";

/**
 * AI の応答文に含まれるファイル名／パスを検出して、クリックで別ウィンドウのエディタ
 * （openFileInEditorWindow）で開けるようにするための補助。
 *
 * AI が `NOTE_article_commitment_vision_confidence.md` のような言及をしたら、
 * ユーザーが該当ファイルを Ctrl+Click で即座に開けるようにしたい、という要望に対応する。
 *
 * 方針:
 * - シンプルな正規表現でテキストを区切る（重い NLP は使わない）
 * - 拡張子ホワイトリストで「URL / 文中の英単語」と区別する
 * - 候補が見つかった行は `[ファイル名](unicrew-file://...)` のような markdown リンクに
 *   変換せず、ReactMarkdown 描画後の DOM ノードを差し替える方が安全。
 *   ただし実装単純化のため、ここでは「テキストブロックをセグメント分割して返す」
 *   ユーティリティだけ提供し、描画は呼び出し側で行う。
 */

/** クリック可能と見なすファイル拡張子（小文字）。 */
const CLICKABLE_EXTENSIONS = new Set([
  // ドキュメント
  "md",
  "txt",
  "rst",
  "adoc",
  // コード
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "py",
  "rs",
  "go",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  // 設定
  "env",
  "ini",
  "conf",
  "config",
  // フロント
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  // ログ・データ
  "log",
  "csv",
  "tsv",
  "xml",
]);

/** ファイルパスっぽい文字列の正規表現。
 *
 *  - 区切り文字: `/` または `\`
 *  - 文字: 半角英数 + アンダースコア + ハイフン + ドット + 日本語（よくある全角名）
 *  - `:` を含める → Windows ドライブレター `D:` を分断しない
 *  - `（）()【】「」` を含める → `CDO（技術責任者）` 等の日本語フォルダ名を分断しない
 *  - 末尾は `.<拡張子>` で終わる
 *  - 区切り文字を含まない単発の `xxx.md` も拾う
 */
const PATH_TOKEN = /[\p{L}\p{N}_.:（）()【】「」§※・〜＆＃＠&#@/\\-]+\.[A-Za-z0-9]{1,8}/gu;

/** Windows ドライブレター（例 `D:\` / `C:/`）を表す強いアンカー。 */
const DRIVE_ANCHOR = /[A-Za-z]:[\\/]/;

/**
 * パス候補トークンの先頭にくっついた日本語の地の文を切り離すためのオフセットを返す。
 *
 * 日本語は空白で単語が区切られないため、`お見せしますD:\secrets\APIキー一覧.md`
 * のように地の文とパスが直結すると、`\p{L}`（日本語を含む全 Unicode 文字）を許す
 * PATH 正規表現が地の文まで貪欲に飲み込み、クリック可能領域がパスではなく手前の
 * 日本語に乗ってしまう（= パス上をクリックしても反応せず、手前の文がクリック領域に
 * なる不具合）。ドライブレターが見つかったら、そこをパスの開始位置とみなす。
 *
 * 返り値: トークン内のパス開始オフセット（ドライブレターが先頭になければ 0）。
 */
export function pathStartOffset(token: string): number {
  const idx = token.search(DRIVE_ANCHOR);
  return idx > 0 ? idx : 0;
}

export interface PathHit {
  /** 元テキスト中のファイルパス候補（そのまま表示する）。 */
  raw: string;
  /** 拡張子（小文字、ドットなし）。 */
  ext: string;
  /** 元トークン内でのパス開始オフセット（先頭の地の文を切り離した分）。 */
  offset: number;
}

/** 1つのトークンがクリック可能ファイルパスかを判定する。 */
function isClickablePath(token: string): PathHit | null {
  // ドライブレター（D:\ 等）が途中に出てきたら、その手前の日本語地の文を切り離す。
  const offset = pathStartOffset(token);
  const body = offset > 0 ? token.slice(offset) : token;
  // 末尾が句読点等で削れてないように、念のため後ろの punctuation を剥がす。
  // （ReactMarkdown 経由なら最終形が来るのでここでは控えめに）
  const trimmed = body.replace(/[。、！？!?,;:]+$/, "");
  // URL 風（http/https/file://）は除外。リンクとして markdown 側が処理する。
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(trimmed)) return null;
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0 || dot === trimmed.length - 1) return null;
  const ext = trimmed.slice(dot + 1).toLowerCase();
  if (!CLICKABLE_EXTENSIONS.has(ext)) return null;
  // 拡張子だけ（`.md` 等）はスキップ
  if (dot === 0) return null;
  // バージョン文字列っぽいやつ（4.7、1.2.3 等）は除外
  if (/^\d+(?:\.\d+)+$/.test(trimmed)) return null;
  return { raw: trimmed, ext, offset };
}

export interface TextSegment {
  kind: "text" | "file";
  text: string;
  /** kind === "file" の時だけセット。Ctrl+Click で開く対象。 */
  path?: string;
}

/**
 * テキストを「通常テキスト」と「ファイルパス候補」のセグメントに分割する。
 * file セグメントは元のトークン文字列をそのまま表示用テキストに残す（後置きの句読点等は
 * 周辺の text 側に分離される）。
 */
export function segmentText(text: string): TextSegment[] {
  if (!text) return [];
  const segments: TextSegment[] = [];
  let lastEnd = 0;
  PATH_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_TOKEN.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    const hit = isClickablePath(token);
    if (!hit) continue;
    // ドライブレター手前に地の文があった場合、その分はパス開始位置を後ろにずらす。
    const fileStart = start + hit.offset;
    if (fileStart > lastEnd) {
      segments.push({ kind: "text", text: text.slice(lastEnd, fileStart) });
    }
    segments.push({ kind: "file", text: hit.raw, path: hit.raw });
    lastEnd = end;
  }
  if (lastEnd < text.length) {
    segments.push({ kind: "text", text: text.slice(lastEnd) });
  }
  if (segments.length === 0) {
    return [{ kind: "text", text }];
  }
  return segments;
}

/**
 * ファイルパスを workspace 基準で絶対パスに解決する。
 * 既に絶対っぽい（Windows: ドライブレター付き、または `\` で始まる / Unix: `/` で始まる）なら
 * そのまま返す。相対なら workspace と join する。
 */
export function resolveFilePath(
  raw: string,
  workspace: string | null | undefined,
): string {
  if (!raw) return raw;
  const isAbsWin = /^[A-Za-z]:[\\/]/.test(raw);
  const isAbsUnix = raw.startsWith("/") || raw.startsWith("\\");
  // `~` / `~/` / `~\` 始まりはホームディレクトリ基準。workspace を前置きせず
  // そのまま渡し、Rust 側 expand_user_path() でホーム展開させる。
  const isHome = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\");
  if (isAbsWin || isAbsUnix || isHome) return raw;
  if (!workspace) return raw;
  // workspace の末尾区切りを揃える
  const wsClean = workspace.replace(/[\\/]+$/, "");
  // workspace に \ が含まれていれば Windows 形式、なければ Unix
  const sep = wsClean.includes("\\") ? "\\" : "/";
  return `${wsClean}${sep}${raw.replace(/^[.][\\/]+/, "")}`;
}


/**
 * ターミナル1行から「クリック可能なファイルパス候補」を行内インデックス付きで抽出する。
 * xterm の registerLinkProvider 用。`path:line:col` の行/桁サフィックスや
 * Windows ドライブ(C:\...)、`~/...`、相対パスに対応。URL は除外。
 */
export interface PathMatch {
  /** 行内 0-based 開始インデックス */
  start: number;
  /** 行内 0-based 終了インデックス（exclusive、:line:col を含む） */
  end: number;
  /** 表示用の元トークン（:line:col 含む） */
  raw: string;
  /** 実際に開くパス（:line:col を除いた本体） */
  openPath: string;
}

// ドライブ接頭辞 + パス本体（`:` は本体に含めない＝行番号と分離）+ 末尾 :line(:col)
const FILE_PATH_RE =
  /(?:[A-Za-z]:)?[\p{L}\p{N}_.（）()【】「」§※・〜＆＃＠&#@/\\~-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/gu;

export function findPathMatches(line: string): PathMatch[] {
  if (!line) return [];
  const out: PathMatch[] = [];
  FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(line)) !== null) {
    let token = m[0];
    let start = m.index;
    if (token.length === 0) {
      FILE_PATH_RE.lastIndex++;
      continue;
    }
    // ドライブレター（D:\ 等）が途中に出てきたら、その手前の日本語地の文を切り離す。
    // （会話文と同様、日本語直結でクリック領域がパス手前にずれる不具合の防止）
    const offset = pathStartOffset(token);
    if (offset > 0) {
      token = token.slice(offset);
      start += offset;
    }
    // 直前が / または : の場合は URL や連続トークンの途中とみなしスキップ
    const prev = start > 0 ? line[start - 1] : "";
    if (prev === "/" || prev === ":") continue;
    // :line(:col) を分離
    const lc = token.match(/:(\d+)(?::\d+)?$/);
    const openPath = lc ? token.slice(0, token.length - lc[0].length) : token;
    // URL は除外
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(openPath)) continue;
    const dot = openPath.lastIndexOf(".");
    if (dot <= 0) continue;
    const ext = openPath.slice(dot + 1).toLowerCase();
    if (!CLICKABLE_EXTENSIONS.has(ext)) continue;
    // バージョン文字列(1.2.3 等)を除外
    if (/^\d+(?:\.\d+)+$/.test(openPath)) continue;
    out.push({ start, end: start + token.length, raw: token, openPath });
  }
  return out;
}

/**
 * ターミナル1行から URL（http / https）を行内インデックス付きで抽出する。
 * xterm の registerLinkProvider 用。Ctrl/Cmd+Click で OS 既定ブラウザに渡す想定。
 *
 * 仕様:
 * - 対象スキーム: http:// / https:// のみ（file://・data: 等はターミナルからは開かない）
 * - 末尾の文末記号 ( `.` `,` `;` `:` `!` `?` `)` `]` `>` `}` `'` `"` ` ` )
 *   は URL から剥がす（「…説明文 https://example.com.」の末尾ピリオド誤吸収を防ぐ）
 * - ただし URL 内に対応する `(` がある場合は閉じ括弧をペアとして残す
 *   （Wikipedia の `https://ja.wikipedia.org/wiki/foo_(bar)` 等のため）
 */
export interface UrlMatch {
  /** 行内 0-based 開始インデックス */
  start: number;
  /** 行内 0-based 終了インデックス（exclusive） */
  end: number;
  /** 表示用の元トークン（末尾整形後と一致） */
  raw: string;
  /** OS 既定ブラウザに渡す URL */
  url: string;
}

// 行内の http(s) URL ざっくり抽出（後段で末尾整形）。スペース/制御文字/角括弧等で終了。
const URL_RE = /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]　]+/gi;

const URL_TRAIL_PUNCT = /[.,;:!?）)\]>}'"`、。」』]+$/u;

export function findUrlMatches(line: string): UrlMatch[] {
  if (!line) return [];
  const out: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(line)) !== null) {
    const start = m.index;
    let token = m[0];
    if (!token) continue;
    // 末尾の文末記号を剥がす。ただし () がペアで閉じてるなら最後の `)` は残す。
    // 例: https://ja.wikipedia.org/wiki/foo_(bar) はそのまま、
    //     https://example.com) は `)` を剥がす。
    // ループで一文字ずつ判定（コーナーケースが少ないので素朴に）。
    let trimmed = true;
    while (trimmed) {
      trimmed = false;
      const last = token[token.length - 1];
      if (!last) break;
      if (URL_TRAIL_PUNCT.test(last)) {
        if (last === ")") {
          const opens = (token.match(/\(/g) || []).length;
          const closes = (token.match(/\)/g) || []).length;
          // 開きより閉じが多いときだけ余分な閉じを剥がす
          if (closes > opens) {
            token = token.slice(0, -1);
            trimmed = true;
          }
        } else {
          token = token.slice(0, -1);
          trimmed = true;
        }
      }
    }
    if (token.length < "https://a".length) continue; // 短すぎる残骸を捨てる
    out.push({ start, end: start + token.length, raw: token, url: token });
  }
  return out;
}
