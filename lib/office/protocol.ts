/**
 * 取りまとめ役（lead）と UNICREW の間の「合図」の決まり。
 *
 * 取りまとめ役は返事の中に合図を書いて手を止める。UNICREW がそれを読んで、
 * 社員に仕事を渡す／社長に聞く／社長に見せる／仕事を終える、を行う。
 * 合図は普通の文字なので、どの会社の AI でも書ける（道具の名前に頼らない）。
 *
 *   [[依頼:名前]] 頼む内容 [[/依頼]]      … 社員に仕事を渡す（1回の返事に何人分でも）
 *   [[質問]] 聞きたいこと [[/質問]]        … 社長に聞く
 *   [[確認:題名]] 説明（ファイル: 場所） [[/確認]] … 社長に見せて OK をもらう
 *   [[返事]] お客さんへの返事の下書き [[/返事]] … 相談の受け箱に出す（送るのは社長）
 *   [[完了]]                               … この仕事は終わり
 */
import type { Office, Staff } from "./types";

export interface Delegation {
  /** 合図に書かれた名前（そのまま） */
  to: string;
  text: string;
}

export interface LeadDirectives {
  /** 合図を取り除いた、社長に見せる文 */
  plain: string;
  delegations: Delegation[];
  question: string | null;
  approval: { title: string; body: string; file: string | null } | null;
  /** お客さんへの返事の下書き（相談の受け箱に出す） */
  reply: string | null;
  done: boolean;
}

// 全角の括弧・コロンで書かれても拾う（日本語入力のまま書く AI がいる）
const OPEN = "(?:\\[\\[|［［)";
const CLOSE = "(?:\\]\\]|］］)";
const COLON = "[:：]";

function block(name: string, withArg: boolean): RegExp {
  const arg = withArg ? `(?:\\s*${COLON}\\s*([^\\]］\\n]*?))?` : "";
  return new RegExp(`${OPEN}\\s*${name}${arg}\\s*${CLOSE}([\\s\\S]*?)${OPEN}\\s*[\\/／]\\s*${name}\\s*${CLOSE}`, "g");
}

const FILE_LINE = /(?:^|\n)\s*(?:見せる)?ファイル\s*[:：]\s*(.+?)\s*(?=\n|$)/;

/** ``` で囲んだ所（説明のために書いた例）を、合図として読まないように隠す。文字数は変えない。 */
function maskFences(text: string): { masked: string; restore: (s: string) => string } {
  const kept: string[] = [];
  const masked = text.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, (m) => {
    kept.push(m);
    return `\u0000F${kept.length - 1}\u0000`;
  });
  return { masked, restore: (s) => s.replace(/\u0000F(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "") };
}

export function parseLeadDirectives(text: string): LeadDirectives {
  // 囲みの外の合図だけを読む。合図の中に囲みがあるとき（確認の中身など）は、読んだあとで元に戻す
  const fences = maskFences(text);
  const d = parseMasked(fences.masked);
  const back = fences.restore;
  return {
    plain: back(d.plain),
    delegations: d.delegations.map((g) => ({ to: g.to, text: back(g.text) })),
    question: d.question === null ? null : back(d.question),
    approval: d.approval ? { ...d.approval, body: back(d.approval.body) } : null,
    reply: d.reply === null ? null : back(d.reply),
    done: d.done,
  };
}

function parseMasked(text: string): LeadDirectives {
  let rest = text;
  const delegations: Delegation[] = [];
  rest = rest.replace(block("依頼", true), (_m, to: string | undefined, body: string) => {
    const name = (to ?? "").trim();
    const t = body.trim();
    if (name && t) delegations.push({ to: name, text: t });
    return "";
  });

  let question: string | null = null;
  rest = rest.replace(block("質問", false), (_m, body: string) => {
    const t = body.trim();
    if (t && question === null) question = t;
    return "";
  });

  let approval: LeadDirectives["approval"] = null;
  rest = rest.replace(block("確認", true), (_m, title: string | undefined, body: string) => {
    if (approval !== null) return "";
    const fm = body.match(FILE_LINE);
    const file = fm ? fm[1].replace(/^[`"'「]+|[`"'」）)]+$/g, "").trim() || null : null;
    const clean = (fm ? body.replace(fm[0], "\n") : body).trim();
    approval = { title: (title ?? "").trim() || "確認のお願い", body: clean, file };
    return "";
  });

  let reply: string | null = null;
  rest = rest.replace(block("返事", false), (_m, body: string) => {
    const t = body.trim();
    if (t && reply === null) reply = t;
    return "";
  });

  const doneRe = new RegExp(`${OPEN}\\s*完了\\s*${CLOSE}`, "g");
  const done = doneRe.test(rest);
  rest = rest.replace(doneRe, "");

  return { plain: rest.replace(/\n{3,}/g, "\n\n").trim(), delegations, question, approval, reply, done };
}

/** 合図に書かれた名前から社員を探す（姓だけ・「さん」付き・担当名でも当たる）。取りまとめ役自身は除く。 */
export function findStaffByName(office: Office, raw: string): Staff | null {
  const norm = (s: string) => s.replace(/[\s　]/g, "").replace(/(さん|様|氏|君|くん|ちゃん)$/, "");
  const q = norm(raw);
  if (!q) return null;
  const members = office.staff.filter((s) => !s.lead);
  const byId = members.find((s) => s.id === raw.trim());
  if (byId) return byId;
  const exact = members.filter((s) => norm(s.name) === q);
  if (exact.length === 1) return exact[0];
  // 同じ名前が2人いるときは決めない（取りまとめ役に、役割で言い直してもらう）
  if (exact.length > 1) return null;
  const byPart = members.filter((s) => norm(s.name).startsWith(q) || norm(s.name).endsWith(q) || norm(s.role) === q);
  if (byPart.length === 1) return byPart[0];
  const loose = members.filter((s) => norm(s.name).includes(q) || q.includes(norm(s.name)) || norm(s.role).includes(q));
  return loose.length === 1 ? loose[0] : null;
}

function deptName(office: Office, s: Staff): string {
  return office.departments.find((d) => d.id === s.deptId)?.name ?? "";
}

/** 取りまとめ役に渡す決まり（system prompt）。 */
export function leadSystemPrompt(office: Office, lead: Staff): string {
  const roster = office.staff
    .filter((s) => !s.lead)
    .map((s) => `- ${s.name}（${[deptName(office, s), s.role].filter(Boolean).join("・")}）`)
    .join("\n");
  return [
    `あなたは「${office.name}」${office.tagline ? `（${office.tagline}）` : ""}の${lead.role}、${lead.name}です。`,
    "社長（この会社の持ち主）から仕事を受け、誰に何を頼むかを決めて、社員に振ります。社長と話すのはあなただけです。",
    "",
    "## 社員",
    roster || "（まだ社員がいません。あなたが自分で仕事をしてください）",
    "",
    "## 進め方の決まり",
    "あなたの返事の中に、次の合図を書くと、その通りに会社が動きます。合図を書いたら、その返事はそこで終えてください。",
    "",
    "1. 社員に仕事を頼む（何人分でも並べて書ける。並べた分は同時に進む）",
    "[[依頼:社員の名前]]",
    "頼む内容。その人はこの文しか読めないので、目的・材料の場所・作る物・置き場所を省かずに書く。",
    "[[/依頼]]",
    "",
    "2. 社長に聞く（1回に1つだけ。選びやすいように番号つきの案を出す）",
    "[[質問]]",
    "聞きたいこと",
    "[[/質問]]",
    "",
    "3. できた物を社長に見せて、OK をもらう",
    "[[確認:見せる物の名前]]",
    "何ができたかを短く。",
    "ファイル: 見せるファイルの場所（あれば1つ）",
    "[[/確認]]",
    "",
    "4. お客さんからの相談に、返事の下書きを出す（送るのは社長です。あなたは送りません）",
    "[[返事]]",
    "お客さんにそのまま送れる文",
    "[[/返事]]",
    "",
    "5. 仕事が全部終わった",
    "[[完了]]",
    "",
    "- 社員に頼んだあとは、報告が届くまで待ちます。報告は「◯◯さんからの報告」として届きます。",
    "- 社長が決めること（方針・好み・お金・外に出すこと）は、勝手に決めずに質問か確認を出してください。",
    "- 社員がいる仕事は、自分でやらずに頼んでください。社員に合う人がいない小さな仕事だけ、自分でやってかまいません。",
    "- 合図の外に書いた文は、そのまま社長に届きます。短く、何がどうなったかを書いてください。",
    "- 終わっていないこと・確かめていないことは、終わったように書かないでください。",
    "",
    "## あなたの仕事のやり方",
    lead.manual.trim() || "（特に決まりはありません）",
  ].join("\n");
}

/** 社員に渡す決まり（system prompt）。 */
export function memberSystemPrompt(office: Office, staff: Staff, lead: Staff | null): string {
  const dept = deptName(office, staff);
  return [
    `あなたは「${office.name}」${office.tagline ? `（${office.tagline}）` : ""}の${dept ? `${dept}の` : ""}${staff.role}、${staff.name}です。`,
    `仕事は${lead ? `${lead.role}の${lead.name}さん` : "取りまとめ役"}から届きます。頼まれた仕事を、作業フォルダの中で最後までやってください。`,
    "",
    "## 決まり",
    "- 社長には直接聞けません。分からないことは、自分で決めて進め、何をどう決めたかを報告に書いてください。",
    "- 最後の返事が、そのまま報告として届きます。次の3つを短く書いてください。①やったこと ②作った・直したファイルの場所 ③気になる点や、確かめていないこと",
    "- 頼まれていないことまで広げないでください。",
    "- 終わっていないこと・確かめていないことは、終わったように書かないでください。",
    "",
    "## あなたの仕事のやり方",
    staff.manual.trim() || "（特に決まりはありません）",
  ].join("\n");
}

/** 社員への依頼文。 */
export function delegationMessage(lead: Staff, text: string): string {
  return `【${lead.name}さんからの依頼】\n${text}`;
}

/** 社員の報告をまとめて、取りまとめ役に渡す文。 */
export function reportsMessage(
  reports: { name: string; text: string; files: string[]; failed: boolean }[],
  note = "",
): string {
  const parts = reports.map((r) => {
    const files = r.files.length > 0 ? `\n作った・直したファイル:\n${r.files.map((f) => `- ${f}`).join("\n")}` : "";
    const head = r.failed ? `【${r.name}さんは途中で止まりました】` : `【${r.name}さんからの報告】`;
    return `${head}\n${r.text.trim() || "（報告の文がありませんでした）"}${files}`;
  });
  if (note) parts.push(note);
  return `${parts.join("\n\n")}\n\n次にやることを、進め方の決まりの合図で書いてください。`;
}

export function unknownStaffMessage(names: string[], office: Office): string {
  const roster = office.staff.filter((s) => !s.lead).map((s) => s.name).join("、");
  return `次の名前の社員が見つかりませんでした: ${names.join("、")}\nいまの社員は ${roster || "（いません）"} です。名前を合わせて、もう一度 依頼の合図を書いてください。`;
}

/** お客さんからの相談を、取りまとめ役に渡す文。 */
export function inquiryMessage(text: string): string {
  return `【お客さんからの相談が届きました】\n${text}\n\n返事の下書きを作ってください（必要なら社員に頼む）。できたら 返事の合図で書いてください。金額・日程・約束は、根拠があるものだけ書き、無ければ【要確認】と書いてください。`;
}
