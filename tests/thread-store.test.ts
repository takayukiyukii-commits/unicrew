import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetThreadStoreForTest, deletePastThread, loadThreadsAsync } from "@/lib/storage";

const KEY = "unicrew.threads.v2";
const thread = (id: string, title = id) => ({ id, title, model: "claude-opus-4-7", messages: [], createdAt: 1, updatedAt: 2 });
function fakeTauri(failDelete = false) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  let queued: string | null = null;
  const invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(command);
    if (command === "threads_load_all") return { threads: [...files.values()], broken: [], exit_errors: [] } as T;
    if (command === "thread_delete") queued = args!.id as string;
    else if (command === "threads_flush") { if (queued && !failDelete) files.delete(queued); }
    else throw new Error(`予期しない書き込み: ${command}`);
    return undefined as T;
  };
  __resetThreadStoreForTest(invoke);
  return { files, calls };
}

beforeEach(() => { localStorage.clear(); __resetThreadStoreForTest(null); });
afterEach(() => { localStorage.clear(); __resetThreadStoreForTest(null); });

describe("過去の会話は移行・書き戻しをせずに読む", () => {
  it("ファイルと古い保存の同じ ID の異なる記録を両方読み、元データを一切変えない", async () => {
    const fake = fakeTauri();
    const file = JSON.stringify(thread("a", "ファイルの内容"));
    const legacy = JSON.stringify([thread("a", "古い保存の内容"), thread("b")]);
    fake.files.set("a", file);
    localStorage.setItem(KEY, legacy);
    const result = await loadThreadsAsync(true);
    expect(result.threads.map((t) => t.title)).toEqual(["ファイルの内容", "古い保存の内容", "b"]);
    expect(new Set(result.threads.map((t) => t.id)).size).toBe(3);
    expect(fake.calls).toEqual(["threads_load_all"]);
    expect(fake.files.get("a")).toBe(file);
    expect(localStorage.getItem(KEY)).toBe(legacy);
    expect(result.threads[0].model).toBe("claude-opus-4-7");
  });
  it("繰り返し読んでも一度だけ読み、同じ内容を二重表示しない", async () => {
    const fake = fakeTauri();
    fake.files.set("a", JSON.stringify(thread("a")));
    localStorage.setItem(KEY, JSON.stringify([thread("a")]));
    const [one, two] = await Promise.all([loadThreadsAsync(true), loadThreadsAsync(true)]);
    expect(one).toBe(two);
    expect(one.threads).toHaveLength(1);
    expect(fake.calls).toEqual(["threads_load_all"]);
  });
  it("壊れた要素を知らせ、読める記録は残す", async () => {
    const fake = fakeTauri();
    fake.files.set("bad", "{");
    fake.files.set("a", JSON.stringify(thread("a")));
    localStorage.setItem(KEY, JSON.stringify([null, thread("b")]));
    const result = await loadThreadsAsync(true);
    expect(result.threads).toHaveLength(2);
    expect(result.broken).toHaveLength(2);
    expect(fake.calls).toEqual(["threads_load_all"]);
  });
});

describe("確認された会話だけ削除する", () => {
  it("削除完了を確かめ、別の会話と親子情報は書き換えない", async () => {
    const fake = fakeTauri();
    const child = JSON.stringify({ ...thread("b"), parentId: "a", kind: "side", archived: true });
    fake.files.set("a", JSON.stringify(thread("a")));
    fake.files.set("b", child);
    await loadThreadsAsync(true);
    await deletePastThread("a");
    expect(fake.files.get("b")).toBe(child);
    expect(fake.calls).toEqual(["threads_load_all", "thread_delete", "threads_flush", "threads_load_all"]);
    expect((await loadThreadsAsync(true)).threads.map((t) => t.id)).toEqual(["b"]);
  });
  it("順番待ちの後で削除できなかった場合は成功扱いにしない", async () => {
    const fake = fakeTauri(true);
    fake.files.set("a", JSON.stringify(thread("a")));
    localStorage.setItem(KEY, JSON.stringify([thread("a")]));
    await loadThreadsAsync(true);
    await expect(deletePastThread("a")).rejects.toThrow();
    expect((await loadThreadsAsync(true)).threads).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1);
  });
  it("重複している古い保存も削除し、再起動で復活させない", async () => {
    const fake = fakeTauri();
    fake.files.set("a", JSON.stringify(thread("a")));
    localStorage.setItem(KEY, JSON.stringify([thread("a"), thread("b")]));
    await loadThreadsAsync(true);
    await deletePastThread("a");
    expect(fake.files.has("a")).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([thread("b")]);
  });
  it("表示用に ID を分けた古い保存だけを消し、同じ ID のファイルは残す", async () => {
    const fake = fakeTauri();
    fake.files.set("a", JSON.stringify(thread("a", "ファイル")));
    localStorage.setItem(KEY, JSON.stringify([thread("a", "古い保存")]));
    const result = await loadThreadsAsync(true);
    await deletePastThread(result.threads.find((t) => t.title === "古い保存")!.id);
    expect(fake.files.has("a")).toBe(true);
    expect(fake.calls).toEqual(["threads_load_all"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([]);
  });
  it("読んだ後に追加された古い保存の会話を消さない", async () => {
    localStorage.setItem(KEY, JSON.stringify([thread("a")]));
    await loadThreadsAsync(false);
    localStorage.setItem(KEY, JSON.stringify([thread("a"), thread("b")]));
    await deletePastThread("a");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([thread("b")]);
  });
  it("0.6.3 がファイルへ移したあとに消した会話を、残っていた古い保存から戻さない", async () => {
    fakeTauri();
    // 0.6.3 と同じ作り方の印（id:中身の印。中身は model を短い名前に直してから数える）
    const hash = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };
    const gone = thread("a", "消した会話");
    const kept = thread("b", "移していない会話");
    localStorage.setItem(KEY, JSON.stringify([gone, kept]));
    localStorage.setItem("unicrew.threads.migratedIds.v1", JSON.stringify([`a:${hash(JSON.stringify({ ...gone, model: "opus" }))}`]));
    const result = await loadThreadsAsync(true);
    expect(result.threads.map((t) => t.title)).toEqual(["移していない会話"]);
    // 元の保存は変えない
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(2);
  });
  it("読んだあとに中身が変わった古い会話は、消えたことにしない", async () => {
    fakeTauri();
    localStorage.setItem(KEY, JSON.stringify([thread("a", "Before")]));
    await loadThreadsAsync(true);
    localStorage.setItem(KEY, JSON.stringify([thread("a", "After")]));
    await expect(deletePastThread("a")).rejects.toThrow("消していません");
    expect(localStorage.getItem(KEY)).toContain("After");
    expect((await loadThreadsAsync(true)).threads).toHaveLength(1);
  });
});
