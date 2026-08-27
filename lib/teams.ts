"use client";

import { nanoid } from "nanoid";
import type { AiTeam, ParticipantSlot } from "./types";
import { PROVIDER_LABELS, type Provider } from "./types";

// 監査（ファイルタブR1）: インポート/復元の入力上限。巨大JSONでのUIフリーズ・
// localStorage 肥大を防ぐ。
const MAX_PARTICIPANTS = 8;
const MAX_NAME_LEN = 120;
const MAX_DESC_LEN = 2000;
const KNOWN_PROVIDERS = new Set(Object.keys(PROVIDER_LABELS));

/** 未知 provider は claude にフォールバック（許可リスト照合）。 */
function normalizeProvider(v: unknown): Provider {
  const s = typeof v === "string" ? v : "";
  return (KNOWN_PROVIDERS.has(s) ? s : "claude") as Provider;
}

/**
 * 組み込みチームテンプレート。
 *
 * これらは「いきなり使える状態」ではなく、ユーザーがコピーして個別キャラを差し替える
 * 起点として使う。直接編集／削除はされない（isTemplate: true）。
 *
 * 設計思想：CLAUDE.md の "機能のユニークさ × 使う人のユニークさ" に合わせ、
 * uniLinks の役職体系（CDO/CMO/CPO/CFO/CSO）と相性の良い組み合わせを選ぶ。
 */
export const TEMPLATE_TEAMS: AiTeam[] = [
  {
    id: "tmpl-team-unilinks-planning",
    name: "uniLinks 企画会議チーム",
    description:
      "新機能・新製品の企画レビュー。プロダクト/マーケ/技術の3視点で並走し、中立審判が合意度を測る。",
    emoji: "",
    defaultConference: true,
    defaultMaxRounds: 3,
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-cpo" },
      { id: "p2", provider: "claude", characterId: "tmpl-cmo" },
      { id: "p3", provider: "codex", characterId: "tmpl-cdo" },
    ],
    moderator: {
      id: "mod",
      provider: "claude",
      characterId: "tmpl-ceo",
      role: "moderator",
    },
    defaultModel: "claude-sonnet-4-6",
    isTemplate: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "tmpl-team-code-review",
    name: "コードレビューチーム",
    description:
      "実装者・レビュアー・セキュリティ監査の3体で同じPRを評価。CDOが司会して合意を取る。",
    emoji: "",
    defaultConference: true,
    defaultMaxRounds: 3,
    participants: [
      { id: "p1", provider: "codex", characterId: "tmpl-cdo" },
      { id: "p2", provider: "claude", characterId: "tmpl-cdo" },
      { id: "p3", provider: "claude", characterId: "tmpl-cdo" },
    ],
    defaultModel: "claude-opus-4-7",
    isTemplate: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "tmpl-team-debate",
    name: "ディベートチーム（賛成 vs 反対）",
    description:
      "論点を「賛成派」「反対派」に分けて議論させる。中立審判が論理性で勝敗判定。",
    emoji: "",
    defaultConference: true,
    defaultMaxRounds: 4,
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-cdo" },
      { id: "p2", provider: "codex", characterId: "tmpl-cdo" },
    ],
    moderator: {
      id: "mod",
      provider: "claude",
      characterId: "tmpl-ceo",
      role: "moderator",
    },
    defaultModel: "claude-sonnet-4-6",
    isTemplate: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "tmpl-team-marketing",
    name: "マーケ作戦会議",
    description:
      "CMO/CSO/CPO の3体でキャンペーン設計。客視点・売上視点・体験視点を並走。",
    emoji: "",
    defaultConference: false,
    defaultMaxRounds: 2,
    participants: [
      { id: "p1", provider: "claude", characterId: "tmpl-cmo" },
      { id: "p2", provider: "claude", characterId: "tmpl-cso" },
      { id: "p3", provider: "claude", characterId: "tmpl-cpo" },
    ],
    defaultModel: "claude-sonnet-4-6",
    isTemplate: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

const STORAGE_KEY = "unicrew.user_teams.v1";

export function loadUserTeams(): AiTeam[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // 監査（R1）: 非配列や壊れた要素で getAllTeams/handleCreateFromTeam が
    // TypeError で落ちるのを防ぐ。配列でない/participants が配列でない要素は捨てる。
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is AiTeam =>
        !!t &&
        typeof t === "object" &&
        Array.isArray((t as { participants?: unknown }).participants),
    );
  } catch {
    return [];
  }
}

export function saveUserTeams(teams: AiTeam[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(teams));
}

export function getAllTeams(): AiTeam[] {
  return [...loadUserTeams(), ...TEMPLATE_TEAMS];
}

export function getTeam(id: string): AiTeam | undefined {
  return getAllTeams().find((t) => t.id === id);
}

export function newTeamId(): string {
  return "team-" + nanoid(10);
}

export function cloneFromTemplateTeam(tmpl: AiTeam): AiTeam {
  const now = Date.now();
  return {
    ...tmpl,
    id: newTeamId(),
    isTemplate: false,
    // 参加者・審判のIDは新スレッドで連番に振り直す前提
    participants: tmpl.participants.map(
      (p, i): ParticipantSlot => ({ ...p, id: `p${i + 1}` }),
    ),
    moderator: tmpl.moderator
      ? { ...tmpl.moderator, id: "mod" }
      : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * チームをエクスポート用JSON文字列に変換する。
 *
 * id / createdAt / updatedAt / isTemplate は受け取り側で再生成するので外す。
 * 受け取り側が信頼できないチーム（外部配布）でも安全に取り込めるように
 * ParticipantSlot の characterId 等は変換せず、そのまま渡す（不在キャラは
 * 取り込み後にユーザーが差し替える前提）。
 */
export function exportTeamToJson(team: AiTeam): string {
  const sanitized = {
    schema: "unicrew.team.v1",
    name: team.name,
    description: team.description,
    emoji: team.emoji,
    defaultConference: team.defaultConference,
    defaultMaxRounds: team.defaultMaxRounds,
    participants: team.participants.map((p) => ({
      provider: p.provider,
      characterId: p.characterId,
      role: p.role ?? "participant",
    })),
    moderator: team.moderator
      ? {
          provider: team.moderator.provider,
          characterId: team.moderator.characterId,
          role: "moderator" as const,
        }
      : undefined,
    defaultModel: team.defaultModel,
  };
  return JSON.stringify(sanitized, null, 2);
}

/**
 * JSON文字列からチームを取り込む。
 *
 * - schema が一致しなければ throw
 * - id / 日付 / isTemplate は新規発行
 * - participants の id は連番 p1.. に振り直し
 * - moderator は id="mod"
 * - 不正なフィールドは握りつぶさず throw（取り込み失敗を明示）
 */
export function importTeamFromJson(json: string): AiTeam {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `JSON のパースに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("チームJSONが正しい形式ではありません（オブジェクトを期待）");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== "unicrew.team.v1") {
    throw new Error(
      `未対応のスキーマです: ${String(obj.schema)} (期待: unicrew.team.v1)`,
    );
  }
  const name = typeof obj.name === "string" ? obj.name.slice(0, MAX_NAME_LEN) : "";
  if (!name.trim()) throw new Error("name フィールドが空です");

  const rawParticipants = Array.isArray(obj.participants)
    ? (obj.participants as Array<Record<string, unknown>>)
    : [];
  if (rawParticipants.length < 1) {
    throw new Error("participants が1人以上必要です");
  }
  // 監査（R1）: 参加者数の上限（巨大配列での UI フリーズ・localStorage 肥大を防ぐ）
  if (rawParticipants.length > MAX_PARTICIPANTS) {
    throw new Error(`participants が多すぎます（最大 ${MAX_PARTICIPANTS} 人）`);
  }
  const participants: ParticipantSlot[] = rawParticipants.map((p, i) => {
    // 監査（R1）: provider は許可リストで検証（未知値は claude にフォールバック）
    const provider = normalizeProvider(p.provider);
    const characterId =
      typeof p.characterId === "string" && p.characterId.length <= MAX_NAME_LEN
        ? p.characterId
        : "tmpl-claude-normal";
    return {
      id: `p${i + 1}`,
      provider,
      characterId,
      role: "participant",
    };
  });

  const rawMod = obj.moderator as Record<string, unknown> | undefined;
  const moderator: ParticipantSlot | undefined = rawMod
    ? {
        id: "mod",
        provider: normalizeProvider(rawMod.provider),
        characterId:
          typeof rawMod.characterId === "string" &&
          rawMod.characterId.length <= MAX_NAME_LEN
            ? rawMod.characterId
            : "tmpl-claude-normal",
        role: "moderator",
      }
    : undefined;

  const now = Date.now();
  return {
    id: newTeamId(),
    name,
    description:
      typeof obj.description === "string"
        ? obj.description.slice(0, MAX_DESC_LEN)
        : "",
    emoji: typeof obj.emoji === "string" ? obj.emoji : "✨",
    defaultConference: Boolean(obj.defaultConference ?? false),
    defaultMaxRounds:
      typeof obj.defaultMaxRounds === "number" ? obj.defaultMaxRounds : 3,
    participants,
    moderator,
    defaultModel:
      typeof obj.defaultModel === "string"
        ? (obj.defaultModel as AiTeam["defaultModel"])
        : "claude-sonnet-4-6",
    isTemplate: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * チーム → 新スレッドの participants 配列に変換する。
 * moderator が居れば末尾に追加する（UIではmoderatorだけ別枠表示）。
 */
export function teamToParticipants(team: AiTeam): ParticipantSlot[] {
  const list: ParticipantSlot[] = team.participants.map((p, i) => ({
    ...p,
    id: p.id || `p${i + 1}`,
    role: p.role ?? "participant",
  }));
  if (team.moderator) {
    list.push({
      ...team.moderator,
      id: team.moderator.id || "mod",
      role: "moderator",
    });
  }
  return list;
}
