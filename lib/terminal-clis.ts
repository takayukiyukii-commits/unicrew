/**
 * ターミナルタブで起動できる対話 CLI（TUI）のカタログ。
 *
 * ここは「PTY でそのまま起動するプログラム名」の一覧であって、
 * 構造化チャットのプロバイダ（lib/types.ts の Provider）とは独立。
 * 未インストールの CLI を選んだ場合は PTY の spawn 失敗が端末内に
 * そのまま表示される（設定 → 各 CLI のインストールで導入できる）。
 *
 * 注意:
 * - goose の対話モードは `goose session`（`goose` 単体はヘルプ表示）
 * - cursor-agent は Windows 版バイナリが存在しない（2026-08-27 実測・
 *   インストーラが Linux/Darwin 限定）。Windows では一覧から除外する
 * - grok は TUI として素の `grok` を起動する（ユーザーの Grok 設定どおり動く）。
 *   構造化チャット側（providers/grok.rs）とは違い、設定輸入の無効化はしない
 */

export interface TerminalCli {
  /** Pane に保存する識別子（安定・変更しない） */
  id: string;
  /** メニュー・バッジの表示名 */
  label: string;
  /** PTY で起動するプログラム名（PATH 解決は Rust 側 resolve_on_path） */
  program: string;
  /** 追加引数 */
  args?: string[];
  /** Windows では起動できない CLI（メニューから除外） */
  noWindows?: boolean;
}

export const TERMINAL_CLIS: TerminalCli[] = [
  { id: "claude", label: "Claude Code", program: "claude" },
  { id: "codex", label: "Codex", program: "codex" },
  { id: "gemini", label: "Gemini CLI", program: "gemini" },
  { id: "grok", label: "Grok CLI", program: "grok" },
  { id: "opencode", label: "OpenCode", program: "opencode" },
  { id: "qwen", label: "Qwen Code", program: "qwen" },
  { id: "kimi", label: "Kimi CLI", program: "kimi" },
  { id: "goose", label: "Goose", program: "goose", args: ["session"] },
  {
    id: "cursor",
    label: "Cursor Agent",
    program: "cursor-agent",
    noWindows: true,
  },
];

/** 実行中 OS で使える CLI 一覧（Windows では noWindows を除外） */
export function availableTerminalClis(isWindows: boolean): TerminalCli[] {
  return TERMINAL_CLIS.filter((c) => !isWindows || !c.noWindows);
}

export function terminalCliById(id: string): TerminalCli | undefined {
  return TERMINAL_CLIS.find((c) => c.id === id);
}
