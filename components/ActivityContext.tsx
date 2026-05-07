"use client";

import { createContext, useContext } from "react";

/**
 * ツール使用の詳細表示をするかどうかを伝える Context。
 * page.tsx の AppSettings.showActivity から流す。
 */
export const ActivityVisibilityContext = createContext<boolean>(true);

export function useShowActivity(): boolean {
  return useContext(ActivityVisibilityContext);
}
