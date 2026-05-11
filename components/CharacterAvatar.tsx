"use client";

import { useEffect, useState } from "react";
import {
  BarChart3,
  Bot,
  Compass,
  Crown,
  Handshake,
  Megaphone,
  Notebook,
  Sparkles,
  Terminal,
  Wand2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { avatarSrc } from "@/lib/tauri";
import type { Character } from "@/lib/types";
import clsx from "clsx";

/**
 * iconName で参照できる lucide アイコン。
 * サイドバー左下のアイコン群と同じ抽象的な白黒ラインアートで揃える。
 * 必要に応じてここに足す（任意名→Componentの明示マップで tree-shake を効かせる）。
 */
const CHARACTER_ICONS: Record<string, LucideIcon> = {
  Sparkles,
  Terminal,
  Wand2,
  Crown,
  Wrench,
  Megaphone,
  Handshake,
  Compass,
  BarChart3,
  Notebook,
  Bot,
};

interface Props {
  character: Character | undefined | null;
  size?: number;
  className?: string;
  /** ユーザー側の "あなた" の場合、emojiの代わりに表示するテキスト */
  fallbackText?: string;
}

export function CharacterAvatar({
  character,
  size = 36,
  className,
  fallbackText,
}: Props) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    if (character?.avatarPath) {
      avatarSrc(character.avatarPath)
        .then((u) => {
          if (!canceled) setImgUrl(u);
        })
        .catch(() => {
          if (!canceled) setImgUrl(null);
        });
    } else {
      setImgUrl(null);
    }
    return () => {
      canceled = true;
    };
  }, [character?.avatarPath]);

  // 表示優先順:
  // 1. アップロード画像 (imgUrl)
  // 2. fallbackText（"あなた" の頭文字など）
  // 3. iconName で指定された lucide ラインアートアイコン
  // 4. emoji（provider 識別の色玉 🟠/🟢/🔵 用。UNICREW では他の絵文字には基本使わない）
  // 5. Bot（最後の保険）
  const Icon =
    !imgUrl && character?.iconName
      ? (CHARACTER_ICONS[character.iconName] ?? null)
      : null;
  const showEmoji = !imgUrl && !Icon && !!character?.emoji;

  // サイドバー左下と同じ抽象的な白黒ラインアートで統一。
  // アクセント塗りやカラー絵文字を使わず、surface背景＋border＋strokeWidth=1.5 で軽さを保つ。
  return (
    <div
      className={clsx(
        "rounded-full shrink-0 flex items-center justify-center border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface)]",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: imgUrl ? "#fff" : "var(--color-surface)",
        color: imgUrl ? undefined : "var(--color-text)",
        fontSize: size * 0.5,
      }}
      title={character?.name ?? ""}
    >
      {imgUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgUrl}
          alt={character?.name ?? ""}
          className="w-full h-full object-cover"
        />
      ) : fallbackText ? (
        <span>{fallbackText}</span>
      ) : Icon ? (
        <Icon size={size * 0.55} strokeWidth={1.5} aria-hidden="true" />
      ) : showEmoji ? (
        <span>{character?.emoji}</span>
      ) : (
        <Bot size={size * 0.55} strokeWidth={1.5} aria-hidden="true" />
      )}
    </div>
  );
}
