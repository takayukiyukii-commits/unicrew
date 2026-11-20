/**
 * AIオフィス（v0.7.0）の型。
 *
 * 会社（Office）＝作業フォルダ1つ＋社員の名簿。社員（Staff）＝AI 1つ＋「仕事のやり方」の文章。
 * 取りまとめ役（lead）だけが社長（利用者）と話し、仕事を社員に振る。
 *
 * 🚨 社員は Claude Code のサブエージェント機能に頼らない。社員1人＝AI のセッション1本にして、
 *    仕事の受け渡しは UNICREW が運ぶ（lib/office/protocol.ts）。こうすると
 *    ①Codex など他社の AI も同じ席に座れる ②誰の作業かが混ざらない（セッションで分かれる）。
 */
import type { ModelId, Provider } from "../types";
import type { Artifact } from "../turn-artifacts";

/** 社員の見た目。builtin＝最初から入っている見本／image＝利用者が差し替えた絵。 */
export type StaffLook =
  | { kind: "builtin"; sample: string }
  | { kind: "image"; path: string };

export interface Department {
  id: string;
  name: string;
  /** 机の島の色（#rrggbb） */
  color: string;
}

export interface Staff {
  id: string;
  /** 名前（例: 森田 圭介） */
  name: string;
  /** 担当の呼び名（例: デザイン担当） */
  role: string;
  deptId: string | null;
  /** true＝取りまとめ役。会社に1人だけ。社長と話すのはこの人だけ */
  lead: boolean;
  provider: Provider;
  model: ModelId;
  /** 仕事のやり方（普通の日本語。AI への指示としてそのまま渡る） */
  manual: string;
  look: StaffLook;
}

export interface Office {
  id: string;
  name: string;
  /** 会社名の下に出す一言（例: SNS運用代行） */
  tagline: string;
  /** 作業フォルダ。社員はこの中で仕事をする。ターミナルの作業フォルダにもなる */
  workspace: string | null;
  /** 部屋の雰囲気（lib/office/themes.ts の id） */
  theme: string;
  departments: Department[];
  staff: Staff[];
  createdAt: number;
  updatedAt: number;
}

export type StaffStatus = "idle" | "working" | "waiting" | "done";

export interface StaffRuntime {
  status: StaffStatus;
  /** 頭の上に出す一言（いまやっていること）。無ければ null */
  bubble: string | null;
  /** いま持っている仕事の短い題（案件ボードの付箋に出す） */
  task: string | null;
  /** このターンで書いている返事（終わったら報告として使う） */
  draft: string;
  /** このターンで使っている道具（tool_use_id → 中身） */
  tools: Record<string, { name: string; input: Record<string, unknown>; done: boolean; error: boolean; result?: string }>;
  /** この仕事で動いた回数 */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** CLI 側のセッション ID（続きから再開するため） */
  cliSessionId: string | null;
  /** AI を起動済みか（アプリを開き直すと false に戻る） */
  started: boolean;
  /** 最後の報告・返事の出だし（部屋の中の会話の吹き出しに出す）。古い保存には無い */
  said?: string | null;
  /** いまのセッションを起動したときの AI と作業フォルダ（変わったら、前の続きからは始めない） */
  sessionKey?: string;
  /** この時刻に「出社」した（表示だけ。RUNner の仕事を受け取った社員が扉から入ってくる）。保存しない */
  arrive?: number;
  /** いまのターンで数え済みのトークン（実況の数字は同じターンの中で増えていくので差分だけ足す） */
  turnIn: number;
  turnOut: number;
}

export type BossMessageKind = "boss" | "lead" | "question" | "system";

export interface BossMessage {
  id: string;
  kind: BossMessageKind;
  /** 発言した社員（boss・system は null） */
  staffId: string | null;
  text: string;
  at: number;
  /** question だけ：答え済みか */
  answered?: boolean;
}

export interface Approval {
  id: string;
  staffId: string;
  title: string;
  body: string;
  /** 見せるファイル（あれば「中身を見る」で開く） */
  file: string | null;
  at: number;
}

export interface PermissionAsk {
  id: string;
  staffId: string;
  requestId: string;
  toolName: string;
  /** 利用者に見せる説明（何をしようとしているか） */
  text: string;
  at: number;
}

export interface Delivery {
  id: string;
  staffId: string;
  artifact: Artifact;
  at: number;
}

export interface Notice {
  id: string;
  staffId: string | null;
  text: string;
  at: number;
}

/** 外から届いた相談（お客さんの問い合わせなど）と、社員が書いた返事の下書き。 */
export interface Inquiry {
  id: string;
  text: string;
  at: number;
  /** 返事の下書き（まだなら null）。送るのは社長（UNICREW は送らない） */
  reply: string | null;
  replyAt: number | null;
}

export interface JobUsage {
  leadTurns: number;
  staffTurns: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: number | null;
  /** 動いていた時間の合計（ミリ秒）。動いている間は startedAt からの経過を足して出す */
  activeMs: number;
  activeSince: number | null;
}

/** 会社1つの「いま」。保存して開き直しても続きが見える。 */
export interface OfficeRun {
  officeId: string;
  staff: Record<string, StaffRuntime>;
  log: BossMessage[];
  approval: Approval | null;
  permissions: PermissionAsk[];
  deliveries: Delivery[];
  notices: Notice[];
  /** 相談の受け箱（新しいものが先） */
  inbox: Inquiry[];
  /** OK が出た時刻（社員が喜ぶ動きのきっかけ）。無ければ 0 */
  cheerAt: number;
  usage: JobUsage;
  /** 取りまとめ役が返事を待っている社員（報告がそろったらまとめて渡す） */
  awaiting: string[];
  /** そろうまで預かっている報告 */
  reports: { staffId: string; text: string; files: string[]; failed: boolean }[];
  /** 仕事が進行中か（社長の番でない） */
  busy: boolean;
  /** 取りまとめ役の手が空くのを待っている指示（作業中・確認待ちの間に届いたもの） */
  pending?: string[];
  /** 取りまとめ役への初回の指示を送ったか（社員名簿の案内を1回だけ添える） */
  briefed: boolean;
}

/** 画面や AI から届く出来事。engine.step に渡す。 */
export type OfficeInput =
  | { t: "boss"; text: string; at: number }
  | { t: "inquiry"; text: string; at: number }
  | { t: "approve"; ok: boolean; comment: string; at: number }
  | { t: "permission"; askId: string; allow: boolean; at: number }
  | { t: "stop"; at: number }
  | { t: "agent"; staffId: string; ev: OfficeAgentEvent; at: number }
  | { t: "started"; staffId: string; sessionKey?: string; /** 前の会話の続きではない（前の会話の番号は捨てる） */ fresh?: boolean }
  /** 社員を消した・設定を変えたあとに、待ち合わせをそろえ直す */
  | { t: "sync"; at: number }
  /** 会社を切り替える・消すとき：動いている AI を全部止める（確認待ちの札は残す） */
  | { t: "suspend"; at: number }
  | { t: "start_failed"; staffId: string; message: string; at: number };

/** lib/tauri.ts の AgentEvent から session_id を外したもの（誰のものかは staffId で渡す）。 */
export type OfficeAgentEvent =
  | { kind: "ready" }
  | { kind: "cli_session_id"; cli_session_id: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; tool_use_id: string; tool_name: string; tool_input: Record<string, unknown> }
  | { kind: "tool_result"; tool_use_id: string; is_error: boolean; content: unknown }
  | { kind: "permission_request"; request_id: string; tool_name: string; input: Record<string, unknown> }
  | { kind: "usage_delta"; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number }
  | { kind: "result"; subtype: string }
  | { kind: "error"; message: string };

/** engine.step が「外でやってほしいこと」として返すもの。 */
export type OfficeEffect =
  | { t: "send"; staffId: string; text: string }
  | { t: "stop"; staffId: string }
  | { t: "permission"; staffId: string; requestId: string; allow: boolean }
  | { t: "attention"; title: string; body: string }
  | { t: "preview"; artifacts: Artifact[] };
