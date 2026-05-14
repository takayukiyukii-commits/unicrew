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
 * Sprint 3 で Qwen Code（独自 stream-json 経路、claude.rs ベース）を追加し
 * 「4極議論」プリセットを開放、Free モードの一気通貫経路（FreeModeWizard）
 * 完成に伴い `preset-fully-free` の comingSoon フラグを外して解禁。
 */

import { useState } from "react";
import { Users, ChevronDown, Lock } from "lucide-react";
import type { ParticipantSlot, Provider } from "@/lib/types";
import { CategoryDot } from "@/lib/providerVisuals";
import { useTranslation, t as tStatic } from "@/lib/i18n";

export interface ConferencePreset {
  id: string;
  /** 表示名の i18n キー（`preset.<id>.name`） */
  nameKey: string;
  /** 説明文の i18n キー（`preset.<id>.desc`） */
  descKey: string;
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

/** 現在の locale で preset の表示名を解決（モジュール外から呼ぶ用） */
export function presetName(preset: ConferencePreset): string {
  return tStatic(preset.nameKey);
}

/** 現在の locale で preset の説明を解決（モジュール外から呼ぶ用） */
export function presetDescription(preset: ConferencePreset): string {
  return tStatic(preset.descKey);
}

/**
 * 全プリセット定義。
 * 上から順に「初心者向け → 上級者向け」。
 */
export const CONFERENCE_PRESETS: ConferencePreset[] = [
  {
    id: "preset-classic-3",
    nameKey: "preset.classic3.name",
    descKey: "preset.classic3.desc",
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "codex", characterId: "tmpl-codex-normal" },
      { id: "p3", provider: "gemini", characterId: "tmpl-claude-normal" },
    ],
    requiredProviders: ["claude", "codex", "gemini"],
    level: "starter",
  },
  {
    id: "preset-four-poles",
    nameKey: "preset.fourPoles.name",
    descKey: "preset.fourPoles.desc",
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "codex", characterId: "tmpl-codex-normal" },
      { id: "p3", provider: "gemini", characterId: "tmpl-claude-normal" },
      { id: "p4", provider: "qwen", characterId: "tmpl-qwen-normal" },
    ],
    requiredProviders: ["claude", "codex", "gemini", "qwen"],
    level: "intermediate",
  },
  {
    id: "preset-code-duel",
    nameKey: "preset.codeDuel.name",
    descKey: "preset.codeDuel.desc",
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "codex", characterId: "tmpl-codex-normal" },
    ],
    requiredProviders: ["claude", "codex"],
    level: "starter",
  },
  {
    id: "preset-uni-marketing",
    nameKey: "preset.uniMarketing.name",
    descKey: "preset.uniMarketing.desc",
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
    nameKey: "preset.cSuite.name",
    descKey: "preset.cSuite.desc",
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
    nameKey: "preset.acpTrio.name",
    descKey: "preset.acpTrio.desc",
    participants: [
      { id: "p1", provider: "goose", characterId: "tmpl-claude-normal" },
      { id: "p2", provider: "opencode", characterId: "tmpl-claude-normal" },
      { id: "p3", provider: "codex-acp", characterId: "tmpl-codex-normal" },
    ],
    requiredProviders: ["goose", "opencode", "codex-acp"],
    level: "advanced",
  },
  {
    id: "preset-acp-east-west",
    nameKey: "preset.eastWest.name",
    descKey: "preset.eastWest.desc",
    participants: [
      { id: "p1", provider: "opencode", characterId: "tmpl-opencode-normal" },
      { id: "p2", provider: "kimi", characterId: "tmpl-kimi-normal" },
      { id: "p3", provider: "goose", characterId: "tmpl-claude-normal" },
    ],
    requiredProviders: ["opencode", "kimi", "goose"],
    level: "advanced",
  },
  {
    id: "preset-kiro-vs-codex",
    nameKey: "preset.cloudDuel.name",
    descKey: "preset.cloudDuel.desc",
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
    nameKey: "preset.fullyFree.name",
    descKey: "preset.fullyFree.desc",
    participants: [
      { id: "p1", provider: "opencode", characterId: "tmpl-opencode-normal" },
      { id: "p2", provider: "opencode", characterId: "tmpl-opencode-normal" },
      { id: "p3", provider: "goose", characterId: "tmpl-claude-normal" },
    ],
    requiredProviders: ["opencode", "goose"],
    level: "advanced",
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
  const { t } = useTranslation();
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
        {t("preset.heading")}
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
                  {t(preset.nameKey)}
                </span>
                {!enabled && (
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-[var(--color-muted)]">
                    <Lock size={10} />
                    {t("preset.comingSoon")}
                  </span>
                )}
                <span className="ml-auto inline-flex items-center gap-1">
                  {preset.participants.map((p) => (
                    <CategoryDot key={p.id} provider={p.provider} size={7} />
                  ))}
                  <span className="text-[10.5px] text-[var(--color-muted)] ml-1">
                    {t("preset.participants", { count: preset.participants.length })}
                  </span>
                </span>
              </div>
              <p className="text-[11.5px] text-[var(--color-muted)] leading-relaxed">
                {t(preset.descKey)}
              </p>
            </button>
          );
        })}
      </div>

      {/* 上級者向け：カスタム選択（Sprint 2 で個別実装） */}
      <details className="rounded-xl border border-[var(--color-border)] bg-white">
        <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 text-[12px] text-[var(--color-muted)] hover:bg-[var(--color-surface)] rounded-xl">
          <ChevronDown size={12} />
          {t("preset.customSummary")}
        </summary>
        <div className="px-3 pb-3 pt-1 text-[11.5px] text-[var(--color-muted)] leading-relaxed">
          {t("preset.customBody")}
        </div>
      </details>
    </div>
  );
}
