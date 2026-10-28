import { describe, test, expect } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  BlockPatchSchema,
  changedFields,
  diffBlocks,
  isEmptyPatch,
  namesField,
  patchesFromDiff,
  writtenIds,
} from "./block-diff";
import type { Block } from "./schemas";

const r = (i: number) => Rank.from(String.fromCharCode(97 + i));

function mk(id: string, over: Partial<Block> = {}): Block {
  return {
    id,
    pageId: "P",
    parentId: null,
    type: "text",
    data: { text: [] },
    rank: r(0),
    expanded: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

describe("changedFields", () => {
  test("names ONLY the fields that differ", () => {
    const before = mk("A");
    expect(changedFields(before, before)).toEqual({});
    expect(
      Object.keys(changedFields(before, mk("A", { type: "callout" }))),
    ).toEqual(["type"]);
    expect(
      Object.keys(
        changedFields(before, mk("A", { data: { text: [{ text: "hi" }] } })),
      ),
    ).toEqual(["data"]);
    expect(
      Object.keys(changedFields(before, mk("A", { expanded: false }))),
    ).toEqual(["expanded"]);
  });

  test("a falsy/null write is still a named field (presence, not truthiness)", () => {
    const changes = changedFields(
      mk("A", { parentId: "X" }),
      mk("A", { parentId: null }),
    );
    expect(namesField(changes, "parentId")).toBe(true);
    expect(changes.parentId).toBe(null);
  });

  test("compares rank by stored value, not instance identity", () => {
    expect(
      changedFields(
        mk("A", { rank: Rank.from("m") }),
        mk("A", { rank: Rank.from("m") }),
      ),
    ).toEqual({});
  });
});

describe("diffBlocks", () => {
  test("detects insert / update / delete by id", () => {
    const before = [mk("A"), mk("B", { type: "heading" })];
    const after = [
      mk("A", { parentId: "X" }), // updated (parent changed)
      mk("C"), // inserted
    ]; // B deleted

    const d = diffBlocks(before, after);
    expect(d.inserted.map((b) => b.id)).toEqual(["C"]);
    expect(d.updated.map((u) => u.after.id)).toEqual(["A"]);
    expect(d.updated[0]!.changes).toEqual({ parentId: "X" });
    expect(d.deletedIds).toEqual(["B"]);
    expect(d.deleted.map((b) => b.id)).toEqual(["B"]);
  });

  test("no change yields an empty diff and empty patches", () => {
    const rows = [mk("A"), mk("B")];
    const d = diffBlocks(rows, rows);
    const { undo, redo } = patchesFromDiff(d);
    expect(isEmptyPatch(undo)).toBe(true);
    expect(isEmptyPatch(redo)).toBe(true);
  });

  test("ignores rank instance identity, compares by serialized value", () => {
    const before = [mk("A", { rank: Rank.from("m") })];
    const after = [mk("A", { rank: Rank.from("m") })]; // same value, different instance
    expect(diffBlocks(before, after).updated.length).toBe(0);
  });
});

describe("writtenIds", () => {
  // THE test of this function. A `Block`'s `rank` is a `Rank` INSTANCE, and the
  // overlay's `fromNodes` mints a FRESH one per row on every reducer run — so an
  // identity comparison here would report every row of an op's output as
  // written. `targets` would then be "every row on the page" for every op, and
  // the overlay's `sameTarget` relation would collapse into a tautology in which
  // every op blocks every other one. Comparing the stored value is what keeps
  // the relation meaningful.
  test("a fresh Rank instance per row is NOT a write (the tautology trap)", () => {
    const rows = [
      mk("A", { rank: r(0) }),
      mk("B", { rank: r(1) }),
      mk("C", { rank: r(2) }),
    ];
    const reminted = rows.map((row) => ({
      ...row,
      rank: Rank.from(String(row.rank)),
    }));
    // Every rank is a different object; not one of them is a different VALUE.
    expect(reminted.every((row, i) => row.rank !== rows[i]!.rank)).toBe(true);
    expect(writtenIds(rows, reminted)).toEqual([]);
  });

  test("inserted ∪ changed ∪ deleted, in one before/after pair", () => {
    const before = [mk("KEEP"), mk("CHANGED"), mk("GONE")];
    const after = [mk("KEEP"), mk("CHANGED", { type: "heading" }), mk("NEW")];
    expect(writtenIds(before, after).sort()).toEqual([
      "CHANGED",
      "GONE",
      "NEW",
    ]);
  });

  test("a row present on both sides with no column changed is not written", () => {
    const rows = [mk("A"), mk("B")];
    expect(writtenIds(rows, rows)).toEqual([]);
    // …and the row order between the two sides is irrelevant (matching is by id).
    expect(writtenIds(rows, [rows[1]!, rows[0]!])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One definition of "changed".
//
// `writtenIds` and `changedFields` read the same private per-column table, and
// this is the backstop for that: the ids one reports and the field set the other
// reports must agree on every pair of rows, or the overlay's target set and the
// patch it dispatches would be derived from two different notions of a write —
// most easily on `data`, whose comparison is a deep walk rather than `!==`.
// ---------------------------------------------------------------------------

// Deterministic PRNG (mulberry32) so a fuzz failure is reproducible from its
// seed. Same generator as `block-ops.test.ts`.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random row of id `A`, varying every persisted column (nested `data` included). */
function fuzzRow(rand: () => number): Block {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const datas: unknown[] = [
    { text: [] },
    { text: [{ text: "hi" }] },
    { text: [{ text: "hi", marks: ["bold"] }] },
    { text: [{ text: "hi" }, { text: "there" }] },
    { text: [{ text: "there" }, { text: "hi" }] }, // same runs, other order
    { text: "hi" }, // the legacy string projection
    { checked: true, text: [] },
    { checked: false, text: [] },
    { text: [], icon: { color: "red", nodes: [{ tag: "path" }] } },
    { text: [], icon: { nodes: [{ tag: "path" }], color: "red" } }, // key order only
    { text: [], meta: null },
    {},
    null,
  ];
  return mk("A", {
    parentId: pick([null, "P1", "P2"]),
    type: pick(["text", "heading", "callout"]),
    rank: pick([r(0), r(1), r(2)]),
    expanded: pick([true, false]),
    data: pick(datas),
  });
}

describe("writtenIds ⟺ changedFields", () => {
  test("a row is written iff some field changed (~2000 fuzzed pairs)", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rand = rng(seed);
      const before = fuzzRow(rand);
      const after = fuzzRow(rand);
      const written = writtenIds([before], [after]).length > 0;
      const changed = Object.keys(changedFields(before, after)).length > 0;
      if (written !== changed) {
        throw new Error(
          `seed ${seed}: writtenIds says ${written}, changedFields says ${changed}\n` +
            `before=${JSON.stringify(before.data)} after=${JSON.stringify(after.data)}`,
        );
      }
    }
  });
});

describe("patchesFromDiff", () => {
  // THE reason this shape exists: a writer that changes one field must not
  // author the others. The projection writing `data.text` while a conversion
  // is in flight used to restate `type` and undo the user's conversion.
  test("a single-field change emits ONLY that field, in both directions", () => {
    const before = [mk("A", { type: "callout", data: { text: [] } })];
    const after = [
      mk("A", { type: "callout", data: { text: [{ text: "hi" }] } }),
    ];
    const { redo, undo } = patchesFromDiff(diffBlocks(before, after));

    expect(redo.creates).toEqual([]);
    expect(redo.deleteIds).toEqual([]);
    expect(redo.updates).toEqual([
      { id: "A", changes: { data: { text: [{ text: "hi" }] } } },
    ]);
    // The undo inverts EXACTLY the same field set — never the whole row, so it
    // cannot restate `type` either.
    expect(undo.updates).toEqual([
      { id: "A", changes: { data: { text: [] } } },
    ]);
    expect(Object.keys(undo.updates[0]!.changes)).toEqual(["data"]);
  });

  test("a multi-field change inverts each named field to its before value", () => {
    const before = [mk("A", { type: "text", expanded: true, rank: r(1) })];
    const after = [mk("A", { type: "toggle", expanded: false, rank: r(1) })];
    const { redo, undo } = patchesFromDiff(diffBlocks(before, after));

    expect(redo.updates[0]!.changes).toEqual({
      type: "toggle",
      expanded: false,
    });
    expect(undo.updates[0]!.changes).toEqual({ type: "text", expanded: true });
    // `rank` never changed, so neither direction claims it.
    expect(namesField(undo.updates[0]!.changes, "rank")).toBe(false);
  });

  test("insert ⇒ redo creates the full row, undo deletes it", () => {
    const before = [mk("A")];
    const after = [mk("A"), mk("B")]; // inserted B
    const { redo, undo } = patchesFromDiff(diffBlocks(before, after));

    expect(redo.creates.map((b) => b.id)).toEqual(["B"]);
    expect(redo.updates).toEqual([]);
    expect(redo.deleteIds).toEqual([]);
    expect(undo.deleteIds).toEqual(["B"]);
    expect(undo.creates).toEqual([]);
  });

  test("delete ⇒ undo re-creates the deleted row as a FULL row (no prior state to merge onto)", () => {
    const before = [mk("A"), mk("B", { type: "quote" })];
    const after = [mk("A")]; // B deleted
    const { redo, undo } = patchesFromDiff(diffBlocks(before, after));

    expect(redo.deleteIds).toEqual(["B"]);
    expect(redo.creates).toEqual([]);
    expect(undo.creates.map((b) => b.id)).toEqual(["B"]);
    expect(undo.creates[0]!.type).toBe("quote");
    expect(undo.deleteIds).toEqual([]);
  });

  test("create/delete round-trip: redo∘undo returns the original rows", () => {
    const before = [mk("A"), mk("B", { type: "quote", rank: r(1) })];
    const after = [mk("A", { type: "heading" }), mk("C", { rank: r(2) })];
    const { redo, undo } = patchesFromDiff(diffBlocks(before, after));

    // Forward: create C, retype A, delete B.
    expect(redo.creates.map((b) => b.id)).toEqual(["C"]);
    expect(redo.updates).toEqual([{ id: "A", changes: { type: "heading" } }]);
    expect(redo.deleteIds).toEqual(["B"]);
    // Reverse: re-create B, retype A back, delete C.
    expect(undo.creates.map((b) => b.id)).toEqual(["B"]);
    expect(undo.updates).toEqual([{ id: "A", changes: { type: "text" } }]);
    expect(undo.deleteIds).toEqual(["C"]);
  });
});

describe("BlockPatchSchema", () => {
  test("round-trips a field-scoped update over the wire, keeping absent fields absent", () => {
    const wire = JSON.parse(
      JSON.stringify({
        creates: [],
        updates: [{ id: "A", changes: { data: { text: [{ text: "hi" }] } } }],
        deleteIds: [],
      }),
    ) as unknown;
    const parsed = BlockPatchSchema.parse(wire);
    const changes = parsed.updates[0]!.changes;
    expect(namesField(changes, "data")).toBe(true);
    // The keys the patch did NOT name must not materialize as `undefined`
    // entries — presence IS the authority claim the server reads.
    expect(namesField(changes, "type")).toBe(false);
    expect(namesField(changes, "parentId")).toBe(false);
    expect(namesField(changes, "rank")).toBe(false);
    expect(namesField(changes, "expanded")).toBe(false);
  });

  test("an update that says nothing about data does not name it", () => {
    // A move/fold/rank write must never read as `data = undefined`: zod 4
    // writes an absent bare `z.unknown()` key as an own `undefined` key.
    const parsed = BlockPatchSchema.parse({
      creates: [],
      updates: [{ id: "A", changes: { type: "x" } }],
      deleteIds: [],
    });
    expect(namesField(parsed.updates[0]!.changes, "data")).toBe(false);
  });

  test("decodes a rank change back into a Rank instance", () => {
    const parsed = BlockPatchSchema.parse(
      JSON.parse(
        JSON.stringify({
          creates: [],
          updates: [{ id: "A", changes: { rank: r(3), parentId: null } }],
          deleteIds: [],
        }),
      ),
    );
    expect(String(parsed.updates[0]!.changes.rank)).toBe(String(r(3)));
    expect(namesField(parsed.updates[0]!.changes, "parentId")).toBe(true);
  });
});
