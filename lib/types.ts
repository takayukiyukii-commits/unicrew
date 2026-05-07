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
  /** 会議モードの何ラウンド目か。0 = 最初の応答、1+ = 議論ラウンド */
  conferenceRound?: number;
  /** トークン消費・所要時間のスナップショット。assistant のみ。 */
  stats?: MessageStats;
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
   * 並列モード時のプロバイダ別キャラ。
   * 設定されていれば Claude / Codex で別人格になる（CDO×CMO 議論など）。
   * 未設定なら `characterId` を両方に使う（後方互換）。
   */
  splitCharacterIds?: { claude: string; codex: string };
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

export type Provider = "claude" | "codex";

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
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
