/**
 * 見本の実況。ブラウザだけで開いたとき（開発中の画面確認）に、AI の代わりに決まった流れを返す。
 *
 * 本物の AI は呼ばない。指示 → 質問 → 依頼 → 報告 → 確認 → 完了 の一連が、数十秒で一通り見られる。
 * 🚨 配布版（Tauri）では使われない（runner.ts が isTauri() で分ける）。
 */
import type { Office, OfficeAgentEvent, Staff } from "./types";

export interface DemoDriver {
  send(office: Office, staff: Staff, text: string): void;
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
    send(office, staff, text) {
      if (staff.lead) {
        const members = office.staff.filter((s) => !s.lead);
        const n = leadTurn.get(office.id) ?? 0;
        const isReports = text.includes("からの報告") || text.includes("途中で止まりました");
        const isApproval = text.includes("は OK です");
        const isReject = text.includes("差し戻し");
        if (text.includes("お客さんからの相談")) {
          finish(staff.id, 1800, "相談を読みました。返事の下書きを出します。\n[[返事]]\nお問い合わせありがとうございます。ご相談の内容、承りました。\nまずは一度、30分ほどお話を伺えればと思います。ご都合のよい日時を2〜3つ教えてください。\n料金は【要確認】のため、お話のあとにご案内します。\n[[/返事]]");
        } else if (isApproval) {
          finish(staff.id, 1200, "社長、OK をいただきありがとうございます。今回の仕事はこれで終わりです。\n\nできた物は右の「納品」に並んでいます。外への公開や、お金に関わることはしていません。\n[[完了]]");
        } else if (isReject || isReports) {
          const file = office.workspace ? `${office.workspace.replace(/[\\/]+$/, "")}/index.html` : "index.html";
          tool(staff.id, 400, "Read", { file_path: "index.html" }, 1200);
          finish(staff.id, 2200, `報告がそろいました。頼んだ通りにできているかを確かめました。\n[[確認:できあがり（第${isReject ? 2 : 1}版）]]\nできあがりました。確認をお願いします。\nファイル: ${file}\n[[/確認]]`);
        } else if (n === 0 && members.length > 0) {
          finish(staff.id, 1500, "[[質問]]\nいちばん前に出したいのは、①任せられる安心感 ②すぐに始められる手軽さ、のどちらですか？\n[[/質問]]");
        } else if (members.length > 0) {
          const picks = members.slice(0, Math.min(3, members.length));
          tool(staff.id, 300, "Write", { file_path: "brief.md" }, 1500);
          finish(
            staff.id,
            2400,
            `承知しました。${picks.map((p) => `${p.name}さん`).join("・")}に頼みます。\n${picks
              .map((p) => `[[依頼:${p.name}]]\nbrief.md を読んで、${p.role}として自分の持ち場を仕上げてください。できた物は作業フォルダに置いてください。\n[[/依頼]]`)
              .join("\n")}`,
          );
        } else {
          finish(staff.id, 1500, "承知しました。いまは社員がいないので、わたしが進めます。\n[[完了]]");
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
      finish(staff.id, base + 7200, `①brief.md を読んで、${staff.role}として ${file} を作りました。\n②${file}\n③実物の写真はまだ入れていません（差し替えられる枠にしてあります）。`);
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
