"use client";

/**
 * Conference モード キャスト選択プリセット。
 *
 * 設計指針（AGENTS.md「UI 複雑化を避ける5原則」原則4）:
 * - N人から3人選ぶ複雑なUIは作らない
 * - プリセット6種を縦リストで提示、ユーザーは1クリックで選択
 * - 「カスタム選択」は <details> の奥に隠す
 *
 * 現状（2026-05-11）: Goose / OpenCode / codex-acp / Kiro は ACP 経由で実装済。
 * Ollama backed の完全無料モード（preset-fully-free）のみ `comingSoon: true` で
 * 引き続き準備中表示。
 */

import { useState } from "react";
import { Users, ChevronDown, Lock } from "lucide-react";
import type { ParticipantSlot, Provider } from "@/lib/types";
import { CategoryDot } from "@/lib/providerVisuals";

export interface ConferencePreset {
  id: string;
  name: string;
  description: string;
  /** プリセットを構成する参加者リスト */
  participants: ParticipantSlot[];
  /** 参加に必要な provider 群（このうち未実装が1つでもあれば disabled） */
  requiredProviders: Provider[];
  /** 押し売り度。低いほど初心者向け */
  level: "starter" | "intermediate" | "advanced";
  /**
   * 未実装フラグ。true なら enabled 判定で常に false を返し「準備中」ラベルを付ける。
   * 既定 false。Sprint 2 で実装したものは外す。
   */
  comingSoon?: boolean;
}

/**
 * 全プリセット定義。
 * 上から順に「初心者向け → 上級者向け」。
 */
export const CONFERENCE_PRESETS: ConferencePreset[] = [
  {
    id: "preset-classic-3",
    name: "定番3社議論",
    description: "Claude / Codex / Gemini が三者三様の視点で意見を出し合う。最初に試すならこれ。",
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "codex", characterId: "tmpl-codex-normal" },
      { id: "p3", provider: "gemini", characterId: "tmpl-claude-normal" },
    ],
    requiredProviders: ["claude", "codex", "gemini"],
    level: "starter",
  },
  {
    id: "preset-code-duel",
    name: "コードレビュー対決",
    description: "Claude と Codex の2社で実装案を出し合い、相互レビューする。",
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "codex", characterId: "tmpl-codex-normal" },
    ],
    requiredProviders: ["claude", "codex"],
    level: "starter",
  },
  {
    id: "preset-uni-marketing",
    name: "UNI 製品マーケ議論",
    description: "CMO / CSO / CDO の3役で UNI シリーズの集客・販売・実装を多面検討。",
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-cmo" },
      { id: "p2", provider: "claude", characterId: "tmpl-cso" },
      { id: "p3", provider: "codex", characterId: "tmpl-cdo" },
    ],
    requiredProviders: ["claude", "codex"],
    level: "intermediate",
  },
  {
    id: "preset-internal-c-suite",
    name: "Claude 内部対話（C-suite）",
    description: "Claude を3体並列、それぞれ CDO / CMO / CFO 役で組織会議を再現。",
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-cdo" },
      { id: "p2", provider: "claude", characterId: "tmpl-cmo" },
      { id: "p3", provider: "claude", characterId: "tmpl-cfo" },
    ],
    requiredProviders: ["claude"],
    level: "intermediate",
  },
  {
    id: "preset-acp-trio",
    name: "ACP 3社議論",
    description:
      "業界標準 ACP に対応する Goose / OpenCode / codex-acp が並列議論。Goose・OpenCode はローカル LLM 可、codex-acp は OPENAI_API_KEY 必須。",
    participants: [
      { id: "p1", provider: "goose", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "opencode", characterId: "tmpl-claude-normal" },
      { id: "p3", provider: "codex-acp", characterId: "tmpl-codex-normal" },
    ],
    requiredProviders: ["goose", "opencode", "codex-acp"],
    level: "advanced",
  },
  {
    id: "preset-kiro-vs-codex",
    name: "クラウド対決（AWS × OpenAI）",
    description:
      "AWS Bedrock backed の Kiro と OpenAI を直接叩く codex-acp、加えて中立な OpenCode を交えた3エージェント議論。",
    participants: [
      { id: "p1", provider: "kiro", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "codex-acp", characterId: "tmpl-codex-normal" },
      { id: "p3", provider: "opencode", characterId: "tmpl-claude-normal" },
    ],
    requiredProviders: ["kiro", "codex-acp", "opencode"],
    level: "advanced",
  },
  {
    id: "preset-fully-free",
    name: "完全無料議論（Coming soon）",
    description: "OpenCode + ローカル Ollama × 3 人格。API 課金 0 円で AI 議論できる究極モード。",
    participants: [
      { id: "p1", provider: "opencode", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "opencode", characterId: "tmpl-claude-normal" },
      { id: "p3", provider: "goose", characterId: "tmpl-claude-normal" },
    ],
    requiredProviders: ["opencode", "goose"],
    level: "advanced",
    comingSoon: true,
  },
];

interface Props {
  /**
   * ユーザーが選んだプリセットそのものを呼び出し元に渡す。
   * 親側はスレッド title に `preset.name` を使い、participants をそのまま反映する。
   */
  onApply: (preset: ConferencePreset) => void;
  /**
   * 利用可能な provider の集合。requiredProviders がこれに含まれていないプリセットは disabled。
   * 未指定なら全 provider 利用可能とみなす（開発時用）。
   */
  availableProviders?: Set<Provider>;
  /**
   * "Coming soon" マーク付きプリセット（Sprint 2 で実装予定）を強制的に disabled に。
   * 既定 true。
   */
  hideComingSoon?: boolean;
}

/**
 * 議論モードのキャスト選択 UI。
 *
 * 使い方:
 * ```tsx
 * <ConferencePresets
 *   availableProviders={new Set(["claude", "codex"])}
 *   onApply={(preset) => {
 *     setThreadParticipants(preset.participants);
 *     setThreadTitle(preset.name);
 *     enterConferenceMode();
 *   }}
 * />
 * ```
 */
export function ConferencePresets({
  onApply,
  availableProviders,
  hideComingSoon = false,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const isAvailable = (preset: ConferencePreset): boolean => {
    if (preset.comingSoon) return false;
    if (!availableProviders) return true;
    return preset.requiredProviders.every((p) => availableProviders.has(p));
  };

  const visiblePresets = hideComingSoon
    ? CONFERENCE_PRESETS.filter((p) => isAvailable(p))
    : CONFERENCE_PRESETS;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-text)]">
        <Users size={14} />
        議論モード — キャストを選ぶ
      </div>

      <div className="space-y-2">
        {visiblePresets.map((preset) => {
          const enabled = isAvailable(preset);
          const selected = selectedId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              disabled={!enabled}
              onClick={() => {
                setSelectedId(preset.id);
                if (enabled) onApply(preset);
              }}
              className={`w-full text-left border rounded-xl p-3 transition ${
                !enabled
                  ? "border-[var(--color-border)] bg-[var(--color-surface)]/40 opacity-60 cursor-not-allowed"
                  : selected
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-border)] bg-white hover:bg-[var(--color-surface)]"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-[12.5px] text-[var(--color-text)]">
                  {preset.name}
                </span>
                {!enabled && (
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-[var(--color-muted)]">
                    <Lock size={10} />
                    準備中
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-1">
                  {preset.participants.map((p) => (
                    <CategoryDot key={p.id} provider={p.provider} size={7} />
                  ))}
                  <span className="text-[10.5px] text-[var(--color-muted)] ml-1">
                    {preset.participants.length} 人
                  </span>
                </span>
              </div>
              <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                {preset.description}
              </p>
            </button>
          );
        })}
      </div>

      {/* 上級者向け：カスタム選択（Sprint 2 で個別実装） */}
      <details className="rounded-xl border border-[var(--color-border)] bg-white">
        <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 text-[12px] text-[var(--color-muted)] hover:bg-[var(--color-surface)] rounded-xl">
          <ChevronDown size={12} />
          カスタム選択（上級者向け）
        </summary>
        <div className="px-3 pb-3 pt-1 text-[11.5px] text-[var(--color-muted)] leading-relaxed">
          各カテゴリから個別にプロバイダ・キャラクターを組み合わせる UI は Sprint 2 で実装予定です。
          現時点ではプリセットからお選びください。
        </div>
      </details>
    </div>
  );
}
