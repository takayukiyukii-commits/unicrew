"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Plus, Sparkles, Users, ArrowLeft, Check } from "lucide-react";
import {
  TEMPLATE_CHARACTERS,
  getCharacter,
  loadUserCharacters,
} from "@/lib/characters";
import type { Character } from "@/lib/types";
import { CharacterAvatar } from "./CharacterAvatar";

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
  onCloneTemplate: (template: Character) => void;
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
  const [userChars, setUserChars] = useState<Character[]>([]);
  const [step, setStep] = useState<Step>("claude");
  const [firstClaudeId, setFirstClaudeId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUserChars(loadUserCharacters());
      setStep("claude");
      setFirstClaudeId(null);
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
    ? "新しい会話"
    : step === "claude"
      ? "🟠 Claude 側のキャラクター"
      : "🟢 Codex 側のキャラクター";

  const headerSub = !splitMode
    ? "モードを選んでそのまま開始 / もしくはキャラを選択（任意）"
    : step === "claude"
      ? "並列モードではキャラクターを 2つ 選択してください ・ ステップ 1 / 2"
      : "もう1つ選択してください ・ ステップ 2 / 2";

  // splitモード中はクローン編集フローを通せないので「直接ピック」に切替
  const handleTemplateClick = (t: Character) => {
    if (splitMode) {
      handleSelect(t.id);
    } else {
      onCloneTemplate(t);
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
                <span>👤 単独モード</span>
                {!splitMode && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white">
                    選択中
                  </span>
                )}
              </div>
              <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
                1人のキャラと会話。Claude 系キャラを選べば Claude 単独、Codex 系なら Codex 単独で動く。
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
                <span>🟠×🟢 並列モード</span>
                {splitMode && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white">
                    選択中
                  </span>
                )}
              </div>
              <div className="text-[10.5px] text-[var(--color-muted)] mt-0.5 leading-relaxed">
                Claude と Codex に別人格を割当て、左右で同時実行。CDO×CMO 議論など。
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
            <span className="font-medium">💬 会議モード（AI同士で議論）</span>
            <span className="text-[var(--color-muted)] text-[11.5px]">
              両AIが互いの回答を読んで批判・改善（最大3ラウンド、足りなければあとから延長可）
            </span>
          </label>
          {!splitMode && (
            <div className="text-[11px] text-[var(--color-muted)] px-1 leading-relaxed">
              💡 Claude をたくさん並べて作業させたい場合は、単独モードでスレッドを作ってから、
              チャット画面右上の「
              <span className="inline-block align-middle">📋</span>
              」アイコンで右ペインに別スレッドを開けます。
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              if (splitMode) {
                // 並列モード: 両方ともおまかせで起動（一発でスタート）
                onPickPair("tmpl-claude-normal", "tmpl-codex-normal");
              } else {
                handleSelect("tmpl-claude-normal");
              }
            }}
            className="w-full flex items-center gap-2 rounded-lg border border-[var(--color-accent)]/40 bg-gradient-to-r from-sky-50 to-indigo-50 px-3 py-2.5 hover:border-[var(--color-accent)] hover:shadow-sm transition group text-left"
          >
            <span className="text-lg shrink-0">🤖</span>
            <span className="flex-1 min-w-0">
              <span className="block text-[12.5px] font-semibold text-[var(--color-text)]">
                {splitMode
                  ? "ノーマル Claude × Codex で開始"
                  : "このまま開始（ノーマル Claude）"}
                <span className="ml-1.5 text-[10px] font-normal text-[var(--color-muted)]">
                  {splitMode
                    ? "(役割なし・素のClaude/Codex)"
                    : "(役割づけなし・素のClaude)"}
                </span>
              </span>
              <span className="block text-[11px] text-[var(--color-muted)] mt-0.5 leading-snug">
                素の Claude Code / Codex CLI の挙動。プログラミング・調査・要約・自然な対話まで万能。
                {splitMode &&
                  " 役割づけしたキャラを当てたい場合は下から2つ選んでください。"}
              </span>
            </span>
            <span className="text-[var(--color-accent)] shrink-0 group-hover:translate-x-0.5 transition">
              →
            </span>
          </button>

          {!splitMode && (
            <div className="text-[11px] text-[var(--color-muted)] px-1 leading-relaxed">
              💡 Claude をたくさん並べて作業させたい場合は、単独モードでスレッドを作ってから、
              チャット画面右上の「
              <span className="inline-block align-middle">📋</span>
              」アイコンで右ペインに別スレッドを開けます。
            </div>
          )}
        </div>

        {/* Step 2 で Claude 側のピック内容を確認用に表示 */}
        {splitMode && step === "codex" && firstClaudeChar && (
          <div className="mx-5 mt-3 flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]">
            <Check size={13} className="text-[var(--color-accent)] shrink-0" />
            <span className="text-[11.5px] text-[var(--color-muted)] shrink-0">
              🟠 Claude:
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
              選び直す
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
                  ? "👇 Claude 側のキャラを 1つ 選択（任意）"
                  : "👇 Codex 側のキャラを 1つ 選択（任意）"
                : "もしくは下からキャラを選ぶ（任意）"}
            </span>
            <span className="h-px flex-1 bg-[var(--color-border)]" />
          </div>

          {/* User-created characters */}
          {userChars.length > 0 && (
            <section>
              <div className="text-[11px] font-semibold text-[var(--color-muted)] mb-2 uppercase tracking-wide flex items-center gap-1">
                <Users size={11} />
                マイキャラクター
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
                          {c.name || "（名前未設定）"}
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
              <div className="text-3xl mb-2">✨</div>
              <h3 className="font-bold text-[14px] mb-1">
                自分のキャラクターを作りましょう
              </h3>
              <p className="text-[12px] text-[var(--color-muted)] mb-3 leading-relaxed">
                名前・アバター画像・口調を自由に設定できます。
                <br />
                ゼロから作るか、テンプレートを元にカスタマイズします。
              </p>
              <button
                onClick={onCreateNew}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] bg-[var(--color-accent)] text-white rounded-md hover:opacity-90 font-medium"
              >
                <Plus size={13} />
                ゼロから作る
              </button>
            </section>
          )}

          {/* Templates */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-semibold text-[var(--color-muted)] uppercase tracking-wide flex items-center gap-1">
                <Sparkles size={11} />
                {splitMode ? "テンプレート（直接選択）" : "テンプレートから複製"}
              </div>
              {!splitMode && userChars.length > 0 && (
                <button
                  onClick={onCreateNew}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] border border-[var(--color-border)] rounded-md hover:bg-[var(--color-surface)]"
                >
                  <Plus size={11} />
                  ゼロから作る
                </button>
              )}
            </div>
            <p className="text-[11.5px] text-[var(--color-muted)] mb-2 leading-relaxed">
              {splitMode
                ? "並列モードではテンプレートをそのまま使います。編集したい場合は単独モードで複製してから戻ってきてください。"
                : "選ぶと編集画面が開きます。名前・アバター・口調を自分用に変えて保存できます。"}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {TEMPLATE_CHARACTERS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleTemplateClick(t)}
                  className="flex items-center gap-2 border border-[var(--color-border)] rounded-md p-2 hover:bg-[var(--color-surface)] transition text-left"
                >
                  <CharacterAvatar character={t} size={32} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[12.5px] truncate">
                      {t.name}
                    </div>
                    <div className="text-[10.5px] text-[var(--color-muted)] truncate">
                      {t.roleTag}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
