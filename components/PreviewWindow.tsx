"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  RefreshCw,
  ExternalLink,
  AlertCircle,
  Folder,
  FolderOpen,
  FileText,
  FileCode2,
  Image as ImageIcon,
  Globe,
  File as FileIcon,
  Copy,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import {
  PREVIEW_NAVIGATE_EVENT,
  loadPreviewSession,
  openExternal,
  type PreviewSession,
} from "@/lib/preview-window";
import {
  isTauri,
  readTextFile,
  readFileBase64,
  revealInFileManager,
  writeClipboardText,
} from "@/lib/tauri";
import { kindOf, type Artifact } from "@/lib/turn-artifacts";

type Target = { url: string } | { file: string } | null;

const IMG = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const HTML = /\.(html?|xhtml)$/i;
const MD = /\.(md|markdown|mdx)$/i;
const TEXT = /\.(txt|text|csv|json|ya?ml|log)$/i;
/** 窓内に出す文章の上限。巨大なログで窓が固まらないように。 */
const MAX_TEXT = 2 * 1024 * 1024;

function mimeFromExt(p: string): string {
  const e = p.toLowerCase();
  if (/\.png$/.test(e)) return "image/png";
  if (/\.jpe?g$/.test(e)) return "image/jpeg";
  if (/\.gif$/.test(e)) return "image/gif";
  if (/\.webp$/.test(e)) return "image/webp";
  if (/\.svg$/.test(e)) return "image/svg+xml";
  if (/\.avif$/.test(e)) return "image/avif";
  if (/\.bmp$/.test(e)) return "image/bmp";
  if (/\.ico$/.test(e)) return "image/x-icon";
  return "application/octet-stream";
}

function targetOf(a: Artifact): Target {
  return a.kind === "web" ? { url: a.target } : { file: a.target };
}

function KindIcon({ kind }: { kind: Artifact["kind"] }) {
  const cls = "shrink-0 text-[var(--color-muted)]";
  if (kind === "web") return <Globe size={13} className={cls} />;
  if (kind === "html") return <FileCode2 size={13} className={cls} />;
  if (kind === "doc") return <FileText size={13} className={cls} />;
  if (kind === "image") return <ImageIcon size={13} className={cls} />;
  return <FileIcon size={13} className={cls} />;
}

/** 作業フォルダの中なら、そこからの相対で短く見せる（Codex の変更一覧と同じ見せ方）。 */
function shortDir(dir: string, workspace: string | null): string {
  if (!workspace || !dir) return dir;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const w = norm(workspace);
  const d = norm(dir);
  if (d === w) return "./";
  if (d.startsWith(`${w}/`)) return `./${dir.replace(/\\/g, "/").slice(w.length + 1)}`;
  return dir;
}

export function PreviewWindow() {
  const sp = useSearchParams();
  const initial: Target = sp.get("url")
    ? { url: sp.get("url") as string }
    : sp.get("file")
      ? { file: sp.get("file") as string }
      : null;
  const initialSession = sp.get("session") ? loadPreviewSession() : null;

  const [session, setSession] = useState<PreviewSession | null>(initialSession);
  const [target, setTarget] = useState<Target>(() => {
    if (initialSession?.selected) {
      const a = initialSession.items.find((x) => x.target === initialSession.selected);
      if (a) return targetOf(a);
    }
    return initial;
  });
  const [html, setHtml] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ text: string; markdown: boolean } | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [sideOpen, setSideOpen] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const objUrlRef = useRef<string | null>(null);

  // ウィンドウ再利用時の遷移イベント（単発のプレビュー or 作業ごとのまとめ）
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const u = await listen<Target | { session: true }>(PREVIEW_NAVIGATE_EVENT, (e) => {
        setError(null);
        setHtml(null);
        setDoc(null);
        setImgUrl(null);
        const p = e.payload;
        if (p && "session" in p) {
          const s = loadPreviewSession();
          setSession(s);
          const a = s?.items.find((x) => x.target === s.selected) ?? s?.items[0];
          setTarget(a ? targetOf(a) : null);
        } else {
          setSession(null);
          setTarget(p as Target);
        }
        // 同一URL/同一パスを再クリックしても確実に作り直す。
        // iframe は src/srcDoc が同値だと React が再読込しないため、
        // key に効く reloadKey を必ず進めて強制リマウントする。
        setReloadKey((k) => k + 1);
      });
      un = u;
    })();
    return () => un?.();
  }, []);

  const loadFile = useCallback(async (file: string) => {
    setError(null);
    setHtml(null);
    setDoc(null);
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = null;
    }
    setImgUrl(null);
    if (!isTauri()) {
      setError("ファイルプレビューは UNICREW アプリ起動時のみ利用できます。");
      return;
    }
    try {
      // editor と同じ自前 Rust コマンドで読む（plugin-fs 直読みはスコープ制限で
      // "forbidden path" になる）。WSL パス(/mnt/d/..)や ~ も Rust 側で正規化される。
      if (HTML.test(file)) {
        const text = await readTextFile(file);
        setHtml(text);
      } else if (IMG.test(file)) {
        const b64 = await readFileBase64(file);
        setImgUrl(`data:${mimeFromExt(file)};base64,${b64}`);
      } else if (MD.test(file) || TEXT.test(file)) {
        // 文章はこの窓で読む（以前は既定アプリへ飛ばしていた）
        const text = await readTextFile(file);
        setDoc({
          text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n…（長いので途中まで表示しています）` : text,
          markdown: MD.test(file),
        });
      } else {
        // それ以外は窓内に出せないので、場所だけ示して既定アプリは押したときだけ開く。
        // 自動で開く経路から来ても勝手に別アプリを立ち上げない。
        setError("このファイルはここでは表示できません。「既定アプリで開く」で開けます。");
      }
    } catch (e) {
      setError(`開けませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    if (target && "file" in target) void loadFile(target.file);
  }, [target, loadFile, reloadKey]);

  useEffect(() => {
    return () => {
      if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    };
  }, []);

  /** 左の一覧：フォルダごとにまとめる（Web ページは先頭に別枠）。 */
  const groups = useMemo(() => {
    const out = new Map<string, Artifact[]>();
    for (const a of session?.items ?? []) {
      const k = a.kind === "web" ? "" : a.dir;
      out.set(k, [...(out.get(k) ?? []), a]);
    }
    return [...out.entries()];
  }, [session]);

  const current =
    target && "url" in target ? target.url : target && "file" in target ? target.file : null;
  const currentDir = current && target && "file" in target
    ? current.slice(0, Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\")))
    : null;

  const onExternal = () => {
    if (current) void openExternal(current);
  };
  const onReload = () => setReloadKey((k) => k + 1);
  const onCopy = async (text: string) => {
    try {
      await writeClipboardText(text);
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    } catch {
      /* noop */
    }
  };
  const onRevealFolder = (path: string) => {
    void revealInFileManager(path).catch(() => openExternal(path));
  };

  const hasSide = (session?.items.length ?? 0) > 0;

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--color-bg)]">
      {/* ツールバー：いま見ているもののフルパス */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
        {hasSide && (
          <button
            onClick={() => setSideOpen((v) => !v)}
            title={sideOpen ? "一覧を隠す" : "作ったものの一覧を出す"}
            className="p-1 rounded hover:bg-[var(--color-bg)] text-[var(--color-muted)]"
          >
            {sideOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
        )}
        <button
          onClick={onReload}
          title="再読み込み"
          className="p-1 rounded hover:bg-[var(--color-bg)] text-[var(--color-muted)]"
        >
          <RefreshCw size={14} />
        </button>
        <span
          className="flex-1 truncate text-[11.5px] font-mono text-[var(--color-muted)]"
          title={current ?? ""}
          data-testid="preview-current-path"
        >
          {current ?? "プレビュー"}
        </span>
        {current && (
          <button
            onClick={() => void onCopy(current)}
            title="パスをコピー"
            className="p-1 rounded hover:bg-[var(--color-bg)] text-[var(--color-muted)]"
          >
            <Copy size={13} />
          </button>
        )}
        {currentDir && (
          <button
            onClick={() => onRevealFolder(current as string)}
            title="フォルダを開く"
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg)]"
          >
            <FolderOpen size={12} />
            フォルダ
          </button>
        )}
        <button
          onClick={onExternal}
          disabled={!current}
          title="ブラウザ / 既定アプリで開く"
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:opacity-40"
        >
          <ExternalLink size={12} />
          {target && "url" in target ? "ブラウザで開く" : "既定アプリで開く"}
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 左：この作業で作った・直したもの（フォルダごと） */}
        {hasSide && sideOpen && (
          <aside
            className="w-72 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] overflow-y-auto"
            data-testid="preview-artifacts"
          >
            <div className="px-3 pt-2.5 pb-1">
              <div className="text-[12px] font-medium text-[var(--color-text)] truncate">
                {session?.title || "この作業で作ったもの"}
              </div>
              {session?.workspace && (
                <button
                  onClick={() => onRevealFolder(session.workspace as string)}
                  className="mt-0.5 flex w-full items-center gap-1 text-left text-[10.5px] font-mono text-[var(--color-muted)] hover:text-[var(--color-text)]"
                  title={`作業フォルダを開く: ${session.workspace}`}
                >
                  <Folder size={11} className="shrink-0" />
                  <span className="truncate">{session.workspace}</span>
                </button>
              )}
              <div className="mt-1 text-[10.5px] text-[var(--color-muted)]">
                {session?.items.length}件を作成・変更
              </div>
            </div>
            {groups.map(([dir, items]) => (
              <div key={dir || "__web"} className="px-1.5 pb-1.5">
                <div
                  className="flex items-center gap-1 px-1.5 pt-1.5 pb-0.5 text-[10.5px] font-mono text-[var(--color-muted)]"
                  title={dir || "開発サーバー"}
                >
                  {dir ? <Folder size={11} className="shrink-0" /> : <Globe size={11} className="shrink-0" />}
                  <span className="truncate">
                    {dir ? shortDir(dir, session?.workspace ?? null) : "開発サーバー"}
                  </span>
                  {dir && (
                    <button
                      onClick={() => onRevealFolder(items[0].target)}
                      className="ml-auto shrink-0 rounded p-0.5 hover:bg-[var(--color-bg)]"
                      title={`このフォルダを開く: ${dir}`}
                    >
                      <FolderOpen size={11} />
                    </button>
                  )}
                </div>
                {items.map((a) => {
                  const active = current === a.target;
                  const viewable = a.kind !== "other" || kindOf(a.target) !== "other";
                  return (
                    <button
                      key={a.target}
                      onClick={() => {
                        setTarget(targetOf(a));
                        setReloadKey((k) => k + 1);
                      }}
                      title={a.target}
                      className={`group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] ${
                        active
                          ? "bg-[var(--color-accent)] text-white"
                          : "text-[var(--color-text)] hover:bg-[var(--color-bg)]"
                      }`}
                    >
                      <KindIcon kind={a.kind} />
                      <span className={`truncate ${viewable ? "" : "opacity-70"}`}>{a.name}</span>
                      {copied === a.target && (
                        <span className="ml-auto text-[10px]">コピー済</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </aside>
        )}

        {/* 本体 */}
        <div className="flex-1 min-w-0 min-h-0 relative bg-white">
          {error ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-[12px] text-[var(--color-muted)] px-6 text-center">
              <AlertCircle size={20} className="text-amber-500" />
              <p>{error}</p>
              {current && <p className="font-mono text-[11px] break-all">{current}</p>}
            </div>
          ) : target && "url" in target ? (
            <iframe
              key={`u-${reloadKey}`}
              src={target.url}
              className="w-full h-full border-0"
              title="preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            />
          ) : html != null ? (
            <iframe
              key={`h-${reloadKey}`}
              srcDoc={html}
              className="w-full h-full border-0"
              title="preview"
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
            />
          ) : doc ? (
            <div className="h-full overflow-auto" data-testid="preview-doc">
              {doc.markdown ? (
                <article className="prose prose-sm max-w-3xl mx-auto px-8 py-6 text-[14px] leading-7 text-neutral-800 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-4 [&_h1]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-6 [&_h2]:mb-2 [&_h3]:font-bold [&_h3]:mt-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_code]:bg-neutral-100 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-neutral-100 [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_blockquote]:border-l-4 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-600 [&_a]:text-blue-600 [&_a]:underline">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.text}</ReactMarkdown>
                </article>
              ) : (
                <pre className="px-6 py-4 text-[12.5px] leading-6 whitespace-pre-wrap break-words font-mono text-neutral-800">
                  {doc.text}
                </pre>
              )}
            </div>
          ) : imgUrl ? (
            <div className="h-full w-full overflow-auto flex items-center justify-center bg-[#1e1e1e]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imgUrl} alt="preview" className="max-w-full max-h-full" />
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[12px] text-[var(--color-muted)]">
              {target ? "読み込み中…" : "左の一覧から選んでください"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
