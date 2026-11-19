/**
 * Pure unit tests for the composite block store's composition helpers.
 * Run with `bun test plugins/page/plugins/editor/web/internal/composition.test.ts`.
 *
 * Exercises the load-bearing invariants of `composition.ts`: the `deriveMounts`
 * BFS (nested expansion, collapsed exclusion, page-link mounts, the shared
 * once-per-surface/cycle guard), `remapUnionParents` (identity vs anchor
 * rewrite), owner resolution + per-page grouping for write routing, the
 * mixed-page bulk throw, and the union→store translation seams.
 */

import { test, expect, describe } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  PAGE_BLOCK_TYPE,
  type Block,
  type BlockOp,
  type BlockPatch,
} from "../../core";
import type { BlockOverlayOp } from "./optimistic-block-ops";
import {
  deriveMounts,
  groupIdsByOwnerPage,
  groupPatchByOwnerPage,
  insertOwnerPage,
  pageByAnchor,
  remapUnionParents,
  resolveOpOwnerPage,
  rowOwnerPage,
  singleOwnerPage,
  splitOpByOwnerPage,
  translateOpForStore,
  translatePatchForStore,
  translateUnionParentId,
  type MountSourceRow,
  type Mounts,
} from "./composition";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A feed row as `deriveMounts` sees it. */
function frow(
  id: string,
  type: string,
  opts: { expanded?: boolean; data?: unknown } = {},
): MountSourceRow {
  return { id, type, expanded: opts.expanded ?? true, data: opts.data ?? {} };
}

/** An expanded sub-page shell row inside a container feed. */
function shell(id: string, opts: { expanded?: boolean } = {}): MountSourceRow {
  return frow(id, PAGE_BLOCK_TYPE, {
    expanded: opts.expanded ?? true,
    data: { title: id },
  });
}

/** An expanded page-link row targeting `pageId`. */
function link(
  id: string,
  pageId: string,
  opts: { expanded?: boolean } = {},
): MountSourceRow {
  return frow(id, "page-link", {
    expanded: opts.expanded ?? true,
    data: { pageId },
  });
}

function feeds(
  entries: Record<string, MountSourceRow[]>,
): Map<string, readonly MountSourceRow[]> {
  return new Map(Object.entries(entries));
}

/** Build a full `Block` row (the union shape, with `Rank` + timestamps). */
function mk(
  id: string,
  pageId: string | null,
  parentId: string | null,
  opts: { type?: string; expanded?: boolean } = {},
): Block {
  return {
    id,
    pageId,
    parentId,
    type: opts.type ?? "text",
    data: { text: id },
    rank: Rank.between(null, null),
    expanded: opts.expanded ?? true,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
  };
}

const BASE = "page-base";

/** Mounts literal: `[pageId, anchorId]` pairs (base identity mount included). */
function mounts(...pairs: [string, string][]): Mounts {
  return new Map([[BASE, BASE], ...pairs]);
}

// ---------------------------------------------------------------------------
// deriveMounts
// ---------------------------------------------------------------------------

describe("deriveMounts", () => {
  test("always mounts the base page, even with no feeds", () => {
    expect(deriveMounts(BASE, feeds({}))).toEqual(new Map([[BASE, BASE]]));
  });

  test("nested expansion: sub-pages mount transitively in BFS order", () => {
    const m = deriveMounts(
      BASE,
      feeds({
        [BASE]: [frow("t1", "text"), shell("child-a")],
        "child-a": [shell("grand-b")],
      }),
    );
    expect([...m.entries()]).toEqual([
      [BASE, BASE],
      ["child-a", "child-a"],
      ["grand-b", "grand-b"],
    ]);
  });

  test("collapsed pages are excluded (and their subtrees never walked)", () => {
    const m = deriveMounts(
      BASE,
      feeds({
        [BASE]: [shell("child-a", { expanded: false })],
        "child-a": [shell("grand-b")],
      }),
    );
    expect(m).toEqual(new Map([[BASE, BASE]]));
  });

  test("an unloaded feed contributes no expansions yet", () => {
    // child-a is mounted off the base feed, but its own feed has not published:
    // its expansions appear on its first push, not before.
    const m = deriveMounts(BASE, feeds({ [BASE]: [shell("child-a")] }));
    expect(m).toEqual(
      new Map([
        [BASE, BASE],
        ["child-a", "child-a"],
      ]),
    );
  });

  test("page-link rows produce translated mounts anchored on the link row", () => {
    const m = deriveMounts(BASE, feeds({ [BASE]: [link("link-1", "page-p")] }));
    expect(m.get("page-p")).toBe("link-1");
  });

  test("collapsed, unset, and empty-target links never mount", () => {
    const m = deriveMounts(
      BASE,
      feeds({
        [BASE]: [
          link("link-1", "page-p", { expanded: false }),
          frow("link-2", "page-link", { data: { pageId: "" } }),
          frow("link-3", "page-link", { data: null }),
        ],
      }),
    );
    expect(m).toEqual(new Map([[BASE, BASE]]));
  });

  test("once-per-surface: a page mounts at most once (first anchor wins)", () => {
    const m = deriveMounts(
      BASE,
      feeds({ [BASE]: [link("link-1", "page-p"), link("link-2", "page-p")] }),
    );
    expect(m.get("page-p")).toBe("link-1");
    expect(m.size).toBe(2);
  });

  test("a link is never shadowed by a sub-page of the SAME id mounting later", () => {
    // The shell IS the page row, so `shell("page-p")` and a link to page-p name
    // one page; whichever the BFS reaches first claims the single mount.
    const m = deriveMounts(
      BASE,
      feeds({ [BASE]: [shell("page-p"), link("link-1", "page-p")] }),
    );
    expect(m.get("page-p")).toBe("page-p");
  });

  test("cycle guard: a link back into the expansion ancestry never mounts", () => {
    const m = deriveMounts(
      BASE,
      feeds({
        [BASE]: [link("link-1", "page-p")],
        "page-p": [link("link-back", BASE), link("link-self", "page-p")],
      }),
    );
    expect([...m.keys()]).toEqual([BASE, "page-p"]);
    expect(m.get(BASE)).toBe(BASE);
  });
});

// ---------------------------------------------------------------------------
// remapUnionParents
// ---------------------------------------------------------------------------

describe("remapUnionParents", () => {
  test("identity — the same array reference — for sub-page-only mounts", () => {
    const rows = [mk("t1", BASE, BASE), mk("c1", "child-a", "child-a")];
    expect(remapUnionParents(rows, mounts(["child-a", "child-a"]))).toBe(rows);
  });

  test("rewrites a translated mount's top-level rows onto the anchor", () => {
    const rows = [
      mk("t1", BASE, BASE),
      mk("link-1", BASE, BASE, { type: "page-link" }),
      mk("p-top", "page-p", "page-p"),
      mk("p-nested", "page-p", "p-top"),
    ];
    const out = remapUnionParents(rows, mounts(["page-p", "link-1"]));
    expect(out.map((r) => r.parentId)).toEqual([BASE, BASE, "link-1", "p-top"]);
    // Untouched rows keep their identity; only the remapped row is copied.
    expect(out[0]).toBe(rows[0]!);
    expect(out[2]).not.toBe(rows[2]!);
  });
});

// ---------------------------------------------------------------------------
// Owner resolution + grouping
// ---------------------------------------------------------------------------

const unionRows = [
  mk("t1", BASE, BASE),
  mk("shell-a", BASE, "t1", { type: PAGE_BLOCK_TYPE }),
  mk("a1", "shell-a", "shell-a"),
  mk("a2", "shell-a", "a1"),
];

describe("owner resolution", () => {
  test("rowOwnerPage reads the row's denormalized pageId", () => {
    expect(rowOwnerPage(unionRows, "t1")).toBe(BASE);
    expect(rowOwnerPage(unionRows, "a1")).toBe("shell-a");
    // A shell row belongs to its CONTAINER page (deleting it routes there).
    expect(rowOwnerPage(unionRows, "shell-a")).toBe(BASE);
  });

  test("rowOwnerPage throws on an id absent from the union", () => {
    expect(() => rowOwnerPage(unionRows, "ghost")).toThrow(
      /not in the composed document/,
    );
  });

  test("groupIdsByOwnerPage groups per page, preserving id order", () => {
    expect(groupIdsByOwnerPage(unionRows, ["a2", "t1", "a1"])).toEqual(
      new Map([
        ["shell-a", ["a2", "a1"]],
        [BASE, ["t1"]],
      ]),
    );
  });

  test("singleOwnerPage throws on a mixed-page set (bulk guard)", () => {
    expect(singleOwnerPage(unionRows, ["a1", "a2"])).toBe("shell-a");
    expect(() => singleOwnerPage(unionRows, ["t1", "a1"])).toThrow(
      /spans 2 pages/,
    );
  });

  test("insertOwnerPage: null → base; shell parent → the shell's own page", () => {
    const m = mounts(["shell-a", "shell-a"]);
    expect(insertOwnerPage(unionRows, null, m, BASE)).toBe(BASE);
    expect(insertOwnerPage(unionRows, "shell-a", m, BASE)).toBe("shell-a");
    expect(insertOwnerPage(unionRows, "a1", m, BASE)).toBe("shell-a");
    // Absent from the union ⇒ the parent IS the page row (top-level insert).
    expect(insertOwnerPage(unionRows, BASE, m, BASE)).toBe(BASE);
  });

  test("insertOwnerPage: a translated anchor resolves to the mounted page", () => {
    const rows = [
      ...unionRows,
      mk("link-1", BASE, "t1", { type: "page-link" }),
    ];
    expect(
      insertOwnerPage(rows, "link-1", mounts(["page-p", "link-1"]), BASE),
    ).toBe("page-p");
  });

  test("resolveOpOwnerPage routes each op kind through its target", () => {
    const m = mounts(["shell-a", "shell-a"]);
    const owner = (op: BlockOp) => resolveOpOwnerPage(unionRows, op, m, BASE);
    expect(
      owner({ kind: "split", blockId: "a1", position: 0, newId: "n1" }),
    ).toBe("shell-a");
    expect(owner({ kind: "merge", blockId: "a2" })).toBe("shell-a");
    expect(owner({ kind: "delete", blockIds: ["shell-a"] })).toBe(BASE);
    expect(owner({ kind: "indent", blockIds: ["a1", "a2"] })).toBe("shell-a");
    expect(
      owner({ kind: "insert", newId: "n1", type: "text", afterId: "a1" }),
    ).toBe("shell-a");
    expect(
      owner({ kind: "insert", newId: "n1", type: "text", parentId: "shell-a" }),
    ).toBe("shell-a");
    expect(() => owner({ kind: "outdent", blockIds: ["t1", "a1"] })).toThrow(
      /spans 2 pages/,
    );
  });
});

// ---------------------------------------------------------------------------
// Patch grouping + translation
// ---------------------------------------------------------------------------

describe("groupPatchByOwnerPage", () => {
  const ownerOf = (id: string) =>
    unionRows.find((r) => r.id === id)?.pageId ??
    (id === "gone-a" ? "shell-a" : null);

  test("groups creates by their own pageId; updates + deletes via the lookup", () => {
    const patch: BlockPatch = {
      creates: [mk("t2", BASE, BASE), mk("a3", "shell-a", "shell-a")],
      // An update carries no pageId (it names only what it changes), so its
      // owner is resolved from the union.
      updates: [{ id: "a1", ofType: "text", changes: { expanded: true } }],
      deleteIds: ["a2", "t1"],
    };
    const groups = groupPatchByOwnerPage(patch, ownerOf);
    expect(groups.get(BASE)).toEqual({
      creates: [patch.creates[0]!],
      updates: [],
      deleteIds: ["t1"],
    });
    expect(groups.get("shell-a")).toEqual({
      creates: [patch.creates[1]!],
      updates: [patch.updates[0]!],
      deleteIds: ["a2"],
    });
  });

  test("an update/delete id absent from the union resolves through the fallback index", () => {
    // The detached case: the row left the union when its page collapsed; the
    // composite's cumulative row→page index still knows it.
    const groups = groupPatchByOwnerPage(
      {
        creates: [],
        updates: [
          { id: "gone-a", ofType: "text", changes: { expanded: false } },
        ],
        deleteIds: ["gone-a"],
      },
      ownerOf,
    );
    expect(groups.get("shell-a")).toEqual({
      creates: [],
      updates: [{ id: "gone-a", ofType: "text", changes: { expanded: false } }],
      deleteIds: ["gone-a"],
    });
  });

  test("an unresolvable id throws (never silently dropped)", () => {
    expect(() =>
      groupPatchByOwnerPage(
        { creates: [], updates: [], deleteIds: ["ghost"] },
        ownerOf,
      ),
    ).toThrow(/Cannot resolve the owning page/);
    expect(() =>
      groupPatchByOwnerPage(
        {
          creates: [],
          updates: [
            { id: "ghost", ofType: "text", changes: { expanded: true } },
          ],
          deleteIds: [],
        },
        ownerOf,
      ),
    ).toThrow(/Cannot resolve the owning page/);
  });
});

describe("translatePatchForStore", () => {
  const anchors = new Map([["link-1", "page-p"]]);

  test("rewrites anchor parents back to the mounted page id, on creates AND updates", () => {
    const patch: BlockPatch = {
      creates: [mk("p-top", "page-p", "link-1"), mk("t2", BASE, BASE)],
      updates: [
        { id: "p-two", ofType: "text", changes: { parentId: "link-1" } },
        { id: "t3", ofType: "text", changes: { parentId: BASE } },
      ],
      deleteIds: ["x"],
    };
    const out = translatePatchForStore(patch, anchors);
    expect(out.creates.map((u) => u.parentId)).toEqual(["page-p", BASE]);
    expect(out.updates.map((u) => u.changes.parentId)).toEqual([
      "page-p",
      BASE,
    ]);
    expect(out.deleteIds).toEqual(["x"]);
  });

  test("identity — the same reference — when nothing rewrites", () => {
    const patch: BlockPatch = {
      creates: [mk("t2", BASE, BASE)],
      updates: [{ id: "t3", ofType: "text", changes: { expanded: true } }],
      deleteIds: [],
    };
    expect(translatePatchForStore(patch, new Map())).toBe(patch);
    expect(translatePatchForStore(patch, anchors)).toBe(patch);
  });
});

describe("splitOpByOwnerPage", () => {
  const m = mounts(["shell-a", "shell-a"]);

  // A cross-page delete is the ONE kind that fans out, and each per-page op
  // carries the WHOLE gesture's target set rather than its own slice. That is
  // deliberate: the set is union-space, so a per-page op legitimately holds ids
  // belonging to another page, and the worst a foreign id can do is match
  // another op in this page's pending list — which only makes a departure WAIT.
  test("a cross-page delete fans out per owner, each op carrying the whole gesture's targets", () => {
    const targets: ReadonlySet<string> = new Set(["t1", "a1", "a2"]);
    const v: Extract<BlockOverlayOp, { tag: "op" }> = {
      tag: "op",
      op: { kind: "delete", blockIds: ["t1", "a1"] },
      effect: { kind: "remove", ids: ["t1", "a1"] },
      targets,
    };
    const out = splitOpByOwnerPage(unionRows, v, m, BASE);

    expect(out.map((o) => o.owner)).toEqual([BASE, "shell-a"]);
    for (const { v: fanned } of out) {
      expect(fanned.tag).toBe("op");
      if (fanned.tag !== "op") throw new Error("expected op variant");
      // Same SET, by reference: carried through whole, never narrowed.
      expect(fanned.targets).toBe(targets);
    }
    const [base, sub] = out;
    expect(base!.v.tag === "op" && base!.v.op).toEqual({
      kind: "delete",
      blockIds: ["t1"],
    });
    expect(sub!.v.tag === "op" && sub!.v.effect).toEqual({
      kind: "remove",
      ids: ["a1"],
    });
  });

  test("a single-page op is routed whole — the same reference, targets included", () => {
    const v: Extract<BlockOverlayOp, { tag: "op" }> = {
      tag: "op",
      op: { kind: "delete", blockIds: ["a1", "a2"] },
      effect: { kind: "remove", ids: ["a1", "a2"] },
      targets: new Set(["a1", "a2"]),
    };
    const out = splitOpByOwnerPage(unionRows, v, m, BASE);
    expect(out).toEqual([{ owner: "shell-a", v }]);
    expect(out[0]!.v).toBe(v);
  });
});

describe("translateOpForStore", () => {
  const m = mounts(["page-p", "link-1"]);

  test("translates insert/move parent anchors and reparent-effect predictions", () => {
    const insert: BlockOverlayOp = {
      tag: "op",
      op: { kind: "insert", newId: "n1", type: "text", parentId: "link-1" },
      effect: { kind: "create", ids: ["n1"] },
      targets: new Set(["n1"]),
    };
    const outInsert = translateOpForStore(insert, m);
    expect(
      outInsert.tag === "op" &&
        outInsert.op.kind === "insert" &&
        outInsert.op.parentId,
    ).toBe("page-p");

    const reparent: BlockOverlayOp = {
      tag: "op",
      op: { kind: "outdent", blockIds: ["p-nested"] },
      effect: {
        kind: "reparent",
        moves: [{ id: "p-nested", parentId: "link-1", rank: "a1" }],
      },
      targets: new Set(["p-nested"]),
    };
    const outReparent = translateOpForStore(reparent, m);
    expect(
      outReparent.tag === "op" &&
        outReparent.effect.kind === "reparent" &&
        outReparent.effect.moves[0]!.parentId,
    ).toBe("page-p");
  });

  // Only PARENT ids live in anchor space. `targets` holds BLOCK ids, which mean
  // the same row in union space and in the owning store's space — so the
  // translation must rewrite the move's `parentId` and leave the set exactly as
  // it found it, even when the set happens to contain the anchor's own id (the
  // link row IS a real block).
  test("targets ride through untouched while the reparent effect IS rewritten", () => {
    const targets: ReadonlySet<string> = new Set(["p-nested", "link-1"]);
    const v: BlockOverlayOp = {
      tag: "op",
      op: { kind: "outdent", blockIds: ["p-nested"] },
      effect: {
        kind: "reparent",
        moves: [{ id: "p-nested", parentId: "link-1", rank: "a1" }],
      },
      targets,
    };
    const out = translateOpForStore(v, m);
    if (out.tag !== "op" || out.effect.kind !== "reparent") {
      throw new Error("expected a reparent op");
    }
    // The parent anchor was translated…
    expect(out.effect.moves[0]!.parentId).toBe("page-p");
    // …and the block ids were not: same set, same reference.
    expect(out.targets).toBe(targets);
    expect([...out.targets].sort()).toEqual(["link-1", "p-nested"]);
  });

  test("patch tag delegates to the patch translation (cumulative anchors win)", () => {
    const restoreIds: ReadonlySet<string> = new Set(["p-top"]);
    const patch: BlockOverlayOp = {
      tag: "patch",
      patch: {
        creates: [mk("p-top", "page-p", "old-link")],
        updates: [],
        deleteIds: [],
      },
      restoreIds,
    };
    // `old-link` is no longer a mounted anchor; the cumulative map resolves it.
    const out = translateOpForStore(
      patch,
      m,
      new Map([["old-link", "page-p"]]),
    );
    expect(out.tag === "patch" && out.patch.creates[0]!.parentId).toBe(
      "page-p",
    );
    // Translation rewrites parent anchors, never row ids — so the restore set,
    // keyed by row id, rides through untouched.
    expect(out.tag === "patch" && out.restoreIds).toBe(restoreIds);
  });

  test("identity — the same reference — when no translated anchor is named", () => {
    const v: BlockOverlayOp = {
      tag: "op",
      op: { kind: "merge", blockId: "a2" },
      effect: { kind: "remove", ids: ["a2"] },
      targets: new Set(["a1", "a2"]),
    };
    expect(translateOpForStore(v, m)).toBe(v);
    expect(translateOpForStore(v, mounts(["shell-a", "shell-a"]))).toBe(v);
  });
});

describe("translateUnionParentId / pageByAnchor", () => {
  test("maps a translated anchor to its page; identity otherwise", () => {
    const m = mounts(["page-p", "link-1"], ["shell-a", "shell-a"]);
    expect(translateUnionParentId("link-1", m)).toBe("page-p");
    expect(translateUnionParentId("shell-a", m)).toBe("shell-a");
    expect(translateUnionParentId(null, m)).toBe(null);
    // Identity mounts (sub-page shells) are NOT translated anchors.
    expect(pageByAnchor(m)).toEqual(new Map([["link-1", "page-p"]]));
  });
});
