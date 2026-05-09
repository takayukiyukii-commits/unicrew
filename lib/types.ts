export type ModelId =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001";

export const MODEL_LABELS: Record<ModelId, string> = {
  "claude-opus-4-7": "Opus 4.7（最強・じっくり）",
  "claude-sonnet-4-6": "Sonnet 4.6（バランス）",
  "claude-haiku-4-5-20251001": "Haiku 4.5（高速）",
};

export type Role = "user" | "assistant";

export interface ToolUseBlock {
  kind: "tool_use";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "completed" | "errored";
  result?: string;
  isError?: boolean;
}

export interface TextBlock {
  kind: "text";
  text: string;
}

export type Block = TextBlock | ToolUseBlock;

export interface MessageStats {
  /** Claude/Codex に送られた入力トークン（このターンの追加分。キャッシュ含む合計） */
  inputTokens: number;
  /** Claude/Codex から返ってきた出力トークン */
  outputTokens: number;
  /** キャッシュ読み出しで節約できた入力分 */
  cacheReadTokens: number;
  /** キャッシュ書き込みに使った入力分 */
  cacheCreationTokens: number;
  /** 応答全体（送信〜completed）の経過ミリ秒 */
  durationMs: number;
  /** 最初のテキスト到達までの「考え中」ミリ秒（null = 計測できなかった/text無し） */
  thinkingMs: number | null;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  blocks?: Block[];
  createdAt: number;
  /** どのプロバイダの応答か。user メッセージや単独モードでは未定義。 */
  provider?: Provider;
  /**
   * N-way並列で同じproviderが複数いる場合（Claude×Claude×Codex 等）に
   * どのスロットの応答かを識別するためのID。`Thread.participants[].id` を指す。
   * 旧2way構造のスレッドでは未定義（provider で十分判別可能）。
   */
  participantSlotId?: string;
  /** 議論モードでの役割。未指定はparticipant扱い。moderatorは中立審判（Phase 2）。 */
  participantRole?: ParticipantRole;
  /** 会議モードの何ラウンド目か。0 = 最初の応答、1+ = 議論ラウンド */
  conferenceRound?: number;
  /** トークン消費・所要時間のスナップショット。assistant のみ。 */
  stats?: MessageStats;
}

export type ParticipantRole = "participant" | "moderator";

/**
 * N-way並列の参加者スロット。
 *
 * 1スレッドに複数置ける（最大4まで現UI想定）。同じプロバイダを複数置いても良い
 * （例: Claude×Claude×Codex で PM/エンジニア/批評家の3体）。
 */
export interface ParticipantSlot {
  /** スロット識別子。session_id の suffix に使うため英数のみ推奨。 */
  id: string;
  provider: Provider;
  characterId: string;
  /**
   * "participant"（既定）= 議論に参加する通常メンバー
   * "moderator"        = 中立審判。議論を読み合意度・残論点・推奨アクションをJSONで返す
   */
  role?: ParticipantRole;
}

export interface Character {
  id: string;
  name: string;
  roleTag: string;
  emoji: string;
  /** ローカル画像の絶対パス。Tauri convertFileSrc で表示。null ならemoji表示。 */
  avatarPath: string | null;
  accentColor: string;
  /** 役割としての指示プロンプト（何の専門家か、思考の癖）。 */
  systemPrompt: string;
  /** 人格テンプレID。lib/personalities.ts から選ぶ。null なら口調指示なし。 */
  personalityId: string | null;
  defaultModel: ModelId;
  /** 既定プロバイダ。並列モード時は両方走らせるためここは「単独モードでの既定」 */
  provider: Provider;
  description: string;
  /** true = 組み込みテンプレート（編集・削除不可、複製のみ）。false = ユーザー作成 */
  isTemplate: boolean;
}

export interface Thread {
  id: string;
  title: string;
  /**
   * 単独モードのキャラ。並列モードでも `splitCharacterIds` 未設定なら両プロバイダ共通フォールバックとして使う。
   */
  characterId: string;
  /**
   * 並列モード時のプロバイダ別キャラ（旧2way専用）。
   * 設定されていれば Claude / Codex で別人格になる（CDO×CMO 議論など）。
   * 未設定なら `characterId` を両方に使う（後方互換）。
   *
   * Phase 1 以降は `participants` が優先される（N-way対応）。
   */
  splitCharacterIds?: { claude: string; codex: string };
  /**
   * N-way並列の参加者リスト。
   * 設定されていれば `splitCharacterIds` よりこちらが優先される。
   * 2人以上で「並列モード」、3人以上で「3-way / N-way」扱い。
   * 同じプロバイダを複数並べても良い（Claude×Claude×Codex 等）。
   */
  participants?: ParticipantSlot[];
  /**
   * 議論モード（conferenceMode）での総合評価役。
   * 設定されていれば各ラウンド終了時に participants の発言を読み、合意度スコア・残論点・
   * 推奨アクションをJSONで返す。Phase 2機能。
   */
  moderator?: ParticipantSlot;
  model: ModelId;
  workspace: string | null;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** true なら Claude と Codex を並列実行（左右2カラムで表示） */
  splitMode: boolean;
  /** splitMode且つ true なら、両AIが互いの回答を読んで批判・改善を繰り返す */
  conferenceMode: boolean;
  /** 最大ラウンド数（デフォルト 3） */
  conferenceMaxRounds: number;
}

export type AuthMode = "subscription" | "apikey";

/**
 * "gemini" は将来の gemini-cli 連携用に予約。
 * 現状では providers/build_provider が None を返すため、選んでも起動できない。
 */
export type Provider = "claude" | "codex" | "gemini";

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

export const PROVIDER_COLORS: Record<Provider, string> = {
  claude: "#dd6b20",
  codex: "#10a37f",
  gemini: "#4285f4",
};

export const PROVIDER_BADGES: Record<Provider, string> = {
  claude: "🟠",
  codex: "🟢",
  gemini: "🔵",
};

export interface AppSettings {
  defaultCharacterId: string;
  authMode: AuthMode;
  /**
   * ツール実行（ファイル編集・コマンド・検索）の詳細を表示するか。
   * - true（既定）: ツールバブルとアクティビティパネルを表示（コーディング状況が見える）
   * - false: ツール詳細を隠して日本語の応答だけ表示（クリーンチャット）
   */
  showActivity: boolean;
  /**
   * 上級者モード。ON で AddonsSection に任意 marketplace / MCP URL の追加 UI が出る。
   * 既定 OFF（curated only）。
   */
  advancedMode?: boolean;
  /**
   * 初心者モード。CLI 用語・技術用語を一切表示せず、AI が手を動かす前提の応答に強制する。
   * 既定 ON（顧客像が「CLI 苦手な初心者」のため）。
   * - showActivity を強制 OFF（ツール実行詳細を隠す）
   * - systemPrompt に「技術用語の言い換え・コマンド非表示」ルールを追加
   * - 上級者は OFF にして開発者向け表示を有効化
   */
  beginnerMode?: boolean;
  // apiKey は OS Keychain（Tauri）に格納するためここに置かない
  // ブラウザdev時のみ localStorage 経由で別キー保管（lib/tauri.ts）
}

export interface PendingPermission {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * AIチームスナップ（Phase 3）。
 *
 * 複数キャラ（人格＋AI割当）を「チーム」として保存・呼び出し・共有するための型。
 * 後で キャラ／チーム販売の収益化レイヤーに繋げる前提。
 */
export interface AiTeam {
  id: string;
  name: string;
  description: string;
  /** 表示用の絵文字（チームを一目で見分けるため） */
  emoji: string;
  /** 既定の議論モード（false = 並列だけ、true = 議論ラウンドあり） */
  defaultConference: boolean;
  /** 最大ラウンド数（defaultConference=true の時に使う） */
  defaultMaxRounds: number;
  /** 参加者構成 */
  participants: ParticipantSlot[];
  /** 中立審判（任意） */
  moderator?: ParticipantSlot;
  /** モデル既定（個別キャラ側の defaultModel が優先される） */
  defaultModel: ModelId;
  /** 組み込みテンプレート or ユーザー保存 */
  isTemplate: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * タスクキュー（Phase 4）。
 *
 * 「これとこれを順次やって」と複数指示を放り込んでおくと、上から順に1件ずつ消化する。
 * Claude Code の TodoWrite と相性良。ttyd リモコン併用で寝てる間にバッチ実行。
 */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface QueuedTask {
  id: string;
  /** 紐づくスレッドID。完了時はそのスレッドにメッセージとして送られる。 */
  threadId: string;
  /** 送信内容（ユーザーメッセージとしてそのまま送る）。 */
  prompt: string;
  /** 任意のラベル（一覧に表示するため）。未指定なら prompt の先頭40字。 */
  label?: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 失敗時のエラーメッセージ。 */
  error?: string;
}
