"use client";

/**
 * CLI（Claude Code / Codex）の自動インストールが失敗したときに出す救済 UI。
 *
 * 2026-08-22: 元は SettingsModal.tsx 内の private 関数だったが、初回セットアップ
 * （Walkthrough）でも同じ救済を出す必要が生じたため独立ファイルへ切り出した。
 * ロジックを2箇所に書かないための移設であって、中身は変えていない
 * （manualInstallCommand の中身だけ、公式の現行導線に合わせて更新済み）。
 */

import { useState } from "react";
import { AlertCircle, Check, Copy, ExternalLink, HelpCircle, Mail } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { useAppVersion } from "@/lib/app-version";

export function detectOs(): "windows" | "mac" | "linux" | "unknown" {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac")) return "mac";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "unknown";
}

/**
 * 手動インストール用コマンド。
 *
 * 🚨 2026-08-22 更新。ここは Rust 側（install_claude_code / install_codex）が実際に
 * 走らせている導線と一致させること。ズレると「アプリと違う入れ方」を案内してしまう。
 *  - 旧 Windows 案内は `winget install --id Anthropic.ClaudeCode` だったが、winget 版は
 *    自動更新されないうえ、一時フォルダ競合で
 *    「remove: The process cannot access the file...」で落ちる事故が実際に起きた。
 *    公式推奨のネイティブインストーラ（管理者不要・Node 不要・自動更新あり）に変更。
 *  - 旧 mac 案内の brew tap `anthropic-ai/claude-code` は 2026-08 時点で 404＝消滅済み。
 */
export function manualInstallCommand(
  product: "claude" | "codex",
  os: ReturnType<typeof detectOs>,
): string {
  if (product === "claude") {
    if (os === "windows") return "irm https://claude.ai/install.ps1 | iex";
    // mac/Linux はアプリと同じく npm フォールバックまで含める
    return "curl -fsSL https://claude.ai/install.sh | bash || npm install -g @anthropic-ai/claude-code";
  }
  if (os === "windows") return "irm https://chatgpt.com/codex/install.ps1 | iex";
  return "curl -fsSL https://chatgpt.com/codex/install.sh | sh || npm install -g @openai/codex";
}

export function InstallFailedFallback({
  product,
  productLabel,
  lastLine,
  helpUrl,
}: {
  product: "claude" | "codex";
  productLabel: string;
  lastLine: string;
  helpUrl: string;
}) {
  const { t: tr } = useTranslation();
  const appVersion = useAppVersion();
  const [copied, setCopied] = useState(false);
  const os = detectOs();
  const command = manualInstallCommand(product, os);
  const osLabel =
    os === "windows" ? "Windows" : os === "mac" ? "macOS" : os === "linux" ? "Linux" : tr("settings.installFail.osUnknown");
  const shellLabel =
    os === "mac"
      ? tr("settings.installFail.shellTerminal")
      : os === "windows"
        ? tr("settings.installFail.shellPowershell")
        : tr("settings.installFail.shellGeneric");

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard 拒否時は select-all 領域から手動コピー
    }
  };

  const sendSupport = () => {
    const subject = tr("settings.installFail.mailSubject", { productLabel });
    const body =
      `${tr("settings.installFail.mailIntro", { productLabel })}\n\n` +
      `${tr("settings.installFail.mailTriedHeader")}\n${tr("settings.installFail.mailTriedBody")}\n\n` +
      `${tr("settings.installFail.mailCmdHeader", { os: osLabel })}\n${command}\n\n` +
      `${tr("settings.installFail.mailLogHeader")}\n${lastLine || tr("settings.installFail.mailLogEmpty")}\n\n` +
      `${tr("settings.installFail.mailEnvHeader")}\nOS: ${osLabel}\nUA: ${typeof navigator !== "undefined" ? navigator.userAgent : ""}\nUNICREW: ${appVersion || "?"}\n\n` +
      `――――――――――――――――――――\n` +
      `${tr("settings.installFail.mailScreenshotNote")}\n`;
    const url = `mailto:support@uni-core.jp?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = url;
  };

  return (
    <div className="pt-2 border-t border-[var(--color-border)] space-y-2.5">
      <div className="flex items-start gap-2 text-[12px] text-red-600">
        <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
        <span className="leading-relaxed">
          {tr("settings.installFail.banner")}
        </span>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] text-[var(--color-muted)] font-medium">
          {tr("settings.installFail.manualHeader", { os: osLabel })}
        </div>
        <div className="bg-white border border-[var(--color-border)] rounded p-2 flex items-start gap-2">
          <span className="flex-1 font-mono text-[11px] text-[var(--color-text)] break-all select-all leading-relaxed">
            {command}
          </span>
          <button
            type="button"
            onClick={copyCommand}
            className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[10.5px] rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] text-[var(--color-text)]"
            title={tr("settings.installFail.copyTitle")}
          >
            {copied ? (
              <>
                <Check size={11} className="text-emerald-500" />
                {tr("settings.installFail.copied")}
              </>
            ) : (
              <>
                <Copy size={11} />
                {tr("settings.installFail.copy")}
              </>
            )}
          </button>
        </div>
        <div className="text-[10.5px] text-[var(--color-muted)] leading-relaxed">
          {tr("settings.installFail.manualHint", { shell: shellLabel })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={sendSupport}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] bg-white border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface)] text-[var(--color-text)] font-medium"
        >
          <Mail size={12} />
          {tr("settings.installFail.sendSupport")}
        </button>
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11.5px] bg-white border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface)] text-[var(--color-text)] font-medium"
        >
          <HelpCircle size={12} />
          {tr("settings.installFail.openHelp")}
          <ExternalLink size={10} className="text-[var(--color-muted)]" />
        </a>
      </div>
    </div>
  );
}
