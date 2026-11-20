/**
 * 見本の実況。ブラウザだけで開いたとき（開発中の画面確認）に、AI の代わりに決まった流れを返す。
 *
 * 本物の AI は呼ばない。指示 → 質問 → 依頼 → 報告 → 確認 → 完了 の一連が、数十秒で一通り見られる。
 * 🚨 配布版（Tauri）では使われない（runner.ts が isTauri() で分ける）。
 */
import type { Locale } from "../i18n";
import { officeT, type OfficeKey } from "./i18n";
import type { Office, OfficeAgentEvent, Staff } from "./types";

export interface DemoDriver {
  send(office: Office, staff: Staff, text: string, locale?: Locale): void;
  stop(staffId: string): void;
  dispose(): void;
}

type Emit = (staffId: string, ev: OfficeAgentEvent) => void;

const MEMBER_FILES = ["design.md", "copy.md", "index.html", "check.md", "notes.md", "plan.md"];

export function createDemoDriver(emit: Emit, speed = 1): DemoDriver {
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** 取りまとめ役が何回目の返事か（会社ごと） */
  const leadTurn = new Map<string, number>();
  let toolSeq = 0;

  const later = (staffId: string, ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms / speed);
    timers.set(staffId, [...(timers.get(staffId) ?? []), t]);
  };

  const finish = (staffId: string, ms: number, text: string) => {
    later(staffId, ms, () => emit(staffId, { kind: "usage_delta", input_tokens: 1800 + Math.floor(text.length * 3), output_tokens: 120 + text.length }));
    later(staffId, ms + 50, () => emit(staffId, { kind: "assistant_text", text }));
    later(staffId, ms + 400, () => emit(staffId, { kind: "result", subtype: "success" }));
  };

  const tool = (staffId: string, ms: number, name: string, input: Record<string, unknown>, hold = 1400) => {
    const id = `demo-${(toolSeq += 1)}`;
    later(staffId, ms, () => emit(staffId, { kind: "tool_use", tool_use_id: id, tool_name: name, tool_input: input }));
    later(staffId, ms + hold, () => emit(staffId, { kind: "tool_result", tool_use_id: id, is_error: false, content: "ok" }));
  };

  return {
    send(office, staff, text, locale = "ja") {
      const t = (key: OfficeKey, vars?: Record<string, string | number>) => officeT(key, locale, vars);
      if (staff.lead) {
        const members = office.staff.filter((s) => !s.lead);
        const n = leadTurn.get(office.id) ?? 0;
        const isReports = text.includes("からの報告") || text.includes("途中で止まりました");
        const isApproval = text.includes("は OK です");
        const isReject = text.includes("差し戻し");
        if (text.includes("お客さんからの相談")) {
          finish(staff.id, 1800, `${t("demo.inquiryIntro")}\n[[返事]]\n${t("demo.inquiryReply")}\n[[/返事]]`);
        } else if (isApproval) {
          finish(staff.id, 1200, `${t("demo.approved")}\n[[完了]]`);
        } else if (isReject || isReports) {
          const file = office.workspace ? `${office.workspace.replace(/[\\/]+$/, "")}/index.html` : "index.html";
          tool(staff.id, 400, "Read", { file_path: "index.html" }, 1200);
          finish(staff.id, 2200, `${t("demo.reports")}\n[[確認:${t("demo.reviewTitle", { n: isReject ? 2 : 1 })}]]\n${t("demo.reviewBody")}\nファイル: ${file}\n[[/確認]]`);
        } else if (n === 0 && members.length > 0) {
          finish(staff.id, 1500, `[[質問]]\n${t("demo.question")}\n[[/質問]]`);
        } else if (members.length > 0) {
          const picks = members.slice(0, Math.min(3, members.length));
          tool(staff.id, 300, "Write", { file_path: "brief.md" }, 1500);
          finish(
            staff.id,
            2400,
            `${t("demo.delegating", { names: picks.map((p) => locale === "ja" ? `${p.name}さん` : p.name).join(locale === "ja" ? "・" : ", ") })}\n${picks
              .map((p) => `[[依頼:${p.name}]]\nbrief.md を読んで、${p.role}として自分の持ち場を仕上げてください。できた物は作業フォルダに置いてください。\n[[/依頼]]`)
              .join("\n")}`,
          );
        } else {
          finish(staff.id, 1500, `${t("demo.solo")}\n[[完了]]`);
        }
        leadTurn.set(office.id, n + 1);
        return;
      }
      // 社員：読む → 書く → 報告
      const idx = office.staff.filter((s) => !s.lead).findIndex((s) => s.id === staff.id);
      const file = MEMBER_FILES[Math.max(0, idx) % MEMBER_FILES.length];
      const base = 600 + (Math.max(0, idx) % 3) * 900;
      tool(staff.id, base, "Read", { file_path: "brief.md" }, 1600);
      tool(staff.id, base + 2200, "Glob", { pattern: "**/*.md" }, 1200);
      tool(staff.id, base + 4000, "Write", { file_path: file }, 2600);
      finish(staff.id, base + 7200, t("demo.report", { role: staff.role, file }));
    },
    stop(staffId) {
      for (const t of timers.get(staffId) ?? []) clearTimeout(t);
      timers.delete(staffId);
    },
    dispose() {
      for (const list of timers.values()) for (const t of list) clearTimeout(t);
      timers.clear();
    },
  };
}
