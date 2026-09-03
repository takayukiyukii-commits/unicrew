import type { AuditDepth, AuditLayer, AuditMeta, Message, Provider, Thread } from "./types";
import { PROVIDER_LABELS } from "./types";
import type { ChangedFile } from "./tauri";

/**
 * 相互監査（v0.4.0・Cursor の Agent Review の輸入）。
 *
 * 「実装した本人（同じ会話の自己点検）は自分の意図の外側が盲点になる」ので、
 * **実装したプロバイダと別の会社のAI** を読み取り専用（plan）で起動し、
 * audit-playbook 付録Bの型（対象／差分／仕様であって欠陥でないもの／観点1つ／出力形式）で
 * ブリーフを渡す。ここは純関数だけ（監査役の選定・観点の輪番・ブリーフ生成・`/監査` の解釈）。
 */

export type { AuditDepth, AuditLayer, AuditMeta } from "./types";

export const AUDIT_SLOT_PREFIX = "audit-";

/** 監査役の一時スロットID か。 */
export function isAuditSlotId(slotId: string | null | undefined): boolean {
  return !!slotId && slotId.startsWith(AUDIT_SLOT_PREFIX);
}

/** 監査役の session id か（`<threadId>::audit-xxxx`）。 */
export function isAuditSid(sid: string): boolean {
  const i = sid.lastIndexOf("::");
  return i >= 0 && sid.slice(i + 2).startsWith(AUDIT_SLOT_PREFIX);
}

/** プロバイダ → 会社。別会社かどうかの判定にだけ使う（表示には使わない）。 */
export const PROVIDER_COMPANY: Record<Provider, string> = {
  claude: "anthropic",
  codex: "openai",
  "codex-acp": "openai",
  gemini: "google",
  goose: "block",
  opencode: "opencode",
  kiro: "aws",
  qwen: "alibaba",
  kimi: "moonshot",
  grok: "xai",
  cursor: "cursor",
};

export function providerCompany(p: Provider): string {
  return PROVIDER_COMPANY[p] ?? p;
}

/**
 * 監査役を選ぶ。既定は「実装した会社と別の会社」：claude→codex、codex→claude、それ以外→claude。
 * available（接続済み）に無ければ順に落ちる。別会社が1つも無ければ同じ会社で続行（sameCompany:true）。
 * 何も無ければ null。
 */
export function pickAuditor(
  implementer: Provider | null,
  available: Provider[],
): { auditor: Provider; sameCompany: boolean } | null {
  if (available.length === 0) return null;
  const preferred: Provider[] =
    implementer === "claude" ? ["codex", "gemini", "claude"] : implementer === "codex" ? ["claude", "gemini", "codex"] : ["claude", "codex", "gemini"];
  const ordered: Provider[] = [...preferred, ...available.filter((p) => !preferred.includes(p))];
  const implCompany = implementer ? providerCompany(implementer) : null;
  const other = ordered.find((p) => available.includes(p) && providerCompany(p) !== implCompany);
  if (other) return { auditor: other, sameCompany: false };
  const same = ordered.find((p) => available.includes(p));
  return same ? { auditor: same, sameCompany: true } : null;
}

/** 実装したプロバイダ＝直近の（監査でない）AI 発言のプロバイダ。無ければ null。 */
export function implementerOf(thread: Thread): { provider: Provider | null; slotId: string | null } {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i];
    if (m.role !== "assistant" || m.audit || m.participantRole === "moderator") continue;
    return { provider: m.provider ?? null, slotId: m.participantSlotId ?? null };
  }
  return { provider: null, slotId: null };
}

export const AUDIT_LAYER_LABELS: Record<AuditLayer, string> = {
  1: "第1層 コードの正しさ（認可・冪等・競合・境界）",
  2: "第2層 表示と実装の一致（文言・分母・記録・仕様との食い違い）",
  3: "第3層 運用（デプロイ順・気づけるか・戻せるか・依存の更新）",
};

/** 前回と違う層を既定にする（1→2→3→1）。監査がまだ無ければ 1。 */
export function nextAuditLayer(thread: Thread): AuditLayer {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const a = thread.messages[i].audit;
    if (a) return ((a.layer % 3) + 1) as AuditLayer;
  }
  return 1;
}

export interface AuditCommand {
  depth?: AuditDepth;
  layer?: AuditLayer;
  note: string;
}

/**
 * `/監査` `/audit` を解釈する。引数は順不同：`quick|deep`、`1|2|3`（`第2層` も可）、残りは
 * 「仕様であって欠陥ではないもの」のメモ。監査コマンドでなければ null。
 */
export function parseAuditCommand(text: string): AuditCommand | null {
  const trimmed = text.trim();
  const m = /^\/(監査|audit)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!m) return null;
  const out: AuditCommand = { note: "" };
  const rest: string[] = [];
  for (const tok of (m[2] ?? "").split(/\s+/).filter(Boolean)) {
    const lower = tok.toLowerCase();
    if (lower === "quick" || lower === "deep") {
      out.depth = lower;
      continue;
    }
    const lm = /^(?:第)?([123])(?:層)?$/.exec(tok);
    if (lm) {
      out.layer = Number(lm[1]) as AuditLayer;
      continue;
    }
    rest.push(tok);
  }
  out.note = rest.join(" ");
  return out;
}

export interface AuditBriefInput {
  layer: AuditLayer;
  depth: AuditDepth;
  files: ChangedFile[];
  patch: string;
  patchTruncated: boolean;
  /** ワークスペース直下の AUDIT.md（無ければ空） */
  auditMd: string;
  /** 依頼者のメモ（仕様であって欠陥ではないもの等） */
  note: string;
  implementer: Provider | null;
  /** 差分の基準（"head"=最後のコミット以降 / "turn" / "empty"） */
  baseKind: string;
}

/** 監査役の system prompt（キャラの人格は使わない・読むだけ）。 */
export function auditorSystemPrompt(): string {
  return `あなたは監査役です。実装した本人とは別のAIとして、渡された変更を読み、欠陥を見つけます。
- ファイルは読んでよいが、書き換え・作成・削除・コマンド実行はしない（読み取り専用）
- 指摘は必ず「場所（ファイル:行）」と「再現の手順か根拠」を添える。根拠が示せないものは書かない
- 「仕様であって欠陥ではない」と依頼者が明示したものは指摘しない
- 分からないことは「判定不能」と書く。推測で欠陥にしない
- 指摘が無ければ「指摘なし」と書き、何を見て無しと判断したかを1行添える`;
}

/** audit-playbook 付録Bの型でブリーフを組む。 */
export function buildAuditBrief(input: AuditBriefInput): string {
  const { layer, depth, files, patch, patchTruncated, auditMd, note, implementer, baseKind } = input;
  const list = files
    .slice(0, 200)
    .map((f) => `- ${f.status} ${f.old_path ? `${f.old_path} → ` : ""}${f.path}${f.binary ? "（バイナリ）" : ` (+${f.additions}/−${f.deletions})`}`)
    .join("\n");
  const more = files.length > 200 ? `\n- …ほか ${files.length - 200} ファイル` : "";
  const baseLabel =
    baseKind === "turn" ? "このターンの送信時点" : baseKind === "empty" ? "リポジトリの最初（コミット無し）" : "最後のコミット（HEAD）";
  const implLabel = implementer ? PROVIDER_LABELS[implementer] : "不明";
  const depthBlock =
    depth === "deep"
      ? "## 深さ: Deep\n差分だけで判断せず、呼び出し元・呼び出し先・テスト・設定など関連ファイルを読んで裏取りしてください（読み取りのみ）。"
      : "## 深さ: Quick\n差分本文だけで判断してください。差分の外を読まないと判断できないものは「判定不能（要Deep）」と書いてください。";
  const specBlock = [note.trim() ? `依頼者のメモ:\n${note.trim()}` : "", auditMd.trim() ? `AUDIT.md（この作業場の監査ルール）:\n${auditMd.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return `# 監査依頼（相互監査）

実装したAI: ${implLabel}。あなたは別のAIとして、この変更を監査します。

## ① 対象
基準: ${baseLabel} からの変更・${files.length} ファイル
${list}${more}

## ② 差分本文
${patchTruncated ? "（大きいため先頭だけ。残りはファイルを読んでください）\n" : ""}\`\`\`diff
${patch.trim() || "（差分本文なし）"}
\`\`\`

## ③ 仕様であって欠陥ではないもの
${specBlock || "（依頼者からの指定なし。明らかな意図的設計は「仕様の可能性」と添えて書く）"}

## ④ 観点（この回はこれ1つだけ）
${AUDIT_LAYER_LABELS[layer]}
この観点の外の指摘は末尾に「観点外」として短く分けてください。

${depthBlock}

## ⑤ 出力形式
\`\`\`
FINDINGS
1. [重大度: HIGH|MEDIUM|LOW|判定不能] 場所: <ファイル:行>
   何が: <欠陥の内容>
   再現/根拠: <手順か根拠>
   修正案: <最小の直し方>
...
観点外: （あれば）
指摘なし: （無い場合。何を見て無しとしたか1行）
\`\`\`
指摘は重大度順。数は水増ししない。`;
}

/** 監査結果を実装AIに渡す本文（「裏取りしてから直す」の指示付き）。 */
export function buildForwardPrompt(audit: Message): string {
  const a = audit.audit;
  const who = a ? PROVIDER_LABELS[a.auditor] : "別のAI";
  const layer = a ? AUDIT_LAYER_LABELS[a.layer] : "";
  return `以下は別のAI（${who}）による監査の指摘です${layer ? `（観点: ${layer}）` : ""}。

各指摘について、まず**コードを読んで裏取り**してください。
- 妥当なら直す（最小の変更で。ついでの改修はしない）
- 妥当でない・仕様である場合は、理由を添えて「却下」と書く（黙って無視しない）
- 「指摘は妥当だが修正案が不十分」の場合は正しい直し方で直す
最後に「直した／却下した／判定不能」の一覧を出してください。

---

${audit.content.trim()}`;
}

/** 依頼の記録（会話に残す1行）。 */
export function auditRequestLine(meta: AuditMeta, fileCount: number): string {
  const layer = AUDIT_LAYER_LABELS[meta.layer].split(" ")[0];
  return `[監査依頼] ${layer}・${meta.depth === "deep" ? "Deep" : "Quick"}・監査役 ${PROVIDER_LABELS[meta.auditor]}${meta.sameCompany ? "（同じ会社）" : ""}・対象 ${fileCount} ファイル`;
}
