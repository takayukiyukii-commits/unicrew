"use client";

import { useEffect, useState } from "react";
import { ChevronDown, FolderOpen, FolderCog } from "lucide-react";
import type { Thread, ModelId, Character, Provider } from "@/lib/types";
import { MODEL_LABELS } from "@/lib/types";
import {
  TEMPLATE_CHARACTERS,
  characterFor,
  getCharacter,
  loadUserCharacters,
} from "@/lib/characters";
import { getPersonality } from "@/lib/personalities";
import { CharacterAvatar } from "./CharacterAvatar";

interface Props {
  thread: Thread | null;
  onChangeCharacter: (characterId: string) => void;
  /** 並列モード時に provider 別にキャラを切替（claude / codex）。 */
  onChangeSplitCharacter?: (provider: Provider, characterId: string) => void;
  onChangeModel: (model: ModelId) => void;
  onChangeWorkspace: () => void;
}

export function RightPane({
  thread,
  onChangeCharacter,
  onChangeSplitCharacter,
  onChangeModel,
  onChangeWorkspace,
}: Props) {
  const character = thread ? getCharacter(thread.characterId) : undefined;
  const personality = character ? getPersonality(character.personalityId ?? "") : null;
  const claudeChar = thread ? characterFor(thread, "claude") : undefined;
  const codexChar = thread ? characterFor(thread, "codex") : undefined;
  const [userChars, setUserChars] = useState<Character[]>([]);
  useEffect(() => {
    setUserChars(loadUserCharacters());
  }, [thread?.characterId, thread?.splitCharacterIds]);
  return (
    <aside className="w-72 shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col overflow-y-auto">
      {!thread ? (
        <div className="p-6 text-xs text-[var(--color-muted)]">
          会話を開始すると、ここにキャラクター情報とモデル設定が表示されます。
        </div>
      ) : (
        <div className="p-5 space-y-5">
          {/* 単独モード: 1人ぶん大きく表示 */}
          {!thread.splitMode && character && (
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

          {/* 並列モード: 2人ぶんコンパクトに並べる */}
          {thread.splitMode && (
            <div className="space-y-2">
              <SplitCharacterCard
                provider="claude"
                badgeEmoji="🟠"
                badgeColor="#dd6b20"
                character={claudeChar}
              />
              <SplitCharacterCard
                provider="codex"
                badgeEmoji="🟢"
                badgeColor="#10a37f"
                character={codexChar}
              />
            </div>
          )}

          {/* 単独モードのキャラ切替 */}
          {!thread.splitMode && (
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

          {/* 並列モードのキャラ別切替 */}
          {thread.splitMode && onChangeSplitCharacter && (
            <div className="space-y-3">
              <div>
                <label className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
                  <span style={{ color: "#dd6b20" }}>🟠 Claude 側のキャラ</span>
                </label>
                <CharacterSelect
                  value={claudeChar?.id ?? thread.characterId}
                  onChange={(id) => onChangeSplitCharacter("claude", id)}
                  userChars={userChars}
                />
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
                  <span style={{ color: "#10a37f" }}>🟢 Codex 側のキャラ</span>
                </label>
                <CharacterSelect
                  value={codexChar?.id ?? thread.characterId}
                  onChange={(id) => onChangeSplitCharacter("codex", id)}
                  userChars={userChars}
                />
              </div>
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

function SplitCharacterCard({
  provider,
  badgeEmoji,
  badgeColor,
  character,
}: {
  provider: Provider;
  badgeEmoji: string;
  badgeColor: string;
  character: Character | undefined;
}) {
  void provider;
  return (
    <div className="flex items-center gap-2 border border-[var(--color-border)] rounded-md bg-white p-2">
      <span className="text-[14px]" style={{ color: badgeColor }}>
        {badgeEmoji}
      </span>
      {character ? (
        <>
          <CharacterAvatar character={character} size={32} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">
              {character.name}
            </div>
            <div className="truncate text-[10.5px] text-[var(--color-muted)]">
              {character.roleTag}
            </div>
          </div>
        </>
      ) : (
        <span className="text-[12px] text-[var(--color-muted)]">未設定</span>
      )}
    </div>
  );
}
