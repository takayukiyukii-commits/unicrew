"use client";

/**
 * 「あなた」アバター。AppSettings の `userAvatarPath` / `userEmoji` / `userAccentColor` を
 * 読んで、メッセージ脇のサムネに使う。CharacterAvatar とロジックは似ているが、
 * Character オブジェクトが無くても動かしたいので独立。
 */

import { useEffect, useState } from "react";
import { avatarSrc } from "@/lib/tauri";
import clsx from "clsx";
import { useTranslation } from "@/lib/i18n";

interface Props {
  avatarPath?: string | null;
  emoji?: string;
  /** 画像が無い時の背景色。指定がなければ既定（#111827）に倒す。 */
  accentColor?: string;
  /** 画像が無く emoji も空の時の最終フォールバック文字（既定「あ」）。 */
  fallbackText?: string;
  size?: number;
  className?: string;
  title?: string;
}

export function UserAvatar({
  avatarPath,
  emoji,
  accentColor,
  fallbackText,
  size = 36,
  className,
  title,
}: Props) {
  const { t } = useTranslation();
  const resolvedFallback = fallbackText ?? t("character.avatar.youInitial");
  const resolvedTitle = title ?? t("character.avatar.you");
  const [imgUrl, setImgUrl] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    if (avatarPath) {
      avatarSrc(avatarPath)
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
  }, [avatarPath]);

  const showEmoji = !imgUrl && !!emoji;
  const bg = imgUrl ? "#fff" : accentColor || "#111827";

  return (
    <div
      className={clsx(
        "rounded-full shrink-0 flex items-center justify-center border border-[var(--color-border)] overflow-hidden shadow-sm",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: bg,
        color: imgUrl ? undefined : "#fff",
        fontSize: size * 0.5,
      }}
      title={resolvedTitle}
    >
      {imgUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgUrl}
          alt={resolvedTitle}
          className="w-full h-full object-cover"
        />
      ) : showEmoji ? (
        <span>{emoji}</span>
      ) : (
        <span>{resolvedFallback}</span>
      )}
    </div>
  );
}
