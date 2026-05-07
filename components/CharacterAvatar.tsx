"use client";

import { useEffect, useState } from "react";
import { avatarSrc } from "@/lib/tauri";
import type { Character } from "@/lib/types";
import clsx from "clsx";

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

  const accent = character?.accentColor ?? "#3b82f6";
  return (
    <div
      className={clsx(
        "rounded-full shrink-0 flex items-center justify-center shadow-sm border border-[var(--color-border)] overflow-hidden bg-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: imgUrl ? "#fff" : accent + "22",
        color: imgUrl ? undefined : accent,
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
      ) : (
        <span>{fallbackText ?? character?.emoji ?? "🤖"}</span>
      )}
    </div>
  );
}
