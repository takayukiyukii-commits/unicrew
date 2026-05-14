"use client";

import { useEffect, useMemo, useState } from "react";
import {
  X,
  Plus,
  Sparkles,
  Users,
  ArrowLeft,
  Check,
  Bot,
  User,
  Columns2,
  Lightbulb,
  ClipboardList,
} from "lucide-react";
import {
  TEMPLATE_CHARACTERS,
  cloneFromTemplate,
  getCharacter,
  loadUserCharacters,
  saveUserCharacters,
} from "@/lib/characters";
import type { Character, Provider } from "@/lib/types";
import { PROVIDER_LABELS } from "@/lib/types";
import { CategoryDot } from "@/lib/providerVisuals";
import { CharacterAvatar } from "./CharacterAvatar";
import { useTranslation } from "@/lib/i18n";

// 「normal」テンプレ群（素のCLIをそのまま起動するキャラ）。これらは自身の provider 固定で、
// 上部の「どのAIで起動」タブの影響を受けない。タブの影響を受けるのは tmpl-auto 以下の人格テンプレ。
const NORMAL_TEMPLATE_IDS = new Set([
  "tmpl-claude-normal",
  "tmpl-codex-normal",
  "tmpl-opencode-normal",
  "tmpl-qwen-normal",
  "tmpl-kimi-normal",
]);
const isNormalTemplate = (t: Character) => NORMAL_TEMPLATE_IDS.has(t.id);

/** AI タブで切替えるプロバイダの順番。Gemini は将来対応のため UI には出すがオプショナル。 */
const TEMPLATE_PROVIDER_TABS: Provider[] = ["claude", "codex", "gemini"];

interface Props {
  open: boolean;
  splitMode: boolean;
  onSplitModeChange: (v: boolean) => void;
  conferenceMode: boolean;
  onConferenceModeChange: (v: boolean) => void;
  onClose: () => void;
  /** 単独モード時のキャラ確定。 */
  onPick: (characterId: string) => void;
  /** 並列モード時に Claude / Codex のキャラが両方確定したら呼ばれる。 */
  onPickPair: (claudeCharacterId: string, codexCharacterId: string) => void;
  onCreateNew: () => void;
  /**
   * テンプレートを元に編集画面を開く。AI タブで provider 上書きが指定された場合は
   * `overrides` に `{ provider: "..." }` 等が入る。
   */
  onCloneTemplate: (
    template: Character,
    overrides?: Partial<Character>,
  ) => void;
}

type Step = "claude" | "codex";

export function CharacterPickerModal({
  open,
  splitMode,
  onSplitModeChange,
  conferenceMode,
  onConferenceModeChange,
  onClose,
  onPick,
  onPickPair,
  onCreateNew,
  onCloneTemplate,
}: Props) {
  const { t: tr } = useTranslation();
  const [userChars, setUserChars] = useState<Character[]>([]);
  const [step, setStep] = useState<Step>("claude");
  const [firstClaudeId, setFirstClaudeId] = useState<string | null>(null);
  /**
   * 「人格 × AI」の AI 部分。テンプレ（CEO/CDO 等の人格）をクリックしたとき、
   * このタブの provider で起動するように上書きする。normal テンプレは
   * 自身の provider 固定（このタブでは上書きしない）。
   */
  const [templateProvider, setTemplateProvider] = useState<Provider>("claude");

  useEffect(() => {
    if (open) {
      setUserChars(loadUserCharacters());
      setStep("claude");
      setFirstClaudeId(null);
      setTemplateProvider("claude");
    }
  }, [open]);

  // splitMode が外れたら 2step 状態もリセット
  useEffect(() => {
    if (!splitMode) {
      setStep("claude");
      setFirstClaudeId(null);
    }
  }, [splitMode]);

  const firstClaudeChar = useMemo(
    () => (firstClaudeId ? getCharacter(firstClaudeId) : undefined),
    [firstClaudeId],
  );

  if (!open) return null;

  const handleSelect = (charId: string) => {
    if (!splitMode) {
      onPick(charId);
      return;
    }
    if (step === "claude") {
      setFirstClaudeId(charId);
      setStep("codex");
    } else {
      // codex 側のキャラ確定
      if (firstClaudeId) {
        onPickPair(firstClaudeId, charId);
      } else {
        // 想定外：Claude が未確定なら単独として扱う
        onPick(charId);
      }
    }
  };

  const headerTitle = !splitMode
    ? tr("character.picker.newConversation")
    : step === "claude"
      ? tr("character.picker.claudeSideTitle")
      : tr("character.picker.codexSideTitle");

  const headerSub = !splitMode
    ? tr("character.picker.singleSub")
    : step === "claude"
      ? tr("character.picker.splitStep1Sub")
      : tr("character.picker.splitStep2Sub");

  // splitモード中はクローン編集フローを通せないので「直接ピック」に切替
  const handleTemplateClick = (t: Character) => {
    // 人格テンプレ（非 normal）の場合は AI タブの provider で上書き起動。
    // normal テンプレは自身の provider 固定（タブの影響を受けない）。
    const overrides: Partial<Character> | undefined =
      !isNormalTemplate(t) && t.provider !== templateProvider
        ? { provider: templateProvider }
        : undefined;
    if (splitMode) {
      if (overrides) {
        // 並列モードは編集画面を挟まないので、先に user character として保存して
        // その新 ID を選択側に渡す。これで「CEO × Codex」のような組合せが成立する。
        const clone = cloneFromTemplate(t, overrides);
        const next = [clone, ...loadUserCharacters()];
        saveUserCharacters(next);
        setUserChars(next);
        handleSelect(clone.id);
      } else {
        handleSelect(t.id);
      }
    } else {
      onCloneTemplate(t, overrides);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <div className="min-w-0">
            <h2 className="font-bold text-[15px] truncate">{headerTitle}</h2>
            <p className="text-[12px] text-[var(--color-muted)] truncate">
              {headerSub}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--color-surface)] rounded transition shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Mode selector: 単独 / 並列 */}
        <div className="px-5 pt-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                onSplitModeChange(false);
                onConferenceModeChange(false);
              }}
              className={`text-left border rounded-md px-3 py-2 transition ${
                !splitMode
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] bg-white hover:bg-[var(--color-surface)]"
              }`}
            >
              <div className="text-[12.5px] font-semibold flex items-center gap-1.5">
                <User size={13} aria-hidden="true" />
                <span>{tr("character.picker.singleMode")}</span>
                {!splitMode && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white">
                    {tr("character.picker.selected")}
                  </span>
                )}
              </div>
              <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
                {tr("character.picker.singleDesc")}
              </div>
            </button>
            <button
              type="button"
              onClick={() => onSplitModeChange(true)}
              className={`text-left border rounded-md px-3 py-2 transition ${
                splitMode
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                  : "border-[var(--color-border)] bg-white hover:bg-[var(--color-surface)]"
              }`}
            >
              <div className="text-[12.5px] font-semibold flex items-center gap-1.5">
                <span>{tr("character.picker.splitMode")}</span>
                {splitMode && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white">
                    {tr("character.picker.selected")}
                  </span>
                )}
              </div>
              <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
                {tr("character.picker.splitDesc")}
              </div>
            </button>
          </div>
          <label
            className={`flex items-center gap-2 text-[12.5px] select-none border border-[var(--color-border)] rounded-md px-3 py-2 ${
              splitMode
                ? "cursor-pointer bg-[var(--color-surface)] hover:bg-white"
                : "cursor-not-allowed bg-[var(--color-surface)]/50 opacity-50"
            }`}
          >
            <input
              type="checkbox"
              checked={conferenceMode}
              disabled={!splitMode}
              onChange={(e) => onConferenceModeChange(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="font-medium">{tr("character.picker.conferenceLabel")}</span>
            <span className="text-[var(--color-muted)] text-[11.5px]">
              {tr("character.picker.conferenceHint")}
            </span>
          </label>
          {!splitMode && (
            <div className="text-[11px] text-[var(--color-muted)] px-1 leading-relaxed flex items-start gap-1.5">
              <Lightbulb size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                {tr("character.picker.parallelTipA")}
                <ClipboardList
                  size={11}
                  className="inline-block align-middle mx-1"
                  aria-hidden="true"
                />
                {tr("character.picker.parallelTipB")}
              </span>
            </div>
          )}
          {/* 「このまま開始」: 単独モードでは Claude / Codex の2択、並列モードでは1ボタン。
              人格テンプレ画面をスキップして素のCLI挙動で即起動するための主導線。 */}
          <div className="rounded-lg border border-[var(--color-accent)]/40 bg-gradient-to-r from-sky-50 to-indigo-50 p-2.5">
            <div className="flex items-center gap-1.5 mb-1.5 px-1">
              <Bot size={14} strokeWidth={1.5} className="text-[var(--color-accent)] shrink-0" aria-hidden="true" />
              <span className="text-[12px] font-semibold text-[var(--color-text)]">
                {tr("character.picker.quickStart")}
              </span>
              <span className="text-[10.5px] text-[var(--color-muted)]">
                {splitMode
                  ? tr("character.picker.quickStartSubSplit")
                  : tr("character.picker.quickStartSubSingle")}
              </span>
            </div>
            {splitMode ? (
              <button
                type="button"
                onClick={() =>
                  onPickPair("tmpl-claude-normal", "tmpl-codex-normal")
                }
                className="w-full flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-white px-3 py-2 hover:border-[var(--color-accent)] hover:shadow-sm transition text-left"
              >
                <span className="text-[12.5px] font-semibold text-[var(--color-accent)]">
                  {tr("character.picker.startBothParallel")}
                </span>
                <span className="ml-auto text-[var(--color-accent)]">→</span>
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleSelect("tmpl-claude-normal")}
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-white px-3 py-2 hover:border-[#dd6b20] hover:shadow-sm transition text-left"
                >
                  <span className="text-[12.5px] font-semibold text-[#dd6b20]">
                    {tr("character.picker.startClaudeSolo")}
                  </span>
                  <span className="ml-auto text-[#dd6b20] opacity-70">→</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSelect("tmpl-codex-normal")}
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-white px-3 py-2 hover:border-[#10a37f] hover:shadow-sm transition text-left"
                >
                  <span className="text-[12.5px] font-semibold text-[#10a37f]">
                    {tr("character.picker.startCodexSolo")}
                  </span>
                  <span className="ml-auto text-[#10a37f] opacity-70">→</span>
                </button>
              </div>
            )}
            <p className="text-[11px] text-[var(--color-muted)] mt-1.5 px-1 leading-snug">
              {tr("character.picker.quickStartFooter")}
              {splitMode && tr("character.picker.quickStartFooterSplit")}
            </p>
          </div>

          {!splitMode && (
            <div className="text-[11px] text-[var(--color-muted)] px-1 leading-relaxed flex items-start gap-1.5">
              <Lightbulb size={12} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                {tr("character.picker.parallelTipA")}
                <ClipboardList
                  size={11}
                  className="inline-block align-middle mx-1"
                  aria-hidden="true"
                />
                {tr("character.picker.parallelTipB")}
              </span>
            </div>
          )}
        </div>

        {/* Step 2 で Claude 側のピック内容を確認用に表示 */}
        {splitMode && step === "codex" && firstClaudeChar && (
          <div className="mx-5 mt-3 flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]">
            <Check size={13} className="text-[var(--color-accent)] shrink-0" />
            <span className="text-[11.5px] text-[var(--color-muted)] shrink-0">
              {tr("character.picker.claudeBadge")}
            </span>
            <CharacterAvatar character={firstClaudeChar} size={20} />
            <span className="text-[12.5px] font-medium text-[var(--color-text)] truncate">
              {firstClaudeChar.name}
            </span>
            <button
              onClick={() => {
                setStep("claude");
                setFirstClaudeId(null);
              }}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline shrink-0"
            >
              <ArrowLeft size={11} />
              {tr("character.picker.choose")}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 「キャラを選ぶ場合はここから」セクションヘッダ */}
          <div className="flex items-center gap-2 text-[11px] text-[var(--color-muted)]">
            <span className="h-px flex-1 bg-[var(--color-border)]" />
            <span className="px-2">
              {splitMode
                ? step === "claude"
                  ? tr("character.picker.splitClaudeHeader")
                  : tr("character.picker.splitCodexHeader")
                : tr("character.picker.singleHeader")}
            </span>
            <span className="h-px flex-1 bg-[var(--color-border)]" />
          </div>

          {/* User-created characters */}
          {userChars.length > 0 && (
            <section>
              <div className="text-[11px] font-semibold text-[var(--color-muted)] mb-2 uppercase tracking-wide flex items-center gap-1">
                <Users size={11} />
                {tr("character.picker.myCharacters")}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {userChars.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleSelect(c.id)}
                    className="text-left rounded-xl border border-[var(--color-border)] p-3 hover:shadow-md hover:-translate-y-0.5 transition bg-white"
                  >
                    <div className="flex items-center gap-3">
                      <CharacterAvatar character={c} size={48} />
                      <div className="min-w-0">
                        <div className="font-semibold text-sm truncate">
                          {c.name || tr("character.section.nameless")}
                        </div>
                        <div className="text-[11px] text-[var(--color-muted)] truncate">
                          {c.roleTag || "—"}
                        </div>
                      </div>
                    </div>
                    {c.description && (
                      <div className="mt-2 text-[12px] text-[var(--color-muted)] leading-relaxed line-clamp-2">
                        {c.description}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Empty state when no characters */}
          {userChars.length === 0 && !splitMode && (
            <section className="border border-dashed border-[var(--color-border)] rounded-xl p-6 text-center">
              <div className="flex justify-center mb-2 text-[var(--color-muted)]">
                <Sparkles size={24} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <h3 className="font-bold text-[14px] mb-1">
                {tr("character.picker.emptyTitle")}
              </h3>
              <p className="text-[12px] text-[var(--color-muted)] mb-3 leading-relaxed">
                {tr("character.picker.emptyBodyLine1")}
                <br />
                {tr("character.picker.emptyBodyLine2")}
              </p>
              <button
                onClick={onCreateNew}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
              >
                <Plus size={13} />
                {tr("character.picker.createFromScratch")}
              </button>
            </section>
          )}

          {/* Templates */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-semibold text-[var(--color-muted)] uppercase tracking-wide flex items-center gap-1">
                <Sparkles size={11} />
                {splitMode ? tr("character.picker.templatesSplit") : tr("character.picker.templatesSingle")}
              </div>
              {!splitMode && userChars.length > 0 && (
                <button
                  onClick={onCreateNew}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface)]"
                >
                  <Plus size={11} />
                  {tr("character.picker.createFromScratch")}
                </button>
              )}
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
              {splitMode
                ? tr("character.picker.templatesIntroSplit")
                : tr("character.picker.templatesIntroSingle")}
            </p>
            {/* AI タブ: 人格テンプレ（CEO/CDO 等）をどの AI で起動するかを切替える。 */}
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
              <span className="text-[10.5px] text-[var(--color-muted)] uppercase tracking-wide font-semibold">
                {tr("character.picker.launchAi")}
              </span>
              {TEMPLATE_PROVIDER_TABS.map((p) => {
                const selected = templateProvider === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setTemplateProvider(p)}
                    className={`px-2 py-0.5 rounded-md text-[11px] border transition inline-flex items-center gap-1 ${
                      selected
                        ? "bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-text)] font-semibold"
                        : "bg-white border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-surface)]"
                    }`}
                    aria-pressed={selected}
                  >
                    <CategoryDot provider={p} size={8} />
                    <span>{PROVIDER_LABELS[p]}</span>
                  </button>
                );
              })}
              <span className="text-[10px] text-[var(--color-muted)] ml-1">
                {tr("character.picker.normalNote")}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {TEMPLATE_CHARACTERS.map((t) => {
                const isNormal = isNormalTemplate(t);
                const launchProvider: Provider = isNormal
                  ? t.provider
                  : templateProvider;
                return (
                <button
                  key={t.id}
                  onClick={() => handleTemplateClick(t)}
                  className="flex items-center gap-2 border border-[var(--color-border)] rounded-md p-2 hover:bg-[var(--color-surface)] transition text-left"
                  title={tr("character.picker.tooltip", { provider: PROVIDER_LABELS[launchProvider], name: t.name })}
                >
                  <CharacterAvatar character={t} size={32} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[12.5px] truncate">
                      {t.name}
                    </div>
                    <div className="text-[10.5px] text-[var(--color-muted)] truncate inline-flex items-center gap-1">
                      <CategoryDot provider={launchProvider} size={8} />
                      <span>{PROVIDER_LABELS[launchProvider]}</span>
                      <span className="text-[var(--color-border)]">／</span>
                      <span>{t.roleTag}</span>
                    </div>
                  </div>
                </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
