import { describe, expect, test } from "bun:test";
import type { Block, BlockUpdate } from "@plugins/page/plugins/editor/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { MarkdownApplyPlan, MarkdownTextEdit } from "./plan";
import { planWriteCount, subtractNoise } from "./subtract-noise";

// Plans are built by hand here rather than planned from documents: the
// subtraction is a pure comparison of two plans and knows nothing about how
// either was produced, so a fixture that went through the planner would only
// hide which write is being tested behind a markdown document.

function block(id: string, data: unknown): Block {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id,
    pageId: "page-1",
    parentId: "page-1",
    type: "text",
    data,
    rank: Rank.from("a0"),
    expanded: true,
    createdAt: at,
    updatedAt: at,
  };
}

function plan(parts: {
  creates?: Block[];
  updates?: BlockUpdate[];
  deleteIds?: string[];
  textEdits?: MarkdownTextEdit[];
  survived?: number;
}): MarkdownApplyPlan {
  const creates = parts.creates ?? [];
  const updates = parts.updates ?? [];
  const deleteIds = parts.deleteIds ?? [];
  const textEdits = parts.textEdits ?? [];
  return {
    patch: { creates, updates, deleteIds },
    textEdits,
    stats: {
      survived: parts.survived ?? 0,
      created: creates.length,
      deleted: deleteIds.length,
      moved: updates.filter(
        (u) => u.changes.parentId !== undefined || u.changes.rank !== undefined,
      ).length,
    },
  };
}

const runs = (text: string) => [{ text }];

describe("subtractNoise: a write the round trip makes too is not the caller's", () => {
  test("an identical update is dropped", () => {
    const update: BlockUpdate = {
      id: "b1",
      ofType: "text",
      changes: { parentId: "b0" },
    };
    const out = subtractNoise(
      plan({ updates: [update] }),
      plan({
        updates: [{ id: "b1", ofType: "text", changes: { parentId: "b0" } }],
      }),
    );
    expect(out.patch.updates).toEqual([]);
  });

  test("an identical rank write is dropped, Rank being a value object", () => {
    const out = subtractNoise(
      plan({
        updates: [
          { id: "b1", ofType: "text", changes: { rank: Rank.from("a1") } },
        ],
      }),
      plan({
        updates: [
          { id: "b1", ofType: "text", changes: { rank: Rank.from("a1") } },
        ],
      }),
    );
    expect(out.patch.updates).toEqual([]);
  });

  test("an identical delete is dropped", () => {
    const out = subtractNoise(
      plan({ deleteIds: ["b1", "b2"] }),
      plan({ deleteIds: ["b1"] }),
    );
    expect(out.patch.deleteIds).toEqual(["b2"]);
  });

  test("an identical text edit is dropped", () => {
    const out = subtractNoise(
      plan({ textEdits: [{ blockId: "b1", runs: runs("hello") }] }),
      plan({ textEdits: [{ blockId: "b1", runs: runs("hello") }] }),
    );
    expect(out.textEdits).toEqual([]);
  });

  test("an update whose data differs only in key order is dropped", () => {
    const out = subtractNoise(
      plan({
        updates: [
          { id: "b1", ofType: "text", changes: { data: { a: 1, b: 2 } } },
        ],
      }),
      plan({
        updates: [
          { id: "b1", ofType: "text", changes: { data: { b: 2, a: 1 } } },
        ],
      }),
    );
    expect(out.patch.updates).toEqual([]);
  });
});

describe("subtractNoise: a real edit on a block the round trip also touched survives", () => {
  test("same block, different data", () => {
    const update: BlockUpdate = {
      id: "b1",
      ofType: "text",
      changes: { data: { text: "new" } },
    };
    const out = subtractNoise(
      plan({ updates: [update] }),
      plan({
        updates: [
          { id: "b1", ofType: "text", changes: { data: { text: "old" } } },
        ],
      }),
    );
    expect(out.patch.updates).toEqual([update]);
  });

  test("same block, different rank", () => {
    const update: BlockUpdate = {
      id: "b1",
      ofType: "text",
      changes: { rank: Rank.from("a2") },
    };
    const out = subtractNoise(
      plan({ updates: [update] }),
      plan({
        updates: [
          { id: "b1", ofType: "text", changes: { rank: Rank.from("a1") } },
        ],
      }),
    );
    expect(out.patch.updates).toEqual([update]);
  });

  test("same block, one MORE field named", () => {
    // Presence is what "this patch writes that column" means, so a write naming
    // `type` as well is a different write however `parentId` compares.
    const update: BlockUpdate = {
      id: "b1",
      ofType: "text",
      changes: { parentId: "b0", type: "heading-1" },
    };
    const out = subtractNoise(
      plan({ updates: [update] }),
      plan({
        updates: [{ id: "b1", ofType: "text", changes: { parentId: "b0" } }],
      }),
    );
    expect(out.patch.updates).toEqual([update]);
  });

  test("same change set, different block", () => {
    const update: BlockUpdate = {
      id: "b2",
      ofType: "text",
      changes: { parentId: "b0" },
    };
    const out = subtractNoise(
      plan({ updates: [update] }),
      plan({
        updates: [{ id: "b1", ofType: "text", changes: { parentId: "b0" } }],
      }),
    );
    expect(out.patch.updates).toEqual([update]);
  });

  test("same block, different text", () => {
    const edit: MarkdownTextEdit = { blockId: "b1", runs: runs("edited") };
    const out = subtractNoise(
      plan({ textEdits: [edit] }),
      plan({ textEdits: [{ blockId: "b1", runs: runs("original") }] }),
    );
    expect(out.textEdits).toEqual([edit]);
  });

  test("two identical writes cancel against one, not both", () => {
    // A multiset difference: two writes that happen to be identical are still
    // two writes, and one occurrence in the noise plan cancels one of them.
    const update: BlockUpdate = {
      id: "b1",
      ofType: "text",
      changes: { parentId: "b0" },
    };
    const out = subtractNoise(
      plan({ updates: [update, { ...update }] }),
      plan({ updates: [{ ...update }] }),
    );
    expect(out.patch.updates).toHaveLength(1);
  });
});

describe("subtractNoise: creates are never subtracted", () => {
  test("a create survives even a byte-identical one in the noise plan", () => {
    // Each planning pass mints fresh ids and a fresh timestamp, so two passes'
    // creates are not comparable at all — and a create in the noise plan would
    // mean the READ invented a block, which must be refused loudly downstream
    // rather than quietly absorbed here.
    const created = block("b9", { text: [] });
    const out = subtractNoise(
      plan({ creates: [created] }),
      plan({ creates: [block("b9", { text: [] })] }),
    );
    expect(out.patch.creates).toEqual([created]);
    expect(out.stats.created).toBe(1);
  });
});

describe("subtractNoise: stats describe what survives", () => {
  test("counts are recomputed off the surviving writes", () => {
    const out = subtractNoise(
      plan({
        creates: [block("b9", {})],
        updates: [
          { id: "b1", ofType: "text", changes: { rank: Rank.from("a1") } },
          { id: "b2", ofType: "text", changes: { parentId: "b0" } },
          { id: "b3", ofType: "text", changes: { data: { text: "kept" } } },
        ],
        deleteIds: ["b4", "b5"],
        textEdits: [{ blockId: "b6", runs: runs("kept") }],
        survived: 7,
      }),
      plan({
        updates: [
          { id: "b1", ofType: "text", changes: { rank: Rank.from("a1") } },
        ],
        deleteIds: ["b4"],
      }),
    );

    expect(out.patch.updates.map((u) => u.id)).toEqual(["b2", "b3"]);
    expect(out.patch.deleteIds).toEqual(["b5"]);
    expect(out.stats).toEqual({
      // A dropped write does not un-survive the row it named: `survived` counts
      // rows that kept their identity, which the alignment decided.
      survived: 7,
      created: 1,
      deleted: 1,
      // Only `b2` still moves — `b1`'s rank write was the round trip's.
      moved: 1,
    });
  });

  test("the absorbed count is the difference in write count", () => {
    const full = plan({
      updates: [
        { id: "b1", ofType: "text", changes: { parentId: "b0" } },
        { id: "b2", ofType: "text", changes: { parentId: "b0" } },
      ],
      deleteIds: ["b3"],
      textEdits: [{ blockId: "b4", runs: runs("noise") }],
      creates: [block("b9", {})],
    });
    const out = subtractNoise(
      full,
      plan({
        updates: [{ id: "b1", ofType: "text", changes: { parentId: "b0" } }],
        textEdits: [{ blockId: "b4", runs: runs("noise") }],
      }),
    );
    expect(planWriteCount(full)).toBe(5);
    expect(planWriteCount(out)).toBe(3);
  });

  test("an empty noise plan changes nothing", () => {
    const full = plan({
      updates: [{ id: "b1", ofType: "text", changes: { parentId: "b0" } }],
      deleteIds: ["b2"],
      textEdits: [{ blockId: "b3", runs: runs("x") }],
      survived: 4,
    });
    expect(subtractNoise(full, plan({}))).toEqual(full);
  });
});
