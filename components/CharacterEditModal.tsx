"use client";

import { useEffect, useState } from "react";
import { X, Upload, Trash2, ChevronDown, RotateCcw } from "lucide-react";
import { ACCENT_COLORS, blankCharacter } from "@/lib/characters";
import { PERSONALITIES, getPersonality } from "@/lib/personalities";
import { MODEL_LABELS, PROVIDER_LABELS } from "@/lib/types";
import { CategoryDot } from "@/lib/providerVisuals";
import { CATEGORY_DESCRIPTIONS, PROVIDER_CATEGORY } from "@/lib/providerCategories";
import type { Character, ModelId, Provider } from "@/lib/types";
import { CharacterAvatar } from "./CharacterAvatar";
import { deleteAvatar, pickAndSaveAvatar } from "@/lib/tauri";
import clsx from "clsx";
import { useTranslation } from "@/lib/i18n";

interface Props {
  open: boolean;
  initial: Character | null; // null = 新規作成モード（blank）
  onClose: () => void;
  onSave: (c: Character) => void;
  onDelete?: (c: Character) => void;
}

export function CharacterEditModal({
  open,
  initial,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const [c, setC] = useState<Character>(blankCharacter());
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (open) {
      setC(initial ? { ...initial } : blankCharacter());
    }
  }, [open, initial]);

  if (!open) return null;

  const setField = <K extends keyof Character>(k: K, v: Character[K]) => {
    setC((prev) => ({ ...prev, [k]: v }));
  };

  const handleAvatarUpload = async () => {
    setUploading(true);
    try {
      const newPath = await pickAndSaveAvatar();
      if (newPath) {
        // 古いアバターは削除（差分を貯めない）
        if (c.avatarPath) {
          await deleteAvatar(c.avatarPath).catch(() => {});
        }
        setField("avatarPath", newPath);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleAvatarRemove = async () => {
    if (c.avatarPath) {
      await deleteAvatar(c.avatarPath).catch(() => {});
      setField("avatarPath", null);
    }
  };

  const personality = getPersonality(c.personalityId ?? "");
  const isValid = c.name.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <h2 className="font-bold text-[15px]">
            {initial ? t("character.editTitle") : t("character.newTitle")}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--color-surface)] rounded transition"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Avatar + name */}
          <section className="flex gap-4 items-start">
            <div className="flex flex-col items-center gap-2">
              <CharacterAvatar character={c} size={84} />
              <div className="flex flex-col gap-1">
                <button
                  onClick={handleAvatarUpload}
                  disabled={uploading}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] border border-[var(--color-border)] rounded hover:bg-[var(--color-surface)] disabled:opacity-50"
                >
                  <Upload size={11} />
                  {t("character.avatarUpload")}
                </button>
                {c.avatarPath && (
                  <button
                    onClick={handleAvatarRemove}
                    className="flex items-center gap-1 px-2 py-1 text-[11px] border border-[var(--color-border)] rounded hover:bg-red-50 text-red-500"
                  >
                    <Trash2 size={11} />
                    {t("character.avatarRemove")}
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 space-y-3 min-w-0">
              <div>
                <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1 uppercase tracking-wide">
                  {t("character.nameLabel")} <span className="text-red-500">*</span>
                </label>
                <input
                  value={c.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder={t("character.namePlaceholder")}
                  className="w-full border border-[var(--color-border)] rounded-md px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1 uppercase tracking-wide">
                  {t("character.roleLabel")}
                </label>
                <input
                  value={c.roleTag}
                  onChange={(e) => setField("roleTag", e.target.value)}
                  placeholder={t("character.rolePlaceholder")}
                  className="w-full border border-[var(--color-border)] rounded-md px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1 uppercase tracking-wide">
                  {t("character.descLabel")}
                </label>
                <input
                  value={c.description}
                  onChange={(e) => setField("description", e.target.value)}
                  placeholder={t("character.descPlaceholder")}
                  className="w-full border border-[var(--color-border)] rounded-md px-3 py-2 text-sm"
                />
              </div>
            </div>
          </section>

          {/* Emoji + accent color */}
          <section className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
                {t("character.iconLabel")}
              </label>
              <div className="text-[11.5px] text-[var(--color-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md p-2 leading-relaxed">
                {t("character.iconHint")}
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
                {t("character.accentLabel")}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ACCENT_COLORS.map((color) => (
                  <button
                    key={color}
                    onClick={() => setField("accentColor", color)}
                    className={clsx(
                      "w-8 h-8 rounded-full border transition",
                      c.accentColor === color
                        ? "ring-2 ring-offset-2 ring-[var(--color-text)] border-transparent"
                        : "border-[var(--color-border)]",
                    )}
                    style={{ background: color }}
                    title={color}
                  />
                ))}
              </div>
            </div>
          </section>

          {/* Personality */}
          <section>
            <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
              {t("character.personalityLabel")}
            </label>
            <div className="grid grid-cols-3 gap-1.5 mb-2">
              {PERSONALITIES.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setField("personalityId", p.id)}
                  className={clsx(
                    "border rounded-md px-2 py-1.5 text-[11.5px] text-left transition",
                    c.personalityId === p.id
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                      : "border-[var(--color-border)] hover:bg-[var(--color-surface)]",
                  )}
                >
                  <span className="font-medium truncate">{p.label}</span>
                </button>
              ))}
            </div>
            {personality && (
              <div className="text-[11.5px] text-[var(--color-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md p-2 leading-relaxed">
                <div className="font-medium text-[var(--color-text)] mb-0.5">
                  {personality.label}：{personality.description}
                </div>
                <div className="italic">
                  {t("character.personalityExample", { line: personality.exampleLine })}
                </div>
              </div>
            )}
          </section>

          {/* Provider */}
          <section>
            <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
              {t("character.providerLabel")}
            </label>
            <div className="grid grid-cols-2 gap-1.5 mb-1">
              {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setField("provider", p)}
                  className={clsx(
                    "border rounded-md px-3 py-2 text-[12.5px] text-left transition",
                    c.provider === p
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium"
                      : "border-[var(--color-border)] hover:bg-[var(--color-surface)]",
                  )}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <CategoryDot provider={p} size={9} />
                    {PROVIDER_LABELS[p]}
                  </span>
                  <span className="block text-[10.5px] text-[var(--color-muted)] mt-0.5">
                    {CATEGORY_DESCRIPTIONS[PROVIDER_CATEGORY[p]]}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-[10.5px] text-[var(--color-muted)]">
              {t("character.providerHint")}
            </p>
          </section>

          {/* Model */}
          <section>
            <label className="block text-[11px] font-semibold text-[var(--color-muted)] mb-1.5 uppercase tracking-wide">
              {t("character.modelLabel")}
            </label>
            <div className="relative">
              <select
                value={c.defaultModel}
                onChange={(e) =>
                  setField("defaultModel", e.target.value as ModelId)
                }
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
          </section>

          {/* System prompt (advanced) */}
          <section>
            <details className="group">
              <summary className="cursor-pointer text-[12px] font-semibold text-[var(--color-muted)] flex items-center gap-1 list-none">
                <ChevronDown
                  size={14}
                  className="transition group-open:rotate-180"
                />
                {t("character.advancedSummary")}
              </summary>
              <div className="mt-2">
                <textarea
                  value={c.systemPrompt}
                  onChange={(e) => setField("systemPrompt", e.target.value)}
                  rows={6}
                  placeholder={t("character.systemPromptPlaceholder")}
                  className="w-full border border-[var(--color-border)] rounded-md px-3 py-2 text-[12.5px] font-mono leading-relaxed"
                />
                <p className="text-[11px] text-[var(--color-muted)] mt-1">
                  {t("character.systemPromptHint")}
                </p>
              </div>
            </details>
          </section>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
          <div>
            {onDelete && initial && !initial.isTemplate && (
              <button
                onClick={() => {
                  if (
                    confirm(
                      t("character.confirmDelete", { name: initial.name }),
                    )
                  ) {
                    onDelete(initial);
                  }
                }}
                className="flex items-center gap-1 px-3 py-2 text-sm rounded-md text-red-600 hover:bg-red-50"
              >
                <Trash2 size={13} />
                {t("character.delete")}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {initial && initial.isTemplate && (
              <button
                onClick={() => setC(blankCharacter())}
                className="flex items-center gap-1 px-3 py-2 text-sm rounded-md hover:bg-white"
              >
                <RotateCcw size={13} />
                {t("character.reset")}
              </button>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-md hover:bg-white transition"
            >
              {t("character.cancel")}
            </button>
            <button
              onClick={() => {
                if (!isValid) return;
                onSave({ ...c, isTemplate: false });
              }}
              disabled={!isValid}
              className="px-4 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              {initial && !initial.isTemplate ? t("character.update") : t("character.create")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
