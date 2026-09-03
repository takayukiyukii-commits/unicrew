import { describe, it, expect } from "vitest";
import {
  sanitizeLayout,
  toSavedLayout,
  type SanitizeLimits,
  type LayoutPageInput,
} from "./terminal-layout";

const LIMITS: SanitizeLimits = {
  maxPages: 4,
  maxPanes: 6,
  knownCliIds: ["claude", "codex", "gemini"],
};

const page = (id: string, panes: unknown[]) => ({ id, panes });

describe("sanitizeLayout", () => {
  it("正常な保存データはそのまま復元できる", () => {
    const out = sanitizeLayout(
      {
        pages: [
          page("p1", [
            { key: "a", kind: "claude" },
            { key: "b", kind: "shell", cliId: "codex", cwd: "D:/work" },
          ]),
        ],
        activePageId: "p1",
      },
      LIMITS,
    );
    expect(out).toEqual({
      pages: [
        {
          id: "p1",
          panes: [
            { key: "a", kind: "claude", cliId: undefined, cwd: null },
            { key: "b", kind: "shell", cliId: "codex", cwd: "D:/work" },
          ],
          colFr: undefined,
          rowFr: undefined,
        },
      ],
      activePageId: "p1",
    });
  });

  it("壊れた入力は null（＝初期状態で始める）", () => {
    expect(sanitizeLayout(null, LIMITS)).toBeNull();
    expect(sanitizeLayout(undefined, LIMITS)).toBeNull();
    expect(sanitizeLayout("{}", LIMITS)).toBeNull();
    expect(sanitizeLayout({}, LIMITS)).toBeNull();
    expect(sanitizeLayout({ pages: "nope" }, LIMITS)).toBeNull();
    expect(sanitizeLayout({ pages: [] }, LIMITS)).toBeNull();
    expect(sanitizeLayout({ pages: [page("p1", [])] }, LIMITS)).toBeNull();
  });

  it("🚨知らない CLI id は落とすが、kind は変えない（勝手に別の AI を起動しない）", () => {
    const out = sanitizeLayout(
      { pages: [page("p1", [{ key: "a", kind: "shell", cliId: "ghost-cli" }])] },
      LIMITS,
    );
    expect(out?.pages[0].panes[0]).toEqual({
      key: "a",
      kind: "shell",
      cliId: undefined,
      cwd: null,
    });
  });

  it("ページ数・ペイン数の上限を超えた分は捨てる", () => {
    // キーはページごとに変える（キー重複は別テストで見る＝ここでは上限だけを見たい）
    const many = (pageIdx: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        key: `p${pageIdx}-k${i}`,
        kind: "shell",
      }));
    const out = sanitizeLayout(
      {
        pages: Array.from({ length: 9 }, (_, i) => page(`p${i}`, many(i, 9))),
      },
      LIMITS,
    );
    expect(out?.pages.length).toBe(4);
    for (const pg of out!.pages) expect(pg.panes.length).toBe(6);
  });

  it("ペインのキー重複は落とす（PTY の id が衝突すると片方が消える）", () => {
    const out = sanitizeLayout(
      {
        pages: [
          page("p1", [
            { key: "same", kind: "shell" },
            { key: "same", kind: "shell" },
          ]),
          page("p2", [{ key: "same", kind: "shell" }]),
        ],
      },
      LIMITS,
    );
    expect(out?.pages.length).toBe(1);
    expect(out?.pages[0].panes.length).toBe(1);
  });

  it("ページ id の重複も落とす", () => {
    const out = sanitizeLayout(
      {
        pages: [
          page("dup", [{ key: "a", kind: "shell" }]),
          page("dup", [{ key: "b", kind: "shell" }]),
        ],
      },
      LIMITS,
    );
    expect(out?.pages.length).toBe(1);
  });

  it("remote-control など未知の kind は claude 扱いにする（未知のプロセスを起動しない）", () => {
    const out = sanitizeLayout(
      { pages: [page("p1", [{ key: "a", kind: "remote-control" }])] },
      LIMITS,
    );
    expect(out?.pages[0].panes[0].kind).toBe("claude");
  });

  it("実在しない activePageId は先頭ページに倒す", () => {
    const out = sanitizeLayout(
      {
        pages: [page("p1", [{ key: "a", kind: "shell" }])],
        activePageId: "消えたページ",
      },
      LIMITS,
    );
    expect(out?.activePageId).toBe("p1");
  });

  it("cwd が文字列でなければ null にする（変な値で PTY を開かせない）", () => {
    const out = sanitizeLayout(
      {
        pages: [
          page("p1", [
            { key: "a", kind: "shell", cwd: 123 },
            { key: "b", kind: "shell", cwd: "" },
            { key: "c", kind: "shell", cwd: "D:/ok" },
          ]),
        ],
      },
      LIMITS,
    );
    expect(out?.pages[0].panes.map((p) => p.cwd)).toEqual([null, null, "D:/ok"]);
  });
});

describe("sanitizeLayout の比率（分割幅）", () => {
  it("正しい比率は残す", () => {
    const out = sanitizeLayout(
      {
        pages: [
          {
            id: "p1",
            panes: [{ key: "a", kind: "shell" }],
            colFr: [1.5, 0.5],
            rowFr: [1],
          },
        ],
      },
      LIMITS,
    );
    expect(out?.pages[0].colFr).toEqual([1.5, 0.5]);
    expect(out?.pages[0].rowFr).toEqual([1]);
  });

  it("🚨 0・負・NaN・文字列が混ざったら丸ごと捨てる（幅ゼロのペインを作らない）", () => {
    for (const bad of [[0, 1], [-1, 2], [NaN, 1], ["1", 2], [], null, "x"]) {
      const out = sanitizeLayout(
        {
          pages: [{ id: "p1", panes: [{ key: "a", kind: "shell" }], colFr: bad }],
        },
        LIMITS,
      );
      expect(out?.pages[0].colFr).toBeUndefined();
    }
  });

  it("長すぎる比率配列は捨てる", () => {
    const out = sanitizeLayout(
      {
        pages: [
          {
            id: "p1",
            panes: [{ key: "a", kind: "shell" }],
            colFr: [1, 1, 1, 1, 1, 1, 1],
          },
        ],
      },
      LIMITS,
    );
    expect(out?.pages[0].colFr).toBeUndefined();
  });
});

describe("sanitizeLayout のエフォート", () => {
  const withEffort: SanitizeLimits = {
    ...LIMITS,
    // codex は low/high だけ妥当、という想定の判定関数
    isValidEffort: (cliId, level) =>
      cliId === "codex" && ["low", "high"].includes(level),
  };

  it("妥当なエフォートは復元する", () => {
    const out = sanitizeLayout(
      {
        pages: [
          page("p1", [
            { key: "a", kind: "shell", cliId: "codex", effort: "high" },
          ]),
        ],
      },
      withEffort,
    );
    expect(out?.pages[0].panes[0].effort).toBe("high");
  });

  it("🚨 その CLI で使えない値は捨てる（バッジだけ嘘になるのを防ぐ）", () => {
    const out = sanitizeLayout(
      {
        pages: [
          page("p1", [
            { key: "a", kind: "shell", cliId: "codex", effort: "banana" },
            { key: "b", kind: "shell", cliId: "gemini", effort: "high" },
            { key: "c", kind: "claude", effort: "high" },
          ]),
        ],
      },
      withEffort,
    );
    expect(out?.pages[0].panes.map((p) => p.effort)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("判定関数を渡さなければ、エフォートは復元しない（既定は安全側）", () => {
    const out = sanitizeLayout(
      {
        pages: [
          page("p1", [
            { key: "a", kind: "shell", cliId: "codex", effort: "high" },
          ]),
        ],
      },
      LIMITS,
    );
    expect(out?.pages[0].panes[0].effort).toBeUndefined();
  });
});

describe("toSavedLayout（保存してよい項目だけを写す）", () => {
  it("🚨 保存対象は key/kind/cliId/effort/cwd だけ（余計な値を持ち出さない）", () => {
    // 画面側のペインには「開いた直後に流すコマンド」など、保存すると
    // 次回起動で勝手に走ってしまう値が付いていることがある。
    const pages = [
      {
        id: "p1",
        panes: [
          {
            key: "a",
            kind: "shell",
            initialInput: "rm -rf ./dist",
            somethingElse: 1,
          },
        ],
      },
    ] as unknown as LayoutPageInput[];
    const out = toSavedLayout(pages, {}, {}, "p1");
    expect(Object.keys(out.pages[0].panes[0]).sort()).toEqual([
      "cliId",
      "cwd",
      "effort",
      "key",
      "kind",
    ]);
    expect(JSON.stringify(out)).not.toContain("rm -rf");
  });

  it("cwd は「実際に開いた場所 → 前回の場所 → null」の順で決まる", () => {
    const pages: LayoutPageInput[] = [
      {
        id: "p1",
        panes: [
          { key: "a", kind: "shell", savedCwd: "D:/old" },
          { key: "b", kind: "shell", savedCwd: "D:/keep" },
          { key: "c", kind: "shell" },
        ],
      },
    ];
    const out = toSavedLayout(pages, { a: "D:/now" }, {}, "p1");
    expect(out.pages[0].panes.map((p) => p.cwd)).toEqual([
      "D:/now",
      "D:/keep",
      null,
    ]);
  });

  it("分割比率とアクティブページも写す", () => {
    const pages: LayoutPageInput[] = [
      { id: "p1", panes: [{ key: "a", kind: "claude" }] },
    ];
    const out = toSavedLayout(
      pages,
      {},
      { p1: { colFr: [2, 1], rowFr: [1] } },
      "p1",
    );
    expect(out.pages[0].colFr).toEqual([2, 1]);
    expect(out.activePageId).toBe("p1");
  });

  it("保存 → 読み戻しが往復する（壊れない）", () => {
    const pages: LayoutPageInput[] = [
      {
        id: "p1",
        panes: [{ key: "a", kind: "shell", cliId: "codex", savedCwd: "D:/w" }],
      },
    ];
    const saved = toSavedLayout(pages, {}, {}, "p1");
    const back = sanitizeLayout(JSON.parse(JSON.stringify(saved)), LIMITS);
    expect(back?.pages[0].panes[0]).toEqual({
      key: "a",
      kind: "shell",
      cliId: "codex",
      effort: undefined,
      cwd: "D:/w",
    });
  });
});
