"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  FolderCog,
  UserPlus,
  X,
  Gavel,
  Save,
} from "lucide-react";
import type {
  Thread,
  ModelId,
  Character,
  ParticipantSlot,
  Provider,
} from "@/lib/types";
import { MODEL_LABELS, PROVIDER_BADGES, PROVIDER_LABELS } from "@/lib/types";
import {
  TEMPLATE_CHARACTERS,
  characterFor,
  getCharacter,
  loadUserCharacters,
} from "@/lib/characters";
import { effectiveParticipants } from "@/lib/participants";
import { getPersonality } from "@/lib/personalities";
import { CharacterAvatar } from "./CharacterAvatar";

interface Props {
  thread: Thread | null;
  onChangeCharacter: (characterId: string) => void;
  /**
   * 並列モード時に slot 別にキャラを切替する。
   * 旧2way時は slotId が "claude"/"codex" になる（Provider と一致）。
   */
  onChangeSplitCharacter?: (slotId: string, characterId: string) => void;
  /** N-way参加者を追加する。 */
  onAddParticipant?: (slot: Omit<ParticipantSlot, "id">) => void;
  /** N-way参加者を削除する。 */
  onRemoveParticipant?: (slotId: string) => void;
  /** 現在の participants 構成を新規チームとして保存する。 */
  onSaveAsTeam?: (meta: { name: string; description: string; emoji: string }) => void;
  /** 現在の participants 構成を JSON エクスポートする（クリップボード）。 */
  onExportTeamJson?: () => void;
  onChangeModel: (model: ModelId) => void;
  onChangeWorkspace: () => void;
}

export function RightPane({
  thread,
  onChangeCharacter,
  onChangeSplitCharacter,
  onAddParticipant,
  onRemoveParticipant,
  onSaveAsTeam,
  onExportTeamJson,
  onChangeModel,
  onChangeWorkspace,
}: Props) {
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
  return (
    <aside className="w-72 shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col overflow-y-auto">
      {!thread ? (
        <div className="p-6 text-xs text-[var(--color-muted)]">
          会話を開始すると、ここにキャラクター情報とモデル設定が表示されます。
        </div>
      ) : (
        <div className="p-5 space-y-5">
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
                  <span>{personality.emoji}</span>
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
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
                キャラクター
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
                  参加者（{participantCount}人）
                  {hasModerator && (
                    <span className="ml-1 text-amber-700 normal-case font-medium">
                      ＋審判
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
                    onRemove={
                      onRemoveParticipant && participantCount > 2
                        ? () => onRemoveParticipant(slot.id)
                        : undefined
                    }
                  />
                ))}
              </div>

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
                  title="この構成を JSON でクリップボードにコピー（共有用）"
                >
                  <Save size={11} />
                  JSONでコピー（チーム共有）
                </button>
              )}
            </div>
          )}

          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
              モデル
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

          <div>
            <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
              ワークスペース
            </label>
            <div className="border border-[var(--color-border)] rounded-md bg-white p-2 text-[12px]">
              <div className="flex items-center gap-1.5 mb-1.5 text-[var(--color-muted)]">
                <FolderOpen size={12} />
                <span className="truncate font-mono" title={thread.workspace ?? undefined}>
                  {thread.workspace?.split(/[/\\]/).pop() ?? "未設定"}
                </span>
              </div>
              <button
                onClick={onChangeWorkspace}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] text-[11.5px] text-[var(--color-text)]"
              >
                <FolderCog size={12} />
                フォルダを変更
              </button>
            </div>
            <div className="text-[10.5px] text-[var(--color-muted)] mt-1 leading-relaxed">
              ファイル編集やコマンドは、このフォルダの中で行われます。
            </div>
          </div>

          <div className="pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-muted)] leading-relaxed">
            <div className="font-semibold mb-1 text-[var(--color-text)]">
              この画面でできること
            </div>
            <ul className="list-disc pl-4 space-y-0.5">
              <li>キャラ切替で口調と専門が変わる</li>
              {thread.splitMode && (
                <li>並列モードでは Claude / Codex に別人格を割り当て可能</li>
              )}
              <li>モデルは応答の質と速度のトレードオフ</li>
              <li>ワークスペースは作業対象のフォルダ</li>
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
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none border border-[var(--color-border)] rounded-md px-3 py-2 text-sm bg-white pr-8"
      >
        {userChars.length > 0 && (
          <optgroup label="マイキャラクター">
            {userChars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji} {c.name || "（名前未設定）"}
                {c.roleTag ? `（${c.roleTag}）` : ""}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="テンプレート">
          {TEMPLATE_CHARACTERS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.emoji} {c.name}（{c.roleTag}）
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
  onRemove,
}: {
  slot: ParticipantSlot;
  character: Character | undefined;
  userChars: Character[];
  onChangeCharacter?: (characterId: string) => void;
  onRemove?: () => void;
}) {
  const isModerator = slot.role === "moderator";
  const colorByProvider: Record<Provider, string> = {
    claude: "#dd6b20",
    codex: "#10a37f",
    gemini: "#4285f4",
  };
  const accent = colorByProvider[slot.provider];
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
          <span className="text-[12px] shrink-0" style={{ color: accent }}>
            {PROVIDER_BADGES[slot.provider]}
          </span>
        )}
        <span
          className="text-[10.5px] font-semibold uppercase tracking-wide shrink-0"
          style={{ color: isModerator ? "#b45309" : accent }}
        >
          {isModerator ? "中立審判" : PROVIDER_LABELS[slot.provider]}
        </span>
        {character && (
          <CharacterAvatar character={character} size={20} />
        )}
        {character ? (
          <span className="truncate text-[12px] font-medium">
            {character.name}
          </span>
        ) : (
          <span className="text-[11.5px] text-[var(--color-muted)]">未設定</span>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto p-0.5 rounded hover:bg-red-50 text-[var(--color-muted)] hover:text-red-500 shrink-0"
            title="この参加者を削除"
            aria-label="この参加者を削除"
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
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("✨");

  return (
    <div className="border border-dashed border-emerald-200 rounded-md mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11.5px] text-emerald-700 hover:bg-emerald-50 transition"
      >
        <Save size={11} />
        この構成をチームとして保存
      </button>
      {open && (
        <div className="px-2 py-2 space-y-1.5 border-t border-emerald-200 bg-emerald-50/40">
          <div className="flex gap-1.5">
            <input
              type="text"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value || "✨")}
              maxLength={2}
              className="w-10 text-center border border-[var(--color-border)] rounded-md px-1 py-1 text-[14px] bg-white"
              title="絵文字"
            />
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="チーム名（例：UNI企画レビュー会）"
              className="flex-1 border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="どんなときに使うか（任意）"
            className="w-full resize-none border border-[var(--color-border)] rounded-md px-2 py-1 text-[11.5px] bg-white outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setName("");
                setDescription("");
                setEmoji("✨");
              }}
              className="flex-1 px-2 py-1 rounded border border-[var(--color-border)] text-[11px] text-[var(--color-muted)] hover:bg-white"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => {
                if (!name.trim()) return;
                onSave({
                  name: name.trim(),
                  description: description.trim(),
                  emoji: emoji.trim() || "✨",
                });
                setOpen(false);
                setName("");
                setDescription("");
                setEmoji("✨");
              }}
              disabled={!name.trim()}
              className="flex-1 px-2 py-1 rounded text-[11px] text-white font-medium bg-emerald-600 disabled:opacity-40"
            >
              保存
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
        {isModerator ? "中立審判を追加" : "参加者を追加"}
      </button>
      {open && (
        <div className="px-2 py-2 space-y-1.5 border-t border-[var(--color-border)] bg-[var(--color-surface)]/40">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-muted)] mb-0.5">
              AI（プロバイダ）
            </label>
            <div className="relative">
              <select
                value={selectedProvider}
                onChange={(e) =>
                  setSelectedProvider(e.target.value as Provider)
                }
                className="w-full appearance-none border border-[var(--color-border)] rounded-md px-2 py-1 text-[12px] bg-white pr-7"
              >
                <option value="claude">🟠 Claude</option>
                <option value="codex">🟢 Codex</option>
                <option value="gemini">🔵 Gemini（gemini-cli 必須）</option>
              </select>
              <ChevronDown
                size={11}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-muted)]"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-[var(--color-muted)] mb-0.5">
              キャラクター
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
              キャンセル
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
              追加
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
