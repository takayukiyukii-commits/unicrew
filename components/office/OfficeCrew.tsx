"use client";

import { createContext, useId } from "react";
import { lookSample } from "@/lib/office/looks";
import type { StaffStatus } from "@/lib/office/types";

export const OfficeAvatarContext = createContext<Record<string, string>>({});

/** 設定・名札・平面表示で共通の乗組員。差し替え画像も画面の中に収める。 */
export function LookFace({ sample, size = 44, image, status = "idle" }: {
  sample: string; size?: number; image?: string | null; status?: StaffStatus;
}) {
  const look = lookSample(sample);
  const clip = useId().replace(/:/g, "");
  const w = look.shape === "wide" ? 40 : look.shape === "tall" ? 30 : 36;
  const h = look.shape === "tall" ? 38 : 32;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="office-crew-face">
      <defs><clipPath id={clip}><rect x="18" y="22" width="28" height="22" rx="4" /></clipPath></defs>
      <ellipse cx="32" cy="59" rx="20" ry="3" fill="#0F172A" opacity=".07" />
      <g fill={look.accent} stroke={look.body} strokeWidth="2">
        {look.accessory === "antenna" ? <><path d="M32 17V8" /><circle cx="32" cy="6" r="3" /></> : null}
        {look.accessory === "ears" ? <><rect x="7" y="25" width="7" height="15" rx="3" /><rect x="50" y="25" width="7" height="15" rx="3" /></> : null}
        {look.accessory === "fins" ? <><path d="m14 21-9 3 9 16z" /><path d="m50 21 9 3-9 16z" /></> : null}
        {look.accessory === "handle" ? <path d="M23 17v-6h18v6" fill="none" strokeWidth="4" /> : null}
      </g>
      <rect x={32 - w / 2} y="16" width={w} height={h} rx="8" fill={look.body} />
      <rect x="16" y="20" width="32" height="26" rx="6" fill="#0F172A" />
      {image ? <image href={image} x="18" y="22" width="28" height="22" preserveAspectRatio="xMidYMid meet" clipPath={`url(#${clip})`} /> : (
        <g stroke={look.accent} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          {status === "done" ? <><path d="m23 31 3-3 3 3m6 0 3-3 3 3M27 38q5 5 10 0" /></> :
            status === "waiting" ? <><circle cx="25" cy="31" r="2" /><circle cx="39" cy="31" r="2" /><path d="M30 39h4" /></> :
            status === "working" ? <><path d="m23 29 4 3-4 3m14-6 4 3-4 3M29 40h6" /></> :
            <><path d="M24 31v3m16-3v3M29 40h6" /></>}
        </g>
      )}
      <rect x="22" y={16 + h} width="6" height="4" rx="1" fill={look.accent} />
      <rect x="36" y={16 + h} width="6" height="4" rx="1" fill={look.accent} />
      <rect x="29" y="49" width="6" height="2" rx="1" fill={status === "done" ? "#10B981" : status === "waiting" ? "#F59E0B" : look.accent} />
    </svg>
  );
}
