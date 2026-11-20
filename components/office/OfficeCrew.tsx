"use client";
import { createContext } from "react";
import { lookSample } from "@/lib/office/looks";
import type { StaffStatus } from "@/lib/office/types";

export const OfficeAvatarContext = createContext<Record<string, string>>({});
/** 席・名札・社員設定で同じ画像を使う。差し替え画像は角丸の立て札。 */
export function LookFace({ sample, size = 44, image, status = "idle" }: {
  sample: string; size?: number; image?: string | null; status?: StaffStatus;
}) {
  const look = lookSample(sample);
  // 静的エクスポートと利用者のdata URLを共通で扱う。
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={image || look.image} alt="" aria-hidden="true" width={size} height={size}
    className={`office-crew-face ${image ? "office-crew-custom" : ""}`} data-status={status}
    style={{ width: size, height: size, objectFit: "contain", imageRendering: "pixelated" }} />;
}
