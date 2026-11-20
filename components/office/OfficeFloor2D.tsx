"use client";

import OfficeDeck, { type DeckProps } from "./OfficeDeck";
import { useOfficeT } from "@/lib/office/i18n";

/** WebGL を使えない PC にも、同じ席・表情・手渡し・納品台を用意する。 */
export default function OfficeFloor2D(props: DeckProps) {
  const { t } = useOfficeT();
  return <><OfficeDeck {...props} flat /><details className="office-fallback-note">
    <summary>{t("fallback.title")}</summary><p>{t("fallback.note")}</p>
  </details></>;
}
