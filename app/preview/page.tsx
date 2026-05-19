"use client";

import { Suspense } from "react";
import { PreviewWindow } from "@/components/PreviewWindow";

export const dynamic = "force-static";

export default function PreviewPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen w-screen flex items-center justify-center text-[12px] text-neutral-500">
          読み込み中…
        </div>
      }
    >
      <PreviewWindow />
    </Suspense>
  );
}
