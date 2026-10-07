"use client";

/**
 * 音声入力ボタン（2026-10-07 作り直し）。
 *
 * Windows 標準の音声入力（Win+H）を呼び出す。押す前に、入力先（チャットの入力欄・
 * ターミナル）へフォーカスを当てるのが呼び出し側の役目（focusTarget）。
 * 話した言葉は、カーソルのある場所にそのまま文字で入る。
 * - API キー不要・追加料金なし（以前の OpenAI 書き起こし方式は v0.2.47 で外されていた）
 * - 実体は src-tauri/src/voice.rs
 */
import { Mic } from "lucide-react";
import { isTauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import { useTranslation } from "@/lib/i18n";
import { armVoiceSend } from "@/lib/voice-send";

interface Props {
  /** 入力先にフォーカスを当てる。当てられなかったら false を返す */
  focusTarget: () => boolean;
  disabled?: boolean;
  size?: number;
  className?: string;
}

export function VoiceInputButton({ focusTarget, disabled, size = 16, className }: Props) {
  const { t } = useTranslation();
  const start = async () => {
    if (!focusTarget()) {
      showToast(t("voice.noTarget"), "error");
      return;
    }
    if (!isTauri()) {
      showToast(t("voice.appOnly"), "error");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("start_voice_typing");
      // ここから一定時間、「送信」と言ったら送る（キーボードの「送信」では送らない）
      armVoiceSend();
      showToast(t("voice.started"));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <button
      type="button"
      // mousedown でフォーカスが移らないようにする（入力欄のカーソル位置を保つ）
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void start()}
      disabled={disabled}
      title={t("voice.mic")}
      aria-label={t("voice.mic")}
      data-testid="voice-input"
      className={
        className ??
        "shrink-0 p-2 rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] transition disabled:opacity-40 disabled:cursor-not-allowed"
      }
    >
      <Mic size={size} />
    </button>
  );
}
