"use client";

import {
  Sparkles,
  FolderOpen,
  Users,
  Plus,
  CheckCircle2,
  AlertCircle,
  Settings as SettingsIcon,
  Split,
} from "lucide-react";
import { useEffect, useState } from "react";
import { claudeStatus, codexStatus, isTauri } from "@/lib/tauri";

interface Props {
  onCreate: () => void;
  onOpenSettings: () => void;
}

interface Status {
  installed: boolean;
  logged_in: boolean;
}

/**
 * スレッドが1つも無いときに右側に表示するトップ画面。
 * UNICREW のセールスポイント・現在の接続状態・「最初の1スレッドを作る」CTA をまとめる。
 */
export function WelcomeLanding({ onCreate, onOpenSettings }: Props) {
  const [claude, setClaude] = useState<Status | null>(null);
  const [codex, setCodex] = useState<Status | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    Promise.all([claudeStatus(), codexStatus()])
      .then(([c, x]) => {
        if (cancelled) return;
        setClaude({ installed: c.installed, logged_in: c.logged_in });
        setCodex({ installed: x.installed, logged_in: x.logged_in });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex-1 overflow-y-auto bg-gradient-to-b from-white to-[var(--color-surface)]">
      <div className="max-w-3xl mx-auto px-8 py-16">
        <div className="text-center mb-10">
          <img
            src="/brand/logo-mark-transparent.png"
            alt="UNICREW"
            className="mx-auto w-24 h-24 mb-5 select-none"
            draggable={false}
          />
          <h1 className="text-3xl font-bold tracking-tight text-[var(--color-text)] mb-2">
            UNICREW
            <span className="ml-2 text-[11px] align-middle px-2 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-semibold">
              β
            </span>
          </h1>
          <p className="text-[15px] text-[var(--color-muted)]">
            AIを動かすことに、特化したデスクトップ。
          </p>
          <p className="text-[12.5px] text-[var(--color-muted)] mt-1">
            Claude / Codex を公式CLI経由で束ねるマルチAIランチャー。サブスクでそのまま動く・完全無料。
          </p>
        </div>

        {/* セットアップウィザード（AIガイドのセリフ） */}
        <SetupGuide
          claude={claude}
          codex={codex}
          onOpenSettings={onOpenSettings}
          onCreate={onCreate}
        />

        {/* 接続ステータス */}
        <div className="grid grid-cols-2 gap-3 mb-8">
          <StatusCard
            label="Claude"
            color="#dd6b20"
            badge="🟠"
            status={claude}
            onFix={onOpenSettings}
          />
          <StatusCard
            label="Codex"
            color="#10a37f"
            badge="🟢"
            status={codex}
            onFix={onOpenSettings}
            optional
          />
        </div>

        {/* 機能カード */}
        <div className="grid grid-cols-2 gap-3 mb-8">
          <FeatureCard
            icon={<Users size={16} />}
            title="キャラクター"
            body="CDO・CMO 等のテンプレ6体＋自作可。並列モードで2人別人格 → 議論させられる。"
          />
          <FeatureCard
            icon={<Split size={16} />}
            title="並列モード"
            body="🟠 Claude × 🟢 Codex を同時実行。会議モードで両AIに最大3ラウンド議論させる。"
          />
          <FeatureCard
            icon={<FolderOpen size={16} />}
            title="ローカルファイル"
            body="フォルダを選んで開けば、AIがそこを編集・実行。許可ダイアログで安全に。"
          />
          <FeatureCard
            icon={<Sparkles size={16} />}
            title="サブスクで動く"
            body="Claude Pro/Max でログインすれば追加課金なし。API キーモードも選べる。"
          />
        </div>

        {/* CTA */}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={onCreate}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[var(--color-accent)] text-white font-semibold text-sm hover:opacity-90 transition shadow-sm"
          >
            <Plus size={16} />
            最初の会話を始める
          </button>
          <button
            onClick={onOpenSettings}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white border border-[var(--color-border)] text-[var(--color-text)] font-medium text-sm hover:bg-[var(--color-surface)] transition"
          >
            <SettingsIcon size={15} />
            設定
          </button>
        </div>

        <div className="mt-10 text-center text-[11px] text-[var(--color-muted)] leading-relaxed">
          UNICREW β は uniLinks UNI シリーズの一員です。
          <br />
          AI の応答とツール実行は誤りを含むことがあります。
        </div>
      </div>
    </main>
  );
}

/**
 * アイデア8: 5分セットアップウィザード（最小実装）。
 *
 * Claude キャラの「セリフ風」ガイドで、現在のCLI状態に応じて次の一歩を提示する。
 * フルウィザード（多段モーダル）は将来実装。今はセリフ＋CTAボタンの組合せで誘導する。
 */
function SetupGuide({
  claude,
  codex,
  onOpenSettings,
  onCreate,
}: {
  claude: Status | null;
  codex: Status | null;
  onOpenSettings: () => void;
  onCreate: () => void;
}) {
  if (!claude) return null; // 確認中は表示しない

  const stepIndex = (() => {
    if (!claude.installed) return 1;
    if (!claude.logged_in) return 2;
    return 3;
  })();

  const message = (() => {
    if (!claude.installed) {
      return {
        title: "ようこそ！まずは Claude Code をインストールしましょう",
        body: "UNICREW は公式 CLI を使ってAIを動かします。1分で終わるので、設定画面から「Claude Code をインストール」を押してください。",
        primary: { label: "セットアップを開く", onClick: onOpenSettings },
      };
    }
    if (!claude.logged_in) {
      return {
        title: "Claude Code が入りました！次はログインを",
        body: "Claude Pro / Max のアカウントでログインすると、API キーなしで使えます。設定画面の「ログイン」を押してください。",
        primary: { label: "ログインに進む", onClick: onOpenSettings },
      };
    }
    if (codex && !codex.logged_in) {
      return {
        title: "準備OK！もし Codex も並列で使うなら",
        body: "Codex CLI を入れてログインすると、Claude と並列で動かして相互レビューや議論モードが使えます（任意）。今すぐ最初の会話を始めても大丈夫です。",
        primary: { label: "最初の会話を始める", onClick: onCreate },
      };
    }
    return {
      title: "セットアップ完了！最初の会話を始めましょう",
      body: "ノーマル Claude / Codex で素のCLIをそのまま動かせます。どんな依頼でもいいので、まず一言投げてみてください。",
      primary: { label: "最初の会話を始める", onClick: onCreate },
    };
  })();

  return (
    <div className="mb-6 rounded-2xl border border-[var(--color-accent)]/30 bg-gradient-to-br from-sky-50 via-white to-amber-50/50 p-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-10 h-10 rounded-full bg-white border border-[var(--color-accent)]/40 flex items-center justify-center text-lg shadow-sm">
          🤖
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[11px] font-semibold text-[var(--color-accent)]">
              UNICREW セットアップ
            </span>
            <span className="text-[10.5px] text-[var(--color-muted)] font-mono">
              Step {stepIndex}/3
            </span>
          </div>
          <div className="font-bold text-[14px] text-[var(--color-text)] mb-1">
            {message.title}
          </div>
          <div className="text-[12px] text-[var(--color-muted)] leading-relaxed mb-2">
            {message.body}
          </div>
          <button
            type="button"
            onClick={message.primary.onClick}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[12px] font-semibold hover:opacity-90"
          >
            {message.primary.label}
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1">
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            className={`flex-1 h-1 rounded ${
              s <= stepIndex ? "bg-[var(--color-accent)]" : "bg-gray-200"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function StatusCard({
  label,
  color,
  badge,
  status,
  onFix,
  optional = false,
}: {
  label: string;
  color: string;
  badge: string;
  status: Status | null;
  onFix: () => void;
  optional?: boolean;
}) {
  const ok = status?.installed && status?.logged_in;
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
        ok
          ? "border-emerald-200 bg-emerald-50/40"
          : "border-[var(--color-border)] bg-white"
      }`}
    >
      <span className="text-lg" style={{ color }}>
        {badge}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
          <span style={{ color }}>{label}</span>
          {!status && (
            <span className="text-[10.5px] text-[var(--color-muted)]">
              確認中…
            </span>
          )}
          {ok && (
            <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
          )}
          {status && !ok && (
            <AlertCircle size={12} className="text-amber-500 shrink-0" />
          )}
        </div>
        <div className="text-[10.5px] text-[var(--color-muted)] truncate">
          {!status
            ? "—"
            : ok
              ? "ログイン済み"
              : status.installed
                ? "未ログイン"
                : "未インストール"}
          {optional && !ok && "（任意）"}
        </div>
      </div>
      {status && !ok && (
        <button
          onClick={onFix}
          className="text-[11px] text-[var(--color-accent)] hover:underline shrink-0"
        >
          設定
        </button>
      )}
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-white p-4">
      <div className="flex items-center gap-2 mb-1.5 text-[var(--color-accent)]">
        {icon}
        <span className="font-semibold text-[12.5px] text-[var(--color-text)]">
          {title}
        </span>
      </div>
      <p className="text-[11.5px] leading-relaxed text-[var(--color-muted)]">
        {body}
      </p>
    </div>
  );
}
