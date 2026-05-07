"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Loader2, AlertCircle } from "lucide-react";
import clsx from "clsx";
import { getOpenAiApiKey, transcribeAudio } from "@/lib/tauri";

interface Props {
  onTranscribed: (text: string) => void;
  disabled?: boolean;
}

type Stage = "idle" | "no-key" | "recording" | "transcribing" | "error";

export function VoiceInputButton({ onTranscribed, disabled }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);

  // OpenAI 鍵の有無を初期チェック
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const key = await getOpenAiApiKey();
        if (!mounted) return;
        if (!key) setStage("no-key");
      } catch {
        // ignore — 鍵の確認に失敗しても idle のまま
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // 録音中の経過時間ライブ更新
  useEffect(() => {
    if (stage !== "recording") return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, [stage]);

  const startRecording = async () => {
    setErrorMsg(null);
    if (stage === "no-key") {
      setErrorMsg(
        "OpenAI API キーが未設定です。設定 → 接続 → 音声入力 から登録してください。",
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      streamRef.current = stream;
      const mimeType = pickSupportedMime();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        if (blob.size < 200) {
          setStage("idle");
          return;
        }
        setStage("transcribing");
        try {
          const text = await transcribeAudio(blob);
          if (text) onTranscribed(text);
          setStage("idle");
        } catch (e) {
          setErrorMsg(e instanceof Error ? e.message : String(e));
          setStage("error");
          setTimeout(() => {
            setStage("idle");
            setErrorMsg(null);
          }, 5000);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setStage("recording");
    } catch (e) {
      setErrorMsg(
        e instanceof Error
          ? `マイクへのアクセスが拒否されました: ${e.message}`
          : "マイクへのアクセスに失敗しました",
      );
      setStage("error");
      setTimeout(() => {
        setStage("idle");
        setErrorMsg(null);
      }, 5000);
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorderRef.current = null;
  };

  const onClick = () => {
    if (disabled) return;
    if (stage === "recording") stopRecording();
    else if (stage === "idle" || stage === "no-key" || stage === "error")
      void startRecording();
  };

  const isBusy = stage === "transcribing";
  const isRec = stage === "recording";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || isBusy}
        title={
          stage === "no-key"
            ? "OpenAI API キーが未設定です（設定から登録してください）"
            : isRec
              ? "録音停止して書き起こす"
              : isBusy
                ? "書き起こし中…"
                : "音声入力（マイク）"
        }
        className={clsx(
          "relative w-9 h-9 rounded-md border flex items-center justify-center transition shrink-0",
          isRec
            ? "bg-rose-500 border-rose-500 text-white"
            : isBusy
              ? "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-muted)]"
              : stage === "no-key"
                ? "bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-muted)] hover:bg-white"
                : "bg-white border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface)]",
        )}
      >
        {isBusy ? (
          <Loader2 size={16} className="animate-spin" />
        ) : isRec ? (
          <span className="relative inline-flex items-center justify-center">
            <span className="absolute w-7 h-7 rounded-full bg-white/30 animate-ping" />
            <Mic size={16} />
          </span>
        ) : stage === "no-key" ? (
          <Mic size={16} className="opacity-50" />
        ) : (
          <Mic size={16} />
        )}
      </button>
      {isRec && (
        <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-md text-[11px] bg-rose-500 text-white font-mono whitespace-nowrap shadow">
          REC {String(Math.floor(elapsed / 60)).padStart(1, "0")}:
          {String(elapsed % 60).padStart(2, "0")}
        </div>
      )}
      {errorMsg && (
        <div className="absolute bottom-full mb-2 right-0 w-72 px-3 py-2 rounded-md bg-rose-50 border border-rose-200 text-[11.5px] text-rose-800 leading-relaxed shadow-lg z-50 flex gap-1.5">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
}

function pickSupportedMime(): string | null {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}
