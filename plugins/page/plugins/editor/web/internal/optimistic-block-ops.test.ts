/**
 * Pure unit tests for the optimistic block-overlay layer.
 * Run with `bun test plugins/page/plugins/editor/`.
 *
 * Exercises the load-bearing invariants of `optimistic-block-ops.ts`: the single
 * `isReflected` predicate per effect kind, the `applyOverlayOp` round-trip
 * (Block[] → reducer → Block[]), the idempotency guard (re-applying an already-
 * reflected op throws `OpNoLongerApplies`), and chained compose (a split absorbed
 * by the base drops while a following outdent still applies).
 */

import { test, expect, describe } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { OpNoLongerApplies } from "@plugins/network/plugins/live/plugins/optimistic-mutation/web";
import type { Block, RichText } from "../../core";
import {
  applyOverlayOp,
  applyPatch,
  buildPatchOverlayOp,
  isPatchAbsorbed,
  isPatchReflected,
  isReflected,
  predictOp,
  sameOverlayTarget,
  type BlockOverlayOp,
  type OpEffect,
} from "./optimistic-block-ops";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A few stable, ascending rank keys for readable fixtures. */
const a = Rank.between(null, null).toJSON();
/** No restores: every create in the patch is a client-minted row. */
const none: ReadonlySet<string> = new Set();
function after(prev: string): string {
  return Rank.between(Rank.from(prev), null).toJSON();
}

/** Build a full `Block` row (the resource shape, with `Rank` + timestamps). */
function mk(
  id: string,
  parentId: string | null,
  rank: string,
  opts: {
    text?: string;
    /** `data.text` as the persisted RUNS array, for the cases where the exact
     *  stored shape decides whether a row counts as written. */
    runs?: RichText;
    expanded?: boolean;
    type?: string;
    pageId?: string | null;
  } = {},
): Block {
  return {
    id,
    pageId: opts.pageId === undefined ? "page-1" : opts.pageId,
    parentId,
    type: opts.type ?? "text",
    data: { text: opts.runs ?? opts.text ?? id },
    rank: Rank.from(rank),
    expanded: opts.expanded ?? false,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
  };
}

// ---------------------------------------------------------------------------
// isReflected
// ---------------------------------------------------------------------------

describe("isReflected", () => {
  const blocks = [mk("A", null, a), mk("B", null, after(a))];

  test("create: true when the id is present, false when absent", () => {
    expect(isReflected(blocks, { kind: "create", ids: ["A"] })).toBe(true);
    expect(isReflected(blocks, { kind: "create", ids: ["NEW"] })).toBe(false);
  });

  test("remove: true when every id is absent, false when any is present", () => {
    expect(isReflected(blocks, { kind: "remove", ids: ["GONE"] })).toBe(true);
    expect(isReflected(blocks, { kind: "remove", ids: ["A"] })).toBe(false);
    expect(
      isReflected(blocks, { kind: "remove", ids: ["GONE", "ALSO-GONE"] }),
    ).toBe(true);
    // A bulk delete is only absorbed once the WHOLE set is gone.
    expect(isReflected(blocks, { kind: "remove", ids: ["GONE", "A"] })).toBe(
      false,
    );
  });

  test("reparent: matches on id + parentId + rank; rank mismatch → false", () => {
    const rank = String(blocks.find((b) => b.id === "B")!.rank);
    const move = { id: "B", parentId: null, rank };
    const e: OpEffect = { kind: "reparent", moves: [move] };
    expect(isReflected(blocks, e)).toBe(true);
    // Same parent, different rank ⇒ not yet reflected (a reorder is distinct).
    expect(
      isReflected(blocks, {
        kind: "reparent",
        moves: [{ ...move, rank: after(rank) }],
      }),
    ).toBe(false);
    // Different parent ⇒ not reflected.
    expect(
      isReflected(blocks, {
        kind: "reparent",
        moves: [{ ...move, parentId: "A" }],
      }),
    ).toBe(false);
  });

  test("unwrap: BOTH the container's removal and every promoted child", () => {
    // The base has A and B at top level: read as "the container C is gone and B
    // was promoted to where the effect predicted".
    const rankB = String(blocks.find((b) => b.id === "B")!.rank);
    const e: OpEffect = {
      kind: "unwrap",
      id: "C",
      moves: [{ id: "B", parentId: null, rank: rankB }],
    };
    expect(isReflected(blocks, e)).toBe(true);
    // Container still present ⇒ not absorbed, even though the child is placed.
    expect(isReflected([...blocks, mk("C", null, after(rankB))], e)).toBe(
      false,
    );
    // Container gone but the child NOT promoted (another client hard-deleted the
    // subtree) ⇒ not absorbed either. This is why a bare `remove` under-describes
    // the op: it would drop a replay whose promotion never happened.
    expect(isReflected([mk("A", null, a)], e)).toBe(false);
  });

  test("unwrap: an EMPTY move list is not vacuous — the removal still has to hold", () => {
    const e: OpEffect = { kind: "unwrap", id: "A", moves: [] };
    expect(isReflected(blocks, e)).toBe(false); // A is still there
    expect(isReflected([mk("B", null, after(a))], e)).toBe(true);
  });

  test("reparent: every listed move must be reflected (a bulk indent/outdent)", () => {
    const rankA = String(blocks.find((b) => b.id === "A")!.rank);
    const rankB = String(blocks.find((b) => b.id === "B")!.rank);
    const both: OpEffect = {
      kind: "reparent",
      moves: [
        { id: "A", parentId: null, rank: rankA },
        { id: "B", parentId: null, rank: rankB },
      ],
    };
    expect(isReflected(blocks, both)).toBe(true);
    // One block still where it was ⇒ the whole op is not yet absorbed.
    expect(
      isReflected(blocks, {
        kind: "reparent",
        moves: [
          { id: "A", parentId: null, rank: rankA },
          { id: "B", parentId: "A", rank: rankB },
        ],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyOverlayOp round-trip
// ---------------------------------------------------------------------------

describe("applyOverlayOp", () => {
  test("round-trips a split (Block[] → Block[]) producing exactly one new node", () => {
    const blocks = [mk("A", null, a, { text: "helloworld" })];
    const overlay = predictOp(
      { kind: "split", blockId: "A", position: 5, newId: "NEW" },
      blocks,
    ).vars;
    const out = applyOverlayOp(blocks, overlay);

    expect(out.length).toBe(2);
    const created = out.filter((b) => b.id === "NEW");
    expect(created.length).toBe(1);
    // The result rows are full Blocks: `rank` is a Rank instance, timestamps set.
    const newNode = created[0]!;
    expect(newNode.rank).toBeInstanceOf(Rank);
    expect(newNode.createdAt).toBeInstanceOf(Date);
    // Origin text truncated; new node carries the trailing text (runs model).
    const aNode = out.find((b) => b.id === "A")!;
    expect((aNode.data as { text: unknown }).text).toEqual([{ text: "hello" }]);
    expect((newNode.data as { text: unknown }).text).toEqual([
      { text: "world" },
    ]);
  });

  test("preserves timestamps from the matching prev row by id", () => {
    const blocks = [mk("A", null, a, { text: "abc" })];
    const overlay = predictOp(
      { kind: "split", blockId: "A", position: 1, newId: "NEW" },
      blocks,
    ).vars;
    const out = applyOverlayOp(blocks, overlay);
    const aNode = out.find((b) => b.id === "A")!;
    expect(aNode.createdAt).toEqual(blocks[0]!.createdAt);
  });
});

// ---------------------------------------------------------------------------
// Idempotency guard
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  test("applying the same split overlay op on a base that already has the newId throws", () => {
    const blocks = [mk("A", null, a, { text: "helloworld" })];
    const overlay = predictOp(
      { kind: "split", blockId: "A", position: 5, newId: "NEW" },
      blocks,
    ).vars;
    const once = applyOverlayOp(blocks, overlay);
    // Replaying the same op on the already-applied base ⇒ the effect is reflected
    // ⇒ guard throws OpNoLongerApplies (so the primitive's replay would drop it).
    expect(() => applyOverlayOp(once, overlay)).toThrow(OpNoLongerApplies);
  });
});

// ---------------------------------------------------------------------------
// Chained compose
// ---------------------------------------------------------------------------

describe("chained compose", () => {
  test("[split, outdent]: split dropped on a base that already absorbed it, outdent still applies", () => {
    // P with children C1, C2 — split C1, then outdent the new node.
    const r1 = a;
    const r2 = after(r1);
    const base = [
      mk("P", null, a, { expanded: true }),
      mk("C1", "P", r1, { text: "foobar" }),
      mk("C2", "P", r2),
    ];

    // Build the two overlay ops against the evolving optimistic state.
    const splitOp = predictOp(
      { kind: "split", blockId: "C1", position: 3, newId: "NEW" },
      base,
    ).vars;
    const afterSplit = applyOverlayOp(base, splitOp);
    const outdentOp = predictOp(
      { kind: "outdent", blockIds: ["NEW"] },
      afterSplit,
    ).vars;

    // Simulate a base that already absorbed the split (server push landed):
    // re-running splitOp on it must drop (throw), while outdentOp still applies.
    expect(() => applyOverlayOp(afterSplit, splitOp)).toThrow(
      OpNoLongerApplies,
    );

    const outdented = applyOverlayOp(afterSplit, outdentOp);
    const moved = outdented.find((b) => b.id === "NEW")!;
    // NEW outdented from under P up to the top level (P's parent is null).
    expect(moved.parentId).toBe(null);
  });

  test("predictOp captures the right effect per kind", () => {
    const r1 = a;
    const r2 = after(r1);
    const rows = [
      mk("P1", null, r1, { text: "one" }),
      mk("P2", null, r2, { text: "two" }),
    ];

    // `predictOp` always yields the `op`-tagged variant; assert + narrow.
    const expectOp = (
      v: BlockOverlayOp,
    ): Extract<BlockOverlayOp, { tag: "op" }> => {
      expect(v.tag).toBe("op");
      if (v.tag !== "op") throw new Error("expected op variant");
      return v;
    };

    const split = expectOp(
      predictOp({ kind: "split", blockId: "P1", position: 1, newId: "S" }, rows)
        .vars,
    );
    expect(split.effect).toEqual({ kind: "create", ids: ["S"] });

    const ins = expectOp(
      predictOp({ kind: "insert", newId: "I", type: "text" }, rows).vars,
    );
    expect(ins.effect).toEqual({ kind: "create", ids: ["I"] });

    const merge = expectOp(
      predictOp({ kind: "merge", blockId: "P2" }, rows).vars,
    );
    expect(merge.effect).toEqual({ kind: "remove", ids: ["P2"] });

    const del = expectOp(
      predictOp({ kind: "delete", blockIds: ["P1"] }, rows).vars,
    );
    expect(del.effect).toEqual({ kind: "remove", ids: ["P1"] });

    expect(merge.op.kind).toBe("merge");
  });

  test("unwrap: the effect names the container AND its promoted children", () => {
    // page ▸ A, CA(container) ▸ [X, Y]. The children are not named by the op, so
    // the builder reads them off the pre-op forest.
    const r1 = a;
    const r2 = after(r1);
    const k1 = a;
    const k2 = after(k1);
    const rows = [
      mk("A", null, r1, { text: "a" }),
      mk("CA", null, r2, { type: "callout", expanded: true }),
      mk("X", "CA", k1, { text: "x" }),
      mk("Y", "CA", k2, { text: "y" }),
    ];
    const anchors = { anchorTypes: new Set(["callout"]) };
    const v = predictOp({ kind: "unwrap", blockId: "CA" }, rows, anchors).vars;
    if (v.tag !== "op" || v.effect.kind !== "unwrap")
      throw new Error("expected an unwrap effect");
    expect(v.effect.id).toBe("CA");
    expect(v.effect.moves.map((m) => m.id)).toEqual(["X", "Y"]);
    expect(v.effect.moves.every((m) => m.parentId === null)).toBe(true);

    // …and the predicted placement is exactly what applying the op produces, so
    // the op confirms against its own result.
    const applied = applyOverlayOp(rows, v, anchors);
    expect(isReflected(applied, v.effect)).toBe(true);
    // Idempotency guard: replaying it onto that base drops the entry.
    expect(() => applyOverlayOp(applied, v, anchors)).toThrow(
      OpNoLongerApplies,
    );
  });
});

// ---------------------------------------------------------------------------
// Patch overlay (undo/redo inverse path)
// ---------------------------------------------------------------------------

describe("applyPatch", () => {
  test("creates insert new + replace existing, deletes drop ids", () => {
    const blocks = [
      mk("A", null, a, { text: "a" }),
      mk("B", null, after(a), { text: "b" }),
    ];
    const out = applyPatch(
      blocks,
      {
        creates: [
          mk("A", null, a, { text: "A!" }),
          mk("C", null, after(after(a)), { text: "c" }),
        ],
        updates: [],
        deleteIds: ["B"],
      },
      none,
    );
    expect(out.map((b) => b.id).sort()).toEqual(["A", "C"]);
    expect((out.find((b) => b.id === "A")!.data as { text: string }).text).toBe(
      "A!",
    );
  });

  test("an update MERGES its named fields — never a whole-row swap", () => {
    const blocks = [
      mk("A", "P", a, { text: "keep me", type: "callout", expanded: true }),
    ];
    const out = applyPatch(
      blocks,
      {
        creates: [],
        updates: [{ id: "A", changes: { expanded: false } }],
        deleteIds: [],
      },
      none,
    );
    const row = out[0]!;
    expect(row.expanded).toBe(false);
    // Everything the patch did not name is untouched — the whole point.
    expect(row.type).toBe("callout");
    expect(row.parentId).toBe("P");
    expect((row.data as { text: string }).text).toBe("keep me");
  });

  test("deleting a subtree root drops descendants too (mirrors FK cascade)", () => {
    const blocks = [
      mk("P", null, a, { expanded: true }),
      mk("C1", "P", after(a)),
      mk("C2", "C1", after(after(a))),
    ];
    const out = applyPatch(
      blocks,
      {
        creates: [],
        updates: [],
        deleteIds: ["P"],
      },
      none,
    );
    expect(out.length).toBe(0);
  });

  test("a child the SAME patch re-parents out of the deleted subtree survives", () => {
    // Redo of an `unwrap`: promote the container's children, then delete the
    // container. The server UPDATEs before it DELETEs, so the cascade sees the
    // child already gone from the subtree — reading pre-patch parentage here
    // instead swallowed every promoted child.
    const blocks = [mk("P", null, a, { expanded: true }), mk("C", "P", a)];
    const out = applyPatch(
      blocks,
      {
        creates: [],
        updates: [{ id: "C", changes: { parentId: null } }],
        deleteIds: ["P"],
      },
      none,
    );
    expect(out.map((b) => b.id)).toEqual(["C"]);
    expect(out[0]!.parentId).toBe(null);
  });
});

describe("isPatchReflected", () => {
  test("true once every create is present + matching and every delete is gone", () => {
    const base = [mk("A", null, a, { type: "heading" })];
    const patch = {
      creates: [mk("A", null, a, { type: "heading" })],
      updates: [],
      deleteIds: ["B"],
    };
    expect(isPatchReflected(base, patch, none)).toBe(true);
    // A create whose column differs ⇒ not yet reflected.
    expect(
      isPatchReflected([mk("A", null, a, { type: "text" })], patch, none),
    ).toBe(false);
    // A delete id still present ⇒ not reflected.
    expect(
      isPatchReflected([...base, mk("B", null, after(a))], patch, none),
    ).toBe(false);
  });

  // Confirmation is deliberately data-BLIND (server truth legitimately differs:
  // `parseBlockData` normalization, a `data.text` projection lagging ~1s). The
  // exact question belongs to the apply-guard — see the `isPatchAbsorbed`
  // describe below, which pins the divergence.
  test("`data` is not compared, even when the patch names it", () => {
    const patch = {
      creates: [],
      updates: [{ id: "A", changes: { data: { text: "projected" } } }],
      deleteIds: [],
    };
    expect(
      isPatchReflected([mk("A", null, a, { text: "stale" })], patch, none),
    ).toBe(true);
    expect(
      isPatchReflected([mk("A", null, a, { text: "projected" })], patch, none),
    ).toBe(true);
  });

  // The two exclusions above compose into a TAUTOLOGY, and this is the case
  // that matters: `data` is never compared (`fieldsReflected`'s `compareData:
  // false`) and an update naming an absent row is skipped (`patchLanded`), so a
  // patch whose only update names `data` has nothing left to test. It returns
  // `true` against every conceivable snapshot — the row present with the wrong
  // text, the row present with the right text, the row missing, the page empty.
  // Such a snapshot did not REFLECT the patch; it merely failed to CONTRADICT
  // it.
  //
  // That is exactly why a confirmation may never speak for a DIFFERENT op. The
  // debounced text projection is this patch shape, it fires constantly while a
  // user types, and the old same-target cascade let its vacuous `true` evict an
  // older structural op sharing a row — which is how a live block vanished from
  // a user's screen for ~90s mid-typing. The overlay is an ordered fold, so
  // dropping a middle op renders a state the user never created. Confirmation
  // is now local to the op that earned it, and an older same-target op merely
  // makes a newer one WAIT. See
  // `research/2026-09-01-global-overlay-ordered-fold-no-transitive-eviction.md`.
  //
  // The `data` exclusion itself is correct and stays: server truth legitimately
  // differs (`parseBlockData` normalization, the ~1s `data.text` projection
  // lag), and comparing it would strand every projection in the overlay. This
  // pins the property so the next reader knows what the predicate can and
  // cannot prove — it does not condemn it.
  test("a data-only patch is confirmed by ANY snapshot — its predicate cannot fail", () => {
    const dataOnly = {
      creates: [],
      updates: [{ id: "A", changes: { data: { text: "projected" } } }],
      deleteIds: [],
    };
    // Row present, text stale — the write demonstrably has NOT landed.
    expect(
      isPatchReflected([mk("A", null, a, { text: "stale" })], dataOnly, none),
    ).toBe(true);
    // Row absent entirely: the update is skipped, so nothing is left to fail.
    expect(isPatchReflected([mk("B", null, after(a))], dataOnly, none)).toBe(
      true,
    );
    // The strongest form: an EMPTY snapshot confirms it too.
    expect(isPatchReflected([], dataOnly, none)).toBe(true);
  });

  test("only the NAMED fields are compared", () => {
    const patch = {
      creates: [],
      updates: [{ id: "A", changes: { expanded: true } }],
      deleteIds: [],
    };
    // `data`/`type`/`parentId` all differ from anything — irrelevant, unnamed.
    expect(
      isPatchReflected(
        [mk("A", "Z", a, { expanded: true, type: "quote", text: "x" })],
        patch,
        none,
      ),
    ).toBe(true);
    expect(
      isPatchReflected([mk("A", "Z", a, { expanded: false })], patch, none),
    ).toBe(false);
  });

  test("applyOverlayOp on a patch that the base already reflects throws", () => {
    const base = [mk("A", null, a)];
    const overlay = buildPatchOverlayOp(
      {
        creates: [mk("A", null, a)],
        updates: [],
        deleteIds: [],
      },
      { restoreIds: none },
    );
    expect(() => applyOverlayOp(base, overlay)).toThrow(OpNoLongerApplies);
  });
});

// ---------------------------------------------------------------------------
// isPatchAbsorbed (the apply-guard) vs isPatchReflected (confirmation).
//
// The two predicates ask different questions of different subjects — "would
// applying this change anything HERE" vs "does server truth prove my write
// landed" — and `data` belongs in the first but not the second. Everything else
// (which fields a patch NAMES, the update-never-creates skip) is shared, so
// these pin exactly that difference: identical on every structural case,
// divergent on a data-only patch, which is every `BlockEditorAPI.update` (to-do
// checked, callout color, image width) and the `data.text` projection.
// ---------------------------------------------------------------------------

describe("isPatchAbsorbed", () => {
  const base = [mk("A", null, a, { text: "old" }), mk("B", null, after(a))];
  const dataOnly = {
    creates: [],
    updates: [{ id: "A", changes: { data: { text: "new" } } }],
    deleteIds: [],
  };

  test("a data-only patch is NOT absorbed, though it IS reflected", () => {
    expect(isPatchAbsorbed(base, dataOnly, none)).toBe(false);
    // The confirmation predicate stays data-blind on purpose (server truth
    // legitimately differs — `parseBlockData` normalization, a lagging
    // `data.text` projection), which is why it cannot double as the guard.
    expect(isPatchReflected(base, dataOnly, none)).toBe(true);
  });

  test("applyOverlayOp APPLIES a data-only patch instead of swallowing it", () => {
    const out = applyOverlayOp(
      base,
      buildPatchOverlayOp(dataOnly, { restoreIds: none }),
    );
    expect((out.find((b) => b.id === "A")!.data as { text: string }).text).toBe(
      "new",
    );
    // …and re-applying it onto the result is a genuine no-op ⇒ guard trips.
    expect(() =>
      applyOverlayOp(out, buildPatchOverlayOp(dataOnly, { restoreIds: none })),
    ).toThrow(OpNoLongerApplies);
  });

  test("`data` equality is by VALUE, not reference (a re-serialized identical payload is absorbed)", () => {
    const same = {
      creates: [],
      updates: [{ id: "A", changes: { data: { text: "old" } } }],
      deleteIds: [],
    };
    expect(isPatchAbsorbed(base, same, none)).toBe(true);
  });

  test("the structural cases behave identically under both predicates", () => {
    const cases: {
      patch: Parameters<typeof isPatchAbsorbed>[1];
      expected: boolean;
    }[] = [
      // Every named field already matches.
      {
        patch: {
          creates: [],
          updates: [{ id: "A", changes: { data: { text: "old" } } }],
          deleteIds: [],
        },
        expected: true,
      },
      // A named structural field differs.
      {
        patch: {
          creates: [],
          updates: [{ id: "A", changes: { type: "heading" } }],
          deleteIds: [],
        },
        expected: false,
      },
      {
        patch: {
          creates: [],
          updates: [{ id: "A", changes: { parentId: "B" } }],
          deleteIds: [],
        },
        expected: false,
      },
      {
        patch: {
          creates: [],
          updates: [{ id: "A", changes: { rank: Rank.from(after(a)) } }],
          deleteIds: [],
        },
        expected: false,
      },
      {
        patch: {
          creates: [],
          updates: [{ id: "A", changes: { expanded: true } }],
          deleteIds: [],
        },
        expected: false,
      },
      // A row the patch would CREATE is missing.
      {
        patch: {
          creates: [mk("C", null, after(after(a)))],
          updates: [],
          deleteIds: [],
        },
        expected: false,
      },
      // A delete id still present / already gone.
      {
        patch: { creates: [], updates: [], deleteIds: ["B"] },
        expected: false,
      },
      {
        patch: { creates: [], updates: [], deleteIds: ["GONE"] },
        expected: true,
      },
    ];
    for (const { patch, expected } of cases) {
      expect(isPatchAbsorbed(base, patch, none)).toBe(expected);
      expect(isPatchReflected(base, patch, none)).toBe(expected);
    }
  });

  test("an update naming an absent row is vacuously satisfied under both", () => {
    const projected = {
      creates: [],
      updates: [{ id: "GONE", changes: { data: { text: "projected" } } }],
      deleteIds: [],
    };
    expect(isPatchAbsorbed(base, projected, none)).toBe(true);
    expect(isPatchReflected(base, projected, none)).toBe(true);
    // The same row as a CREATE should have been created ⇒ neither is satisfied.
    const created = {
      creates: [mk("GONE", null, a, { text: "projected" })],
      updates: [],
      deleteIds: [],
    };
    expect(isPatchAbsorbed(base, created, none)).toBe(false);
    expect(isPatchReflected(base, created, none)).toBe(false);
  });

  test("a PRESENT row's data still counts for the guard (the projection applies optimistically)", () => {
    const projected = {
      creates: [],
      updates: [{ id: "A", changes: { data: { text: "projected" } } }],
      deleteIds: [],
    };
    expect(isPatchAbsorbed(base, projected, none)).toBe(false);
    expect(isPatchReflected(base, projected, none)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// An update never creates. The CRDT text projection is a `data`-only update, so
// a debounced flush racing a concurrent delete (most importantly a history
// RESTORE, which replaces every content row) cannot resurrect the block: the
// patch's SHAPE forbids it, with no flag to set or forget. These pin the client
// half; the server half is the symmetric skip in handle-patch-blocks.ts.
// ---------------------------------------------------------------------------

describe("updates never create", () => {
  const projected = {
    creates: [],
    updates: [{ id: "A", changes: { data: { text: "projected" } } }],
    deleteIds: [],
  };

  test("applyPatch updates a present row", () => {
    const out = applyPatch(
      [mk("A", null, a, { text: "old" }), mk("B", null, after(a))],
      projected,
      none,
    );
    expect(out.map((b) => b.id)).toEqual(["A", "B"]);
    expect((out.find((b) => b.id === "A")!.data as { text: string }).text).toBe(
      "projected",
    );
  });

  test("applyPatch NEVER re-creates an absent row (no resurrection)", () => {
    // Base without A — e.g. a restore replaced the page's rows.
    const out = applyPatch([mk("B", null, after(a))], projected, none);
    expect(out.map((b) => b.id)).toEqual(["B"]);
  });

  test("isPatchReflected treats an absent row as vacuously absorbed (confirms, never sticks)", () => {
    // Row gone from server truth: the server writer skipped the update, so the
    // op must confirm against this base instead of replaying forever.
    expect(isPatchReflected([mk("B", null, after(a))], projected, none)).toBe(
      true,
    );
    // Same row as a CREATE: NOT reflected (the row should have been created).
    expect(
      isPatchReflected(
        [mk("B", null, after(a))],
        {
          creates: [mk("A", null, a, { text: "projected" })],
          updates: [],
          deleteIds: [],
        },
        none,
      ),
    ).toBe(false);
  });

  test("isPatchReflected still compares named columns for present rows", () => {
    const moved = {
      creates: [],
      updates: [{ id: "A", changes: { parentId: "B" } }],
      deleteIds: [],
    };
    expect(isPatchReflected([mk("A", null, a)], moved, none)).toBe(false);
    expect(isPatchReflected([mk("A", "B", a)], moved, none)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A create of a row this client has seen in server truth is a RESTORE.
//
// Every block delete is a trash, and a patch `create` whose id matches a
// trashed row restores the STORED row: the server keeps the row's own fields
// (re-ranked after a slot occupant, reparented to the root if its parent is
// gone, expanded if the user toggled it between the delete and the undo) and
// ignores the create's copy. So a restore asserts PRESENCE only, under both
// predicates — otherwise the op could never confirm (no later push arrives:
// the restore ran in its own transaction and the patch wrote nothing) and the
// overlay would keep painting the recorded fields over the server's row. The
// ids come from `restoreIds` on the patch variant, derived at dispatch from
// `RowTruth`; a client-minted id is never in the set and keeps the full
// comparison.
// ---------------------------------------------------------------------------

describe("restore creates are presence-only", () => {
  // Recorded at delete time: a collapsed toggle T at rank `a` under the root,
  // with its child B.
  const recordedT = mk("T", null, a, { type: "toggle", expanded: false });
  const recordedB = mk("B", "T", a, { text: "hidden child" });
  const undoDelete = {
    creates: [recordedT, recordedB],
    updates: [],
    deleteIds: [],
  };
  const restoring: ReadonlySet<string> = new Set(["T", "B"]);
  // What the server restored: T expanded (toggled meanwhile), re-ranked after
  // a sibling that took its slot, and B reparented to the root.
  const restoredT = mk("T", null, after(a), { type: "toggle", expanded: true });
  const restoredB = mk("B", null, after(after(a)), { text: "hidden child" });
  const serverTruth = [mk("S", null, a), restoredT, restoredB];

  test("a restore create is reflected when the row is present with DIFFERENT expanded / rank / parentId", () => {
    expect(isPatchReflected(serverTruth, undoDelete, restoring)).toBe(true);
    // Absent is still absent: presence is the one thing a restore asserts.
    expect(isPatchReflected([mk("S", null, a)], undoDelete, restoring)).toBe(
      false,
    );
    expect(
      isPatchReflected([mk("S", null, a), restoredT], undoDelete, restoring),
    ).toBe(false);
  });

  test("a client-minted create with different fields is still NOT reflected", () => {
    // Same patch, same snapshot, but nothing says these ids are restores: the
    // full comparison stands, and the differing rows do not confirm it.
    expect(isPatchReflected(serverTruth, undoDelete, none)).toBe(false);
    // Only one of the two is a restore: the other keeps its field comparison.
    expect(isPatchReflected(serverTruth, undoDelete, new Set(["T"]))).toBe(
      false,
    );
    // The genuine create confirms exactly when its row matches.
    expect(
      isPatchReflected(
        [mk("S", null, a), restoredT, recordedB],
        undoDelete,
        new Set(["T"]),
      ),
    ).toBe(true);
  });

  test("the apply-guard drops a restore op whose row is present (the server's row shows through)", () => {
    const op = buildPatchOverlayOp(undoDelete, { restoreIds: restoring });
    expect(isPatchAbsorbed(serverTruth, undoDelete, restoring)).toBe(true);
    expect(() => applyOverlayOp(serverTruth, op)).toThrow(OpNoLongerApplies);
    // The same rows judged as genuine creates would be re-asserted whole.
    expect(isPatchAbsorbed(serverTruth, undoDelete, none)).toBe(false);
    const clobbered = applyOverlayOp(
      serverTruth,
      buildPatchOverlayOp(undoDelete, { restoreIds: none }),
    );
    expect(clobbered.find((b) => b.id === "T")!.expanded).toBe(false);
  });

  test("while the row is ABSENT a restore renders its recorded copy; once PRESENT the present row wins", () => {
    // The optimistic render before the server answers: the recorded rows.
    const optimistic = applyPatch([mk("S", null, a)], undoDelete, restoring);
    expect(optimistic.map((b) => b.id)).toEqual(["S", "T", "B"]);
    expect(optimistic.find((b) => b.id === "T")!.expanded).toBe(false);
    // A mixed patch replayed over a base that already holds the restored row
    // (the guard did not fire because the update below has not landed): the
    // restore must not paint its recorded copy over the server's row.
    const mixed = {
      ...undoDelete,
      updates: [{ id: "S", changes: { expanded: true } }],
    };
    const out = applyPatch(serverTruth, mixed, restoring);
    expect(out.find((b) => b.id === "T")).toBe(restoredT);
    expect(out.find((b) => b.id === "B")).toBe(restoredB);
    expect(out.find((b) => b.id === "S")!.expanded).toBe(true);
  });

  test("a restore's ids still count as targets for the ordering rule", () => {
    const restore = buildPatchOverlayOp(undoDelete, { restoreIds: restoring });
    const toggleT = buildPatchOverlayOp(
      {
        creates: [],
        updates: [{ id: "T", changes: { expanded: true } }],
        deleteIds: [],
      },
      { restoreIds: none },
    );
    expect(sameOverlayTarget(restore, toggleT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sameOverlayTarget (op identity for the overlay's ordering rule)
//
// The relation is unchanged; what it MEANS changed. It used to be a licence to
// evict — a confirmed newer op dropped every older op sharing a row. It is now
// a reason to WAIT: an op may not leave the overlay while an older, still-
// pending op sharing a row survives the same pass. So an inaccurate answer now
// costs a deferred departure instead of a reverted edit.
// ---------------------------------------------------------------------------

describe("sameOverlayTarget", () => {
  const patchOn = (ids: string[], deleteIds: string[] = []): BlockOverlayOp =>
    buildPatchOverlayOp(
      {
        creates: ids.map((id) => mk(id, null, a)),
        updates: [],
        deleteIds,
      },
      { restoreIds: none },
    );

  test("an update's target counts as a written row", () => {
    const upd = buildPatchOverlayOp(
      {
        creates: [],
        updates: [{ id: "A", changes: { expanded: true } }],
        deleteIds: [],
      },
      { restoreIds: none },
    );
    expect(sameOverlayTarget(upd, patchOn(["A"]))).toBe(true);
    expect(sameOverlayTarget(upd, patchOn(["B"]))).toBe(false);
  });

  test("an undo patch and its redo inverse share their id set (the stuck-inverse pair blocks)", () => {
    const undoP = patchOn([], ["X"]); // undo: delete X
    const redoP = patchOn(["X"]); // redo: restore X
    expect(sameOverlayTarget(undoP, redoP)).toBe(true);
  });

  // The relation is an INTERSECTION — "do these two write any row in common" —
  // not a subset, and the difference is load-bearing. Here the split writes two
  // rows (the origin block it truncates — it is in the set twice over, named by
  // the op and measurably rewritten — and the block it mints) while the patch
  // names only the minted one. They match, yet the patch's evidence says nothing
  // about the ORIGIN row the split also rewrote.
  //
  // That is why an overlap may not absorb: dropping the split on the patch's
  // word would discard the split's effect on a row nothing vouched for — and
  // this is the incident's own shape, since the patch is the debounced text
  // projection on the new block, whose predicate confirms unconditionally (see
  // the `isPatchReflected` tautology case above). Under the ordering rule the
  // overlap instead makes the newer op WAIT for the older one, which needs no
  // claim about coverage at all: over-matching only defers a departure. An
  // absorbing rule would need a true subset relation, which is why it was
  // deferred rather than shipped —
  // `research/2026-09-01-global-overlay-ordered-fold-no-transitive-eviction.md`.
  test("target sets INTERSECT rather than nest (a split writes a row its patch never names)", () => {
    const rows = [mk("A", null, a), mk("B", null, after(a))];
    const split = predictOp(
      { kind: "split", blockId: "A", position: 1, newId: "NEW" },
      rows,
    ).vars;
    // The projection patch: a `data`-only update on the minted block alone.
    const projection = buildPatchOverlayOp(
      {
        creates: [],
        updates: [{ id: "NEW", changes: { data: { text: "typed" } } }],
        deleteIds: [],
      },
      { restoreIds: none },
    );
    expect(sameOverlayTarget(split, projection)).toBe(true);
    // …but the split also rewrote "A", which the patch never mentions, so the
    // match is an overlap and not containment in either direction.
    expect(sameOverlayTarget(split, patchOn([], ["A"]))).toBe(true);
    expect(sameOverlayTarget(projection, patchOn([], ["A"]))).toBe(false);
  });

  test("patches on disjoint blocks are unrelated (a projectText on another block never blocks)", () => {
    expect(sameOverlayTarget(patchOn(["A"]), patchOn(["B"]))).toBe(false);
    expect(sameOverlayTarget(patchOn([], ["A"]), patchOn(["B"], ["C"]))).toBe(
      false,
    );
  });

  // The claim used to be "the rows the BlockOp NAMES" and that is the half that
  // changed: a structural op's set is the union of what it names and what the
  // reducer measurably wrote, so it now covers rows the op mentions nowhere.
  test("structural ops target the rows the op names OR writes", () => {
    const rows = [mk("A", null, a), mk("B", null, after(a))];
    const split = predictOp(
      { kind: "split", blockId: "A", position: 1, newId: "NEW" },
      rows,
    ).vars;
    const del = predictOp({ kind: "delete", blockIds: ["A"] }, rows).vars;
    const other = predictOp({ kind: "delete", blockIds: ["B"] }, rows).vars;
    expect(sameOverlayTarget(split, del)).toBe(true); // both touch A
    expect(sameOverlayTarget(split, other)).toBe(false);
    // op ↔ patch across the same row
    expect(sameOverlayTarget(del, patchOn(["A"]))).toBe(true);
    expect(sameOverlayTarget(del, patchOn(["B"]))).toBe(false);

    // The widened half: `merge{blockId: B}` names B alone, yet it rewrites A —
    // the previous visible line it folds B's runs into — so a delete of A and a
    // patch on A both register against it.
    const merge = predictOp({ kind: "merge", blockId: "B" }, rows).vars;
    expect(sameOverlayTarget(merge, del)).toBe(true);
    expect(sameOverlayTarget(merge, patchOn(["A"]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// predictOp: `targets` is what the op NAMES ∪ what the reducer WROTE
//
// The naming half alone under-approximates — merge rewrites a row the op never
// mentions, split adopts children it never mentions, delete cascades — and the
// measured half alone is SMALLER than the naming one wherever the reducer
// returns a row byte-identical (an identity split, an end-of-line split against
// a caught-up projection, a partially-refused indent). Only the union covers
// both, which is what these pin.
// ---------------------------------------------------------------------------

describe("predictOp targets", () => {
  /** `predictOp` always yields the `op`-tagged variant; assert + narrow. */
  const expectOpVars = (
    v: BlockOverlayOp,
  ): Extract<BlockOverlayOp, { tag: "op" }> => {
    expect(v.tag).toBe("op");
    if (v.tag !== "op") throw new Error("expected op variant");
    return v;
  };
  const patchOn = (id: string): BlockOverlayOp =>
    buildPatchOverlayOp(
      {
        creates: [],
        updates: [{ id, changes: { data: { text: "typed" } } }],
        deleteIds: [],
      },
      { restoreIds: none },
    );

  // The residue case the measurement exists for. `merge{blockId: M}` names only
  // M, but `applyMerge` writes the previous visible line T as well (T's runs
  // gain M's). Under naming alone the two ops did not register as same-target,
  // so a later patch on T could be confirmed by a snapshot that says nothing
  // about the merge, leave the overlay, and be clobbered when the merge replayed
  // over T. They intersect now, so the patch waits for the merge.
  test("merge names its unnamed target: a patch on the row it rewrites is same-target", () => {
    const rows = [
      mk("T", null, a, { runs: [{ text: "T" }] }),
      mk("M", null, after(a), { runs: [{ text: "M" }] }),
    ];
    const merge = expectOpVars(
      predictOp({ kind: "merge", blockId: "M" }, rows).vars,
    );

    expect([...merge.targets].sort()).toEqual(["M", "T"]);
    expect(sameOverlayTarget(merge, patchOn("T"))).toBe(true);
  });

  // The negative twin, and it is CORRECT rather than a miss. Backspace on a
  // blank line merges an EMPTY childless block: `mergeRuns(T, [])` is T's own
  // runs, so the reducer writes T byte-identically and adopts nothing. The
  // merge's replay therefore cannot clobber a patch on T — there is nothing for
  // it to clobber — so T legitimately stays out of the set and the patch is free
  // to leave.
  test("an EMPTY childless merge writes its target byte-identically, so it is not a target", () => {
    const rows = [
      mk("T", null, a, { runs: [{ text: "T" }] }),
      mk("M", null, after(a), { runs: [] }),
    ];
    const merge = expectOpVars(
      predictOp({ kind: "merge", blockId: "M" }, rows).vars,
    );

    expect([...merge.targets]).toEqual(["M"]);
    expect(sameOverlayTarget(merge, patchOn("T"))).toBe(false);
  });

  test("split names the children the tail adopts", () => {
    // P is expanded with visible children, so `applySplit` reparents both onto
    // the tail — rows the op names nowhere.
    const rows = [
      mk("P", null, a, { runs: [{ text: "parent" }], expanded: true }),
      mk("C1", "P", a, { expanded: true }),
      mk("C2", "P", after(a), { expanded: true }),
    ];
    const split = expectOpVars(
      predictOp(
        { kind: "split", blockId: "P", position: 3, newId: "NEW" },
        rows,
      ).vars,
    );
    expect([...split.targets].sort()).toEqual(["C1", "C2", "NEW", "P"]);
  });

  test("delete names the subtree it cascades, not only its roots", () => {
    const rows = [
      mk("P", null, a, { expanded: true }),
      mk("C", "P", a, { expanded: true }),
      mk("G", "C", a, { expanded: true }),
    ];
    const del = expectOpVars(
      predictOp({ kind: "delete", blockIds: ["P"] }, rows).vars,
    );
    expect([...del.targets].sort()).toEqual(["C", "G", "P"]);
    // The EFFECT stays the named root: one transaction removes the subtree, so
    // the root's absence already implies its descendants'.
    expect(del.effect).toEqual({ kind: "remove", ids: ["P"] });
  });

  // Why the union is a union and not the measured diff. In each of these the
  // reducer writes FEWER rows than the op names, so a diff-only set would drop
  // the origin — re-opening exactly the hole the measurement closes, since a
  // later patch on that origin would stop being blocked.
  test("the union is monotone: a row the reducer left byte-identical is still a target", () => {
    // Identity split (Enter at offset 0 with a tail): the origin is returned
    // untouched and only the empty sibling above it is minted.
    const one = [mk("A", null, a, { runs: [{ text: "abc" }] })];
    const identity = predictOp(
      { kind: "split", blockId: "A", position: 0, newId: "NEW" },
      one,
    );
    expect(identity.written).toEqual(["NEW"]);
    expect(expectOpVars(identity.vars).targets.has("A")).toBe(true);

    // End-of-line split against a caught-up projection: `withRuns` rewrites the
    // origin's `data.text` to the very value it already held.
    const endSplit = predictOp(
      { kind: "split", blockId: "A", position: 3, newId: "NEW" },
      one,
    );
    expect(endSplit.written).toEqual(["NEW"]);
    expect(expectOpVars(endSplit.vars).targets.has("A")).toBe(true);

    // A partially-refused indent: "A" is a first child of the top level, so the
    // reducer refuses it, while "C" indents under "B".
    const three = [
      mk("A", null, a, { expanded: true }),
      mk("B", null, after(a), { expanded: true }),
      mk("C", null, after(after(a)), { expanded: true }),
    ];
    const indent = predictOp({ kind: "indent", blockIds: ["A", "C"] }, three);
    expect(indent.written).toEqual(["C"]);
    expect([...expectOpVars(indent.vars).targets].sort()).toEqual(["A", "C"]);
  });

  // Two different questions about one paste, asserted together so a later reader
  // cannot conflate them. `targets` is "which rows does this op write" and must
  // name the whole forest (a patch on any pasted row has to block against it);
  // `effect.create.ids` is "what proves this op landed" and stays ROOTS-ONLY,
  // because the forest lands in one transaction so a root's presence implies its
  // descendants'.
  test("paste names its whole forest in targets while its effect stays roots-only", () => {
    const rows = [mk("A", null, a)];
    const paste = expectOpVars(
      predictOp(
        {
          kind: "paste",
          afterId: "A",
          forest: [
            {
              id: "R",
              type: "text",
              data: { text: [] },
              expanded: true,
              children: [
                {
                  id: "R1",
                  type: "text",
                  data: { text: [] },
                  expanded: true,
                  children: [
                    {
                      id: "R1a",
                      type: "text",
                      data: { text: [] },
                      expanded: true,
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        rows,
      ).vars,
    );
    expect([...paste.targets].sort()).toEqual(["R", "R1", "R1a"]);
    expect(paste.effect).toEqual({ kind: "create", ids: ["R"] });
  });

  // A splice's effect is the rows it CREATED, measured off the reducer: the
  // leading paragraph it absorbed into the origin is named on the op but never
  // becomes a row, so listing it would make the op unconfirmable; the tail is
  // listed only when one was minted. Its targets still carry the origin (whose
  // text it rewrites) and the child the landing line adopts.
  test("splice: effect = the created roots (never the absorbed head); targets = origin + adopted + forest", () => {
    const ctx = { defaultTextType: "text" };
    const para = (id: string, text: string) => ({
      id,
      type: "text",
      data: { text: [{ text }] },
      expanded: true,
      children: [],
    });
    const rows = [
      mk("A", null, a, { runs: [{ text: "foobar" }], expanded: true }),
      mk("K", "A", a),
    ];
    const absorbed = expectOpVars(
      predictOp(
        {
          kind: "splice",
          blockId: "A",
          position: 3,
          runs: [{ text: "foobar" }],
          forest: [para("P1", "a"), para("P2", "b")],
          granularity: "text",
          tailId: "TAIL",
        },
        rows,
        ctx,
      ).vars,
    );
    expect(absorbed.effect).toEqual({ kind: "create", ids: ["P2"] });
    expect(absorbed.targets.has("A")).toBe(true);
    expect(absorbed.targets.has("K")).toBe(true);
    expect(absorbed.targets.has("P2")).toBe(true);

    const tailed = expectOpVars(
      predictOp(
        {
          kind: "splice",
          blockId: "A",
          position: 3,
          runs: [{ text: "foobar" }],
          forest: [para("P1", "a"), { ...para("H", "h"), type: "heading" }],
          granularity: "text",
          tailId: "TAIL",
        },
        rows,
        ctx,
      ).vars,
    );
    expect(tailed.effect).toEqual({ kind: "create", ids: ["H", "TAIL"] });
    // Not reflected before the server lands it; reflected once both rows exist.
    expect(isReflected(rows, tailed.effect)).toBe(false);
    expect(
      isReflected(
        [...rows, mk("H", null, after(a)), mk("TAIL", null, after(after(a)))],
        tailed.effect,
      ),
    ).toBe(true);
  });
});
