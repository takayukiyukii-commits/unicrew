"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Save, FileText, Plus, AlertCircle } from "lucide-react";
import clsx from "clsx";
import { readTextFile, writeTextFile, isTauri } from "@/lib/tauri";
import { EDITOR_OPEN_TAB_EVENT } from "@/lib/editor-window";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center text-[12px] text-neutral-500">
      エディタ読み込み中…
    </div>
  ),
});

interface Tab {
  /** ファイル絶対パス */
  path: string;
  /** ファイル名（タブ表示用） */
  name: string;
  /** ディスク上のオリジナル内容（保存判定用） */
  original: string;
  /** 現在編集中の内容 */
  content: string;
  /** 言語ID（Monaco 用） */
  language: string;
  /** 読み込み中フラグ */
  loading: boolean;
  /** 読み込み失敗時のエラーメッセージ */
  error: string | null;
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    mdx: "markdown",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    rb: "ruby",
    php: "php",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps1: "powershell",
    sql: "sql",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    xml: "xml",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cc: "cpp",
    cs: "csharp",
  };
  return map[ext] ?? "plaintext";
}

function makeNewTab(path: string): Tab {
  return {
    path,
    name: basename(path),
    original: "",
    content: "",
    language: detectLanguage(path),
    loading: true,
    error: null,
  };
}

export function EditorWindow() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  /** 起動時の URL クエリ ?file= に対する 1 回限りの初期処理フラグ */
  const initialUrlHandled = useRef(false);

  /** 単発のファイル open 処理（既にタブがあれば切り替え、無ければロード） */
  const openPath = useCallback(async (rawPath: string) => {
    if (!rawPath) return;
    setTabs((prev) => {
      if (prev.some((t) => t.path === rawPath)) return prev;
      return [...prev, makeNewTab(rawPath)];
    });
    setActivePath(rawPath);
    if (!isTauri()) {
      // ブラウザ開発時はファイル読めないのでダミー内容を入れる
      setTabs((prev) =>
        prev.map((t) =>
          t.path === rawPath
            ? {
                ...t,
                original: "",
                content: `// browser preview: cannot read ${rawPath}\n`,
                loading: false,
              }
            : t,
        ),
      );
      return;
    }
    try {
      const text = await readTextFile(rawPath);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === rawPath
            ? { ...t, original: text, content: text, loading: false }
            : t,
        ),
      );
    } catch (e) {
      setTabs((prev) =>
        prev.map((t) =>
          t.path === rawPath
            ? {
                ...t,
                loading: false,
                error: e instanceof Error ? e.message : String(e),
              }
            : t,
        ),
      );
    }
  }, []);

  // URL ?file=... から初期タブを開く（ウィンドウ生成時の最初のファイル）
  useEffect(() => {
    if (initialUrlHandled.current) return;
    initialUrlHandled.current = true;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const initial = params.get("file");
    if (initial) {
      void openPath(initial);
    }
  }, [openPath]);

  // メインウィンドウから飛んでくる「タブ追加」イベントを購読
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const fn = await listen<{ path: string }>(
        EDITOR_OPEN_TAB_EVENT,
        (event) => {
          const p = event.payload?.path;
          if (typeof p === "string" && p.length > 0) {
            void openPath(p);
          }
        },
      );
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [openPath]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activePath) ?? null,
    [tabs, activePath],
  );

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== path);
        if (activePath === path) {
          const idx = prev.findIndex((t) => t.path === path);
          const fallback = next[Math.max(0, idx - 1)] ?? next[0] ?? null;
          setActivePath(fallback?.path ?? null);
        }
        return next;
      });
    },
    [activePath],
  );

  const updateContent = useCallback((path: string, value: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.path === path ? { ...t, content: value } : t)),
    );
  }, []);

  const saveActive = useCallback(async () => {
    if (!activeTab) return;
    if (activeTab.loading) return;
    if (activeTab.original === activeTab.content) return;
    if (!isTauri()) {
      alert("ブラウザ開発モードでは保存できません。");
      return;
    }
    try {
      await writeTextFile(activeTab.path, activeTab.content);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === activeTab.path ? { ...t, original: t.content } : t,
        ),
      );
    } catch (e) {
      alert(`保存に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [activeTab]);

  // Ctrl/Cmd+S で保存、Ctrl/Cmd+W でタブ閉じ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        void saveActive();
      } else if (e.key === "w" || e.key === "W") {
        if (activePath) {
          e.preventDefault();
          closeTab(activePath);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveActive, closeTab, activePath]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#1e1e1e] text-neutral-100">
      {/* タブストリップ */}
      <div className="flex items-stretch bg-[#252526] border-b border-black/40 overflow-x-auto unicrew-scroll">
        {tabs.length === 0 && (
          <div className="px-4 py-2 text-[12px] text-neutral-500 flex items-center gap-2">
            <FileText size={12} />
            エクスプローラーからファイルを開いてください
          </div>
        )}
        {tabs.map((t) => {
          const isActive = t.path === activePath;
          const isDirty = t.original !== t.content && !t.loading;
          return (
            <div
              key={t.path}
              className={clsx(
                "group flex items-center gap-1.5 pl-3 pr-1 py-1.5 text-[12px] border-r border-black/40 cursor-pointer select-none",
                isActive
                  ? "bg-[#1e1e1e] text-white"
                  : "bg-[#2d2d2d] text-neutral-400 hover:bg-[#333]",
              )}
              onClick={() => setActivePath(t.path)}
              title={t.path}
            >
              <FileText
                size={12}
                className={clsx(
                  "shrink-0",
                  isActive ? "text-sky-400" : "text-neutral-500",
                )}
              />
              <span className="truncate max-w-[200px]">{t.name}</span>
              {isDirty && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-white/80 ml-0.5"
                  title="未保存"
                />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.path);
                }}
                className={clsx(
                  "ml-1 p-0.5 rounded hover:bg-white/10 transition",
                  isActive
                    ? "opacity-80"
                    : "opacity-0 group-hover:opacity-80",
                )}
                title="タブを閉じる (Ctrl+W)"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* ステータスバー（パス + 保存ボタン） */}
      <div className="flex items-center justify-between gap-2 px-3 py-1 bg-[#181818] border-b border-black/40 text-[11px] text-neutral-400">
        <div className="truncate font-mono">
          {activeTab ? activeTab.path : "—"}
        </div>
        <div className="flex items-center gap-2">
          <span className="opacity-60">{activeTab?.language ?? ""}</span>
          <button
            onClick={() => void saveActive()}
            disabled={
              !activeTab ||
              activeTab.loading ||
              activeTab.original === activeTab.content
            }
            className={clsx(
              "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border",
              activeTab && activeTab.original !== activeTab.content
                ? "border-sky-500 text-sky-300 hover:bg-sky-500/10"
                : "border-neutral-700 text-neutral-600 cursor-not-allowed",
            )}
            title="保存 (Ctrl+S)"
          >
            <Save size={11} />
            保存
          </button>
        </div>
      </div>

      {/* エディタ本体 */}
      <div className="flex-1 min-h-0">
        {!activeTab && (
          <div className="h-full w-full flex flex-col items-center justify-center gap-3 text-neutral-500">
            <Plus size={28} className="opacity-40" />
            <div className="text-[13px]">タブが開かれていません</div>
            <div className="text-[11px] opacity-70">
              UNICREW のエクスプローラーからファイルをクリックすると、ここに新しいタブが追加されます
            </div>
          </div>
        )}
        {activeTab && activeTab.loading && (
          <div className="h-full w-full flex items-center justify-center text-[12px] text-neutral-500">
            読み込み中…
          </div>
        )}
        {activeTab && activeTab.error && (
          <div className="h-full w-full flex items-center justify-center text-[12px] text-red-400">
            <AlertCircle size={14} className="mr-2" />
            読み込み失敗: {activeTab.error}
          </div>
        )}
        {activeTab && !activeTab.loading && !activeTab.error && (
          <MonacoEditor
            key={activeTab.path}
            height="100%"
            theme="vs-dark"
            language={activeTab.language}
            value={activeTab.content}
            onChange={(v) => updateContent(activeTab.path, v ?? "")}
            options={{
              fontSize: 13,
              minimap: { enabled: true },
              wordWrap: "on",
              automaticLayout: true,
              scrollBeyondLastLine: false,
              tabSize: 2,
              renderWhitespace: "selection",
            }}
          />
        )}
      </div>
    </div>
  );
}
