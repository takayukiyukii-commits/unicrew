"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  UserPlus,
  X,
  Gavel,
  Save,
  BookMarked,
  RefreshCw,
} from "lucide-react";
import type {
  Thread,
  ModelId,
  Character,
  ParticipantSlot,
  Provider,
} from "@/lib/types";
import { MODEL_LABELS, PROVIDER_LABELS } from "@/lib/types";
import { CategoryDot } from "@/lib/providerVisuals";
import { colorOf } from "@/lib/providerCategories";
import {
  TEMPLATE_CHARACTERS,
  characterFor,
  getCharacter,
  loadUserCharacters,
} from "@/lib/characters";
import { effectiveParticipants } from "@/lib/participants";
import { getPersonality } from "@/lib/personalities";
import { CharacterAvatar } from "./CharacterAvatar";
import { useTranslation } from "@/lib/i18n";
import {
  gitInitWorkspace,
  gitProbe,
  worktreeIntegrate,
  workspaceChanges,
  type GitProbe,
  type WorkspaceChanges as WorkspaceChangesResult,
} from "@/lib/tauri";
import { isolatedSlots } from "@/lib/worktree";
import { changeTargets, statusGlyph, turnBaseFor, type ChangeTarget } from "@/lib/changes";
import { openDiffInEditorWindow } from "@/lib/editor-window";
import { showToast } from "@/lib/toast";

interface Props {
  thread: Thread | null;
  /**
   * true の場合、編集対象のスレッドが「並列ペインの一つ（主ペインではない）」であることを示す。
   * RightPane 上部に「このペインを編集中」のバナーを出して、ユーザーに編集対象を明示する。
   */
  isFocusedFromSplit?: boolean;
  onChangeCharacter: (characterId: string) => void;
  /**
   * 単独モード：現キャラを動かす AI（provider）を切替える。テンプレならクローン+保存、
   * ユーザーキャラなら直接書換（実装側で対応）。
   */
  /**
   * 並列モード時に slot 別にキャラを切替する。
   * 旧2way時は slotId が "claude"/"codex" になる（Provider と一致）。
   */
  onChangeSplitCharacter?: (slotId: string, characterId: string) => void;
  /** 並列モード時に slot 別の AI（provider）を切替する。CEO×Codex のような組合せに対応。 */
  onChangeSlotProvider?: (slotId: string, provider: Provider) => void;
  /** N-way参加者を追加する。 */
  onAddParticipant?: (slot: Omit<ParticipantSlot, "id">) => void;
  /** N-way参加者を削除する。 */
  onRemoveParticipant?: (slotId: string) => void;
  /** 現在の participants 構成を新規チームとして保存する。 */
  onSaveAsTeam?: (meta: { name: string; description: string; emoji: string }) => void;
  /** 現在の participants 構成を JSON エクスポートする（クリップボード）。 */
  onExportTeamJson?: () => void;
  onChangeModel: (model: ModelId) => void;
  /**
   * このスレッドで AI に覚えておいてほしいこと（Memory.md 方式）の編集ハンドラ。
   * 値は string、空文字でクリア。
   */
  onChangePersistentMemory?: (memo: string) => void;
}

export function RightPane({
  thread,
  isFocusedFromSplit = false,
  onChangeCharacter,
  onChangeSplitCharacter,
  onChangeSlotProvider,
  onAddParticipant,
  onRemoveParticipant,
  onSaveAsTeam,
  onExportTeamJson,
  onChangeModel,
  onChangePersistentMemory,
}: Props) {
  const { t } = useTranslation();
  const character = thread ? getCharacter(thread.characterId) : undefined;
  const personality = character ? getPersonality(character.personalityId ?? "") : null;
  const slots: ParticipantSlot[] = thread ? effectiveParticipants(thread) : [];
  const isParallel = slots.length >= 2;
  // characterFor は旧2way互換のため import 残置（type-checkを通すための noop 参照）
  void characterFor;
  const [userChars, setUserChars] = useState<Character[]>([]);
  useEffect(() => {
    setUserChars(loadUserCharacters());
  }, [thread?.characterId, thread?.splitCharacterIds, thread?.participants]);

  const participantCount = slots.filter(
    (s) => s.role !== "moderator",
  ).length;
  const hasModerator = slots.some((s) => s.role === "moderator");
  // MODEL_LABELS は Claude 系モデルしか定義されていないため、Claude を使うプロバイダが
  // 1人もいない時に「モデル」セレクトを出すと、ユーザーが Codex/Gemini/OpenCode 等を
  // 動かしているのに Claude モデル切替UIが見えて混乱する。Claude が含まれる時だけ表示する。
  const showModelSection = isParallel
    ? slots.some((s) => s.provider === "claude")
    : character?.provider === "claude";
  return (
    <aside className="w-72 shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col overflow-y-auto">
      {!thread ? (
        <div className="p-6 text-xs text-[var(--color-muted)]">
          {t("rightPane.startConversationHint")}
        </div>
      ) : (
        <div className="p-5 space-y-5">
          {isFocusedFromSplit && (
            <div className="rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-2 text-[11.5px] text-[var(--color-accent)] leading-snug">
              <span className="font-semibold">{t("rightPane.splitEditingLabel")}</span>
              <span className="text-[var(--color-muted)]">
                {t("rightPane.splitEditingSep")}{thread.title || t("rightPane.splitEditingUntitled")}{t("rightPane.splitEditingClose")}
              </span>
              <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5">
                {t("rightPane.splitEditingHint")}
              </div>
            </div>
          )}
          {/* 単独モード: 1人ぶん大きく表示 */}
          {!isParallel && character && (
            <div className="text-center">
              <CharacterAvatar
                character={character}
                size={84}
                className="mx-auto"
              />
              <div className="mt-3 font-bold text-[15px]">{character.name}</div>
              <div className="text-[12px] text-[var(--color-muted)]">
                {character.roleTag}
              </div>
              {personality && (
                <div className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-[var(--color-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] px-1.5 py-0.5 rounded-full">
                  <span>{personality.label}</span>
                </div>
              )}
              <div className="mt-2 text-[12px] leading-relaxed text-[var(--color-muted)] px-2">
                {character.description}
              </div>
            </div>
          )}

          {/* 単独モードのキャラ切替 */}
          {!isParallel && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold text-[var(--color-muted)] uppercase tracking-wide">
                {t("rightPane.characterLabel")}
              </label>
              <CharacterSelect
                value={thread.characterId}
                onChange={onChangeCharacter}
                userChars={userChars}
              />
            </div>
          )}

          {/* 並列モード（N-way対応）: 参加者リスト + 追加・削除 */}
          {isParallel && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="block text-[11px] font-semibold text-[var(--color-muted)] uppercase tracking-wide">
                  {t("rightPane.participantsLabel").replace("{count}", String(participantCount))}
                  {hasModerator && (
                    <span className="ml-1 text-amber-700 normal-case font-medium">
                      {t("rightPane.withModerator")}
                    </span>
                  )}
                </label>
              </div>
              <div className="space-y-2">
                {slots.map((slot) => (
                  <ParticipantCard
                    key={slot.id}
                    slot={slot}
                    character={getCharacter(slot.characterId)}
                    userChars={userChars}
                    onChangeCharacter={
                      onChangeSplitCharacter
                        ? (id) => onChangeSplitCharacter(slot.id, id)
                        : undefined
                    }
                    onChangeProvider={
                      onChangeSlotProvider && slot.role !== "moderator"
                        ? (p) => onChangeSlotProvider(slot.id, p)
                        : undefined
                    }
                    onRemove={
                      onRemoveParticipant && participantCount > 2
                        ? () => onRemoveParticipant(slot.id)
                        : undefined
                    }
                  />
                ))}
              </div>

              {/* worktree 隔離（v0.4.0）: 作業場の状態と取り込み */}
              <WorkspaceIsolation thread={thread} />

              {/* 参加者追加ボタン群（最大4人＋審判1人まで） */}
              {onAddParticipant && (
                <div className="space-y-1.5 pt-1">
                  {participantCount < 4 && (
                    <AddParticipantMenu
                      onAdd={onAddParticipant}
                      userChars={userChars}
                      role="participant"
                    />
                  )}
                  {!hasModerator && participantCount >= 2 && (
                    <AddParticipantMenu
                      onAdd={onAddParticipant}
                      userChars={userChars}
                      role="moderator"
                    />
                  )}
                </div>
              )}

              {/* チーム保存ボタン：今の構成をテンプレ化 */}
              {onSaveAsTeam && participantCount >= 2 && (
                <SaveAsTeamButton onSave={onSaveAsTeam} />
              )}
              {/* チーム JSON エクスポート：他人と共有・配布するため */}
              {onExportTeamJson && participantCount >= 2 && (
                <button
                  type="button"
                  onClick={onExportTeamJson}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 mt-1 rounded-md border border-dashed border-sky-200 text-[11.5px] text-sky-700 hover:bg-sky-50 transition"
                  title={t("rightPane.exportTeamJsonTitle")}
                >
                  <Save size={11} />
                  {t("rightPane.exportTeamJson")}
                </button>
              )}
            </div>
          )}

          {/* 変更の差分ビュー（v0.4.0）: 単独・並列どちらでも1ブロック */}
          <WorkspaceChanges thread={thread} />

          {showModelSection && (
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
                {t("rightPane.modelLabel")}
                {isParallel && (
                  <span className="ml-1.5 normal-case font-normal text-[10px] text-[var(--color-muted)]">
                    {t("rightPane.modelClaudeOnly")}
                  </span>
                )}
              </label>
              <div className="relative">
                <select
                  value={thread.model}
                  onChange={(e) => onChangeModel(e.target.value as ModelId)}
                  className="w-full appearance-none border border-[var(--color-border)] rounded-md px-3 py-2 text-sm bg-white pr-8"
                >
                  {(Object.keys(MODEL_LABELS) as ModelId[]).map((m) => (
                    <option key={m} value={m}>
                      {MODEL_LABELS[m]}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-muted)]"
                />
              </div>
            </div>
          )}

          {onChangePersistentMemory && (
            <PersistentMemorySection
              value={thread.persistentMemory ?? ""}
              onChange={onChangePersistentMemory}
            />
          )}

          {/*
           * ワークスペース変更 UI は左の「エクスプローラー」列に集約済み。
           * 右サイドバーから二重に編集できると、Explorer 側に変更が反映されない混乱を生むため削除。
           */}

          <div className="pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-muted)] leading-relaxed">
            <div className="font-semibold mb-1 text-[var(--color-text)]">
              {t("rightPane.canDoTitle")}
            </div>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>{t("rightPane.canDoCharSwitch")}</li>
              {thread.splitMode && (
                <li>{t("rightPane.canDoSplit")}</li>
              )}
              {showModelSection && (
                <li>{t("rightPane.canDoModel")}</li>
              )}
              <li>{t("rightPane.canDoWorkspace")}</li>
            </ul>
          </div>
        </div>
      )}
    </aside>
  );
}

function CharacterSelect({
  value,
  onChange,
  userChars,
}: {
  value: string;
  onChange: (id: string) => void;
  userChars: Character[];
}) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none border border-[var(--color-border)] rounded-md px-3 py-2 text-sm bg-white pr-8"
      >
        {userChars.length > 0 && (
          <optgroup label={t("rightPane.charOptgroupUser")}>
            {userChars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || t("rightPane.charUnnamed")}
                {c.roleTag ? `${t("chat.parallelOpenParen")}${c.roleTag}${t("chat.parallelCloseParen")}` : ""}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label={t("rightPane.charOptgroupTemplate")}>
          {TEMPLATE_CHARACTERS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{t("chat.parallelOpenParen")}{c.roleTag}{t("chat.parallelCloseParen")}
            </option>
          ))}
        </optgroup>
      </select>
      <ChevronDown
        size={14}
        className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-muted)]"
      />
    </div>
  );
}

/**
 * 参加者1人ぶんのカード。N-way対応。
 *
 * - キャラ選択 select
 * - role が moderator なら審判アイコン＋枠色変更
 * - 削除可能（最低2人は残す前提で、3人目以降のみ × 表示）
 */
function ParticipantCard({
  slot,
  character,
  userChars,
  onChangeCharacter,
  onChangeProvider,
  onRemove,
}: {
  slot: ParticipantSlot;
  character: Character | undefined;
  userChars: Character[];
  onChangeCharacter?: (characterId: string) => void;
  onChangeProvider?: (provider: Provider) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const isModerator = slot.role === "moderator";
  // プロバイダ色は lib/providerCategories の CATEGORY_COLORS に集約済み（4 色）。
  // 個別色テーブルを再定義しない。新プロバイダ追加時に毎回ここを直すと UI 崩壊する。
  const accent = colorOf(slot.provider);
  return (
    <div
      className={`border rounded-md p-2 ${
        isModerator
          ? "bg-amber-50/40 border-amber-200"
          : "bg-white border-[var(--color-border)]"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {isModerator ? (
          <Gavel size={12} className="text-amber-700 shrink-0" />
        ) : (
          <CategoryDot provider={slot.provider} size={9} />

        )}
        <span
          className="text-[10.5px] font-semibold uppercase tracking-wide shrink-0"
          style={{ color: isModerator ? "#b45309" : accent }}
        >
          {isModerator ? t("rightPane.moderator") : PROVIDER_LABELS[slot.provider]}
        </span>
        {character && (
          <CharacterAvatar character={character} size={20} />
        )}
        {character ? (
          <span className="truncate text-[12px] font-medium">
            {character.name}
          </span>
        ) : (
          <span className="text-[11.5px] text-[var(--color-muted)]">{t("rightPane.notSet")}</span>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto p-0.5 rounded hover:bg-red-50 text-[var(--color-muted)] hover:text-red-500 shrink-0"
            title={t("rightPane.removeParticipantTitle")}
            aria-label={t("rightPane.removeParticipantAria")}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {onChangeCharacter && (
        <CharacterSelect
          value={slot.characterId}
          onChange={onChangeCharacter}
          userChars={userChars}
        />
      )}
      {onChangeProvider && (
        <div className="mt-1.5">
          <ProviderToggle
            current={slot.provider}
            onChange={onChangeProvider}
            hint={t("rightPane.providerHintSlot")}
            compact
          />
        </div>
      )}
    </div>
  );
}

/**
 * AI（provider）切替用の小さなセグメントコントロール。
 * Claude / Codex / Gemini を色玉付きピルで並べる。
 */
function ProviderToggle({
  current,
  onChange,
  hint,
  compact = false,
}: {
  current: Provider;
  onChange: (p: Provider) => void;
  hint?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const providers: Provider[] = ["claude", "codex", "gemini"];
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 flex-wrap">
        <span
          className={`text-[10.5px] uppercase tracking-wide text-[var(--color-muted)] font-semibold ${
            compact ? "" : "mr-1"
          }`}
        >
          {t("rightPane.providerLabelShort")}
        </span>
        {providers.map((p) => {
          const selected = current === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={`px-2 py-0.5 rounded text-[10.5px] border transition inline-flex items-center gap-1 ${
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
      </div>
      {!compact && hint && (
        <div className="text-[10px] text-[var(--color-muted)] leading-snug">
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * 現在の参加者構成を「チーム」として保存するインライン展開ボタン。
 *
 * 押すと name / description / emoji の入力欄が出て、保存ボタンで onSave 発火。
 * 保存されたチームは「ファイル」メニューから再利用できる。
 */
function SaveAsTeamButton({
  onSave,
}: {
  onSave: (meta: { name: string; description: string; emoji: string }) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  return (
    <div className="border border-dashed border-emerald-200 rounded-md mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11.5px] text-emerald-700 hover:bg-emerald-50 transition"
      >
        <Save size={11} />
        {t("rightPane.saveAsTeamLabel")}
      </button>
      {open && (
        <div className="px-2 py-2 space-y-1.5 border-t border-emerald-200 bg-emerald-50/40">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("rightPane.teamNamePlaceholder")}
            className="w-full border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white outline-none focus:border-[var(--color-accent)]"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder={t("rightPane.teamDescPlaceholder")}
            className="w-full resize-none border border-[var(--color-border)] rounded-md px-2 py-1 text-[11.5px] bg-white outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setName("");
                setDescription("");
              }}
              className="flex-1 px-2 py-1 rounded border border-[var(--color-border)] text-[11px] text-[var(--color-muted)] hover:bg-white"
            >
              {t("rightPane.cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!name.trim()) return;
                // emoji フィールドは絵文字レス方針のため空文字で保存（描画側は無視）。
                onSave({
                  name: name.trim(),
                  description: description.trim(),
                  emoji: "",
                });
                setOpen(false);
                setName("");
                setDescription("");
              }}
              disabled={!name.trim()}
              className="flex-1 px-2 py-1 rounded text-[11px] text-white font-medium bg-emerald-600 disabled:opacity-40"
            >
              {t("rightPane.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 参加者を追加するためのドロップダウン。
 *
 * Provider と Character を1ステップで選ばせる：optgroup で provider を分け、
 * 配下のテンプレ・ユーザーキャラから選ぶ。選択 → onAdd 発火。
 */
function AddParticipantMenu({
  onAdd,
  userChars,
  role,
}: {
  onAdd: (slot: Omit<ParticipantSlot, "id">) => void;
  userChars: Character[];
  role: "participant" | "moderator";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider>("claude");
  const [selectedCharId, setSelectedCharId] = useState<string>(
    userChars[0]?.id ?? TEMPLATE_CHARACTERS[0]?.id ?? "",
  );

  const isModerator = role === "moderator";

  return (
    <div className="border border-dashed border-[var(--color-border)] rounded-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11.5px] transition ${
          isModerator
            ? "text-amber-800 hover:bg-amber-50"
            : "text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        }`}
      >
        {isModerator ? <Gavel size={11} /> : <UserPlus size={11} />}
        {isModerator ? t("rightPane.addModerator") : t("rightPane.addParticipant")}
      </button>
      {open && (
        <div className="px-2 py-2 space-y-1.5 border-t border-[var(--color-border)] bg-[var(--color-surface)]/40">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-muted)] mb-0.5">
              {t("rightPane.providerSelectLabel")}
            </label>
            <div className="relative">
              <select
                value={selectedProvider}
                onChange={(e) =>
                  setSelectedProvider(e.target.value as Provider)
                }
                className="w-full appearance-none border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white pr-7"
              >
                <option value="claude">{t("rightPane.providerOptionClaude")}</option>
                <option value="codex">{t("rightPane.providerOptionCodex")}</option>
                <option value="gemini">{t("rightPane.providerOptionGemini")}</option>
              </select>
              <ChevronDown
                size={11}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-muted)]"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-muted)] mb-0.5">
              {t("rightPane.characterLabel")}
            </label>
            <CharacterSelect
              value={selectedCharId}
              onChange={setSelectedCharId}
              userChars={userChars}
            />
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex-1 px-2 py-1 rounded border border-[var(--color-border)] text-[11px] text-[var(--color-muted)] hover:bg-white"
            >
              {t("rightPane.cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!selectedCharId) return;
                onAdd({
                  provider: selectedProvider,
                  characterId: selectedCharId,
                  role,
                });
                setOpen(false);
              }}
              disabled={!selectedCharId}
              className={`flex-1 px-2 py-1 rounded text-[11px] text-white font-medium disabled:opacity-40 ${
                isModerator ? "bg-amber-600" : "bg-[var(--color-accent)]"
              }`}
            >
              {t("rightPane.add")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * このスレッドで AI に覚えておいてほしいこと（Memory.md 方式）。
 *
 * - 自由記述。空欄でクリア。
 * - 各送信時、system_prompt の先頭に「## ユーザーが覚えてほしいこと」として注入される
 *   （注入は app/page.tsx 側で行う）
 * - 親 thread が切り替わったら表示も同期する。
 */
function PersistentMemorySection({
  value,
  onChange,
}: {
  value: string;
  onChange: (memo: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(value.length > 0);
  useEffect(() => {
    setDraft(value);
    setOpen(value.length > 0);
  }, [value]);

  const dirty = draft !== value;
  const charCount = draft.length;
  const tooLong = charCount > 4000;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide hover:text-[var(--color-text)]"
      >
        <span className="flex items-center gap-1.5">
          <BookMarked size={11} />
          {t("rightPane.memoryTitle")}
          {value.length > 0 && (
            <span className="ml-1 normal-case font-normal text-[10px] bg-[var(--color-accent-soft)] text-[var(--color-accent)] px-1 py-0.5 rounded">
              {t("rightPane.memoryOn")}
            </span>
          )}
        </span>
        <ChevronDown
          size={11}
          className={`transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder={t("rightPane.memoryPlaceholder")}
            className="w-full resize-y border border-[var(--color-border)] rounded-md px-2 py-1.5 text-[12px] bg-white outline-none focus:border-[var(--color-accent)] font-mono leading-relaxed min-h-[80px]"
          />
          <div className="flex items-center gap-2 text-[10.5px] text-[var(--color-muted)]">
            <span className={tooLong ? "text-red-500 font-medium" : ""}>
              {charCount}{t("rightPane.memoryCountSuffix")}
            </span>
            <span className="ml-auto">
              {dirty ? t("rightPane.memoryUnsaved") : t("rightPane.memorySaved")}
            </span>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setDraft(value)}
              disabled={!dirty}
              className="flex-1 px-2 py-1 rounded border border-[var(--color-border)] text-[11px] text-[var(--color-muted)] hover:bg-white disabled:opacity-40"
            >
              {t("rightPane.memoryRevert")}
            </button>
            <button
              type="button"
              onClick={() => onChange(draft)}
              disabled={!dirty || tooLong}
              className="flex-1 px-2 py-1 rounded text-[11px] text-white font-medium bg-[var(--color-accent)] disabled:opacity-40"
            >
              {t("rightPane.memorySave")}
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-[var(--color-muted)]">
            {t("rightPane.memoryFooter")}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * worktree 隔離（v0.4.0）の状態表示と取り込み。
 * 足す表示は「1行＋隔離中スロットの行」だけ（UI複雑化5原則）。プロバイダ毎の節や色は作らない。
 */
function WorkspaceIsolation({ thread }: { thread: Thread }) {
  const { t } = useTranslation();
  const [probe, setProbe] = useState<GitProbe | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ws = thread.workspace;
  const slots = isolatedSlots(thread);
  const refresh = useCallback(() => {
    if (!ws) return;
    gitProbe(ws)
      .then(setProbe)
      .catch(() => setProbe(null));
  }, [ws]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  if (!ws) return null;

  const integrate = async (slot: ParticipantSlot, mode: "merge" | "patch") => {
    if (!slot.worktreeBranch) return;
    setBusy(slot.id);
    try {
      const r = await worktreeIntegrate(ws, slot.worktreeBranch, mode);
      const extra = r.conflicts.length > 0 ? ` / ${t("rightPane.isolation.conflicts")}: ${r.conflicts.join(", ")}` : "";
      const patch = r.patch_path ? ` → ${r.patch_path}` : "";
      showToast(`${r.message}${extra}${patch}`, r.ok ? "info" : "error");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const init = async () => {
    setBusy("init");
    try {
      showToast(await gitInitWorkspace(ws));
      refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const btn =
    "shrink-0 px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[11px] text-[var(--color-text)] hover:opacity-80 disabled:opacity-50";

  return (
    <div className="rounded-md border border-[var(--color-border)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--color-muted)] space-y-1.5">
      {slots.length > 0 ? (
        <>
          <div className="font-semibold text-[var(--color-text)]">
            {t("rightPane.isolation.active").replace("{count}", String(slots.length))}
          </div>
          {slots.map((s) => {
            const c = getCharacter(s.characterId);
            return (
              <div key={s.id} className="flex items-center gap-1.5">
                <span className="flex-1 min-w-0 truncate" title={s.worktreePath}>
                  {c?.name ?? s.id} <span className="opacity-70">({s.worktreeBranch})</span>
                </span>
                <button type="button" className={btn} disabled={busy !== null} onClick={() => integrate(s, "merge")}>
                  {t("rightPane.isolation.merge")}
                </button>
                <button type="button" className={btn} disabled={busy !== null} onClick={() => integrate(s, "patch")}>
                  {t("rightPane.isolation.patch")}
                </button>
              </div>
            );
          })}
          <div className="opacity-80">{t("rightPane.isolation.hint")}</div>
        </>
      ) : probe && !probe.is_repo ? (
        <div className="flex items-center gap-2">
          <span className="flex-1">{t("rightPane.isolation.noGit")}</span>
          <button type="button" className={btn} disabled={busy !== null} onClick={init}>
            {t("rightPane.isolation.gitInit")}
          </button>
        </div>
      ) : probe && !probe.has_head ? (
        <div className="flex items-center gap-2">
          <span className="flex-1">{t("rightPane.isolation.noHead")}</span>
          <button type="button" className={btn} disabled={busy !== null} onClick={init}>
            {t("rightPane.isolation.firstCommit")}
          </button>
        </div>
      ) : (
        <div>{t("rightPane.isolation.pending")}</div>
      )}
    </div>
  );
}

/**
 * 変更の差分ビュー（v0.4.0）。AI が動いた後に「何が変わったか」を一覧で見せ、クリックで
 * エディタウィンドウに左右比較（読み取り専用）を開く。足す表示は1ブロックだけ。
 * 基準は「このターン」（送信時に記録した tree）か「コミット後すべて」（HEAD）。
 * worktree 隔離中は対象（作業フォルダ／各参加者）をプルダウン1つで切り替える。
 */
function WorkspaceChanges({ thread }: { thread: Thread }) {
  const { t } = useTranslation();
  const targets = changeTargets(thread);
  const [targetKey, setTargetKey] = useState("workspace");
  const [mode, setMode] = useState<"turn" | "head">("turn");
  const [result, setResult] = useState<WorkspaceChangesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = targets.find((x) => x.key === targetKey) ?? targets[0];
  const cwd = target?.cwd;
  const turnBase = cwd ? turnBaseFor(thread, cwd) : undefined;
  const effectiveMode: "turn" | "head" = mode === "turn" && turnBase ? "turn" : "head";
  const sinceRef = effectiveMode === "turn" ? turnBase : undefined;
  // 手動更新用のカウンタ（押すたびに数え直す）
  const [tick, setTick] = useState(0);
  // 会話が進む（updatedAt）・対象や基準が変わる・手動更新のたびに、少し遅らせて数え直す（連続更新の間引き）
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const h = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await workspaceChanges(cwd, sinceRef);
        if (cancelled) return;
        setResult(r);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setResult(null);
        setError(msg === "NOT_A_REPO" ? null : msg);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [cwd, sinceRef, thread.updatedAt, tick]);
  if (!cwd || !target) return null;
  if (!result && !error) return null; // git 管理外（NOT_A_REPO）か未取得

  const files = result?.files ?? [];
  const nameOf = (x: ChangeTarget) =>
    x.slot ? (getCharacter(x.slot.characterId)?.name ?? x.key) : t("rightPane.changes.workspace");
  const btn =
    "shrink-0 px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[11px] text-[var(--color-text)] hover:opacity-80 disabled:opacity-50";
  const pill = (active: boolean) =>
    `px-1.5 py-0.5 rounded text-[10.5px] border ${
      active
        ? "border-[var(--color-accent)] text-[var(--color-accent)]"
        : "border-[var(--color-border)] text-[var(--color-muted)]"
    } disabled:opacity-50`;

  return (
    <div className="rounded-md border border-[var(--color-border)] px-2.5 py-2 text-[11.5px] leading-relaxed text-[var(--color-muted)] space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="font-semibold text-[var(--color-text)] flex-1 min-w-0 truncate">
          {t("rightPane.changes.title")}
          {result ? ` (${files.length})` : ""}
        </span>
        {result && files.length > 0 && (
          <span className="text-[10.5px] font-mono">
            <span className="text-emerald-600">+{result.additions}</span>{" "}
            <span className="text-rose-600">−{result.deletions}</span>
          </span>
        )}
        <button
          type="button"
          className={btn}
          disabled={busy}
          onClick={() => setTick((n) => n + 1)}
          title={t("rightPane.changes.refresh")}
        >
          <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        <button
          type="button"
          className={pill(effectiveMode === "turn")}
          disabled={!turnBase}
          onClick={() => setMode("turn")}
          title={!turnBase ? t("rightPane.changes.noTurnHint") : undefined}
        >
          {t("rightPane.changes.sinceTurn")}
        </button>
        <button type="button" className={pill(effectiveMode === "head")} onClick={() => setMode("head")}>
          {t("rightPane.changes.sinceHead")}
        </button>
        {targets.length > 1 && (
          <select
            value={target.key}
            onChange={(e) => setTargetKey(e.target.value)}
            className="ml-auto max-w-[120px] text-[10.5px] border border-[var(--color-border)] rounded px-1 py-0.5 bg-white text-[var(--color-text)]"
          >
            {targets.map((x) => (
              <option key={x.key} value={x.key}>
                {nameOf(x)}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <div className="text-rose-600 break-all">{error}</div>}
      {result && files.length === 0 && <div className="opacity-80">{t("rightPane.changes.empty")}</div>}
      {files.length > 0 && (
        <ul className="max-h-56 overflow-y-auto space-y-0.5" title={t("rightPane.changes.openDiff")}>
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className="w-full flex items-center gap-1.5 text-left hover:bg-[var(--color-accent-soft)] rounded px-1"
                onClick={() =>
                  void openDiffInEditorWindow({
                    workspace: cwd,
                    file: f.path,
                    base: result?.base,
                    label: target.slot ? nameOf(target) : undefined,
                  })
                }
              >
                <span className="w-3 shrink-0 text-center font-mono">{statusGlyph(f.status)}</span>
                <span
                  className="flex-1 min-w-0 truncate font-mono text-[10.5px] text-[var(--color-text)]"
                  title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                >
                  {f.path}
                </span>
                {f.binary ? (
                  <span className="shrink-0 text-[10px]">{t("rightPane.changes.binary")}</span>
                ) : (
                  <span className="shrink-0 text-[10px] font-mono">
                    <span className="text-emerald-600">+{f.additions}</span>{" "}
                    <span className="text-rose-600">−{f.deletions}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {result?.truncated && (
        <div className="opacity-80">{t("rightPane.changes.truncated", { count: files.length })}</div>
      )}
    </div>
  );
}
