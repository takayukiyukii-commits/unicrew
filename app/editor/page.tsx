"use client";

import { Suspense } from "react";
import { EditorWindow } from "@/components/EditorWindow";

export const dynamic = "force-static";

export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen w-screen flex items-center justify-center text-[12px] text-neutral-500">
          読み込み中…
        </div>
      }
    >
      <EditorWindow />
    </Suspense>
  );
}
