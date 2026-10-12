// 会話のファイル保存（lib/storage.ts・2026-10-13）の回帰テスト。
// 背景：localStorage の上限で保存できなくなり、知らせても「何が消えて何が残るか」が分からなかった。
// 監査（第9回）で出た「データを失う方向の経路」を1つずつ固定している。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetThreadStoreForTest,
  loadThreadsAsync,
  mergeLoadedThreads,
  saveThreads,
  setThreadsSaveErrorHandler,
  shortHash,
} from "@/lib/storage";
import type { Thread } from "@/lib/types";

const THREADS_KEY = "unicrew.threads.v2";

function thread(id: string, updatedAt = 1, title = id, extra: Record<string, unknown> = {}): Thread {
  return {
    id,
    title,
    characterId: "c",
    model: "sonnet",
    workspace: null,
    messages: [],
    createdAt: 1,
    updatedAt,
    ...extra,
  } as unknown as Thread;
}

/**
 * Rust 側（thread_store.rs）の代わり。thread_write / thread_delete は順番待ちに積んですぐ戻り、
 * 失敗は unicrew://thread-save-error イベントで届く（本物と同じ）。thread_write_now は書き終わってから戻る。
 */
function fakeTauri(
  opts: {
    failWrite?: (id: string) => boolean;
    failDelete?: (id: string) => boolean;
    failBackup?: boolean;
    onBackup?: () => void;
  } = {},
) {
  const files = new Map<string, string>();
  const backups: string[] = [];
  const calls: string[] = [];
  const exitErrors: Array<{ id: string; message: string }> = [];
  let errorCb: ((e: { payload: unknown }) => void) | null = null;
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(`${cmd}:${(args?.id as string) ?? ""}`);
    const id = args?.id as string;
    if (cmd === "threads_load_all") {
      const out = { threads: [...files.values()], broken: [], exit_errors: [...exitErrors] };
      exitErrors.length = 0;
      return out as T;
    }
    if (cmd === "thread_write") {
      setTimeout(() => {
        if (opts.failWrite?.(id)) errorCb?.({ payload: { id, op: "write", message: "disk full" } });
        else files.set(id, args!.json as string);
      }, 0);
      return undefined as T;
    }
    if (cmd === "thread_write_now") {
      if (opts.failWrite?.(id)) throw new Error("disk full");
      files.set(id, args!.json as string);
      return undefined as T;
    }
    if (cmd === "threads_backup_legacy") {
      opts.onBackup?.();
      if (opts.failBackup) throw new Error("backup failed");
      backups.push(args!.json as string);
      return "backup.json" as T;
    }
    if (cmd === "thread_delete") {
      setTimeout(() => {
        if (opts.failDelete?.(id)) errorCb?.({ payload: { id, op: "delete", message: "locked" } });
        else files.delete(id);
      }, 0);
      return undefined as T;
    }
    throw new Error(`unknown ${cmd}`);
  };
  const listen = async (_event: string, cb: (e: { payload: unknown }) => void) => {
    errorCb = cb;
    return () => {};
  };
  return { files, backups, calls, exitErrors, invoke, listen };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function use(fake: ReturnType<typeof fakeTauri>) {
  __resetThreadStoreForTest(fake.invoke, fake.listen);
}

beforeEach(() => {
  localStorage.clear();
  __resetThreadStoreForTest(null, null);
});
afterEach(() => {
  __resetThreadStoreForTest(null, null);
  setThreadsSaveErrorHandler(null);
  localStorage.clear();
});

describe("loadThreadsAsync（読み込みと移行）", () => {
  it("ブラウザ（Tauri 外）では従来どおり localStorage から読む", async () => {
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a")]));
    const r = await loadThreadsAsync(false);
    expect(r.threads.map((t) => t.id)).toEqual(["a"]);
    expect(localStorage.getItem(THREADS_KEY)).not.toBeNull();
  });

  it("何度呼んでも読み込みは1回（開発時の二重実行で片方が失敗しても、もう片方を壊さない）", async () => {
    const fake = fakeTauri();
    use(fake);
    const [r1, r2] = await Promise.all([loadThreadsAsync(true), loadThreadsAsync(true)]);
    expect(r1).toBe(r2);
    expect(fake.calls.filter((c) => c.startsWith("threads_load_all"))).toHaveLength(1);
  });

  it("古い保存をファイルへ移し、控えを書いてから localStorage を消す", async () => {
    const fake = fakeTauri();
    use(fake);
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a", 2), thread("b", 1)]));
    const r = await loadThreadsAsync(true);
    expect(r.migrated).toBe(2);
    expect([...fake.files.keys()].sort()).toEqual(["a", "b"]);
    expect(fake.backups).toHaveLength(1);
    expect(localStorage.getItem(THREADS_KEY)).toBeNull();
    expect(r.threads.map((t) => t.id)).toEqual(["a", "b"]); // 新しい順
  });

  it("控えを書き出せなければ localStorage を消さない", async () => {
    const fake = fakeTauri({ failBackup: true });
    use(fake);
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a")]));
    await loadThreadsAsync(true);
    expect(localStorage.getItem(THREADS_KEY)).not.toBeNull();
  });

  it("控えを取っている間に localStorage が変わったら消さない（未移行の会話を消さない）", async () => {
    const fake = fakeTauri({
      onBackup: () => localStorage.setItem(THREADS_KEY, JSON.stringify([thread("b"), thread("a")])),
    });
    use(fake);
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a")]));
    await loadThreadsAsync(true);
    expect(JSON.parse(localStorage.getItem(THREADS_KEY)!).map((t: Thread) => t.id)).toEqual(["b", "a"]);
  });

  it("ファイルと内容が違う会話は、ファイルを上書きせず（復元）として別に足す", async () => {
    const fake = fakeTauri();
    fake.files.set("a", JSON.stringify(thread("a", 1000, "企画", { memo: "旧方針" })));
    use(fake);
    const legacyA = thread("a", 1000, "企画", { memo: "新方針" });
    localStorage.setItem(THREADS_KEY, JSON.stringify([legacyA]));
    const r = await loadThreadsAsync(true);
    const rid = `a-r${shortHash(JSON.stringify(legacyA))}`;
    const a = r.threads.find((t) => t.id === "a") as unknown as { memo: string };
    const restored = r.threads.find((t) => t.id === rid) as unknown as { memo: string; title: string };
    expect(a.memo).toBe("旧方針");
    expect(restored.memo).toBe("新方針");
    expect(restored.title).toBe("企画（復元）");
    expect(fake.files.has(rid)).toBe(true);
    expect(localStorage.getItem(THREADS_KEY)).toBeNull(); // 全部ファイルにあるので消してよい
    // localStorage が残っていて次の起動でまた照合しても、復元が増え続けない
    __resetThreadStoreForTest(fake.invoke, fake.listen);
    localStorage.setItem(THREADS_KEY, JSON.stringify([legacyA]));
    const r2 = await loadThreadsAsync(true);
    expect(r2.threads.filter((t) => t.id.startsWith("a")).map((t) => t.id).sort()).toEqual(["a", rid].sort());
  });

  it("（復元）の id に別の会話があっても、未移行の会話を取り残さない", async () => {
    const fake = fakeTauri();
    const legacyA = thread("a", 1, "企画", { memo: "legacy only content" });
    const rid = `a-r${shortHash(JSON.stringify(legacyA))}`;
    fake.files.set("a", JSON.stringify(thread("a", 1, "企画", { memo: "disk version" })));
    fake.files.set(rid, JSON.stringify(thread(rid, 1, "別の会話", { memo: "legitimate different conversation" })));
    use(fake);
    localStorage.setItem(THREADS_KEY, JSON.stringify([legacyA]));
    const r = await loadThreadsAsync(true);
    const shown = r.threads.find((t) => (t as unknown as { memo: string }).memo === "legacy only content");
    expect(shown).toBeDefined();
    expect(shown!.id).not.toBe(rid);
    expect(fake.files.has(shown!.id)).toBe(true);
  });

  it("localStorage が残っていても、取り込み済みの会話を消した後に復活させない", async () => {
    const fake = fakeTauri({ failBackup: true }); // 控えが書けず localStorage が残る
    use(fake);
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a")]));
    const r = await loadThreadsAsync(true);
    expect(fake.files.has("a")).toBe(true);
    saveThreads(r.threads.filter((t) => t.id !== "a")); // a を消す
    await flush();
    expect(fake.files.has("a")).toBe(false);
    __resetThreadStoreForTest(fake.invoke, fake.listen); // 再起動
    const r2 = await loadThreadsAsync(true);
    expect(r2.threads.map((t) => t.id)).toEqual([]);
    expect(fake.files.has("a")).toBe(false);
  });

  it("取り込んだ後に localStorage 側の中身が変わった会話は、取り込み済みとみなさない（第12回）", async () => {
    const fake = fakeTauri({ failBackup: true }); // localStorage が残る
    use(fake);
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a", 1, "a", { memo: "旧" })]));
    await loadThreadsAsync(true);
    // 別の起動が代替で localStorage に新しい内容を保存した
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a", 2, "a", { memo: "10月20日までに納品" })]));
    __resetThreadStoreForTest(fake.invoke, fake.listen);
    const r = await loadThreadsAsync(true);
    const memos = r.threads.map((t) => (t as unknown as { memo: string }).memo);
    expect(memos).toContain("10月20日までに納品");
  });

  it("前回の終了時に保存できなかった会話を、起動時に返す", async () => {
    const fake = fakeTauri();
    use(fake);
    fake.exitErrors.push({ id: "a", message: "disk full" });
    const r = await loadThreadsAsync(true);
    expect(r.exitErrors).toEqual([{ id: "a", message: "disk full" }]);
  });

  it("同じ内容なら何もしない", async () => {
    const fake = fakeTauri();
    fake.files.set("a", JSON.stringify(thread("a")));
    use(fake);
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a")]));
    const r = await loadThreadsAsync(true);
    expect(r.migrated).toBe(0);
    expect(r.threads.map((t) => t.id)).toEqual(["a"]);
  });

  it("移行で書けなかった会話は、localStorage を残し、画面に出し、次の保存でまた書く", async () => {
    let fail = true;
    const fake = fakeTauri({ failWrite: (id) => fail && id === "b" });
    use(fake);
    localStorage.setItem(THREADS_KEY, JSON.stringify([thread("a"), thread("b")]));
    const r = await loadThreadsAsync(true);
    expect(r.threads.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(localStorage.getItem(THREADS_KEY)).not.toBeNull();
    fail = false;
    saveThreads(r.threads); // 変更していなくても、書けていない会話は渡す
    await flush();
    expect(fake.files.has("b")).toBe(true);
  });
});

describe("saveThreads（ファイル保存）", () => {
  it("変わった会話だけ渡し、消した会話は削除を渡す（localStorage には書かない）", async () => {
    const fake = fakeTauri();
    fake.files.set("a", JSON.stringify(thread("a")));
    fake.files.set("b", JSON.stringify(thread("b")));
    use(fake);
    const { threads } = await loadThreadsAsync(true);
    fake.calls.length = 0;
    const a = threads.find((t) => t.id === "a")!;
    const b = threads.find((t) => t.id === "b")!;
    const a2 = { ...a, title: "変更" };
    saveThreads([a2, b]);
    await flush();
    expect(fake.calls).toEqual(["thread_write:a"]);
    saveThreads([a2]);
    await flush();
    expect(fake.calls).toContain("thread_delete:b");
    expect(fake.files.has("b")).toBe(false);
    expect(localStorage.getItem(THREADS_KEY)).toBeNull();
  });

  it("保存の失敗（Rust からのイベント）を会話名つきで知らせ、次の変更でもう一度渡す", async () => {
    let fail = true;
    const fake = fakeTauri({ failWrite: () => fail });
    use(fake);
    await loadThreadsAsync(true);
    const errors: Array<[string, string | undefined]> = [];
    setThreadsSaveErrorHandler((m, title) => errors.push([m, title]));
    const t = thread("a", 1, "企画の相談");
    saveThreads([t]);
    await flush();
    expect(errors).toEqual([["disk full", "企画の相談"]]);
    fail = false;
    saveThreads([t]); // 同じ物でも、失敗した会話はもう一度渡す
    await flush();
    expect(fake.files.has("a")).toBe(true);
  });
});

describe("削除（2026-10-13 監査 第11回）", () => {
  it("保存に失敗した会話を消しても、削除はちゃんと送る（前回までのファイルが残っているため）", async () => {
    const fake = fakeTauri({ failWrite: () => true });
    fake.files.set("a", JSON.stringify(thread("a")));
    use(fake);
    const { threads } = await loadThreadsAsync(true);
    saveThreads([{ ...threads[0], title: "変更" }]); // 失敗する
    await flush();
    saveThreads([]); // 消す
    await flush();
    expect(fake.calls).toContain("thread_delete:a");
    expect(fake.files.has("a")).toBe(false);
  });

  it("削除に失敗したら、次の保存でもう一度消す", async () => {
    let fail = true;
    const fake = fakeTauri({ failDelete: () => fail });
    fake.files.set("a", JSON.stringify(thread("a")));
    fake.files.set("b", JSON.stringify(thread("b")));
    use(fake);
    const { threads } = await loadThreadsAsync(true);
    const b = threads.find((t) => t.id === "b")!;
    saveThreads([b]); // a を消す → 失敗
    await flush();
    expect(fake.files.has("a")).toBe(true);
    fail = false;
    saveThreads([{ ...b, title: "b2" }]); // 別の会話の保存のついでに、a をもう一度消す
    await flush();
    expect(fake.files.has("a")).toBe(false);
  });
});

describe("mergeLoadedThreads（読み込み中に作った会話）", () => {
  it("読み込み中に画面で作った会話を消さずに足す", () => {
    const loaded = [thread("a"), thread("b")];
    const current = [thread("new1"), thread("a", 9)];
    expect(mergeLoadedThreads(loaded, current).map((t) => t.id)).toEqual(["new1", "a", "b"]);
  });
});
