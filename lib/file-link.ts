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
  "map",
]);

/**
 * テキストエディタではなく OS 既定アプリで開くべき拡張子（PDF・画像・Office等）。
 * リンク判定は CLICKABLE ∪ EXTERNAL の和集合で行い、開く経路だけ分岐する。
 */
const EXTERNAL_EXTENSIONS = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "docx",
  "xlsx",
  "pptx",
  "zip",
  "mp4",
  "mp3",
  "wav",
]);

/** リンク化してよい拡張子か（エディタ用＋外部アプリ用の和集合）。 */
function isLinkableExt(ext: string): boolean {
  return CLICKABLE_EXTENSIONS.has(ext) || EXTERNAL_EXTENSIONS.has(ext);
}

/** このパスは OS 既定アプリで開くべきか（openFileSmart の分岐に使う）。 */
export function isExternalOpenPath(path: string): boolean {
  const m = path.match(/\.([A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?$/);
  return m != null && EXTERNAL_EXTENSIONS.has(m[1].toLowerCase());
}

/** ファイルパスっぽい文字列の正規表現。
 *
 *  - 区切り文字: `/` または `\`
 *  - 文字: 半角英数 + アンダースコア + ハイフン + ドット + 日本語（よくある全角名）
 *  - `:` を含める → Windows ドライブレター `D:` を分断しない
 *  - `（）()【】「」` を含める → `プロジェクト（開発）` 等の日本語フォルダ名を分断しない
 *  - 末尾は `.<拡張子>` で終わる
 *  - 区切り文字を含まない単発の `xxx.md` も拾う
 */
const PATH_TOKEN = /[\p{L}\p{N}_.:+（）()【】「」§※・〜＆＃＠&#@/\\-]+\.[A-Za-z0-9]{1,8}/gu;

/** Windows ドライブレター（例 `D:\` / `C:/`）を表す強いアンカー。 */
const DRIVE_ANCHOR = /[A-Za-z]:[\\/]/;

/**
 * パス候補トークンの先頭にくっついた日本語の地の文を切り離すためのオフセットを返す。
 *
 * 日本語は空白で単語が区切られないため、`お見せしますD:\work\設定メモ.md`
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
  if (!isLinkableExt(ext)) return null;
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
  interface Hit {
    start: number;
    end: number;
    display: string;
    path: string;
  }
  // 1) ドライブレター起点の貪欲展開（「。」「、」空白入り日本語ファイル名対応）を優先
  const hits: Hit[] = findDrivePathMatches(text).map((h) => ({
    start: h.start,
    end: h.end,
    display: h.raw,
    path: h.openPath,
  }));
  // 2) 従来の PATH_TOKEN 検出（相対パス・裸ファイル名）。展開済み範囲と重なるものは捨てる
  PATH_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_TOKEN.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    if (hits.some((h) => start < h.end && end > h.start)) continue;
    const hit = isClickablePath(token);
    if (!hit) continue;
    // ドライブレター手前に地の文があった場合、その分はパス開始位置を後ろにずらす。
    hits.push({
      start: start + hit.offset,
      end,
      display: hit.raw,
      path: hit.raw,
    });
  }
  hits.sort((a, b) => a.start - b.start);
  const segments: TextSegment[] = [];
  let lastEnd = 0;
  for (const h of hits) {
    if (h.start < lastEnd) continue;
    if (h.start > lastEnd) {
      segments.push({ kind: "text", text: text.slice(lastEnd, h.start) });
    }
    segments.push({ kind: "file", text: h.display, path: h.path });
    lastEnd = h.end;
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

/** パス本体1文字（PATH_TOKEN と同クラス、ドライブ展開ウォーク用）。 */
const PATH_BODY_CHAR = /[\p{L}\p{N}_.:+（）()【】「」§※・〜＆＃＠&#@/\\~-]/u;
/**
 * ドライブレター起点の貪欲展開でのみ追加で許す文字。
 * 日本語ファイル名には「。」「、」や空白が普通に入る（例: 運命は変えられる。魂の建築学 習慣.pdf）。
 * 通常の正規表現クラスにこれらを入れると地の文を丸飲みするため、
 * 「D:\ 等の強いアンカーで始まる場合だけ」「最初の有効拡張子まで」に限定して許可する。
 */
const PATH_EXTRA_CHAR = /[、。]/u;

/**
 * ドライブレター（D:\ / C:/）起点のパスを貪欲に検出する。
 *
 * アルゴリズム: アンカーから 1 文字ずつ進み、
 *  - パス構成文字・「。」「、」・単一の空白は取り込む（連続2空白は区切りとみなし打ち切り）
 *  - 「.拡張子(ホワイトリスト内)＋境界」に到達したら**そこで停止**して確定する
 *    （最初の有効拡張子で止まる＝`D:\a.md と D:\b.md` を丸飲みしない）
 *  - 有効拡張子に到達しないまま途切れたら不採用（従来の正規表現パスに委ねる）
 */
export function findDrivePathMatches(line: string): PathMatch[] {
  if (!line) return [];
  const out: PathMatch[] = [];
  const anchorRe = /[A-Za-z]:[\\/]/g;
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(line)) !== null) {
    const start = am.index;
    // 直前が英数字ならスキーム（https:// 等）や識別子の一部なので除外
    const prev = start > 0 ? line[start - 1] : "";
    if (/[A-Za-z0-9]/.test(prev)) continue;
    let i = start + am[0].length;
    let end = -1;
    let spaceRun = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === " ") {
        spaceRun++;
        if (spaceRun >= 2) break; // 連続空白＝カラム区切り/行末パディング
        i++;
        continue;
      }
      // 別のドライブアンカーが始まったら打ち切り（複数パスの併記）
      if (
        i > start + am[0].length &&
        /^[A-Za-z]:[\\/]/.test(line.slice(i, i + 3))
      ) {
        break;
      }
      if (!PATH_BODY_CHAR.test(ch) && !PATH_EXTRA_CHAR.test(ch)) break;
      spaceRun = 0;
      if (ch === ".") {
        const m2 = line
          .slice(i)
          .match(/^\.([A-Za-z0-9]{1,8})(?![A-Za-z0-9])/);
        if (m2 && isLinkableExt(m2[1].toLowerCase())) {
          end = i + m2[0].length;
          break; // 最初の有効拡張子で停止（誤爆防止の要）
        }
      }
      i++;
    }
    if (end < 0) continue;
    const openPath = line.slice(start, end);
    let raw = openPath;
    // :line(:col) サフィックスは表示に含め、開くパスからは除外（従来仕様と同じ）
    const lc = line.slice(end).match(/^:(\d+)(?::\d+)?/);
    if (lc) raw += lc[0];
    out.push({ start, end: start + raw.length, raw, openPath });
    anchorRe.lastIndex = start + raw.length;
  }
  return out;
}

// ドライブ接頭辞 + パス本体（`:` は本体に含めない＝行番号と分離）+ 末尾 :line(:col)
const FILE_PATH_RE =
  /(?:[A-Za-z]:)?[\p{L}\p{N}_.+（）()【】「」§※・〜＆＃＠&#@/\\~-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/gu;

export function findPathMatches(line: string): PathMatch[] {
  if (!line) return [];
  // ドライブレター起点は貪欲展開（「。」「、」空白入りの日本語ファイル名対応）を優先
  const driveHits = findDrivePathMatches(line);
  const out: PathMatch[] = [...driveHits];
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
    if (!isLinkableExt(ext)) continue;
    // バージョン文字列(1.2.3 等)を除外
    if (/^\d+(?:\.\d+)+$/.test(openPath)) continue;
    // ドライブ展開で確定済みの範囲と重なるものは捨てる（二重リンク防止）
    const end = start + token.length;
    if (driveHits.some((h) => start < h.end && end > h.start)) continue;
    out.push({ start, end, raw: token, openPath });
  }
  out.sort((a, b) => a.start - b.start);
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

/* ------------------------------------------------------------------ */
/* チャット（AI発言）描画前の前処理（設計書②-B / ④-A）                  */
/* ------------------------------------------------------------------ */

/** markdown で意味を持つ活性文字（パス内に現れると装飾解釈でノードが分断される）。 */
const MD_ACTIVE = /[\\`*_~[\]]/g;

/** コードフェンス開始/終了行（``` / ~~~）。フェンス内は前処理の対象外。 */
const FENCE_LINE = /^\s{0,3}(?:```|~~~)/;

/** 1行ぶんのプレーンテキスト中のパス範囲だけ markdown 活性文字をエスケープする。 */
function escapeInlineSegment(seg: string): string {
  if (!seg) return seg;
  const hits = findPathMatches(seg);
  if (hits.length === 0) return seg;
  let out = "";
  let last = 0;
  for (const h of hits) {
    out += seg.slice(last, h.start);
    out += seg.slice(h.start, h.end).replace(MD_ACTIVE, (m) => "\\" + m);
    last = h.end;
  }
  return out + seg.slice(last);
}

/**
 * ReactMarkdown に渡す前に、生テキスト中のファイルパス内の markdown 活性文字
 * （`_ * ~ \ [ ]` など）をバックスラッシュエスケープする。
 *
 * 目的: `**D:\...\x.md**` や `file_name.md` のようにパスが装飾記号を含む/挟まれると
 * ReactMarkdown がパスを複数ノード（text + <strong> + text）に分断し、
 * linkifyFilePaths（文字列ノード単位）が全長を1リンクにできない。
 * エスケープすれば CommonMark 上 `\_` は文字 `_` として描画される＝見た目不変のまま
 * パスが単一テキストノードで届く。
 *
 * ガード:
 *  - コードフェンス（``` / ~~~）内はエスケープが文字として見えてしまうため触らない
 *  - インラインコード（`...`）内も触らない（そちらは CodeRenderer 側の linkify が担当）
 */
export function escapeMarkdownInPaths(src: string): string {
  if (!src) return src;
  let inFence = false;
  return src
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // バッククォートで分割し、偶数インデックス（インラインコード外）だけ処理する。
      const parts = line.split("`");
      for (let i = 0; i < parts.length; i += 2) {
        parts[i] = escapeInlineSegment(parts[i]);
      }
      return parts.join("`");
    })
    .join("\n");
}

/** 行末が「パス構成文字」で終わるか（PATH_TOKEN の文字クラスと揃える）。 */
const WRAP_TAIL = /[\p{L}\p{N}_.:+（）()【】「」§※・〜＆＃＠&#@/\\-]$/u;
/** 継続行の先頭（インデント除去後）が「パス構成文字」で始まるか。 */
const WRAP_HEAD = /^[\p{L}\p{N}_.:+（）()【】「」§※・〜＆＃＠&#@／/\\-]/u;
/** リスト・番号付きリストのマーカー（継続行と誤認して接合しない）。 */
const LIST_MARKER = /^(?:[-*+][ \t]|\d+[.)][ \t])/;

/**
 * 折り返し（実改行＋インデント）で分断されたファイルパスを1本に戻す（設計書④-A）。
 *
 * AI応答やツール結果には、端末幅などで物理的に折り返された実改行入りのパスが
 * 混ざることがある。そのままだと segmentText が改行を跨げず複数断片に割れて
 * クリック不可＆コピペに改行が混入する。
 *
 * 誤爆防止（本文の意味的改行は消さない）:
 *  - 「行末がパス構成文字」かつ「次行がインデント空白＋パス構成文字」のときだけ候補にする
 *  - リストマーカー（`- ` `1. ` 等）で始まる次行は接合しない
 *  - コードフェンス内は触らない
 *  - 接合した結果、改行位置を跨ぐ「区切り文字（/ or \）入りのパス」が実際に成立する
 *    改行だけ接合を確定する（findPathMatches で検証）。中間断片に拡張子が無い
 *    多行折り返しに対応するため、候補行を先読みで集めてから一括検証する。
 */
export function unwrapPaths(src: string): string {
  if (!src || !src.includes("\n")) return src;
  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;
  /** 先読みする継続行の上限（暴走防止） */
  const MAX_JOIN_LINES = 8;
  for (let i = 0; i < lines.length; i++) {
    let cur = lines[i];
    if (FENCE_LINE.test(cur)) {
      inFence = !inFence;
      out.push(cur);
      continue;
    }
    if (inFence) {
      out.push(cur);
      continue;
    }
    // 1) 構文条件（インデント＋パス構成文字…）を満たす継続候補行を先読みで集める。
    const rests: string[] = [];
    let acc = cur;
    while (i + 1 + rests.length < lines.length && rests.length < MAX_JOIN_LINES) {
      const next = lines[i + 1 + rests.length];
      if (FENCE_LINE.test(next)) break;
      const m = next.match(/^[ \t]+(.*)$/);
      if (!m) break;
      const rest = m[1];
      if (
        !rest ||
        !WRAP_TAIL.test(acc) ||
        !WRAP_HEAD.test(rest) ||
        LIST_MARKER.test(rest)
      ) {
        break;
      }
      rests.push(rest);
      acc += rest;
    }
    // 2) 一括検証: 各改行位置を「区切り文字入りのパス」が跨ぐ改行だけ、先頭から連続して確定する。
    if (rests.length > 0) {
      const boundaries: number[] = [];
      let off = cur.length;
      for (const r of rests) {
        boundaries.push(off);
        off += r.length;
      }
      const hits = findPathMatches(acc).filter((h) => /[\\/]/.test(h.raw));
      let commit = 0;
      for (const b of boundaries) {
        if (hits.some((h) => h.start < b && h.end > b)) commit++;
        else break;
      }
      if (commit > 0) {
        cur += rests.slice(0, commit).join("");
        i += commit;
      }
    }
    out.push(cur);
  }
  return out.join("\n");
}
