import { describe, expect, it } from "vitest";
import { parseRunLog, RUN_PANE_BASE, RUN_RECENT_MS, RUN_WAIT_MAX_MS, RUN_WORK_IDLE_MS, RunWatcher } from "./run-link";
import { nextTerminalActivity } from "./terminal-link";

const claudeTool = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = JSON.stringify({ type: "result", subtype: "success" });

describe("RUNner の記録を読む", () => {
  it("Claude Code の記録：最後に使った道具と、AI が書いた「いまやっていること」を読む", () => {
    const snap = parseRunLog([
      claudeTool("t1", "mcp__run__report_run_status", { goal_id: "fc977dd5-450f-4c02-9000-c9bf0f7c3bf6", status: "running", message: "まず DM を探します。" }),
      claudeTool("t2", "Read", { file_path: "notes/a.md" }),
    ].join("\n"));
    expect(snap).toEqual({ state: "working", tool: { key: "t2", name: "Read", detail: "notes/a.md" }, message: "まず DM を探します。", goalId: "fc977dd5-450f-4c02-9000-c9bf0f7c3bf6" });
  });

  it("終わりの行が来たら終わり。直前が『あなた待ち』の報告・承認の依頼なら、待ちとして読む", () => {
    expect(parseRunLog([claudeTool("t1", "Write", { file_path: "a.md" }), result].join("\n")).state).toBe("done");
    expect(parseRunLog([claudeTool("t1", "mcp__run__report_run_status", { status: "waiting_human", message: "色はどちらにしますか" }), result].join("\n")).state).toBe("waiting");
    expect(parseRunLog([claudeTool("t1", "mcp__run__request_approval", { title: "投稿してよいですか" }), result].join("\n")).state).toBe("waiting");
    // 計画を出して止まる（監査待ち）は、利用者の返事待ちではない
    expect(parseRunLog([claudeTool("t1", "mcp__run__submit_plan", {}), claudeTool("t2", "mcp__run__report_run_status", { status: "stopped", message: "計画を出しました" }), result].join("\n")).state).toBe("done");
  });

  it("終わったあとに、返事を受けてまた動き出したら、作業中に戻る", () => {
    const snap = parseRunLog([claudeTool("t1", "mcp__run__report_run_status", { status: "waiting_human" }), result, claudeTool("t9", "Edit", { file_path: "b.md" })].join("\n"));
    expect(snap.state).toBe("working");
    expect(snap.tool?.name).toBe("Edit");
  });

  it("Codex の記録（run の道具・コマンド）も読む", () => {
    const snap = parseRunLog([
      JSON.stringify({ type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "run", tool: "report_run_status", arguments: { status: "running", message: "監査します" } } }),
      JSON.stringify({ type: "item.started", item: { id: "item_2", type: "command_execution", command: "npm test" } }),
    ].join("\n"));
    expect(snap.state).toBe("working");
    expect(snap.tool).toEqual({ key: "item_2", name: "Bash", detail: "npm test" });
    expect(snap.message).toBe("監査します");
    expect(parseRunLog([JSON.stringify({ type: "turn.completed" })].join("\n")).state).toBe("done");
  });

  it("末尾だけを読むので、途中から始まる行・JSON でない行があっても落ちない", () => {
    const snap = parseRunLog(`"partial":"...切れた行"}\nただの文字\n${claudeTool("t3", "Grep", { pattern: "TODO" })}\n`);
    expect(snap.tool).toEqual({ key: "t3", name: "Grep", detail: "TODO" });
  });
});

describe("RUNner の知らせ", () => {
  const working = (id: string, name = "Read") => claudeTool(id, name, { file_path: "a.md" });

  it("昔の記録（もう動いていないフォルダ）は読まない＝社員を動かさない", () => {
    const w = new RunWatcher();
    const now = 100_000_000;
    expect(w.wantsTail("aaaaaaaa", now - RUN_RECENT_MS - 1, now)).toBe(false);
    expect(w.wantsTail("aaaaaaaa", now - 60_000, now)).toBe(true);
    expect(w.feed([{ key: "aaaaaaaa", modifiedMs: now - RUN_RECENT_MS - 1, tail: null }], now)).toEqual([]);
    expect(w.active()).toEqual([]);
    // 最近終わった記録は、読んでも社員を動かさない。次からは書き足されるまで読まない
    expect(w.feed([{ key: "bbbbbbbb", modifiedMs: now - 60_000, tail: [working("t1"), result].join("\n") }], now)).toEqual([]);
    expect(w.wantsTail("bbbbbbbb", now - 60_000, now)).toBe(false);
    expect(w.wantsTail("bbbbbbbb", now, now)).toBe(true);
  });

  it("承認待ちで止まってしばらくしてから開いても、待ちとして拾う。だいぶ前から書かれていない作業中は拾わない", () => {
    const w = new RunWatcher();
    const now = 100_000_000;
    const wait = [claudeTool("t2", "mcp__run__request_approval", { title: "投稿してよいですか" }), result].join("\n");
    expect(w.feed([{ key: "cccccccc", modifiedMs: now - 20 * 60_000, tail: wait }], now).map((e) => e.kind)).toEqual(["waiting"]);
    expect(w.feed([{ key: "dddddddd", modifiedMs: now - RUN_WORK_IDLE_MS - 1, tail: working("t1") }, { key: "cccccccc", modifiedMs: now - 20 * 60_000, tail: null }], now)).toEqual([]);
  });

  it("動き出す → 道具 → 同じ道具では知らせない → 別の道具 → 終わり、を1回ずつ知らせる", () => {
    const w = new RunWatcher();
    let now = 10_000_000;
    let evs = w.feed([{ key: "fc977dd5", modifiedMs: now, tail: working("t1") }], now);
    expect(evs.map((e) => e.kind)).toEqual(["start", "activity"]);
    expect(evs[0]).toMatchObject({ pane: RUN_PANE_BASE, source: "runner", key: "fc977dd5" });
    now += 5000;
    // 書き足されていない
    expect(w.feed([{ key: "fc977dd5", modifiedMs: now - 5000, tail: working("t1") }], now)).toEqual([]);
    // 書き足されたが、同じ道具
    expect(w.feed([{ key: "fc977dd5", modifiedMs: now, tail: working("t1") }], now)).toEqual([]);
    now += 5000;
    evs = w.feed([{ key: "fc977dd5", modifiedMs: now, tail: [working("t1"), working("t2", "Edit")].join("\n") }], now);
    expect(evs.map((e) => [e.kind, e.tool])).toEqual([["activity", "Edit"]]);
    now += 5000;
    evs = w.feed([{ key: "fc977dd5", modifiedMs: now, tail: [working("t2", "Edit"), result].join("\n") }], now);
    expect(evs.map((e) => e.kind)).toEqual(["stop"]);
    expect(w.active()).toEqual([]);
  });

  it("あなた待ちで止まったら待ちを1回知らせ、返事を受けて動き出したら始まりを知らせる", () => {
    const w = new RunWatcher();
    let now = 20_000_000;
    w.feed([{ key: "ee2177b4", modifiedMs: now, tail: working("t1") }], now);
    now += 5000;
    const wait = [claudeTool("t2", "mcp__run__report_run_status", { status: "waiting_human", message: "どちらにしますか" }), result].join("\n");
    expect(w.feed([{ key: "ee2177b4", modifiedMs: now, tail: wait }], now).map((e) => e.kind)).toEqual(["waiting"]);
    expect(w.active()).toHaveLength(1);
    now += 600_000;
    // 待っている間は、長く書き足されなくても「終わり」にしない
    expect(w.feed([{ key: "ee2177b4", modifiedMs: now - 600_000, tail: null }], now)).toEqual([]);
    now += 5000;
    const evs = w.feed([{ key: "ee2177b4", modifiedMs: now, tail: [wait, working("t3", "Write")].join("\n") }], now);
    expect(evs.map((e) => e.kind)).toEqual(["start", "activity"]);
  });

  it("時間のかかるコマンドの最中（しばらく書き足されない）は、終わりにしない。長く経ったら終わった扱いにする", () => {
    const w = new RunWatcher();
    const now = 30_000_000;
    w.feed([{ key: "bff1577c", modifiedMs: now, tail: working("t1") }], now);
    expect(w.feed([{ key: "bff1577c", modifiedMs: now, tail: null }], now + 200_000)).toEqual([]);
    expect(w.feed([{ key: "bff1577c", modifiedMs: now, tail: null }], now + RUN_WORK_IDLE_MS + 1000).map((e) => e.kind)).toEqual(["stop"]);
  });

  it("待ちのまま長く放置されたら手を下ろす。記録が消えたら終わりを知らせる。遅れて届いた古い読み込みは捨てる", () => {
    const w = new RunWatcher();
    const now = 50_000_000;
    const wait = [claudeTool("t2", "mcp__run__report_run_status", { status: "waiting_human" }), result].join("\n");
    w.feed([{ key: "11111111", modifiedMs: now, tail: wait }, { key: "22222222", modifiedMs: now, tail: wait }, { key: "33333333", modifiedMs: now, tail: working("t1") }], now);
    // 33333333 が終わった（新しい読み込み）あとに、古い読み込み（待ち）が遅れて届いても戻らない
    expect(w.feed([{ key: "11111111", modifiedMs: now, tail: null }, { key: "22222222", modifiedMs: now, tail: null }, { key: "33333333", modifiedMs: now + 3000, tail: [working("t1"), result].join("\n") }], now + 3000).map((e) => e.kind)).toEqual(["stop"]);
    expect(w.feed([{ key: "11111111", modifiedMs: now, tail: null }, { key: "22222222", modifiedMs: now, tail: null }, { key: "33333333", modifiedMs: now + 2000, tail: wait }], now + 4000)).toEqual([]);
    // 22222222 のフォルダが消えた
    const gone = w.feed([{ key: "11111111", modifiedMs: now, tail: null }], now + 5000);
    expect(gone.map((e) => [e.kind, e.key])).toEqual([["stop", "22222222"]]);
    expect(w.feed([{ key: "11111111", modifiedMs: now, tail: null }], now + RUN_WAIT_MAX_MS + 1000).map((e) => e.kind)).toEqual(["stop"]);
    expect(w.active()).toEqual([]);
  });

  it("2つのゴールは別々の番号になる。始まりの時刻は、動き出したときだけ新しくなる（扉から入るのは受け取ったとき1回）", () => {
    const w = new RunWatcher();
    const now = 40_000_000;
    const evs = w.feed([{ key: "aaaaaaaa", modifiedMs: now, tail: working("t1") }, { key: "bbbbbbbb", modifiedMs: now, tail: working("t1") }], now);
    expect(new Set(evs.map((e) => e.pane)).size).toBe(2);
    let act = nextTerminalActivity(undefined, { ...evs[0], at: 100 });
    expect(act).toMatchObject({ source: "runner", key: "aaaaaaaa", startedAt: 100 });
    act = nextTerminalActivity(act, { ...evs[1], pane: evs[0].pane, at: 200 });
    act = nextTerminalActivity(act, { pane: evs[0].pane, kind: "start", source: "runner", instruction: "続き", at: 300 });
    expect(act.startedAt).toBe(100);
    act = nextTerminalActivity(act, { pane: evs[0].pane, kind: "stop", source: "runner", at: 400 });
    act = nextTerminalActivity(act, { pane: evs[0].pane, kind: "start", source: "runner", at: 500 });
    expect(act.startedAt).toBe(500);
  });
  it("追っているゴールだけを読んだ回では、読んでいないフォルダを「消えた」と見なさない", () => {
    const w = new RunWatcher();
    const now = 70_000_000;
    w.feed([{ key: "aaaaaaaa", modifiedMs: now, tail: working("t1") }, { key: "bbbbbbbb", modifiedMs: now - 60_000, tail: [working("t1"), result].join("\n") }], now);
    expect(w.feed([{ key: "aaaaaaaa", modifiedMs: now, tail: null }], now + 5000, { partial: true })).toEqual([]);
    // 終わっていた bbbbbbbb は覚えたまま（次に全部読む回で、また末尾を読み直さない）
    expect(w.wantsTail("bbbbbbbb", now - 60_000, now + 6000)).toBe(false);
    // 追っていたのに読めなかった物は、消えたと見る
    expect(w.feed([], now + 10_000, { partial: true }).map((e) => [e.kind, e.key])).toEqual([["stop", "aaaaaaaa"]]);
  });
  it("記録を読めなかった回は、追っている仕事を忘れない（待ちのゴールを見失わない）。長く動きが無い物だけ終わりにする", () => {
    const w = new RunWatcher();
    const now = 80_000_000;
    const wait = [claudeTool("t2", "mcp__run__request_approval", { title: "よいですか" }), result].join("\n");
    w.feed([{ key: "aaaaaaaa", modifiedMs: now, tail: wait }], now);
    expect(w.expire(now + 31 * 60_000)).toEqual([]);
    expect(w.active()).toHaveLength(1);
    // 読めるようになったあとも、同じ記録を読み直さずに待ちのまま
    expect(w.feed([{ key: "aaaaaaaa", modifiedMs: now, tail: null }], now + 32 * 60_000)).toEqual([]);
    expect(w.active()).toHaveLength(1);
    expect(w.expire(now + RUN_WAIT_MAX_MS + 1000).map((e) => e.kind)).toEqual(["stop"]);
  });
});
