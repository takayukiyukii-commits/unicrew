import type { Provider } from "./types";

export type SlashCommandCategory = "basic" | "dev" | "config" | "info";

export interface SlashCommandDef {
  /** 実際にCLIへ送られる文字列（例: "/clear"）。引数を受けるものは末尾スペース付き。 */
  command: string;
  /** プルダウンに出す日本語ラベル（先頭の絵文字＋短い動詞）。 */
  label: string;
  /** ホバー時に出す日本語の詳しい説明（1〜2行）。 */
  description: string;
  /** どのCLIで効くか。両方なら ["claude","codex"]。 */
  providers: Provider[];
  category: SlashCommandCategory;
  /**
   * 引数を要求するコマンドは true。textareaに挿入後、末尾にカーソルを置いて
   * ユーザーに続きを書いてもらう想定（送信は手動）。
   */
  takesArgs?: boolean;
}

export const SLASH_COMMAND_CATEGORIES: Record<SlashCommandCategory, string> = {
  basic: "基本操作",
  dev: "開発支援",
  config: "設定・管理",
  info: "情報・ヘルプ",
};

/**
 * UNICREWの送信エリアから挿入できるスラッシュコマンド一覧。
 *
 * 注: UNICREW は claude / codex CLI を headless stream-json モードで呼ぶため、
 * 一部のスラッシュコマンドはCLI側で解釈されず、AI（モデル本体）への
 * 「お願い」として届く挙動になることがある。それでも自然言語の指示として
 * モデルが拾ってくれるため、ワークフロー短縮として実用に足る。
 */
export const SLASH_COMMANDS: SlashCommandDef[] = [
  // ── 基本操作 ──
  {
    command: "/clear",
    label: "会話履歴をクリア",
    description: "今のスレッドの履歴をリセットして、ゼロから話し始める。",
    providers: ["claude", "codex"],
    category: "basic",
  },
  {
    command: "/compact",
    label: "履歴を要約して圧縮",
    description:
      "長くなった会話を要約して短くする。トークン節約と話の整理に。",
    providers: ["claude", "codex"],
    category: "basic",
  },
  {
    command: "/new",
    label: "新しいセッション",
    description: "今までの文脈をリセットして新しいセッションを始める（Codex）。",
    providers: ["codex"],
    category: "basic",
  },

  // ── 開発支援 ──
  {
    command: "/監査 ",
    label: "別のAIに監査させる",
    description:
      "最後のコミット以降の変更を、実装したAIとは別の会社のAIに読み取り専用で監査させる。引数: quick|deep、1|2|3（観点の層）、残りは「仕様であって欠陥ではないもの」のメモ。",
    providers: [
      "claude",
      "codex",
      "gemini",
      "goose",
      "opencode",
      "codex-acp",
      "kiro",
      "qwen",
      "kimi",
      "grok",
      "cursor",
    ],
    category: "dev",
    takesArgs: true,
  },
  {
    command: "/side ",
    label: "サイドチャットで相談",
    description:
      "本線の会話の文脈を持ったまま、脇の読み取り専用スレッドで短い相談をする。質問を続けて書く。結論は「親に戻す」で本線の次の送信に前置きできる。",
    providers: [
      "claude",
      "codex",
      "gemini",
      "goose",
      "opencode",
      "codex-acp",
      "kiro",
      "qwen",
      "kimi",
      "grok",
      "cursor",
    ],
    category: "dev",
    takesArgs: true,
  },
  {
    command: "/init",
    label: "CLAUDE.mdを初期化",
    description:
      "ワークスペースを解析して CLAUDE.md / AGENTS.md の雛形を作る。新規プロジェクトの最初に。",
    providers: ["claude", "codex"],
    category: "dev",
  },
  {
    command: "/review",
    label: "コードレビュー",
    description:
      "現在のブランチの変更をプルリクとして読み、改善点・バグ・スタイル違反を指摘してもらう。",
    providers: ["claude"],
    category: "dev",
  },
  {
    command: "/security-review",
    label: "セキュリティレビュー",
    description:
      "未コミットの変更を OWASP Top10 視点で監査。販売開始前の最終チェックに。",
    providers: ["claude"],
    category: "dev",
  },
  {
    command: "/pr_comments",
    label: "PRコメント取得",
    description:
      "GitHub PR のレビューコメントを読み込んで、対応方針を整理してもらう。",
    providers: ["claude"],
    category: "dev",
  },
  {
    command: "/diff",
    label: "差分を表示",
    description:
      "現在のワークスペースの未コミット差分を表示する（Codex）。",
    providers: ["codex"],
    category: "dev",
  },
  {
    command: "/loop ",
    label: "定期実行（要・コマンド）",
    description:
      "間隔を置いて指定タスクを繰り返す（例: 5m / build-status）。スペース後に頻度＋指示を続ける。",
    providers: ["claude"],
    category: "dev",
    takesArgs: true,
  },
  {
    command: "/schedule ",
    label: "スケジュール実行",
    description:
      "cronで動く遠隔エージェントを作成・更新・一覧する。スペース後に内容を続ける。",
    providers: ["claude"],
    category: "dev",
    takesArgs: true,
  },

  // ── 設定・管理 ──
  {
    command: "/model",
    label: "モデル切替",
    description:
      "応答に使うモデルを切り替える。UNICREWでは右ペインのプルダウンでも切替可能。",
    providers: ["claude", "codex"],
    category: "config",
  },
  {
    command: "/permissions",
    label: "パーミッション設定",
    description:
      "ツール実行の許可/拒否ルールを編集する。Bashコマンドの自動許可リストなど。",
    providers: ["claude"],
    category: "config",
  },
  {
    command: "/mcp",
    label: "MCPサーバー管理",
    description:
      "接続中のMCPサーバー一覧・追加・削除。LINE Harness / Sentry / Linear 等。",
    providers: ["claude"],
    category: "config",
  },
  {
    command: "/agents",
    label: "サブエージェント管理",
    description:
      "Explore / code-architect / code-reviewer 等のサブエージェント一覧・新規作成。",
    providers: ["claude"],
    category: "config",
  },
  {
    command: "/hooks",
    label: "フック設定",
    description:
      "PreToolUse / PostToolUse / Stop 等のシェルフックを編集する。",
    providers: ["claude"],
    category: "config",
  },
  {
    command: "/memory",
    label: "メモリ管理",
    description:
      "auto-memory（恒久記憶）を確認・編集する。MEMORY.md と各トピック.md。",
    providers: ["claude"],
    category: "config",
  },
  {
    command: "/config",
    label: "設定を変更",
    description:
      "テーマ・通知・キーボードなど Claude Code 全般の設定を開く。",
    providers: ["claude"],
    category: "config",
  },
  {
    command: "/vim",
    label: "Vimモード切替",
    description: "入力エリアでVimキーバインドを使えるようにする。",
    providers: ["claude"],
    category: "config",
  },
  {
    command: "/ide",
    label: "IDE接続",
    description:
      "VSCode / JetBrains の開いているファイルや診断情報を取り込めるようにする。",
    providers: ["claude"],
    category: "config",
  },
  {
    command: "/login",
    label: "ログイン",
    description:
      "Claude / Codex のサブスク認証を再実行する。401 エラー時の復旧用。",
    providers: ["claude", "codex"],
    category: "config",
  },
  {
    command: "/logout",
    label: "ログアウト",
    description: "保存された認証情報をクリアする。",
    providers: ["claude"],
    category: "config",
  },

  // ── 情報・ヘルプ ──
  {
    command: "/help",
    label: "ヘルプ",
    description: "使えるコマンド一覧と基本操作を表示する。",
    providers: ["claude", "codex"],
    category: "info",
  },
  {
    command: "/status",
    label: "ステータス表示",
    description:
      "認証状態・モデル・ワークスペース・MCP接続を一覧表示する。",
    providers: ["claude", "codex"],
    category: "info",
  },
  {
    command: "/cost",
    label: "コスト・使用量",
    description:
      "今日のセッションのトークン使用量と概算コストを表示する。",
    providers: ["claude"],
    category: "info",
  },
  {
    command: "/doctor",
    label: "ヘルスチェック",
    description:
      "PATH・Node・Rust・CLI 認証など環境を点検し、問題があれば指摘する。",
    providers: ["claude"],
    category: "info",
  },
  {
    command: "/release-notes",
    label: "リリースノート",
    description: "Claude Code 直近バージョンの変更点を表示する。",
    providers: ["claude"],
    category: "info",
  },
  {
    command: "/upgrade",
    label: "プランをアップグレード",
    description:
      "Claude Pro / Max のサブスク変更ページを開く。",
    providers: ["claude"],
    category: "info",
  },
  {
    command: "/bug",
    label: "バグ報告",
    description: "Claude Code のバグレポートを送る。",
    providers: ["claude"],
    category: "info",
  },
];

/**
 * 指定 provider 群で使えるコマンドを返す。
 * splitMode の場合は両方欲しいので ["claude","codex"] を渡す。
 */
export function commandsForProviders(
  providers: Provider[],
): SlashCommandDef[] {
  if (providers.length === 0) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) =>
    c.providers.some((p) => providers.includes(p)),
  );
}

/**
 * UNICREW は claude/codex を headless で動かすため、Claude Code の REPL 専用
 * コマンド（/mcp /agents /help 等）は CLI に送っても解釈されず「何も起きない」。
 * これらは UNICREW 内の対応画面に振り替える（送信時に横取り）。
 */
export type NativeSlashTarget = "addons" | "settings";

export const NATIVE_SLASH: Record<
  string,
  { target: NativeSlashTarget; hint: string }
> = {
  "/mcp": { target: "addons", hint: "MCP / アドオン画面を開きます" },
  "/agents": { target: "addons", hint: "サブエージェント / スキルを開きます" },
  "/help": { target: "settings", hint: "設定（ヘルプ・アカウント）を開きます" },
  "/config": { target: "settings", hint: "設定を開きます" },
  "/settings": { target: "settings", hint: "設定を開きます" },
  "/permissions": { target: "settings", hint: "設定（権限・モード）を開きます" },
  "/status": { target: "settings", hint: "設定（接続状態）を開きます" },
  "/model": { target: "settings", hint: "設定（モデル）を開きます" },
  "/login": { target: "settings", hint: "設定（ログイン）を開きます" },
  "/logout": { target: "settings", hint: "設定（ログアウト）を開きます" },
  "/doctor": { target: "settings", hint: "設定（診断）を開きます" },
  "/cost": { target: "settings", hint: "設定を開きます" },
};

/**
 * 入力が「UNICREW で横取りすべき REPL コマンド」なら対応先を返す。
 * 先頭トークンだけ見る（引数付きでも判定可）。それ以外は null（＝通常送信）。
 */
export function resolveNativeSlash(
  text: string,
): { command: string; target: NativeSlashTarget; hint: string } | null {
  const head = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!head.startsWith("/")) return null;
  const hit = NATIVE_SLASH[head];
  return hit ? { command: head, ...hit } : null;
}

/**
 * headless では Claude Code の会話系 REPL コマンド（/compact /clear 等）を
 * 素送りすると claude プロセスがそのターンで終了したり無反応になる
 * （/mcp 等の「画面振替」とは別クラス＝会話操作）。これらは自然言語の
 * 指示へ書き換えて送ることで、セッションを落とさず実用的に効かせる。
 * 戻り値が string ならその文字列で送信、null なら書き換え対象外。
 */
export function rewriteSlashForHeadless(text: string): string | null {
  const head = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!head.startsWith("/")) return null;
  switch (head) {
    case "/compact":
      return "ここまでの会話の要点（決定事項・前提・未解決・次の一手）を簡潔な箇条書きで要約してください。以降はその要約だけを文脈として続け、それ以前の細部は参照しなくて構いません。";
    case "/clear":
    case "/new":
      return "ここから新しい話題として扱ってください。これまでの会話の文脈はいったん忘れ、まっさらな状態で次の指示に答えてください（履歴を完全に消したい場合は左上の新規スレッドを使ってください）。";
    case "/resume":
      return "直前の作業の続きから再開してください。どこまで終わっていて次に何をするかを最初に一言で確認してから進めてください。";
    default:
      return null;
  }
}
