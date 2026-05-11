"use client";

import {
  Bot,
  Sparkles,
  FolderOpen,
  Users,
  Plus,
  CheckCircle2,
  AlertCircle,
  Settings as SettingsIcon,
  Split,
  Gift,
  ChevronDown,
} from "lucide-react";
import { useEffect, useState } from "react";
import { claudeStatus, codexStatus, isTauri } from "@/lib/tauri";
import { CategoryDot } from "@/lib/providerVisuals";
import {
  ConferencePresets,
  type ConferencePreset,
} from "@/components/ConferencePresets";

interface Props {
  onCreate: () => void;
  onOpenSettings: () => void;
  /**
   * 「無料で試す」ボタンのハンドラ。
   * Sprint 2 で OpenCode + Ollama 自動セットアップを wire 予定。
   * 現状は未提供時に onOpenSettings へフォールバック。
   */
  onStartFreeMode?: () => void;
  /**
   * 議論モードのキャストプリセットを選択したときのハンドラ。
   * 親側で participants をセットしたスレッドを作成し議論を開始する。
   * 未指定なら presets セクション自体を出さない。
   */
  onApplyPreset?: (preset: ConferencePreset) => void;
}

interface Status {
  installed: boolean;
  logged_in: boolean;
}

/**
 * スレッドが1つも無いときに右側に表示するトップ画面。
 *
 * 設計方針（2026-05-10 改訂）:
 * - **「無料で試す（API キー不要）」を最上位の単一CTA**として提示。
 *   従来の「Claude をインストール」一択は試用障壁を作っていたため。
 * - 既存サブスク派の動線は <details> で折りたたみ、必要な人だけ展開。
 * - StatusCard を 1 行に並べる方式は廃止（プロバイダ増加に耐えない）。
 *   詳細ステータスは SettingsModal のカテゴリ accordion 側に集約。
 */
export function WelcomeLanding({
  onCreate,
  onOpenSettings,
  onStartFreeMode,
  onApplyPreset,
}: Props) {
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

  const hasAnyConnected =
    (claude?.installed && claude?.logged_in) ||
    (codex?.installed && codex?.logged_in);

  const handleFreeMode = onStartFreeMode ?? onOpenSettings;

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
            業界標準 ACP 対応のマルチAI ランチャー。サブスクでも、ローカル AI でも動く。
          </p>
        </div>

        {/* 「無料で試す」最上位 CTA。既存サブスク派は下の <details> から進める。 */}
        <div className="mb-6 rounded-2xl border-2 border-[var(--color-accent)] bg-gradient-to-br from-amber-50 via-white to-sky-50 p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="shrink-0 w-12 h-12 rounded-full bg-[var(--color-accent)] text-white flex items-center justify-center shadow-sm">
              <Gift size={22} strokeWidth={1.8} aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-[15px] text-[var(--color-text)] mb-1">
                まずは無料で試す
              </div>
              <p className="text-[12.5px] text-[var(--color-muted)] leading-relaxed mb-3">
                API キー不要。ローカルで動く OSS AI（OpenCode + Ollama）を自動セットアップして、UNICREW の議論モード・並列モードをすぐ体験できます。
              </p>
              <button
                type="button"
                onClick={handleFreeMode}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-[13px] font-semibold hover:opacity-90 shadow-sm"
              >
                <Sparkles size={14} />
                1分で始める
              </button>
            </div>
          </div>
        </div>

        {/* 既存サブスク派の動線は折りたたみ。 */}
        <details className="mb-8 rounded-xl border border-[var(--color-border)] bg-white open:shadow-sm">
          <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-2 text-[12.5px] text-[var(--color-text)] font-medium hover:bg-[var(--color-surface)] rounded-xl">
            <ChevronDown size={14} className="text-[var(--color-muted)] transition-transform" />
            <span>Claude / Codex / Gemini のサブスクをお持ちの方</span>
            {hasAnyConnected && (
              <span className="ml-auto text-[11px] text-emerald-600 inline-flex items-center gap-1">
                <CheckCircle2 size={12} />
                接続済み
              </span>
            )}
          </summary>
          <div className="px-4 pb-4 pt-2 border-t border-[var(--color-border)] space-y-3">
            <SetupGuide
              claude={claude}
              codex={codex}
              onOpenSettings={onOpenSettings}
              onCreate={onCreate}
            />
            <StatusRow
              label="Claude"
              provider="claude"
              status={claude}
              onFix={onOpenSettings}
            />
            <StatusRow
              label="Codex"
              provider="codex"
              status={codex}
              onFix={onOpenSettings}
              optional
            />
          </div>
        </details>

        {/* 機能カード（4 → 3 に削減、「サブスクで動く」は当然なので除去） */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <FeatureCard
            icon={<Users size={16} />}
            title="議論モード"
            body="複数の AI に役割を持たせて議論させる。プリセットあり。"
          />
          <FeatureCard
            icon={<Split size={16} />}
            title="並列モード"
            body="2社以上を同時実行。レスポンスを横並びで比較。"
          />
          <FeatureCard
            icon={<FolderOpen size={16} />}
            title="ローカルファイル"
            body="フォルダを選んで開けば、AI がそこを編集・実行。"
          />
        </div>

        {/* 議論モードのプリセット起動。
            <details> で閉じておくことで初見の縦長化を避けつつ、
            「議論モード」カードに惹かれた人がワンクリックで開始できる導線。 */}
        {onApplyPreset && (
          <details className="mb-8 rounded-xl border border-[var(--color-border)] bg-white open:shadow-sm">
            <summary className="cursor-pointer list-none px-4 py-3 flex items-center gap-2 text-[12.5px] text-[var(--color-text)] font-medium hover:bg-[var(--color-surface)] rounded-xl">
              <ChevronDown size={14} className="text-[var(--color-muted)] transition-transform" />
              <Users size={14} className="text-[var(--color-accent)]" />
              <span>プリセットから議論を始める</span>
              <span className="ml-auto text-[10.5px] text-[var(--color-muted)]">
                定番3社 / コードレビュー / ACP 3社 ほか
              </span>
            </summary>
            <div className="px-4 pb-4 pt-2 border-t border-[var(--color-border)]">
              <ConferencePresets
                onApply={onApplyPreset}
                hideComingSoon={true}
              />
            </div>
          </details>
        )}

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
 * セットアップウィザード（折りたたみの中で表示）。
 * 既存接続状態に応じて次の一歩を提示。
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
  if (!claude) return null;

  const stepIndex = (() => {
    if (!claude.installed) return 1;
    if (!claude.logged_in) return 2;
    return 3;
  })();

  const message = (() => {
    if (!claude.installed) {
      return {
        title: "Claude Code の自動インストールから",
        body: "「設定」ボタンから「Claude Code を自動インストール」を押すと 2〜3 分で完了します。",
        primary: { label: "設定を開く", onClick: onOpenSettings },
      };
    }
    if (!claude.logged_in) {
      return {
        title: "Claude にログインしましょう",
        body: "Claude Pro / Max のアカウントでログインすると、API キーなしで使えます。",
        primary: { label: "ログインに進む", onClick: onOpenSettings },
      };
    }
    if (codex && !codex.logged_in) {
      return {
        title: "Codex も並列で使うなら（任意）",
        body: "Codex CLI を入れてログインすると、Claude と並列で動かして相互レビューや議論モードが使えます。",
        primary: { label: "最初の会話を始める", onClick: onCreate },
      };
    }
    return {
      title: "セットアップ完了",
      body: "Claude（normal）/ Codex（normal）で素の CLI をそのまま動かせます。",
      primary: { label: "最初の会話を始める", onClick: onCreate },
    };
  })();

  return (
    <div className="rounded-xl border border-[var(--color-accent)]/30 bg-gradient-to-br from-sky-50 via-white to-amber-50/50 p-3">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-full bg-white border border-[var(--color-accent)]/40 flex items-center justify-center shadow-sm text-[var(--color-accent)]">
          <Bot size={18} strokeWidth={1.5} aria-hidden="true" />
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
          <div className="font-bold text-[13px] text-[var(--color-text)] mb-1">
            {message.title}
          </div>
          <div className="text-[11.5px] text-[var(--color-muted)] leading-relaxed mb-2">
            {message.body}
          </div>
          <button
            type="button"
            onClick={message.primary.onClick}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-white text-[11.5px] font-semibold hover:opacity-90"
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

/**
 * シンプルな1行ステータス表示（カードではなく行）。
 * プロバイダが増えても縦に並べるだけで破綻しない。
 */
function StatusRow({
  label,
  provider,
  status,
  onFix,
  optional = false,
}: {
  label: string;
  provider: "claude" | "codex" | "gemini";
  status: Status | null;
  onFix: () => void;
  optional?: boolean;
}) {
  const ok = status?.installed && status?.logged_in;
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-white">
      <CategoryDot provider={provider} size={9} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
          <span>{label}</span>
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
