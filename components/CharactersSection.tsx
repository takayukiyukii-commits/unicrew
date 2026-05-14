"use client";

import { useEffect, useState } from "react";
import { Plus, Pencil, Copy, Sparkles, Users } from "lucide-react";
import {
  TEMPLATE_CHARACTERS,
  cloneFromTemplate,
  loadUserCharacters,
  saveUserCharacters,
  blankCharacter,
} from "@/lib/characters";
import { getPersonality } from "@/lib/personalities";
import type { Character } from "@/lib/types";
import { CharacterAvatar } from "./CharacterAvatar";
import { CharacterEditModal } from "./CharacterEditModal";
import { deleteAvatar } from "@/lib/tauri";
import { useTranslation } from "@/lib/i18n";

interface Props {
  onCharactersChanged?: () => void;
}

export function CharactersSection({ onCharactersChanged }: Props) {
  const { t: tr } = useTranslation();
  const [userChars, setUserChars] = useState<Character[]>([]);
  const [editing, setEditing] = useState<Character | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const reload = () => setUserChars(loadUserCharacters());

  useEffect(() => {
    reload();
  }, []);

  const persistAndNotify = (next: Character[]) => {
    saveUserCharacters(next);
    setUserChars(next);
    onCharactersChanged?.();
  };

  const onCreateBlank = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const onCloneTemplate = (tmpl: Character) => {
    setEditing(cloneFromTemplate(tmpl));
    setEditorOpen(true);
  };

  const onEditExisting = (c: Character) => {
    setEditing(c);
    setEditorOpen(true);
  };

  const onSave = (c: Character) => {
    const exists = userChars.find((x) => x.id === c.id);
    const next = exists
      ? userChars.map((x) => (x.id === c.id ? c : x))
      : [...userChars, c];
    persistAndNotify(next);
    setEditorOpen(false);
  };

  const onDelete = async (c: Character) => {
    if (c.avatarPath) {
      await deleteAvatar(c.avatarPath).catch(() => {});
    }
    persistAndNotify(userChars.filter((x) => x.id !== c.id));
    setEditorOpen(false);
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-sm flex items-center gap-1.5">
          <Users size={15} />
          {tr("character.section.title")}
        </h3>
        <button
          onClick={onCreateBlank}
          className="flex items-center gap-1 px-2.5 py-1 text-[11.5px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
        >
          <Plus size={12} />
          {tr("character.section.newButton")}
        </button>
      </div>

      <p className="text-[12px] text-[var(--color-muted)] mb-3 leading-relaxed">
        {tr("character.section.intro")}
      </p>

      {/* User characters */}
      {userChars.length > 0 && (
        <div className="space-y-1.5 mb-4">
          {userChars.map((c) => {
            const p = getPersonality(c.personalityId ?? "");
            return (
              <div
                key={c.id}
                className="flex items-center gap-3 border border-[var(--color-border)] rounded-md px-3 py-2 bg-white hover:shadow-sm transition"
              >
                <CharacterAvatar character={c} size={36} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[13px] truncate">
                      {c.name || tr("character.section.nameless")}
                    </span>
                    {c.roleTag && (
                      <span className="text-[10.5px] text-[var(--color-muted)] truncate">
                        {c.roleTag}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-[var(--color-muted)] truncate">
                    {p ? p.label : tr("character.section.unsetTone")} ・{" "}
                    {c.description || tr("character.section.noDesc")}
                  </div>
                </div>
                <button
                  onClick={() => onEditExisting(c)}
                  className="px-2 py-1 text-[11px] border border-[var(--color-border)] rounded hover:bg-[var(--color-surface)] flex items-center gap-1"
                >
                  <Pencil size={11} />
                  {tr("character.section.edit")}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {userChars.length === 0 && (
        <div className="border border-dashed border-[var(--color-border)] rounded-md p-4 text-center text-[12px] text-[var(--color-muted)] mb-4">
          {tr("character.section.emptyLine1")}
          <br />
          {tr("character.section.emptyLine2")}
        </div>
      )}

      {/* Templates */}
      <div>
        <div className="text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide flex items-center gap-1">
          <Sparkles size={11} />
          {tr("character.section.templatesTitle")}
        </div>
        <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
          {tr("character.section.templatesIntro")}
          <span className="block text-[10.5px] mt-0.5">
            {tr("character.section.templatesNote")}
          </span>
        </p>
        {(() => {
          // 既に複製済みのテンプレを隠す（CEO 2つ表示の二重感を防止）。
          // 旧データ（clonedFrom 未設定）は判定できないので、その場合は名前一致でフォールバック判定する。
          const clonedIds = new Set(
            userChars.map((c) => c.clonedFrom).filter((x): x is string => !!x),
          );
          const clonedNamesAndRoles = new Set(
            userChars
              .filter((c) => !c.clonedFrom)
              .map((c) => `${c.name}${c.roleTag}`),
          );
          const remainingTemplates = TEMPLATE_CHARACTERS.filter(
            (t) =>
              !clonedIds.has(t.id) &&
              !clonedNamesAndRoles.has(`${t.name}${t.roleTag}`),
          );
          if (remainingTemplates.length === 0) {
            return (
              <div className="text-[11.5px] text-[var(--color-muted)] border border-dashed border-[var(--color-border)] rounded-md p-3 text-center">
                {tr("character.section.allCloned")}
              </div>
            );
          }
          return (
            <div className="grid grid-cols-2 gap-1.5">
              {remainingTemplates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onCloneTemplate(t)}
                  className="flex items-center gap-2 border border-[var(--color-border)] rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-surface)] transition"
                >
                  <CharacterAvatar character={t} size={28} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[12px] truncate">
                      {t.name}
                    </div>
                    <div className="text-[10.5px] text-[var(--color-muted)] truncate">
                      {t.roleTag}
                    </div>
                  </div>
                  <Copy size={12} className="text-[var(--color-muted)]" />
                </button>
              ))}
            </div>
          );
        })()}
      </div>

      <CharacterEditModal
        open={editorOpen}
        initial={editing}
        onClose={() => setEditorOpen(false)}
        onSave={onSave}
        onDelete={onDelete}
      />
    </section>
  );
}
