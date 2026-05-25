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
const PATH_TOKEN = /[\p{L}\p{N}_.:（）()【】「」/\\-]+\.[A-Za-z0-9]{1,8}/gu;

export interface PathHit {
  /** 元テキスト中のファイルパス候補（そのまま表示する）。 */
  raw: string;
  /** 拡張子（小文字、ドットなし）。 */
  ext: string;
}

/** 1つのトークンがクリック可能ファイルパスかを判定する。 */
function isClickablePath(token: string): PathHit | null {
  // 末尾が句読点等で削れてないように、念のため後ろの punctuation を剥がす。
  // （ReactMarkdown 経由なら最終形が来るのでここでは控えめに）
  const trimmed = token.replace(/[。、！？!?,;:]+$/, "");
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
  return { raw: trimmed, ext };
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
    if (start > lastEnd) {
      segments.push({ kind: "text", text: text.slice(lastEnd, start) });
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
