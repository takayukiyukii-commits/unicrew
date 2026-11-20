import { describe, expect, it, vi } from "vitest";
import { registerBossReceiver, sendBossInstruction } from "@/lib/office/boss-bus";
import { fireDueRoutines, loadRoutines, type Routine } from "@/lib/routines";

describe("AIオフィスへの指示の受け渡し", () => {
  it("受信側がいないとき、準備不足と空の指示を区別する", () => {
    expect(sendBossInstruction("指示")).toBe("notReady");
    expect(sendBossInstruction("  ")).toBe("empty");
  });
  it("本文を一度だけ渡し、準備不足も送り手へ返す", () => {
    const receive = vi.fn(() => "noWorkspace" as const);
    const off = registerBossReceiver(receive);
    try {
      expect(sendBossInstruction("日本語\n出力")).toBe("noWorkspace");
      expect(receive).toHaveBeenCalledTimes(1);
      expect(receive).toHaveBeenCalledWith("日本語\n出力");
    } finally { off(); }
    expect(sendBossInstruction("指示")).toBe("notReady");
  });
  it("古い受信側の後片付けで、新しい受信側を消さない", () => {
    const oldOff = registerBossReceiver(() => "noOffice");
    const off = registerBossReceiver(() => "accepted");
    oldOff();
    expect(sendBossInstruction("指示")).toBe("accepted");
    off();
  });
});

describe("定期実行の引き継ぎと再送", () => {
  const now = new Date(2026, 10, 21, 10);
  const routine: Routine = { id: "r", label: "朝の報告", threadId: "削除済みの会話", prompt: "報告してください", enabled: true, createdAt: 1, schedule: { type: "daily", hour: 9, minute: 0 } };
  it("古い宛先の有無にかかわらず読める定期実行を残す", () => {
    const { threadId: _old, ...current } = routine;
    void _old;
    localStorage.setItem("unicrew.routines.v1", JSON.stringify([routine, { ...current, id: "new" }]));
    expect(loadRoutines().map((r) => r.id)).toEqual(["r", "new"]);
    localStorage.removeItem("unicrew.routines.v1");
  });
  it("受信できなければ未実行で残し、再送が届いた日だけ重複を防ぐ", () => {
    const initial = [routine];
    expect(fireDueRoutines(initial, () => false, now)).toBe(initial);
    const deliver = vi.fn(() => true);
    const done = fireDueRoutines(initial, deliver, now);
    expect(deliver).toHaveBeenCalledWith(routine.prompt);
    expect(done[0].schedule.lastFiredDay).toBe("2026-11-21");
    expect(fireDueRoutines(done, deliver, now)).toBe(done);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(routine.schedule.lastFiredDay).toBeUndefined();
  });
  it("停止中と未来の時刻は送らない", () => {
    const deliver = vi.fn(() => true);
    fireDueRoutines([{ ...routine, enabled: false }, { ...routine, id: "future", schedule: { type: "daily", hour: 11, minute: 0 } }], deliver, now);
    expect(deliver).not.toHaveBeenCalled();
  });
});
