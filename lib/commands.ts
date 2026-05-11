/**
 * Command Palette のコマンド定義。
 *
 * `Command` はステートレス（クロージャ）で、page.tsx の `useCommands(...)` 内で
 * 現在のアプリ状態を捕まえて生成する。Palette はその snapshot をフィルタするだけ。
 */

import type { LucideIcon } from "lucide-react";

export interface Command {
  /** 一意ID（テスト・ログ用） */
  id: string;
  /** Palette に出る主タイトル */
  label: string;
  /** カテゴリ（左に小さく表示） */
  category: string;
  /** 補足説明（薄字） */
  description?: string;
  /** ⌘K / Ctrl+K を含むショートカット表示（任意） */
  shortcut?: string;
  /** lucide アイコン（任意） */
  icon?: LucideIcon;
  /** 検索でヒットさせたいキーワード（label/description に追加） */
  keywords?: string[];
  /** 実行関数。Palette を閉じてから呼ぶ。 */
  run: () => void | Promise<void>;
  /** false なら一覧から除外（コマンド配列を毎回再計算するので大丈夫） */
  enabled?: boolean;
}

/** Palette フィルタ用の検索文字列を組み立てる */
export function commandSearchText(cmd: Command): string {
  const parts = [cmd.label, cmd.category];
  if (cmd.description) parts.push(cmd.description);
  if (cmd.keywords?.length) parts.push(...cmd.keywords);
  return parts.join("  ");
}
