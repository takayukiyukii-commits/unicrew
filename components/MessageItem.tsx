"use client";

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, LifeBuoy, Play } from "lucide-react";
import type { Character, Message, MessageStats } from "@/lib/types";
import { ToolUseBubble } from "./ToolUseBubble";
import { CharacterAvatar } from "./CharacterAvatar";
import { UserAvatar } from "./UserAvatar";
import { formatElapsed, formatThinking, formatTokens } from "@/lib/format";
import { resolveFilePath, segmentText } from "@/lib/file-link";
import { openFileInEditorWindow } from "@/lib/editor-window";
import clsx from "clsx";

interface Props {
  message: Message;
  character: Character | undefined;
  onExecute?: (command: string, lang: string) => void;
  /**
   * アイデア10: エラー文言検知時に表示する「AIに助けてもらう」ボタンの押下ハンドラ。
   * エラー本文を渡し、page.tsx 側で対処プロンプトに整形して送り直す。
   */
  onSosForError?: (errorText: string) => void;
  /**
   * AI が応答内で言及したファイル名（NOTE_xxx.md など）を Ctrl+Click で
   * 別ウィンドウのエディタに開けるようにするための workspace 基準パス。
   * 未指定でも動作するが、相対ファイル名の絶対化はできない。
   */
  workspace?: string | null;
  /**
   * 「あなた」アバターの設定。AppSettings から流し込む。
   * 未指定なら従来通り黒丸 + "あ"。
   */
  userProfile?: {
    displayName?: string;
    avatarPath?: string | null;
    emoji?: string;
    accentColor?: string;
  };
}

const ERROR_PATTERNS = ["**エラー**", "**起動エラー**"];

function looksLikeError(content: string): boolean {
  const t = content.trim();
  return ERROR_PATTERNS.some((p) => t.startsWith(p));
}

const EXECUTABLE_LANGS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "powershell",
  "pwsh",
  "cmd",
  "console",
  "terminal",
]);

export function MessageItem({
  message,
  character,
  onExecute,
  onSosForError,
  workspace,
  userProfile,
}: Props) {
  const isUser = message.role === "user";
  const showSos = !isUser && onSosForError && looksLikeError(message.content);
  // ReactMarkdown は markdown ASTを `<p>`, `<li>`, `<strong>` ... と HTML 要素に近い
  // タグでレンダリングする。これらの中身（children）には plain text のノードが混在する。
  // text ノードを「ファイル名 / 通常テキスト」に分割し、ファイル名だけをクリッカブルに
  // 差し替える共通レンダラを用意し、ブロック要素ごとに適用する。
  const linkify = (children: React.ReactNode): React.ReactNode =>
    isUser ? children : linkifyFilePaths(children, workspace ?? null);
  const renderers = {
    code: (props: {
      inline?: boolean;
      className?: string;
      children?: React.ReactNode;
    }) => (
      <CodeRenderer
        inline={props.inline}
        className={props.className}
        onExecute={isUser ? undefined : onExecute}
      >
        {props.children}
      </CodeRenderer>
    ),
    p: (props: { children?: React.ReactNode }) => (
      <p>{linkify(props.children)}</p>
    ),
    li: (props: { children?: React.ReactNode }) => (
      <li>{linkify(props.children)}</li>
    ),
    strong: (props: { children?: React.ReactNode }) => (
      <strong>{linkify(props.children)}</strong>
    ),
    em: (props: { children?: React.ReactNode }) => (
      <em>{linkify(props.children)}</em>
    ),
  };

  return (
    <div
      className={clsx(
        "flex gap-3 px-6 py-4",
        isUser ? "" : "bg-[var(--color-surface)]/60",
      )}
    >
      {isUser ? (
        <UserAvatar
          avatarPath={userProfile?.avatarPath ?? null}
          emoji={userProfile?.emoji}
          accentColor={userProfile?.accentColor}
          fallbackText={userProfile?.displayName?.trim().charAt(0) || "あ"}
          title={userProfile?.displayName?.trim() || "あなた"}
          size={36}
        />
      ) : (
        <CharacterAvatar character={character} size={36} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold">
            {isUser
              ? userProfile?.displayName?.trim() || "あなた"
              : character?.name ?? "Claude"}
          </span>
          {!isUser && character && (
            <span className="text-[11px] text-[var(--color-muted)]">
              {character.roleTag}
            </span>
          )}
        </div>
        <div className="md-body text-[14.5px] leading-relaxed">
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">
              {message.content}
            </div>
          ) : message.blocks && message.blocks.length > 0 ? (
            message.blocks.map((b, i) =>
              b.kind === "text" ? (
                <ReactMarkdown
                  key={i}
                  remarkPlugins={[remarkGfm]}
                  components={renderers}
                >
                  {b.text}
                </ReactMarkdown>
              ) : (
                <ToolUseBubble key={i} block={b} />
              ),
            )
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={renderers}
            >
              {message.content || "…"}
            </ReactMarkdown>
          )}
        </div>
        {showSos && (
          <button
            type="button"
            onClick={() => onSosForError?.(message.content)}
            className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-amber-100 border border-amber-300 text-amber-900 text-[11.5px] font-medium hover:bg-amber-200 transition"
            title="このエラーをAIに診断・修復してもらう"
          >
            <LifeBuoy size={12} />
            このエラーをAIに助けてもらう
          </button>
        )}
        {!isUser && message.stats && <StatsLine stats={message.stats} />}
      </div>
    </div>
  );
}

function CodeRenderer({
  inline,
  className,
  children,
  onExecute,
}: {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  onExecute?: (command: string, lang: string) => void;
}) {
  const lang = (className ?? "")
    .replace("language-", "")
    .toLowerCase()
    .trim();
  const text = String(children ?? "").replace(/\n$/, "");
  if (inline || !text.includes("\n") && !lang) {
    return <code className={className}>{children}</code>;
  }
  const executable = EXECUTABLE_LANGS.has(lang);
  return (
    <CodeBlockShell
      lang={lang}
      text={text}
      className={className}
      executable={executable}
      onExecute={onExecute}
    >
      {children}
    </CodeBlockShell>
  );
}

function CodeBlockShell({
  lang,
  text,
  className,
  executable,
  onExecute,
  children,
}: {
  lang: string;
  text: string;
  className?: string;
  executable: boolean;
  onExecute?: (command: string, lang: string) => void;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <div className="relative group my-2">
      {(lang || executable) && (
        <div className="absolute top-1.5 left-3 text-[10px] font-mono text-zinc-400 uppercase tracking-wider">
          {lang || "code"}
        </div>
      )}
      <div className="absolute top-1.5 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
        <button
          onClick={copy}
          className="px-1.5 py-1 rounded text-[11px] bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 inline-flex items-center gap-1"
          title="クリップボードにコピー"
        >
          {copied ? (
            <>
              <Check size={11} />
              コピー済
            </>
          ) : (
            <>
              <Copy size={11} />
              コピー
            </>
          )}
        </button>
        {executable && onExecute && (
          <button
            onClick={() => onExecute(text, lang || "bash")}
            className="px-2 py-1 rounded text-[11px] bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 font-medium"
            title="このコマンドを UNICREW で実行する（AI が Bash ツールで自動実行）"
          >
            <Play size={11} fill="currentColor" />
            実行
          </button>
        )}
      </div>
      <pre className={className}>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

/**
 * markdown 描画後の children を走査して、文字列ノード内のファイル名（NOTE_xxx.md 等）を
 * クリック可能な `<FilePathLink>` に置換する。React 要素はそのまま再帰。
 *
 * - 入力 children には `string | number | ReactElement` が混在する
 * - 単純な split/正規表現で書き換えると ReactMarkdown の構造を破壊するので、
 *   文字列ノードだけ touch し、要素ノードは props.children を再帰処理して新しい要素として返す
 */
function linkifyFilePaths(
  node: React.ReactNode,
  workspace: string | null,
): React.ReactNode {
  // 文字列ノード: セグメント化して file 部分だけ <FilePathLink> に置換
  if (typeof node === "string") {
    const segments = segmentText(node);
    if (segments.length === 1 && segments[0].kind === "text") return node;
    return segments.map((seg, i) =>
      seg.kind === "text" ? (
        seg.text
      ) : (
        <FilePathLink
          key={`fp-${i}-${seg.text}`}
          display={seg.text}
          path={seg.path ?? seg.text}
          workspace={workspace}
        />
      ),
    );
  }
  if (typeof node === "number" || typeof node === "boolean" || node == null) {
    return node;
  }
  // 配列: 各要素を再帰
  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <React.Fragment key={i}>{linkifyFilePaths(child, workspace)}</React.Fragment>
    ));
  }
  // React 要素: props.children を再帰してクローン
  if (React.isValidElement(node)) {
    const el = node as React.ReactElement<{ children?: React.ReactNode }>;
    const children = el.props?.children;
    if (children === undefined) return el;
    return React.cloneElement(el, undefined, linkifyFilePaths(children, workspace));
  }
  return node;
}

/**
 * AI 応答内のファイルパス用クリック可能リンク。
 *
 * - 通常クリック / Ctrl+Click / Cmd+Click いずれでも別ウィンドウのエディタで開く
 *   （UNICREW では「別ウィンドウで開く」が既定挙動なので分けない）
 * - 開けない場合は console.error にとどめ、ユーザーには干渉しない
 */
function FilePathLink({
  display,
  path,
  workspace,
}: {
  display: string;
  path: string;
  workspace: string | null;
}) {
  // VSCode 風: 修飾キー (Ctrl/Cmd) なしの単純クリックでは何も起こらず、テキスト選択が普通にできる。
  // Ctrl+Click（Win/Linux）または Cmd+Click（Mac）で別ウィンドウのエディタを開く。
  // 中ボタンクリックも同等扱い。
  const isModifierClick = (e: React.MouseEvent) =>
    e.ctrlKey || e.metaKey || e.button === 1;

  const tryOpen = (e: React.MouseEvent<HTMLSpanElement>) => {
    if (!isModifierClick(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const absolute = resolveFilePath(path, workspace);
    void openFileInEditorWindow(absolute).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[file-link] failed to open", absolute, err);
    });
  };

  const absoluteForTitle = resolveFilePath(path, workspace);
  // a タグから span に変更：通常クリックでナビゲーションが走らないようにする
  // （a + href="#" だとアンカージャンプ抑止のためにイベント preventDefault が必須で、選択が壊れがち）。
  return (
    <span
      onClick={tryOpen}
      onAuxClick={tryOpen}
      // ホバーで「Ctrl+Click で開く」を案内
      title={`Ctrl+クリックで別ウィンドウで開く: ${absoluteForTitle}`}
      className="text-[var(--color-accent)] underline decoration-dotted underline-offset-2 hover:decoration-solid"
      // 通常テキストとして選択もできるよう cursor は text のまま、ホバー時のみ移動感を出す
      style={{ cursor: "text" }}
      onMouseEnter={(e) => {
        if (e.ctrlKey || e.metaKey) {
          (e.currentTarget as HTMLSpanElement).style.cursor = "pointer";
        }
      }}
      onMouseMove={(e) => {
        (e.currentTarget as HTMLSpanElement).style.cursor =
          e.ctrlKey || e.metaKey ? "pointer" : "text";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLSpanElement).style.cursor = "text";
      }}
    >
      {display}
    </span>
  );
}

function StatsLine({ stats }: { stats: MessageStats }) {
  if (
    stats.outputTokens <= 0 &&
    stats.inputTokens <= 0 &&
    stats.durationMs <= 0
  ) {
    return null;
  }
  const segments: string[] = [];
  if (stats.outputTokens > 0) {
    segments.push(`↓ ${formatTokens(stats.outputTokens)} tokens`);
  }
  if (stats.inputTokens > 0) {
    segments.push(`↑ ${formatTokens(stats.inputTokens)} tokens`);
  }
  if (stats.cacheReadTokens > 0) {
    segments.push(`cached ${formatTokens(stats.cacheReadTokens)}`);
  }
  if (stats.durationMs > 0) {
    segments.push(formatElapsed(stats.durationMs));
  }
  if (stats.thinkingMs !== null && stats.thinkingMs > 0) {
    segments.push(`thought for ${formatThinking(stats.thinkingMs)}`);
  }
  if (segments.length === 0) return null;
  return (
    <div className="mt-2 text-[10.5px] text-[var(--color-muted)] font-mono tabular-nums">
      {segments.join(" · ")}
    </div>
  );
}
