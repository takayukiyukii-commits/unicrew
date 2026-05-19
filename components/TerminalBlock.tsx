"use client";

import { useEffect, useMemo, useRef } from "react";
import { Terminal, Check, X as XIcon, Loader2 } from "lucide-react";
import type { ToolUseBlock } from "@/lib/types";
import { ansiToLines, type AnsiStyle } from "@/lib/ansi";
import { useTranslation } from "@/lib/i18n";

interface Props {
  block: ToolUseBlock;
}

function styleToCss(s: AnsiStyle): React.CSSProperties {
  const css: React.CSSProperties = {};
  if (s.fg) css.color = s.fg;
  if (s.bg) css.backgroundColor = s.bg;
  if (s.bold) css.fontWeight = 700;
  if (s.dim) css.opacity = 0.6;
  if (s.italic) css.fontStyle = "italic";
  if (s.underline) css.textDecoration = "underline";
  return css;
}

/**
 * Renders a Bash tool use as a read-only block that looks exactly like
 * VSCode's integrated terminal: a prompt line with the command, followed
 * by the full captured output with real ANSI colors, tab stops and
 * carriage-return overwrites, with terminal-style scrollback.
 */
export function TerminalBlock({ block }: Props) {
  const { t } = useTranslation();
  const command = String((block.input ?? {}).command ?? "");
  const output = block.result ?? "";
  const running = block.status === "pending" || block.status === "approved";
  const errored = block.status === "errored" || block.status === "denied";

  const lines = useMemo(() => ansiToLines(output), [output]);

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep pinned to the bottom while the command is still producing output,
    // exactly like a live terminal.
    if (running && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [output, running]);

  const StatusIcon = running ? Loader2 : errored ? XIcon : Check;
  const statusColor = running
    ? "text-amber-300"
    : errored
      ? "text-red-400"
      : "text-emerald-400";
  const statusText = running
    ? t("terminal.running")
    : errored
      ? t("terminal.failed")
      : t("terminal.done");

  const hasOutput = output.trim().length > 0;

  return (
    <div className="my-2 max-w-full overflow-hidden rounded-lg border border-black/40 bg-[#1e1e1e] shadow-sm">
      {/* Title bar — like a VSCode terminal tab strip */}
      <div className="flex items-center gap-2 border-b border-white/10 bg-[#252526] px-3 py-1.5">
        <Terminal size={12} className="text-emerald-400 shrink-0" />
        <span className="font-mono text-[11px] font-semibold text-slate-200">
          {t("terminal.title")}
        </span>
        <span
          className={`ml-auto flex items-center gap-1 text-[10.5px] ${statusColor}`}
        >
          <StatusIcon size={11} className={running ? "animate-spin" : ""} />
          <span>{statusText}</span>
        </span>
      </div>

      {/* Terminal body */}
      <div
        ref={bodyRef}
        className="max-h-[420px] overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.45]"
        style={{ color: "#cccccc" }}
      >
        {/* Prompt line */}
        <div className="whitespace-pre-wrap break-words">
          <span className="text-sky-400 select-none">~</span>
          <span className="text-emerald-400 select-none"> $ </span>
          <span className="text-slate-100">{command}</span>
        </div>

        {/* Output */}
        {hasOutput ? (
          <div className="mt-0.5 whitespace-pre">
            {lines.map((segs, li) => (
              <div key={li} className="min-h-[1.45em]">
                {segs.length === 0 ? (
                  " "
                ) : (
                  segs.map((seg, si) => (
                    <span key={si} style={styleToCss(seg.style)}>
                      {seg.text}
                    </span>
                  ))
                )}
              </div>
            ))}
            {running && (
              <span className="inline-block h-[1em] w-[7px] translate-y-[2px] animate-pulse bg-slate-200" />
            )}
          </div>
        ) : running ? (
          <div className="mt-0.5">
            <span className="inline-block h-[1em] w-[7px] translate-y-[2px] animate-pulse bg-slate-200" />
          </div>
        ) : (
          <div className="mt-0.5 text-slate-500">{t("terminal.noOutput")}</div>
        )}
      </div>
    </div>
  );
}
