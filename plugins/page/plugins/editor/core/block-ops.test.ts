/**
 * Pure unit tests for the block-tree reducer (`applyBlockOp`).
 * Run with `bun test plugins/page/plugins/editor/`.
 *
 * The server only diffs + persists; all tree/rank math lives here. These tests
 * exercise the load-bearing invariants (Notion-style outdent reparenting, split
 * as-child, merge child adoption, subtree delete, move cycle guard) plus the
 * structural invariants every op must hold: strictly-ascending rank ordering
 * per parent, pageId never changes for a surviving node, and the input array is
 * never mutated.
 */

import { test, expect, describe } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { selectionRoots } from "@plugins/primitives/plugins/tree/core";
import { PAGE_BLOCK_TYPE } from "./schemas";
import {
  applyBlockOp,
  applyBulkMove,
  blockOpContextOf,
  canIndent,
  canOutdent,
  childrenOf,
  pasteAnchorId,
  planBulkMove,
  planSplice,
  blockSelectionRoots,
  withContainersSelected,
  prevVisibleLine,
  nextVisibleLine,
  visibleChildrenOf,
  collapsedAnchorAbove,
  runsOfNode,
  textOf,
  type BlockNode,
  type BlockOp,
  type BlockOpContext,
  type IsAnchor,
} from "./block-ops";
import {
  coalesce,
  mergeRuns,
  runsLength,
  splitRuns,
  type RichText,
} from "./rich-text";
import {
  withMintedIds,
  type IdentifiedBlock,
  type SerializedBlock,
} from "./serialized-block";

// ---------------------------------------------------------------------------
// Test factory + invariant helpers
// ---------------------------------------------------------------------------

/**
 * Build a `BlockNode`. `rank` is required and must be a fractional-indexing key
 * (use `key("a0")`, etc. — passing readable letters keeps the ordering obvious).
 */
function mk(
  id: string,
  parentId: string | null,
  rank: string,
  opts: {
    text?: string;
    expanded?: boolean;
    type?: string;
    pageId?: string | null;
  } = {},
): BlockNode {
  return {
    id,
    pageId: opts.pageId === undefined ? "page-1" : opts.pageId,
    parentId,
    type: opts.type ?? "text",
    data: { text: opts.text ?? id },
    rank,
    expanded: opts.expanded ?? false,
  };
}

/** A few stable, ascending rank keys for readable fixtures. */
const a = Rank.between(null, null).toJSON(); // first key
/** "No type is a container" — the pre-container behavior, for forests with none. */
const NO_ANCHOR: IsAnchor = () => false;
function after(prev: string): string {
  return Rank.between(Rank.from(prev), null).toJSON();
}

/** Assert ranks are strictly ascending within every parent group. */
function assertRankOrdering(blocks: BlockNode[]): void {
  const byParent = new Map<string | null, BlockNode[]>();
  for (const b of blocks) {
    const list = byParent.get(b.parentId) ?? [];
    list.push(b);
    byParent.set(b.parentId, list);
  }
  for (const list of byParent.values()) {
    const sorted = childrenOf(blocks, list[0]!.parentId);
    for (let i = 1; i < sorted.length; i++) {
      expect(
        Rank.compare(
          Rank.from(sorted[i - 1]!.rank),
          Rank.from(sorted[i]!.rank),
        ),
      ).toBe(-1);
    }
  }
}

/** pageId of every surviving node is unchanged vs the before snapshot. */
function assertPageIdInvariant(before: BlockNode[], after: BlockNode[]): void {
  const beforeById = new Map(before.map((b) => [b.id, b.pageId]));
  for (const node of after) {
    if (beforeById.has(node.id)) {
      expect(node.pageId).toBe(beforeById.get(node.id)!);
    }
  }
}

/**
 * Run an op and assert the universal invariants: input frozen + deep-equal
 * after (not mutated), rank ordering strictly ascending, pageId preserved.
 * Returns the result for op-specific assertions. `ctx` is omitted by every
 * pre-anchor case — the default is byte-identical to a context-free call.
 */
function run(
  blocks: BlockNode[],
  op: BlockOp,
  ctx?: BlockOpContext,
): BlockNode[] {
  const snapshot = structuredClone(blocks);
  Object.freeze(blocks);
  blocks.forEach((b) => Object.freeze(b));
  const result = applyBlockOp(blocks, op, ctx);
  // Input not mutated.
  expect(blocks).toEqual(snapshot);
  assertRankOrdering(result);
  assertPageIdInvariant(snapshot, result);
  return result;
}

function ids(blocks: BlockNode[], parentId: string | null): string[] {
  return childrenOf(blocks, parentId).map((b) => b.id);
}

// ---------------------------------------------------------------------------
// outdent
// ---------------------------------------------------------------------------

describe("outdent", () => {
  test("reparents the FOLLOWING siblings as its children, order preserved + expanded set", () => {
    // parent P with children C1, C2(target), C3, C4 — outdent C2.
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    const r4 = after(r3);
    const blocks = [
      mk("P", null, a),
      mk("C1", "P", r1),
      mk("C2", "P", r2, { expanded: false }),
      mk("C3", "P", r3),
      mk("C4", "P", r4),
    ];
    const out = run(blocks, { kind: "outdent", blockIds: ["C2"] });

    // C2 became a top-level sibling immediately after P.
    const c2 = out.find((b) => b.id === "C2")!;
    expect(c2.parentId).toBe(null);
    // It sits between P and (P's next sibling — none) at the top level.
    expect(ids(out, null)).toEqual(["P", "C2"]);
    // Followers C3, C4 are now C2's children, in order.
    expect(ids(out, "C2")).toEqual(["C3", "C4"]);
    // C1 stays under P.
    expect(ids(out, "P")).toEqual(["C1"]);
    // C2 forced open because it gained children.
    expect(c2.expanded).toBe(true);
  });

  test("first child with no followers: moves up, gains no children, expanded unchanged", () => {
    const r1 = a;
    const blocks = [mk("P", null, a), mk("C1", "P", r1, { expanded: false })];
    const out = run(blocks, { kind: "outdent", blockIds: ["C1"] });
    const c1 = out.find((b) => b.id === "C1")!;
    expect(c1.parentId).toBe(null);
    expect(ids(out, "C1")).toEqual([]);
    expect(c1.expanded).toBe(false);
    expect(ids(out, null)).toEqual(["P", "C1"]);
  });

  test("middle child keeps its place and adopts only the followers after it", () => {
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    const blocks = [
      mk("P", null, a),
      mk("C1", "P", r1),
      mk("C2", "P", r2),
      mk("C3", "P", r3),
    ];
    const out = run(blocks, { kind: "outdent", blockIds: ["C2"] });
    expect(ids(out, "P")).toEqual(["C1"]);
    expect(ids(out, "C2")).toEqual(["C3"]);
    expect(ids(out, null)).toEqual(["P", "C2"]);
  });

  test("appends followers AFTER the block's existing children, order preserved", () => {
    const r1 = a;
    const r2 = after(r1); // target C
    const r3 = after(r2); // follower F1
    const r4 = after(r3); // follower F2
    const k1 = a;
    const k2 = after(k1);
    const blocks = [
      mk("P", null, a),
      mk("C1", "P", r1),
      mk("C", "P", r2, { expanded: true }),
      mk("F1", "P", r3),
      mk("F2", "P", r4),
      mk("K1", "C", k1),
      mk("K2", "C", k2),
    ];
    const out = run(blocks, { kind: "outdent", blockIds: ["C"] });
    // Existing kids first, then followers in order.
    expect(ids(out, "C")).toEqual(["K1", "K2", "F1", "F2"]);
  });

  test("at top level → no-op", () => {
    const blocks = [mk("T", null, a)];
    const out = run(blocks, { kind: "outdent", blockIds: ["T"] });
    expect(out).toEqual(blocks);
  });

  test("under a page block → no-op", () => {
    const blocks = [
      mk("PG", null, a, { type: PAGE_BLOCK_TYPE }),
      mk("C", "PG", a),
    ];
    const out = run(blocks, { kind: "outdent", blockIds: ["C"] });
    expect(out).toEqual(blocks);
  });
});

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

describe("split", () => {
  test("at end with expanded children (asChild) → new block is the FIRST child", () => {
    const k1 = a;
    const blocks = [
      mk("B", null, a, { text: "hello", expanded: true }),
      mk("K1", "B", k1, { text: "child" }),
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "B",
      position: 5,
      newId: "NEW",
      asChild: true,
    });
    const b = out.find((x) => x.id === "B")!;
    const newNode = out.find((x) => x.id === "NEW")!;
    expect(textOf(b)).toBe("hello");
    expect(textOf(newNode)).toBe(""); // after-text empty (split at end)
    expect(b.expanded).toBe(true);
    expect(newNode.parentId).toBe("B");
    // NEW is the first child, before K1.
    expect(ids(out, "B")).toEqual(["NEW", "K1"]);
    expect(newNode.pageId).toBe(b.pageId);
    // A block is BORN EXPANDED — see the `expanded: true` note in `applySplit`.
    // Unobservable on a childless node, and it is what makes "collapsed is the
    // user's own act" true rather than hoped-for.
    expect(newNode.expanded).toBe(true);
  });

  // `data` belongs to a TYPE. A cross-type tail that inherited the origin's
  // payload handed the write boundary keys the target's strict schema rejects
  // (400 `Unrecognized key(s)`) — which is what a container block's
  // `splitChildWhenExpanded: {childType: "text"}` produces on every Enter.
  // Latent until a block type carried more than `{text}`: every earlier
  // cross-type split (heading → text, list → text) was between structurally
  // identical schemas.
  //
  // The fixture is a `to-do` (`{text, checked}`) — any type whose data carries
  // more than `{text}` pins the rule, which is generic and names no type.
  const dataBearing = (expanded: boolean): BlockNode => ({
    id: "C",
    pageId: "page-1",
    parentId: null,
    type: "to-do",
    data: { text: [{ text: "Heads up" }], checked: true },
    rank: a,
    expanded,
  });

  test("asChild split into a DIFFERENT type does not inherit the origin's data", () => {
    const out = run([dataBearing(true)], {
      kind: "split",
      blockId: "C",
      position: 8,
      newId: "NEW",
      asChild: true,
      childType: "text",
    });
    const newNode = out.find((x) => x.id === "NEW")!;
    expect(newNode.type).toBe("text");
    expect(Object.keys(newNode.data as object).sort()).toEqual(["text"]);
    // The origin keeps its own payload untouched.
    const origin = out.find((x) => x.id === "C")!;
    expect(origin.data).toMatchObject({ checked: true });
  });

  test("asChild split into the SAME type still inherits the origin's data", () => {
    const out = run([dataBearing(true)], {
      kind: "split",
      blockId: "C",
      position: 8,
      newId: "NEW",
      asChild: true,
    });
    const newNode = out.find((x) => x.id === "NEW")!;
    expect(newNode.type).toBe("to-do");
    expect(newNode.data).toMatchObject({ checked: true });
  });

  test("sibling split into a DIFFERENT type does not inherit the origin's data", () => {
    const out = run([dataBearing(false)], {
      kind: "split",
      blockId: "C",
      position: 8,
      newId: "NEW",
      siblingType: "text",
    });
    const newNode = out.find((x) => x.id === "NEW")!;
    expect(newNode.type).toBe("text");
    expect(Object.keys(newNode.data as object).sort()).toEqual(["text"]);
  });

  test("explicit tailData still wins over the same/cross-type rule", () => {
    const todo: BlockNode = {
      id: "T",
      pageId: "page-1",
      parentId: null,
      type: "to-do",
      data: { text: [{ text: "done thing" }], checked: true },
      rank: a,
      expanded: false,
    };
    const out = run([todo], {
      kind: "split",
      blockId: "T",
      position: 10,
      newId: "NEW",
      tailData: { text: [], checked: false },
    });
    const newNode = out.find((x) => x.id === "NEW")!;
    expect(newNode.data).toMatchObject({ checked: false });
  });

  test("mid-text → sibling carrying trailing text", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      mk("A", null, r1, { text: "helloworld" }),
      mk("B", null, r2, { text: "next" }),
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "A",
      position: 5,
      newId: "NEW",
    });
    const aNode = out.find((x) => x.id === "A")!;
    const newNode = out.find((x) => x.id === "NEW")!;
    expect(textOf(aNode)).toBe("hello");
    expect(textOf(newNode)).toBe("world");
    expect(newNode.parentId).toBe(null);
    // NEW sits between A and B.
    expect(ids(out, null)).toEqual(["A", "NEW", "B"]);
    expect(newNode.type).toBe("text");
  });

  test("no next sibling → new sibling appended at end", () => {
    const blocks = [mk("A", null, a, { text: "abcdef" })];
    const out = run(blocks, {
      kind: "split",
      blockId: "A",
      position: 3,
      newId: "NEW",
    });
    expect(ids(out, null)).toEqual(["A", "NEW"]);
    const newNode = out.find((x) => x.id === "NEW")!;
    expect(textOf(newNode)).toBe("def");
  });

  test("siblingType overrides the new sibling's type (heading → text)", () => {
    const blocks = [mk("H", null, a, { text: "Title", type: "heading-1" })];
    const out = run(blocks, {
      kind: "split",
      blockId: "H",
      position: 5,
      newId: "NEW",
      siblingType: "text",
    });
    const newNode = out.find((x) => x.id === "NEW")!;
    // The origin keeps its heading type; the new sibling becomes a body paragraph.
    expect(out.find((x) => x.id === "H")!.type).toBe("heading-1");
    expect(newNode.type).toBe("text");
  });

  test("without siblingType the new sibling keeps the original type", () => {
    const blocks = [mk("H", null, a, { text: "Title", type: "heading-1" })];
    const out = run(blocks, {
      kind: "split",
      blockId: "H",
      position: 5,
      newId: "NEW",
    });
    expect(out.find((x) => x.id === "NEW")!.type).toBe("heading-1");
  });

  // --- Visible-line adoption: the tail becomes the immediately-next visible
  // line, so an expanded parent's visible subtree moves to the tail (mirror of
  // `applyMerge`'s adoption). ---

  test("adoption: mid-text split of an expanded parent moves its visible children under the tail, ranks byte-equal", () => {
    const k1 = a;
    const k2 = after(k1);
    const blocks = [
      mk("P", null, a, { text: "helloworld", expanded: true }),
      mk("K1", "P", k1),
      mk("K2", "P", k2),
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "P",
      position: 5,
      newId: "NEW",
    });

    // Tail is the immediate next sibling of the head, at the head's own depth.
    expect(ids(out, null)).toEqual(["P", "NEW"]);

    // Head kept its text, lost every child, but DELIBERATELY keeps expanded=true
    // (a childless block renders no chevron; this also makes `prevVisibleLine`
    // of the tail resolve to the head, so merge-after-split round-trips).
    const head = out.find((b) => b.id === "P")!;
    expect(textOf(head)).toBe("hello");
    expect(ids(out, "P")).toEqual([]);
    expect(head.expanded).toBe(true);

    // Tail carries the trailing text, adopts both children IN ORDER, is expanded.
    const tail = out.find((b) => b.id === "NEW")!;
    expect(textOf(tail)).toBe("world");
    expect(ids(out, "NEW")).toEqual(["K1", "K2"]);
    expect(tail.expanded).toBe(true);

    // Rank strings preserved byte-for-byte (the whole sibling set moves together).
    expect(out.find((b) => b.id === "K1")!.rank).toBe(k1);
    expect(out.find((b) => b.id === "K2")!.rank).toBe(k2);
  });

  test("adoption: a COLLAPSED parent's children are not visible lines, so they stay with the head", () => {
    const k1 = a;
    const blocks = [
      mk("P", null, a, { text: "helloworld", expanded: false }),
      mk("K1", "P", k1),
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "P",
      position: 5,
      newId: "NEW",
    });
    expect(ids(out, "P")).toEqual(["K1"]);
    const tail = out.find((b) => b.id === "NEW")!;
    expect(ids(out, "NEW")).toEqual([]);
    expect(tail.expanded).toBe(true); // born expanded; childless, so unobservable
  });

  test("adoption predicate needs BOTH: expanded but zero children → plain sibling split", () => {
    const blocks = [mk("P", null, a, { text: "helloworld", expanded: true })];
    const out = run(blocks, {
      kind: "split",
      blockId: "P",
      position: 5,
      newId: "NEW",
    });
    expect(ids(out, null)).toEqual(["P", "NEW"]);
    const tail = out.find((b) => b.id === "NEW")!;
    expect(ids(out, "NEW")).toEqual([]);
    expect(tail.expanded).toBe(true); // born expanded; childless, so unobservable
  });

  test("identity: position-0 split of a NON-EMPTY block inserts an empty sibling ABOVE and leaves the origin untouched", () => {
    const k1 = a;
    const k2 = after(k1);
    const origin = mk("P", null, a, { text: "helloworld", expanded: true });
    const blocks = [origin, mk("K1", "P", k1), mk("K2", "P", k2)];
    const out = run(blocks, {
      kind: "split",
      blockId: "P",
      position: 0,
      newId: "NEW",
    });

    // The empty sibling is minted ABOVE the origin, at the same depth.
    expect(ids(out, null)).toEqual(["NEW", "P"]);
    const above = out.find((b) => b.id === "NEW")!;
    expect(textOf(above)).toBe("");
    expect(ids(out, "NEW")).toEqual([]); // childless
    expect(above.expanded).toBe(true); // born expanded; childless, so unobservable
    expect(above.parentId).toBe(null);
    expect(above.pageId).toBe(origin.pageId);

    // The origin is the SAME object reference, completely untouched: full text,
    // its children subtree, and its expanded state all survive.
    const head = out.find((b) => b.id === "P")!;
    expect(head).toBe(origin);
    expect(textOf(head)).toBe("helloworld");
    expect(head.expanded).toBe(true);
    expect(ids(out, "P")).toEqual(["K1", "K2"]);
  });

  test("identity: EMPTY-block position-0 split keeps the plain empty-sibling-BELOW behavior", () => {
    const blocks = [mk("P", null, a, { text: "", expanded: false })];
    const out = run(blocks, {
      kind: "split",
      blockId: "P",
      position: 0,
      newId: "NEW",
    });
    // afterRuns is empty, so the identity branch does not fire: a plain empty
    // sibling is minted BELOW, as before.
    expect(ids(out, null)).toEqual(["P", "NEW"]);
    expect(textOf(out.find((b) => b.id === "NEW")!)).toBe("");
  });

  test("identity: position-0 split honors tailData → empty UNCHECKED to-do above, origin data literally unchanged", () => {
    const origin: BlockNode = {
      id: "A",
      pageId: "page-1",
      parentId: null,
      type: "to-do",
      data: { checked: true, text: "helloworld" },
      rank: a,
      expanded: false,
    };
    const out = run([origin], {
      kind: "split",
      blockId: "A",
      position: 0,
      newId: "NEW",
      tailData: { checked: false },
    });
    // The empty sibling above inherits tailData with an empty text.
    expect(out.find((b) => b.id === "NEW")!.data).toEqual({
      checked: false,
      text: [],
    });
    // The origin keeps its data literally (still checked, full text).
    expect(out.find((b) => b.id === "A")!.data).toEqual({
      checked: true,
      text: "helloworld",
    });
  });

  test("identity: position-0 split of a FIRST child inserts a new first child under the parent", () => {
    const c1 = a;
    const c2 = after(c1);
    const blocks = [
      mk("P", null, a, { expanded: true }),
      mk("C1", "P", c1, { text: "helloworld" }),
      mk("C2", "P", c2),
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "C1",
      position: 0,
      newId: "NEW",
    });
    // NEW lands before C1 as the parent's new first child.
    expect(ids(out, "P")).toEqual(["NEW", "C1", "C2"]);
    expect(out.find((b) => b.id === "NEW")!.parentId).toBe("P");
    expect(textOf(out.find((b) => b.id === "NEW")!)).toBe("");
    expect(textOf(out.find((b) => b.id === "C1")!)).toBe("helloworld");
  });

  test("adoption + siblingType (pure-reducer combo, UI-unreachable): tail takes the type AND adopts", () => {
    const k1 = a;
    const blocks = [
      mk("P", null, a, { text: "Title", type: "heading-1", expanded: true }),
      mk("K1", "P", k1),
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "P",
      position: 5,
      newId: "NEW",
      siblingType: "text",
    });
    const tail = out.find((b) => b.id === "NEW")!;
    expect(tail.type).toBe("text");
    expect(ids(out, "NEW")).toEqual(["K1"]);
    expect(tail.expanded).toBe(true);
    // Origin keeps its heading type.
    expect(out.find((b) => b.id === "P")!.type).toBe("heading-1");
  });

  test("asChild split with expanded children is unchanged: NEW is the first child, no sibling adoption", () => {
    const k1 = a;
    const k2 = after(k1);
    const blocks = [
      mk("P", null, a, { text: "hello", expanded: true }),
      mk("K1", "P", k1),
      mk("K2", "P", k2),
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "P",
      position: 5,
      newId: "NEW",
      asChild: true,
    });
    expect(ids(out, "P")).toEqual(["NEW", "K1", "K2"]);
    expect(ids(out, "NEW")).toEqual([]);
    expect(out.find((b) => b.id === "P")!.expanded).toBe(true);
  });

  test("adoption: a sub-page (page row) child moves under the tail with its pageId unchanged, staying a leaf", () => {
    const k1 = a;
    const k2 = after(k1);
    const blocks = [
      content("P", PAGE, a, "helloworld"),
      content("K1", "P", k1),
      subPage("S1", "P", k2),
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "P",
      position: 5,
      newId: "NEW",
    });
    // Both children (including the sub-page) reparent to the tail, order preserved.
    expect(ids(out, "NEW")).toEqual(["K1", "S1"]);
    const s1 = out.find((b) => b.id === "S1")!;
    expect(s1.parentId).toBe("NEW");
    expect(s1.pageId).toBe(PAGE);
    // Page rows never gain a child.
    for (const [, kids] of pageRowChildren(out)) expect(kids).toEqual([]);
  });

  test("tailData present → tail data = tailData spread + afterRuns text; head data untouched", () => {
    const blocks: BlockNode[] = [
      {
        id: "A",
        pageId: "page-1",
        parentId: null,
        type: "to-do",
        data: { checked: true, text: "helloworld" },
        rank: a,
        expanded: false,
      },
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "A",
      position: 5,
      newId: "NEW",
      tailData: { checked: false },
    });
    // The tail gets the per-type-transformed payload; `.text` is always afterRuns.
    expect(out.find((b) => b.id === "NEW")!.data).toEqual({
      checked: false,
      text: [{ text: "world" }],
    });
    // Head keeps its own data (still checked), text truncated to the head runs.
    expect(out.find((b) => b.id === "A")!.data).toEqual({
      checked: true,
      text: [{ text: "hello" }],
    });
  });

  test("tailData absent → the tail INHERITS the origin's data (checked:true carries — today's fallback, now explicit)", () => {
    const blocks: BlockNode[] = [
      {
        id: "A",
        pageId: "page-1",
        parentId: null,
        type: "to-do",
        data: { checked: true, text: "helloworld" },
        rank: a,
        expanded: false,
      },
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "A",
      position: 5,
      newId: "NEW",
    });
    expect(out.find((b) => b.id === "NEW")!.data).toEqual({
      checked: true,
      text: [{ text: "world" }],
    });
  });
});

// ---------------------------------------------------------------------------
// prevVisibleLine
// ---------------------------------------------------------------------------

describe("prevVisibleLine", () => {
  test("descends to the deepest last expanded child of the prev sibling", () => {
    // xx (expanded) ├ yy0 └ yy1 ; zz follows xx. zz's prev visible line is yy1.
    const r1 = a;
    const r2 = after(r1);
    const k1 = a;
    const k2 = after(k1);
    const blocks = [
      mk("xx", null, r1, { expanded: true }),
      mk("zz", null, r2),
      mk("yy0", "xx", k1),
      mk("yy1", "xx", k2),
    ];
    const leaf = prevVisibleLine(
      blocks,
      blocks.find((b) => b.id === "zz")!,
    );
    expect(leaf?.id).toBe("yy1");
  });

  test("stops at a collapsed parent (its children aren't visible)", () => {
    // xx is COLLAPSED → its children are hidden, so the line is xx itself.
    const r1 = a;
    const r2 = after(r1);
    const k1 = a;
    const blocks = [
      mk("xx", null, r1, { expanded: false }),
      mk("zz", null, r2),
      mk("yy0", "xx", k1),
    ];
    const leaf = prevVisibleLine(
      blocks,
      blocks.find((b) => b.id === "zz")!,
    );
    expect(leaf?.id).toBe("xx");
  });

  test("no previous sibling → the parent (the upward branch), null at the forest root", () => {
    // P (expanded) ├ C0 (first child) └ C1 ; C0 has no prev sibling, so the
    // visible line directly above it is its parent P — not null.
    const r1 = a;
    const k1 = a;
    const k2 = after(k1);
    const blocks = [
      mk("P", null, r1, { expanded: true }),
      mk("C0", "P", k1),
      mk("C1", "P", k2),
    ];
    expect(
      prevVisibleLine(
        blocks,
        blocks.find((b) => b.id === "C0")!,
      )?.id,
    ).toBe("P");
    // A first top-level block has no parent inside the forest → null (root).
    expect(
      prevVisibleLine(
        blocks,
        blocks.find((b) => b.id === "P")!,
      ),
    ).toBe(null);
  });

  test("a lone top-level block → null", () => {
    const r1 = a;
    const blocks = [mk("first", null, r1)];
    expect(prevVisibleLine(blocks, blocks[0]!)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// nextVisibleLine — the dual of prevVisibleLine
// ---------------------------------------------------------------------------

describe("nextVisibleLine", () => {
  test("first visible child of an expanded parent", () => {
    const r1 = a;
    const r2 = after(r1);
    const k1 = a;
    const k2 = after(k1);
    const blocks = [
      mk("P", null, r1, { expanded: true }),
      mk("Q", null, r2),
      mk("C0", "P", k1),
      mk("C1", "P", k2),
    ];
    expect(
      nextVisibleLine(
        blocks,
        blocks.find((b) => b.id === "P")!,
      )?.id,
    ).toBe("C0");
  });

  test("a collapsed parent skips its subtree, landing on the next sibling", () => {
    const r1 = a;
    const r2 = after(r1);
    const k1 = a;
    const blocks = [
      mk("P", null, r1, { expanded: false }),
      mk("Q", null, r2),
      mk("C0", "P", k1),
    ];
    expect(
      nextVisibleLine(
        blocks,
        blocks.find((b) => b.id === "P")!,
      )?.id,
    ).toBe("Q");
  });

  test("an expanded-but-childless block falls through to its next sibling", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [mk("P", null, r1, { expanded: true }), mk("Q", null, r2)];
    expect(
      nextVisibleLine(
        blocks,
        blocks.find((b) => b.id === "P")!,
      )?.id,
    ).toBe("Q");
  });

  test("the next sibling of a leaf", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [mk("A", null, r1), mk("B", null, r2)];
    expect(
      nextVisibleLine(
        blocks,
        blocks.find((b) => b.id === "A")!,
      )?.id,
    ).toBe("B");
  });

  test("a last child resolves to its uncle via the upward walk", () => {
    // P (expanded) └ C (last child) ; U follows P. nextVisibleLine(C) walks up
    // past P to U.
    const r1 = a;
    const r2 = after(r1);
    const k1 = a;
    const blocks = [
      mk("P", null, r1, { expanded: true }),
      mk("U", null, r2),
      mk("C", "P", k1),
    ];
    expect(
      nextVisibleLine(
        blocks,
        blocks.find((b) => b.id === "C")!,
      )?.id,
    ).toBe("U");
  });

  test("the last visible line → null", () => {
    const r1 = a;
    const k1 = a;
    const blocks = [mk("P", null, r1, { expanded: true }), mk("C", "P", k1)];
    // C is the deepest last line; nothing follows it anywhere up the tree.
    expect(
      nextVisibleLine(
        blocks,
        blocks.find((b) => b.id === "C")!,
      ),
    ).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe("merge", () => {
  test("concatenates text into prev and adopts the block's children", () => {
    const r1 = a;
    const r2 = after(r1);
    const pk = a; // prev's existing child
    const ck1 = a; // block's children
    const ck2 = after(ck1);
    const blocks = [
      mk("PREV", null, r1, { text: "foo" }),
      mk("CUR", null, r2, { text: "bar" }),
      mk("PK", "PREV", pk, { text: "prevkid" }),
      mk("CK1", "CUR", ck1),
      mk("CK2", "CUR", ck2),
    ];
    const out = run(blocks, { kind: "merge", blockId: "CUR" });
    const prev = out.find((b) => b.id === "PREV")!;
    expect(textOf(prev)).toBe("foobar");
    expect(prev.expanded).toBe(true);
    // CUR removed.
    expect(out.find((b) => b.id === "CUR")).toBeUndefined();
    // Adopted children appended after prev's existing child, in order.
    expect(ids(out, "PREV")).toEqual(["PK", "CK1", "CK2"]);
  });

  test("merges into the previous VISIBLE leaf, not the immediate sibling", () => {
    // xx (expanded) ├ yy0 └ yy1 ; zz (with its own child zk) follows xx.
    // Backspace at zz must merge into yy1 (the last visible block), adopting
    // zz's child under yy1 — NOT into xx.
    const r1 = a;
    const r2 = after(r1);
    const k1 = a;
    const k2 = after(k1);
    const zk = a;
    const blocks = [
      mk("xx", null, r1, { text: "xx", expanded: true }),
      mk("zz", null, r2, { text: "zz", expanded: true }),
      mk("yy0", "xx", k1, { text: "yy0" }),
      mk("yy1", "xx", k2, { text: "yy1" }),
      mk("zk", "zz", zk, { text: "zk" }),
    ];
    const out = run(blocks, { kind: "merge", blockId: "zz" });
    // Text joined into yy1; xx untouched.
    expect(textOf(out.find((b) => b.id === "yy1")!)).toBe("yy1zz");
    expect(textOf(out.find((b) => b.id === "xx")!)).toBe("xx");
    // zz removed; its child zk adopted under yy1.
    expect(out.find((b) => b.id === "zz")).toBeUndefined();
    expect(ids(out, "yy1")).toEqual(["zk"]);
    // yy1 forced open because it gained a child.
    expect(out.find((b) => b.id === "yy1")!.expanded).toBe(true);
  });

  test("no prev sibling → no-op", () => {
    const blocks = [mk("ONLY", null, a, { text: "x" })];
    const out = run(blocks, { kind: "merge", blockId: "ONLY" });
    expect(out).toEqual(blocks);
  });

  test("into a parent (first child): text joins the parent, adopted grandchildren land BEFORE the merged block's former next siblings", () => {
    // P (expanded) ├ S (FIRST child, expanded, ├ G1 └ G2) └ T. Merge S — its
    // previous visible line is its PARENT P (the upward branch), NOT a sibling.
    // S's text joins into P, and S's children take S's OWN visible slot: before
    // T, never appended after it (the general adoption rule — adopted children
    // occupy the position the merged block occupied).
    const s = a;
    const t = after(s);
    const g1 = a;
    const g2 = after(g1);
    const blocks = [
      mk("P", null, a, { text: "P", expanded: true }),
      mk("S", "P", s, { text: "S", expanded: true }),
      mk("T", "P", t, { text: "T" }),
      mk("G1", "S", g1),
      mk("G2", "S", g2),
    ];
    const out = run(blocks, { kind: "merge", blockId: "S" });
    // S removed; its text merged into the parent P.
    expect(out.find((b) => b.id === "S")).toBeUndefined();
    expect(textOf(out.find((b) => b.id === "P")!)).toBe("PS");
    // Grandchildren occupy S's old slot: BEFORE T, in order (`run` already
    // asserted the minted ranks are strictly ascending, so this order IS the
    // rank order).
    expect(ids(out, "P")).toEqual(["G1", "G2", "T"]);
    // Collision-safety invariant: the adopted ranks must sort STRICTLY ABOVE the
    // merged block S's own rank. The server write applies UPDATEs (the reparented
    // grandchildren) BEFORE the DELETE of S, so S's row is still live under P when
    // the children are re-ranked; an adopted rank equal to S's would violate the
    // `(parent_id, rank)` live-unique index. Minting in `(S.rank, T.rank)` — not
    // `(null, T.rank)` — is what guarantees it.
    for (const g of ["G1", "G2"]) {
      const gr = Rank.from(out.find((b) => b.id === g)!.rank);
      expect(Rank.compare(Rank.from(s), gr)).toBe(-1); // s < g
    }
  });
});

// ---------------------------------------------------------------------------
// rich-text runs round-trip through split / merge
// ---------------------------------------------------------------------------

describe("rich-text runs", () => {
  test("split preserves marks/color on both sides, dividing the straddling run", () => {
    const runs: RichText = [
      { text: "foo", marks: ["bold"] },
      { text: "barbaz", color: "red" },
    ];
    const blocks: BlockNode[] = [
      {
        id: "A",
        pageId: "page-1",
        parentId: null,
        type: "text",
        data: { text: runs },
        rank: a,
        expanded: false,
      },
    ];
    const out = run(blocks, {
      kind: "split",
      blockId: "A",
      position: 5,
      newId: "NEW",
    });
    // "foo"(bold) + "ba"(red) | "rbaz"(red)
    expect(runsOfNode(out.find((b) => b.id === "A")!)).toEqual([
      { text: "foo", marks: ["bold"] },
      { text: "ba", color: "red" },
    ]);
    expect(runsOfNode(out.find((b) => b.id === "NEW")!)).toEqual([
      { text: "rbaz", color: "red" },
    ]);
  });

  test("op.runs authoritative payload overrides stored data", () => {
    const blocks = [mk("A", null, a, { text: "stale" })];
    const liveRuns: RichText = [{ text: "live", marks: ["italic"] }];
    const out = run(blocks, {
      kind: "split",
      blockId: "A",
      position: 2,
      newId: "NEW",
      runs: liveRuns,
    });
    expect(runsOfNode(out.find((b) => b.id === "A")!)).toEqual([
      { text: "li", marks: ["italic"] },
    ]);
    expect(runsOfNode(out.find((b) => b.id === "NEW")!)).toEqual([
      { text: "ve", marks: ["italic"] },
    ]);
  });

  test("merge concatenates runs and coalesces the seam", () => {
    const prevRuns: RichText = [{ text: "foo", marks: ["bold"] }];
    const curRuns: RichText = [{ text: "bar", marks: ["bold"] }];
    const r1 = a;
    const r2 = after(r1);
    const blocks: BlockNode[] = [
      {
        id: "PREV",
        pageId: "page-1",
        parentId: null,
        type: "text",
        data: { text: prevRuns },
        rank: r1,
        expanded: false,
      },
      {
        id: "CUR",
        pageId: "page-1",
        parentId: null,
        type: "text",
        data: { text: curRuns },
        rank: r2,
        expanded: false,
      },
    ];
    const out = run(blocks, { kind: "merge", blockId: "CUR" });
    // Same marks ⇒ one coalesced run.
    expect(runsOfNode(out.find((b) => b.id === "PREV")!)).toEqual([
      { text: "foobar", marks: ["bold"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// indent
// ---------------------------------------------------------------------------

describe("indent", () => {
  test("reparents block under its prev sibling and opens prev", () => {
    const r1 = a;
    const r2 = after(r1);
    const pk = a;
    const blocks = [
      mk("PREV", null, r1, { expanded: false }),
      mk("CUR", null, r2),
      mk("PK", "PREV", pk),
    ];
    const out = run(blocks, { kind: "indent", blockIds: ["CUR"] });
    const prev = out.find((b) => b.id === "PREV")!;
    const cur = out.find((b) => b.id === "CUR")!;
    expect(cur.parentId).toBe("PREV");
    expect(prev.expanded).toBe(true);
    // CUR appended after PREV's existing child.
    expect(ids(out, "PREV")).toEqual(["PK", "CUR"]);
    expect(ids(out, null)).toEqual(["PREV"]);
  });

  test("no prev sibling → no-op", () => {
    const blocks = [mk("FIRST", null, a)];
    const out = run(blocks, { kind: "indent", blockIds: ["FIRST"] });
    expect(out).toEqual(blocks);
  });
});

// ---------------------------------------------------------------------------
// bulk indent / outdent — a selection moves as one rigid body
// ---------------------------------------------------------------------------

/** Z, A, B, C as top-level siblings in that order. */
function fourSiblings(): BlockNode[] {
  const r1 = a;
  const r2 = after(r1);
  const r3 = after(r2);
  const r4 = after(r3);
  return [
    mk("Z", null, r1),
    mk("A", null, r2),
    mk("B", null, r3),
    mk("C", null, r4),
  ];
}

describe("bulk indent", () => {
  test("a run of siblings all nest under the block above, keeping their order", () => {
    const out = run(fourSiblings(), {
      kind: "indent",
      blockIds: ["A", "B", "C"],
    });
    expect(ids(out, null)).toEqual(["Z"]);
    expect(ids(out, "Z")).toEqual(["A", "B", "C"]);
    expect(out.find((b) => b.id === "Z")!.expanded).toBe(true);
  });

  test("order of `blockIds` is irrelevant — the fold runs in document order", () => {
    const out = run(fourSiblings(), {
      kind: "indent",
      blockIds: ["C", "A", "B"],
    });
    expect(ids(out, "Z")).toEqual(["A", "B", "C"]);
  });

  test("leading block cannot indent → the whole run holds still (never self-nests)", () => {
    // Z is first, so it has no previous sibling. A/B must NOT nest into it.
    const blocks = fourSiblings();
    const out = run(blocks, { kind: "indent", blockIds: ["Z", "A", "B"] });
    expect(out).toBe(blocks); // identity: a fully-refused op is a no-op
  });

  test("a gap in the selection still nests each root under its own prev sibling", () => {
    // Z, A, B, C — select A and C (B unselected). A → under Z; C → under B.
    const out = run(fourSiblings(), { kind: "indent", blockIds: ["A", "C"] });
    expect(ids(out, null)).toEqual(["Z", "B"]);
    expect(ids(out, "Z")).toEqual(["A"]);
    expect(ids(out, "B")).toEqual(["C"]);
  });

  test("selected blocks carry their own children along", () => {
    const blocks = [...fourSiblings(), mk("A1", "A", a)];
    const out = run(blocks, { kind: "indent", blockIds: ["A", "B"] });
    expect(ids(out, "Z")).toEqual(["A", "B"]);
    expect(ids(out, "A")).toEqual(["A1"]);
  });
});

describe("bulk outdent", () => {
  test("a run of children lifts to the parent's level, keeping their order", () => {
    const c2 = after(a);
    const c3 = after(c2);
    const blocks = [
      mk("P", null, a, { expanded: true }),
      mk("C1", "P", a),
      mk("C2", "P", c2),
      mk("C3", "P", c3),
    ];
    const out = run(blocks, { kind: "outdent", blockIds: ["C1", "C2", "C3"] });
    expect(ids(out, null)).toEqual(["P", "C1", "C2", "C3"]);
    expect(ids(out, "P")).toEqual([]);
  });

  test("an unselected follower is adopted by the LAST selected block, once", () => {
    // P > [C1, C2, X] — outdent C1+C2. Bottom-up: C2 adopts X, then C1 lifts out
    // with nothing left to adopt. (Top-down, C1 would swallow C2 as a child.)
    const c2 = after(a);
    const x = after(c2);
    const blocks = [
      mk("P", null, a, { expanded: true }),
      mk("C1", "P", a),
      mk("C2", "P", c2),
      mk("X", "P", x),
    ];
    const out = run(blocks, { kind: "outdent", blockIds: ["C1", "C2"] });
    expect(ids(out, null)).toEqual(["P", "C1", "C2"]);
    expect(ids(out, "C1")).toEqual([]);
    expect(ids(out, "C2")).toEqual(["X"]);
  });

  test("an unselected leader keeps its place; the rest lift past it", () => {
    // P > [X, C1, C2] — outdent C1+C2. X stays P's only child.
    const c1 = after(a);
    const c2 = after(c1);
    const blocks = [
      mk("P", null, a, { expanded: true }),
      mk("X", "P", a),
      mk("C1", "P", c1),
      mk("C2", "P", c2),
    ];
    const out = run(blocks, { kind: "outdent", blockIds: ["C1", "C2"] });
    expect(ids(out, null)).toEqual(["P", "C1", "C2"]);
    expect(ids(out, "P")).toEqual(["X"]);
  });

  test("top-level blocks are refused, the indented ones still lift", () => {
    const blocks = [
      mk("P", null, a, { expanded: true }),
      mk("C", "P", a),
      mk("T", null, after(a)),
    ];
    const out = run(blocks, { kind: "outdent", blockIds: ["C", "T"] });
    expect(ids(out, null)).toEqual(["P", "C", "T"]);
  });

  test("a fully-refused bulk outdent is an identity no-op", () => {
    const blocks = fourSiblings();
    const out = run(blocks, { kind: "outdent", blockIds: ["A", "B"] });
    expect(out).toBe(blocks);
  });
});

describe("canIndent / canOutdent", () => {
  test("mirror what the fold would actually do", () => {
    const blocks = fourSiblings();
    expect(canIndent(blocks, ["A", "B"])).toBe(true);
    expect(canIndent(blocks, ["Z", "A"])).toBe(false); // Z blocks the run
    expect(canOutdent(blocks, ["A", "B"])).toBe(false); // all top level
    const nested = [...blocks, mk("A1", "A", a)];
    expect(canOutdent(nested, ["A1"])).toBe(true);
    expect(canIndent(nested, ["A1"])).toBe(false); // only child
  });
});

// ---------------------------------------------------------------------------
// pasteAnchorId — the block-selection paste anchor
// ---------------------------------------------------------------------------

describe("pasteAnchorId", () => {
  test("a downward-extended run anchors on its bottom block", () => {
    expect(
      pasteAnchorId(fourSiblings(), new Set(["A", "B"]), "B", NO_ANCHOR),
    ).toBe("B");
  });

  test("an upward-extended run anchors on its bottom block too, never the head", () => {
    // Shift+ArrowUp from B leaves the range's head on A — the TOP of the run.
    // Anchoring there drops the copies between A and B, splitting the selection.
    expect(
      pasteAnchorId(fourSiblings(), new Set(["B", "A"]), "A", NO_ANCHOR),
    ).toBe("B");
  });

  test("array order is irrelevant — the anchor comes from document order", () => {
    // `selectionRoots` preserves the row array's order, which is not the forest's.
    expect(
      pasteAnchorId(
        fourSiblings().reverse(),
        new Set(["A", "B"]),
        null,
        NO_ANCHOR,
      ),
    ).toBe("B");
  });

  test("a selected parent anchors on the parent, not on its last descendant", () => {
    // An insert after A lands after A's whole subtree; after A1 it would land
    // inside it.
    const blocks = [...fourSiblings(), mk("A1", "A", a)];
    expect(pasteAnchorId(blocks, new Set(["A", "A1"]), null, NO_ANCHOR)).toBe(
      "A",
    );
  });

  test("no selection → the caret's own block, else null", () => {
    const blocks = fourSiblings();
    expect(pasteAnchorId(blocks, new Set(), "C", NO_ANCHOR)).toBe("C");
    expect(pasteAnchorId(blocks, new Set(), null, NO_ANCHOR)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

describe("insert", () => {
  test("afterId → inserts between target and its next sibling, inherits parent", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [mk("A", null, r1), mk("B", null, r2)];
    const out = run(blocks, {
      kind: "insert",
      newId: "NEW",
      type: "text",
      afterId: "A",
    });
    expect(ids(out, null)).toEqual(["A", "NEW", "B"]);
    const newNode = out.find((b) => b.id === "NEW")!;
    expect(newNode.parentId).toBe(null);
    expect(newNode.expanded).toBe(true); // born expanded; childless, so unobservable
  });

  test("beforeId → inserts between target and its previous sibling, inherits parent", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [mk("A", null, r1), mk("B", null, r2)];
    const out = run(blocks, {
      kind: "insert",
      newId: "NEW",
      type: "text",
      beforeId: "B",
    });
    expect(ids(out, null)).toEqual(["A", "NEW", "B"]);
    expect(out.find((b) => b.id === "NEW")!.parentId).toBe(null);
  });

  test("beforeId on the first sibling → becomes the new first child", () => {
    const blocks = [mk("A", "PAGE", a, { pageId: "PAGE" })];
    const out = run(blocks, {
      kind: "insert",
      newId: "NEW",
      type: "text",
      beforeId: "A",
    });
    expect(ids(out, "PAGE")).toEqual(["NEW", "A"]);
    expect(out.find((b) => b.id === "NEW")!.pageId).toBe("PAGE");
  });

  test("afterId wins over beforeId", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [mk("A", null, r1), mk("B", null, r2)];
    const out = run(blocks, {
      kind: "insert",
      newId: "NEW",
      type: "text",
      afterId: "B",
      beforeId: "A",
    });
    expect(ids(out, null)).toEqual(["A", "B", "NEW"]);
  });

  test("append under parentId → after the last child, opens parent", () => {
    const k1 = a;
    const blocks = [mk("P", null, a, { expanded: false }), mk("K1", "P", k1)];
    const out = run(blocks, {
      kind: "insert",
      newId: "NEW",
      type: "text",
      parentId: "P",
    });
    expect(ids(out, "P")).toEqual(["K1", "NEW"]);
    const parent = out.find((b) => b.id === "P")!;
    expect(parent.expanded).toBe(true);
    const newNode = out.find((b) => b.id === "NEW")!;
    expect(newNode.pageId).toBe(parent.pageId);
  });

  test("append at top level (no parent, no afterId)", () => {
    const blocks = [mk("A", null, a)];
    const out = run(blocks, { kind: "insert", newId: "NEW", type: "text" });
    expect(ids(out, null)).toEqual(["A", "NEW"]);
    expect(out.find((b) => b.id === "NEW")!.pageId).toBe(null);
  });

  test("append under the page row (excluded from the content forest) → pageId is the page id, not null", () => {
    // The reducer runs over `loadPageBlocks(pageId)` — the page's content blocks,
    // which does NOT include the page row itself. A top-level insert is parented
    // to that absent page row, so the new block's nearest page ancestor is the
    // parentId. Using `parent.pageId` (parent not found → null) hid the block
    // from the page-scoped query on reload.
    const blocks = [mk("A", "PAGE", a, { pageId: "PAGE" })];
    const out = run(blocks, {
      kind: "insert",
      newId: "NEW",
      type: "text",
      parentId: "PAGE",
    });
    expect(out.find((b) => b.id === "NEW")!.pageId).toBe("PAGE");
  });

  test("append under an in-forest sub-page node → pageId is that sub-page's id", () => {
    // A sub-page (type="page") nested inside this page IS in the forest; its
    // children are scoped to the sub-page itself (parent.id), mirroring
    // computePageId / planForestInsert.
    const blocks = [mk("SUB", null, a, { type: "page", pageId: "PAGE" })];
    const out = run(blocks, {
      kind: "insert",
      newId: "NEW",
      type: "text",
      parentId: "SUB",
    });
    expect(out.find((b) => b.id === "NEW")!.pageId).toBe("SUB");
  });
});

// ---------------------------------------------------------------------------
// paste / duplicate — the two ops sharing the forest-insert arm
// ---------------------------------------------------------------------------

/** A one-node identified forest — the ids are the caller's, never minted here. */
const node = (
  id: string,
  children: IdentifiedBlock[] = [],
  type = "text",
): IdentifiedBlock => ({ id, type, data: {}, expanded: false, children });

describe("paste", () => {
  test("afterId → the run lands between the anchor and its next sibling", () => {
    const blocks = [mk("A", null, a), mk("B", null, after(a))];
    const out = run(blocks, {
      kind: "paste",
      forest: [node("N1"), node("N2")],
      afterId: "A",
    });
    expect(ids(out, null)).toEqual(["A", "N1", "N2", "B"]);
    expect(out.find((b) => b.id === "N1")!.parentId).toBe(null);
  });

  test("the pasted ids are EXACTLY the ones handed in — never re-minted", () => {
    // The whole point of the op form: the client mints, both reducers carry. If
    // this ever re-minted, the client's overlay rows and the server's rows would
    // be different blocks and the paste could never confirm.
    const blocks = [mk("A", "PAGE", a, { pageId: "PAGE" })];
    const out = run(blocks, {
      kind: "paste",
      forest: [node("ROOT", [node("KID")])],
      afterId: "A",
    });
    expect(out.map((b) => b.id).sort()).toEqual(["A", "KID", "ROOT"]);
    expect(out.find((b) => b.id === "KID")!.parentId).toBe("ROOT");
  });

  test("descendants inherit the page scope; a pasted sub-page scopes its own", () => {
    const blocks = [mk("A", "PAGE", a, { pageId: "PAGE" })];
    const out = run(blocks, {
      kind: "paste",
      forest: [
        node("SUB", [node("KID")], PAGE_BLOCK_TYPE),
        node("PLAIN", [node("K2")]),
      ],
      afterId: "A",
    });
    expect(out.find((b) => b.id === "KID")!.pageId).toBe("SUB");
    expect(out.find((b) => b.id === "K2")!.pageId).toBe("PAGE");
  });

  test("parentId addressing: the page row (absent from the forest) is the top level", () => {
    // Same page-scope rule `insert` holds — the content forest excludes the page
    // row, so a top-level paste is parented to it and scoped by its id.
    //
    // POSITION, though, deliberately differs from `insert`: an anchorless paste
    // lands at the START of `parentId`'s children (`rankWindow(…, afterId=null)`
    // → `[null, firstSibling]`), where an anchorless `insert` APPENDS after the
    // last child. That is the paste endpoint's long-standing contract ("insert
    // after `afterId`, or at the start of `parentId`") and every real caller
    // supplies an anchor anyway — `pasteAnchorId` resolves one from the selection
    // or the caret, so the anchorless branch is only reached on an empty page.
    const blocks = [mk("A", "PAGE", a, { pageId: "PAGE" })];
    const out = run(blocks, {
      kind: "paste",
      forest: [node("N1")],
      afterId: null,
      parentId: "PAGE",
    });
    expect(ids(out, "PAGE")).toEqual(["N1", "A"]);
    expect(out.find((b) => b.id === "N1")!.pageId).toBe("PAGE");
  });

  test("pasting under a collapsed parent opens it, so the blocks are visible", () => {
    const blocks = [mk("P", null, a, { expanded: false }), mk("K", "P", a)];
    const out = run(blocks, {
      kind: "paste",
      forest: [node("N1")],
      afterId: "K",
    });
    expect(out.find((b) => b.id === "P")!.expanded).toBe(true);
  });

  test("a missing anchor refuses the whole paste rather than guessing a home", () => {
    const blocks = [mk("A", null, a)];
    const out = run(blocks, {
      kind: "paste",
      forest: [node("N1")],
      afterId: "GONE",
    });
    expect(out).toEqual(blocks);
  });

  test("an empty forest is an identity no-op", () => {
    const blocks = [mk("A", null, a)];
    expect(run(blocks, { kind: "paste", forest: [], afterId: "A" })).toEqual(
      blocks,
    );
  });
});

// ---------------------------------------------------------------------------
// duplicate
// ---------------------------------------------------------------------------

describe("duplicate", () => {
  /**
   * An id-less clone shape. Built the way the provider builds one — a
   * `SerializedBlock` handed to `withMintedIds` — rather than with hand-written
   * ids, so "the clone's ids are fresh" is a fact about the reducer's output and
   * not about the fixture's spelling.
   */
  const ser = (
    text: string,
    children: SerializedBlock[] = [],
    opts: { type?: string; expanded?: boolean } = {},
  ): SerializedBlock => ({
    type: opts.type ?? "text",
    data: { text },
    expanded: opts.expanded ?? false,
    children,
  });

  /**
   * A subtree's shape in document order: one `depth·type:text[ ▾expanded]` line
   * per node. Ids are deliberately absent — a clone's ids differ from its
   * source's by construction, so shape is the only thing the two can share, and
   * it is exactly what "cloned whole" means.
   */
  function shapeOf(blocks: BlockNode[], rootId: string, depth = 0): string[] {
    const root = blocks.find((b) => b.id === rootId)!;
    return [
      `${"·".repeat(depth)}${root.type}:${textOf(root)}${root.expanded ? " ▾" : ""}`,
      ...childrenOf(blocks, rootId).flatMap((c) =>
        shapeOf(blocks, c.id, depth + 1),
      ),
    ];
  }

  /** The whole top-level forest's shape, for comparing two runs of the same op. */
  function documentShape(blocks: BlockNode[]): string[] {
    return childrenOf(blocks, null).flatMap((b) => shapeOf(blocks, b.id));
  }

  test("one root → the clone lands right after its source, cloned whole, with fresh ids", () => {
    const blocks = [
      mk("A", null, a, { expanded: true }),
      mk("A1", "A", a, { expanded: true }),
      mk("A1a", "A1", a),
      mk("B", null, after(a)),
    ];
    const out = run(blocks, {
      kind: "duplicate",
      placements: [
        {
          afterId: "A",
          forest: withMintedIds([
            ser("A", [ser("A1", [ser("A1a")], { expanded: true })], {
              expanded: true,
            }),
          ]),
        },
      ],
    });

    // Immediately after its source, ahead of the source's next sibling.
    const top = ids(out, null);
    expect(top.length).toBe(3);
    const cloneId = top[1]!;
    expect([top[0], top[2]]).toEqual(["A", "B"]);

    // The whole subtree came across — depth, order, types, text AND `expanded`
    // (which `planForestInsert` carries per node, so a collapsed child stays
    // collapsed and an open one stays open).
    expect(shapeOf(out, cloneId)).toEqual(shapeOf(out, "A"));
    expect(out.find((b) => b.id === cloneId)!.expanded).toBe(true);

    // No id from the source subtree reappears in the clone's: every source id
    // still occurs exactly once, the three added rows are the clone's own, and
    // the whole document's ids stay unique.
    const sourceIds = ["A", "A1", "A1a", "B"];
    for (const id of sourceIds) {
      expect(out.filter((b) => b.id === id).length).toBe(1);
    }
    expect(out.length).toBe(sourceIds.length + 3);
    expect(new Set(out.map((b) => b.id)).size).toBe(out.length);
  });

  test("two ADJACENT sibling roots → A A' B B', and no two siblings share a rank", () => {
    // The case the deleted server handler only asserted in a prose comment
    // ("duplicating adjacent siblings never collides") and nothing tested. A' has
    // to fit in the TIGHT open interval (rank A, rank B) while B' takes the open
    // one after B — the one arrangement where a shared rank is even possible.
    const blocks = [mk("A", null, a), mk("B", null, after(a))];
    const cloneA = { afterId: "A", forest: withMintedIds([ser("A")]) };
    const cloneB = { afterId: "B", forest: withMintedIds([ser("B")]) };
    const out = run(blocks, {
      kind: "duplicate",
      placements: [cloneA, cloneB],
    });

    // Each clone in its OWN source's slot, not appended after the selection.
    expect(ids(out, null)).toEqual([
      "A",
      cloneA.forest[0]!.id,
      "B",
      cloneB.forest[0]!.id,
    ]);
    const ranks = childrenOf(out, null).map((b) => b.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  test("the fold is order-independent: reversing the placements changes nothing", () => {
    const blocks = [mk("A", null, a), mk("B", null, after(a))];
    // Fresh ids per call — so what the two runs share can only be structure.
    // The clone text is MARKED (a real clone's would equal its source's) purely
    // so the digest can tell a clone from its source: with both reading "A", a
    // clone landing in the wrong slot would compare equal.
    const placements = () => [
      { afterId: "A", forest: withMintedIds([ser("A*", [ser("A1*")])]) },
      { afterId: "B", forest: withMintedIds([ser("B*")]) },
    ];
    const forward = run(blocks, {
      kind: "duplicate",
      placements: placements(),
    });
    const reversed = run(blocks, {
      kind: "duplicate",
      placements: placements().reverse(),
    });

    expect(documentShape(forward)).toEqual([
      "text:A",
      "text:A*",
      "·text:A1*",
      "text:B",
      "text:B*",
    ]);
    expect(documentShape(reversed)).toEqual(documentShape(forward));
    expect(reversed.length).toBe(forward.length);
  });

  test("a placement whose anchor is gone drops ONLY its own clone", () => {
    // Deliberately unlike paste, which refuses the whole op: a placement names
    // its destination explicitly, so a dead one costs exactly its own clone.
    const blocks = [mk("A", null, a), mk("B", null, after(a))];
    const dead = { afterId: "GONE", forest: withMintedIds([ser("X")]) };
    const live = { afterId: "B", forest: withMintedIds([ser("B")]) };
    const out = run(blocks, { kind: "duplicate", placements: [dead, live] });

    expect(ids(out, null)).toEqual(["A", "B", live.forest[0]!.id]);
    expect(out.some((b) => b.id === dead.forest[0]!.id)).toBe(false);
  });

  test("a cloned type=page root scopes its own descendants, not the outer page", () => {
    // `planForestInsert`'s page rule, reached through the duplicate arm: the
    // clone of a sub-page owns its descendants' `pageId`, while the clone itself
    // stays in the page it was duplicated inside.
    const blocks = [mk("A", "PAGE", a, { pageId: "PAGE" })];
    const forest = withMintedIds([
      ser("SUB", [ser("KID", [ser("GRANDKID")])], { type: PAGE_BLOCK_TYPE }),
    ]);
    const out = run(blocks, {
      kind: "duplicate",
      placements: [{ afterId: "A", forest }],
    });

    const subId = forest[0]!.id;
    expect(out.find((b) => b.id === subId)!.pageId).toBe("PAGE");
    const kid = out.find((b) => b.parentId === subId)!;
    expect(kid.pageId).toBe(subId);
    expect(out.find((b) => b.parentId === kid.id)!.pageId).toBe(subId);
  });

  test("no placements is an identity no-op", () => {
    const blocks = [mk("A", null, a)];
    expect(run(blocks, { kind: "duplicate", placements: [] })).toEqual(blocks);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("delete", () => {
  test("removes the block and its full subtree", () => {
    const k1 = a;
    const gk = a;
    const blocks = [
      mk("ROOT", null, a),
      mk("K1", "ROOT", k1),
      mk("GK", "K1", gk),
      mk("OTHER", null, after(a)),
    ];
    const out = run(blocks, { kind: "delete", blockIds: ["ROOT"] });
    expect(out.map((b) => b.id).sort()).toEqual(["OTHER"]);
  });
});

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

describe("move", () => {
  test("in-page move sets parentId/rank and opens the new parent", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [mk("A", null, r1, { expanded: false }), mk("B", null, r2)];
    // Positional intent with no target: "after" the (empty) child list of A.
    const out = run(blocks, {
      kind: "move",
      blockId: "B",
      parentId: "A",
      targetId: null,
      zone: "after",
    });
    const b = out.find((x) => x.id === "B")!;
    expect(b.parentId).toBe("A");
    expect(out.find((x) => x.id === "A")!.expanded).toBe(true);
  });

  test("cycle guard: moving a block under its own descendant → no-op", () => {
    const k1 = a;
    const blocks = [mk("A", null, a), mk("CHILD", "A", k1)];
    // Try to move A under CHILD (its own descendant).
    const out = run(blocks, {
      kind: "move",
      blockId: "A",
      parentId: "CHILD",
      targetId: null,
      zone: "after",
    });
    expect(out).toEqual(blocks);
  });
});

// ---------------------------------------------------------------------------
// bulk move (`planBulkMove` / `applyBulkMove`)
// ---------------------------------------------------------------------------

/**
 * `bulkMove` IS a `BlockOp` (see the `bulkMove op` describe below), but its
 * planner carries the typed refusals and the `currentParentId` the server's
 * park-then-place protocol reads, so these drive it directly rather than through
 * `run()`. The invariant it exists to protect is that both sides derive the SAME
 * placements from the same forest, whatever order they happen to hold their rows
 * in.
 */
describe("planBulkMove", () => {
  /**
   * A ⊃ A1, then B, C, D at top level. Deep on purpose: a flat fixture lets a
   * same-parent rank sort masquerade as document order.
   */
  function forest(): BlockNode[] {
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    const r4 = after(r3);
    return [
      mk("A", null, r1, { expanded: true }),
      mk("A1", "A", a),
      mk("B", null, r2),
      mk("C", null, r3),
      mk("D", null, r4, { expanded: false }),
    ];
  }

  /** Deterministic shuffle, so a failure reproduces. */
  function shuffled(blocks: BlockNode[], seed: number): BlockNode[] {
    const rand = rng(seed);
    const out = [...blocks];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  test("placements are DOCUMENT-ordered, independent of the input array's order", () => {
    // The regression test for the real defect: `selectionRoots` preserves INPUT
    // array order, and the server feeds it `loadPageBlocks` — a plain select with
    // no ORDER BY, i.e. Postgres heap order, which UPDATEs rewrite. Without the
    // `inDocumentOrder` sort, which moved root gets which minted rank is
    // arbitrary and the two sides disagree.
    const selected = ["A", "B", "C"];
    const base = planBulkMove(forest(), {
      ids: selected,
      parentId: "D",
      afterId: null,
    });
    expect(base.roots).toEqual(["A", "B", "C"]);

    const rawOrders = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const rows = shuffled(forest(), seed);
      rawOrders.add(selectionRoots(rows, new Set(selected)).join(","));
      const plan = planBulkMove(rows, {
        ids: selected,
        parentId: "D",
        afterId: null,
      });
      expect(plan.placements).toEqual(base.placements);
      expect(plan.roots).toEqual(base.roots);
    }
    // Non-vacuity: the shuffles really do reach several raw `selectionRoots`
    // orders, so the equality above is the sort doing work, not the fixture
    // being accidentally stable.
    expect(rawOrders.size).toBeGreaterThan(1);
  });

  test("selecting a parent AND its child plans only the root (the child rides along)", () => {
    const plan = planBulkMove(forest(), {
      ids: ["A1", "A"],
      parentId: "D",
      afterId: null,
    });
    expect(plan.roots).toEqual(["A"]);
    expect(plan.placements.map((p) => p.id)).toEqual(["A"]);
  });

  test("placements carry the CURRENT parent (what `parkRanks` needs) and the destination", () => {
    const plan = planBulkMove(forest(), {
      ids: ["A1", "B"],
      parentId: "D",
      afterId: null,
    });
    expect(plan.roots).toEqual(["A1", "B"]);
    expect(
      plan.placements.map((p) => [p.id, p.currentParentId, p.parentId]),
    ).toEqual([
      ["A1", "A", "D"],
      ["B", null, "D"],
    ]);
    expect(plan.expandParentId).toBe("D");
    expect(plan.refusal).toBeNull();
  });

  test("refusal: an empty selection, and a selection naming only absent ids", () => {
    for (const selected of [[], ["ghost"]]) {
      const plan = planBulkMove(forest(), {
        ids: selected,
        parentId: "D",
        afterId: null,
      });
      expect(plan.refusal).toBe("empty-selection");
      expect(plan.placements).toEqual([]);
      expect(plan.roots).toEqual([]);
    }
  });

  test("refusal: dropping the selection INTO the selection", () => {
    const plan = planBulkMove(forest(), {
      ids: ["A", "B"],
      parentId: "B",
      afterId: null,
    });
    expect(plan.refusal).toBe("into-selection");
    expect(plan.placements).toEqual([]);
  });

  test("refusal: dropping a root into its OWN subtree", () => {
    // A1 is A's child and is NOT selected, so this is not `into-selection`.
    const plan = planBulkMove(forest(), {
      ids: ["A"],
      parentId: "A1",
      afterId: null,
    });
    expect(plan.refusal).toBe("into-own-subtree");
    expect(plan.placements).toEqual([]);
  });

  test("a refused plan is the identity under `applyBulkMove`", () => {
    const blocks = forest();
    const plan = planBulkMove(blocks, {
      ids: ["A", "B"],
      parentId: "B",
      afterId: null,
    });
    expect(applyBulkMove(blocks, plan)).toEqual(blocks);
  });

  test("same-parent reorder: the movers do not bound their own window", () => {
    // B, C, D are top-level siblings; move {B, D} after C. The window EXCLUDES
    // both movers, so it is ("C", null) — and B's new key can equal the rank D
    // still holds. That transient duplicate is the server's park-then-place
    // problem, not the planner's: the FINAL keys must simply be ascending and
    // land after C.
    const blocks = forest();
    const plan = planBulkMove(blocks, {
      ids: ["B", "D"],
      parentId: null,
      afterId: "C",
    });
    expect(plan.refusal).toBeNull();
    expect(plan.roots).toEqual(["B", "D"]);

    const out = applyBulkMove(blocks, plan);
    expect(ids(out, null)).toEqual(["A", "C", "B", "D"]);
    assertRankOrdering(out);
  });

  test("`destSiblings` is the rank window's source, and it can hold rows `blocks` cannot see", () => {
    // The server case: the destination is a sub-page row whose children are keyed
    // to ITS page id, so a page-scoped load does not contain them. Planning the
    // window over `blocks` would mint the first key onto that child's rank.
    const blocks = forest();
    const hidden: BlockNode[] = [
      ...blocks,
      // D's real (invisible-to-`blocks`) first child, sitting at the very first key.
      mk("HIDDEN", "D", a, { pageId: "sub-page" }),
    ];

    const blind = planBulkMove(blocks, {
      ids: ["B"],
      parentId: "D",
      afterId: null,
    });
    const seeing = planBulkMove(
      blocks,
      { ids: ["B"], parentId: "D", afterId: null },
      hidden,
    );

    // The blind plan collides head-on with the row it cannot see.
    expect(blind.placements[0]!.rank).toBe(a);
    // The window-aware plan lands strictly BEFORE it instead.
    expect(seeing.placements[0]!.rank).not.toBe(a);
    expect(
      Rank.compare(Rank.from(seeing.placements[0]!.rank), Rank.from(a)),
    ).toBe(-1);
  });

  test("plan ∘ apply: reparents every root, opens the destination, leaves the rest alone", () => {
    const blocks = forest();
    const snapshot = structuredClone(blocks);
    Object.freeze(blocks);
    blocks.forEach((b) => Object.freeze(b));

    const plan = planBulkMove(blocks, {
      ids: ["B", "C"],
      parentId: "D",
      afterId: null,
    });
    const out = applyBulkMove(blocks, plan);

    // Input untouched.
    expect(blocks).toEqual(snapshot);
    // Both roots landed under D, in document order.
    expect(ids(out, "D")).toEqual(["B", "C"]);
    expect(ids(out, null)).toEqual(["A", "D"]);
    // The destination was opened (it was collapsed).
    expect(out.find((b) => b.id === "D")!.expanded).toBe(true);
    // Untouched rows are the very same objects.
    expect(out.find((b) => b.id === "A1")).toBe(
      blocks.find((b) => b.id === "A1"),
    );
    assertRankOrdering(out);
    // `pageId` is deliberately NOT recomputed here — the server owns that.
    assertPageIdInvariant(snapshot, out);
  });

  test("a top-level drop expands nothing", () => {
    const blocks = forest();
    const plan = planBulkMove(blocks, {
      ids: ["A1"],
      parentId: null,
      afterId: "B",
    });
    expect(plan.expandParentId).toBeNull();
    const out = applyBulkMove(blocks, plan);
    expect(ids(out, null)).toEqual(["A", "B", "A1", "C", "D"]);
    expect(ids(out, "A")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The DnD / block-selection ops (`move` positional intent, `delete` sets,
// `bulkMove`) — Stage 4a: each is a real `BlockOp` on the ordered op stream.
// ---------------------------------------------------------------------------

describe("move — positional intent", () => {
  /** P ▸ [X, Y, Z] plus a top-level sibling T. */
  function forest(): BlockNode[] {
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    return [
      mk("P", null, a, { expanded: false }),
      mk("X", "P", r1),
      mk("Y", "P", r2),
      mk("Z", "P", r3),
      mk("T", null, after(a)),
    ];
  }

  /** Where each op lands `T`, read as the visible child order under P. */
  function landedOrder(op: BlockOp): string[] {
    return ids(run(forest(), op), "P");
  }

  test("the REDUCER mints the rank — the op carries no key at all", () => {
    // The whole point of Stage 4a's move: `(parentId, targetId, zone)` travels,
    // and each side resolves it against the sibling set it holds. A rank minted
    // by a caller over a projection of the one `(parent_id, rank)` space would
    // collide with the siblings it cannot see.
    const out = run(forest(), {
      kind: "move",
      blockId: "T",
      parentId: "P",
      targetId: "Y",
      zone: "after",
    });
    const t = out.find((b) => b.id === "T")!;
    expect(t.parentId).toBe("P");
    assertRankOrdering(out);
  });

  test("zone resolves against the target, both directions", () => {
    expect(
      landedOrder({
        kind: "move",
        blockId: "T",
        parentId: "P",
        targetId: "Y",
        zone: "after",
      }),
    ).toEqual(["X", "Y", "T", "Z"]);
    expect(
      landedOrder({
        kind: "move",
        blockId: "T",
        parentId: "P",
        targetId: "Y",
        zone: "before",
      }),
    ).toEqual(["X", "T", "Y", "Z"]);
    // Before the FIRST child is the list's start, not "after nothing".
    expect(
      landedOrder({
        kind: "move",
        blockId: "T",
        parentId: "P",
        targetId: "X",
        zone: "before",
      }),
    ).toEqual(["T", "X", "Y", "Z"]);
  });

  test("a null target addresses the sibling-list BOUNDARY (append / prepend)", () => {
    expect(
      landedOrder({
        kind: "move",
        blockId: "T",
        parentId: "P",
        targetId: null,
        zone: "after",
      }),
    ).toEqual(["X", "Y", "Z", "T"]);
    expect(
      landedOrder({
        kind: "move",
        blockId: "T",
        parentId: "P",
        targetId: null,
        zone: "before",
      }),
    ).toEqual(["T", "X", "Y", "Z"]);
  });

  test("a same-parent reorder does not let the mover bound its own window", () => {
    // X moving after Y must land BETWEEN Y and Z, which is only possible if X's
    // own rank is excluded from the window it is minting into.
    expect(
      landedOrder({
        kind: "move",
        blockId: "X",
        parentId: "P",
        targetId: "Y",
        zone: "after",
      }),
    ).toEqual(["Y", "X", "Z"]);
  });

  test("the destination parent is opened, as every other insert path does", () => {
    const out = run(forest(), {
      kind: "move",
      blockId: "T",
      parentId: "P",
      targetId: null,
      zone: "after",
    });
    expect(out.find((b) => b.id === "P")!.expanded).toBe(true);
  });

  test("a STALE anchor refuses the whole move rather than guessing a slot", () => {
    // The neighbour is gone, or has since moved to another parent: resolving the
    // intent against a different sibling list would drop the block somewhere the
    // user never pointed at.
    const blocks = forest();
    for (const targetId of ["ghost", "T"]) {
      const out = run(blocks, {
        kind: "move",
        blockId: "X",
        parentId: "P",
        targetId,
        zone: "after",
      });
      expect(out).toEqual(blocks);
    }
  });
});

describe("delete — a set operation", () => {
  function forest(): BlockNode[] {
    const r2 = after(a);
    const r3 = after(r2);
    return [
      mk("A", null, a),
      mk("A1", "A", a),
      mk("B", null, r2),
      mk("C", null, r3),
    ];
  }

  test("one gesture deletes every named subtree — one op, not N", () => {
    const out = run(forest(), { kind: "delete", blockIds: ["A", "C"] });
    expect(out.map((b) => b.id)).toEqual(["B"]);
  });

  test("a single Backspace-delete is simply the one-element case", () => {
    expect(
      run(forest(), { kind: "delete", blockIds: ["A"] }).map((b) => b.id),
    ).toEqual(["B", "C"]);
  });

  test("absent ids are skipped, not refused; an all-absent set is the identity", () => {
    const blocks = forest();
    expect(
      run(blocks, { kind: "delete", blockIds: ["ghost", "B"] }).map(
        (b) => b.id,
      ),
    ).toEqual(["A", "A1", "C"]);
    expect(run(blocks, { kind: "delete", blockIds: ["ghost"] })).toEqual(
      blocks,
    );
  });

  test("selecting a parent AND its child deletes each once (subtrees overlap)", () => {
    expect(
      run(forest(), { kind: "delete", blockIds: ["A", "A1"] }).map((b) => b.id),
    ).toEqual(["B", "C"]);
  });
});

describe("bulkMove op", () => {
  function forest(): BlockNode[] {
    const r2 = after(a);
    const r3 = after(r2);
    const r4 = after(r3);
    return [
      mk("A", null, a),
      mk("B", null, r2),
      mk("C", null, r3),
      mk("D", null, r4, { expanded: false }),
    ];
  }

  test("the op arm is plan ∘ apply, byte-identical to driving the planner by hand", () => {
    const blocks = forest();
    const args = { ids: ["A", "B"], parentId: "D", afterId: null };
    expect(run(blocks, { kind: "bulkMove", ...args })).toEqual(
      applyBulkMove(blocks, planBulkMove(blocks, args)),
    );
  });

  test("the selection moves as one body, in document order, opening the destination", () => {
    const out = run(forest(), {
      kind: "bulkMove",
      ids: ["A", "B"],
      parentId: "D",
      afterId: null,
    });
    expect(ids(out, "D")).toEqual(["A", "B"]);
    expect(ids(out, null)).toEqual(["C", "D"]);
    expect(out.find((b) => b.id === "D")!.expanded).toBe(true);
    assertRankOrdering(out);
  });

  test("every refusal is the IDENTITY, so a refused drag never reaches the network", () => {
    const blocks = forest();
    // into-selection, into-own-subtree, empty-selection — the three the planner
    // distinguishes. The op arm collapses all of them to "nothing happened",
    // which `dispatchOp`'s empty-diff rule then drops before dispatch.
    expect(
      run(blocks, {
        kind: "bulkMove",
        ids: ["A", "B"],
        parentId: "B",
        afterId: null,
      }),
    ).toEqual(blocks);
    expect(
      run(blocks, {
        kind: "bulkMove",
        ids: ["ghost"],
        parentId: "D",
        afterId: null,
      }),
    ).toEqual(blocks);
  });

  test("a same-parent reorder lands the run after its anchor", () => {
    const out = run(forest(), {
      kind: "bulkMove",
      ids: ["A", "B"],
      parentId: null,
      afterId: "C",
    });
    expect(ids(out, null)).toEqual(["C", "A", "B", "D"]);
    assertRankOrdering(out);
  });
});

// ---------------------------------------------------------------------------
// Container anchors (`BlockOpContext.anchorTypes`) + the `unwrap` op
// ---------------------------------------------------------------------------

/**
 * An anchor is a container that renders no line of its own — its content IS its
 * children. The reducer learns which types those are ONLY from the op context,
 * never from a type name, so the fixtures use a made-up type: if any of these
 * pass because the reducer recognised `"callout"`, the abstraction has leaked.
 */
const ANCHOR = "container";
const withAnchors: BlockOpContext = { anchorTypes: new Set([ANCHOR]) };
/** The same fact in the shape the visibility helpers take. */
const isAnchorFn: IsAnchor = (n) => n.type === ANCHOR;

/**
 * Is `node` a line the user can actually see (and therefore put a caret on)?
 *
 * DERIVED from `visibleChildrenOf` rather than re-encoding "walk up checking
 * `expanded`" — that hand-rolled version is exactly what made the original
 * duality round pass vacuously once containers arrived: it calls a collapsed
 * container's borrowed line hidden, when the borrowed line is the one thing a
 * collapsed container still shows.
 */
function isVisibleLine(
  rows: BlockNode[],
  node: BlockNode,
  isAnchor: IsAnchor = () => false,
): boolean {
  let cur = node;
  while (cur.parentId !== null) {
    const parent = rows.find((r) => r.id === cur.parentId);
    // A parent outside the row set is the forest root (the fuzz forest hangs its
    // top level off a `PAGE` sentinel that is not itself a row) — the same
    // "absent parent ⇒ top" reading `prevVisibleLine` takes.
    if (!parent) return true;
    if (!visibleChildrenOf(rows, parent, isAnchor).some((k) => k.id === cur.id))
      return false;
    cur = parent;
  }
  return true;
}

function anchorNode(
  id: string,
  parentId: string | null,
  rank: string,
): BlockNode {
  // Void payload: an anchor's schema carries appearance only, never `text`.
  return {
    ...mk(id, parentId, rank, { expanded: true, type: ANCHOR }),
    data: { color: "info" },
  };
}

function pageRow(id: string, parentId: string | null, rank: string): BlockNode {
  return {
    ...mk(id, parentId, rank, { type: PAGE_BLOCK_TYPE }),
    data: { title: id, icon: null },
  };
}

// ---------------------------------------------------------------------------
// Text-less merge targets (`BlockOpContext.textBearingTypes`)
// ---------------------------------------------------------------------------

/**
 * `anchorTypes` covers only the CONTAINER half of "carries no text". The reason
 * it gives for refusing — writing `data.text` onto a void schema is a 400 at the
 * write boundary — is exactly as true for a divider, which is not a container
 * and renders a line of its own.
 *
 * Made-up type names again: if any of these pass because the reducer recognised
 * `"divider"`, the abstraction has leaked.
 */
const VOID_LINE = "rule";
const TEXTY = "para";
const withTextTypes: BlockOpContext = {
  anchorTypes: new Set([ANCHOR]),
  textBearingTypes: new Set([TEXTY, "text"]),
};

function voidLine(
  id: string,
  parentId: string | null,
  rank: string,
): BlockNode {
  // A void row that IS a visible line — no children, no text, empty payload.
  return { ...mk(id, parentId, rank, { type: VOID_LINE }), data: {} };
}

describe("blockOpContextOf", () => {
  // The one derivation both runtimes call. Parity used to be a convention —
  // two filters, one per runtime, kept in step by hand — and this is what
  // replaced it: the registries differ, the derivation cannot.
  const handles = [
    { type: "para", acceptsText: true, anchor: undefined, defaultText: true },
    { type: "rule", acceptsText: false, anchor: undefined },
    { type: "box", acceptsText: false, anchor: true },
  ] as unknown as Parameters<typeof blockOpContextOf>[0];

  test("derives every fact from the handles' own declarations", () => {
    const ctx = blockOpContextOf(handles);
    expect([...(ctx.anchorTypes ?? [])].sort()).toEqual(["box"]);
    expect([...(ctx.textBearingTypes ?? [])].sort()).toEqual(["para"]);
    expect(ctx.defaultTextType).toBe("para");
  });

  test("no default-text handle → no plain paragraph, rather than a guessed one", () => {
    expect(blockOpContextOf([]).defaultTextType).toBeUndefined();
  });

  test("both fields are always PRESENT, so a real registry never reads as `no opinion`", () => {
    // `textBearingTypes: undefined` means "cannot resolve the registry" and
    // disables the refusal. A mint that produced it for an empty registry would
    // silently turn the guard off rather than turn it on with nothing in it.
    const ctx = blockOpContextOf([]);
    expect(ctx.anchorTypes).toBeDefined();
    expect(ctx.textBearingTypes).toBeDefined();
  });
});

describe("merge — text-less targets", () => {
  test("merge refuses a text-less NON-anchor as the resolved target", () => {
    // Backspace at the start of the line below a `/divider`. `prevVisibleLine`
    // returns the divider (it is a real visible line, unlike a container), and
    // merging into it would write `data.text` onto a schema with no `text` key.
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      voidLine("D", null, r1),
      mk("T", null, r2, { text: "below" }),
    ];
    const op: BlockOp = { kind: "merge", blockId: "T" };
    expect(run(blocks, op, withTextTypes)).toBe(blocks);
    // Same op with the fact withheld: the merge fires. The refusal comes from
    // the CONTEXT, not from a type name — and this is the behaviour every
    // context-free caller (and every pre-existing seed below) still gets.
    expect(run(blocks, op).find((b) => b.id === "T")).toBeUndefined();
  });

  test("the refusal is not blanket — a text-bearing target still merges", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      { ...mk("P", null, r1, { text: "above" }), type: TEXTY },
      mk("T", null, r2, { text: "below" }),
    ];
    const out = run(blocks, { kind: "merge", blockId: "T" }, withTextTypes);
    expect(out.find((b) => b.id === "T")).toBeUndefined();
    expect(textOf(out.find((b) => b.id === "P")!)).toBe("abovebelow");
  });

  test("an ABSENT textBearingTypes means no opinion, never `nothing accepts text`", () => {
    // The empty-set default that is right for `anchorTypes` would be
    // catastrophic here: it would refuse EVERY merge on the page. A caller that
    // cannot resolve the registry must get today's behaviour instead, with the
    // write boundary left to reject loudly.
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      mk("P", null, r1, { text: "above" }),
      mk("T", null, r2, { text: "below" }),
    ];
    const op: BlockOp = { kind: "merge", blockId: "T" };
    expect(
      run(blocks, op, { anchorTypes: new Set() }).find((b) => b.id === "T"),
    ).toBeUndefined();
    expect(run(blocks, op, {}).find((b) => b.id === "T")).toBeUndefined();
  });
});

describe("anchors — split / merge refusals", () => {
  test("split refuses an anchor as origin, and it is the CONTEXT that refuses", () => {
    const blocks = [anchorNode("A", null, a), mk("C1", "A", a)];
    const op: BlockOp = {
      kind: "split",
      blockId: "A",
      position: 0,
      newId: "NEW",
    };
    expect(run(blocks, op, withAnchors)).toBe(blocks);
    // Same op, no context: an ordinary split. The refusal is not a type-name
    // special case — drop `anchorTypes` and the reducer is exactly as before.
    expect(run(blocks, op)).not.toBe(blocks);
  });

  test("merge refuses an anchor as SOURCE (Delete at the end of the line above a container)", () => {
    // `nextVisibleLine` happily returns the anchor, so `mergeNext` issues
    // `merge` with the ANCHOR as the merging block — which would delete the
    // container out from under its children on one keypress.
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      mk("T0", null, r1, { text: "above" }),
      anchorNode("A", null, r2),
      mk("C1", "A", a),
    ];
    const op: BlockOp = { kind: "merge", blockId: "A" };
    expect(run(blocks, op, withAnchors)).toBe(blocks);
    expect(run(blocks, op).find((b) => b.id === "A")).toBeUndefined(); // unguarded: gone
  });

  test("merge refuses an anchor as the resolved TARGET (Backspace at the start of the first child)", () => {
    // The first child's previous visible line is its PARENT — the anchor. A
    // merge there writes `data.text` onto a void schema (400) and dissolves the
    // box. Escaping a container is `unwrap`, not `merge`.
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      mk("T0", null, r1),
      anchorNode("A", null, r2),
      mk("C1", "A", a, { text: "first" }),
    ];
    const op: BlockOp = { kind: "merge", blockId: "C1" };
    expect(run(blocks, op, withAnchors)).toBe(blocks);
    expect(run(blocks, op).find((b) => b.id === "C1")).toBeUndefined(); // unguarded: merged into A
  });

  test("merge into a COLLAPSED container lands on its BORROWED line, not the anchor", () => {
    // A collapsed container is not an empty space above `T2`: it still paints
    // one line — its first child's, borrowed (R1). So the previous VISIBLE line
    // below which `T2` sits is `C1`, and Backspace at the start of `T2` joins
    // that line, exactly as it would for a collapsed toggle. `prevVisibleLine`
    // descending into a collapsed anchor (to its FIRST child, where every other
    // block descends to its last) is what makes this the dual of
    // `nextVisibleLine` — without it Delete at the end of `C1` would resolve a
    // merge the reducer then refuses: a consumed keystroke that does nothing.
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      { ...anchorNode("A", null, r1), expanded: false },
      mk("T2", null, r2, { text: "below" }),
      mk("C1", "A", a, { text: "first" }),
      mk("C2", "A", after(a), { text: "hidden" }),
    ];
    expect(prevVisibleLine(blocks, blocks[1]!, isAnchorFn)?.id).toBe("C1");

    const out = run(blocks, { kind: "merge", blockId: "T2" }, withAnchors);
    expect(out.find((b) => b.id === "T2")).toBeUndefined();
    expect(textOf(out.find((b) => b.id === "C1")!)).toBe("firstbelow");
    // The container survives with both children — a merge into its visible line
    // must not dissolve the box or disturb what it folded away.
    expect(ids(out, "A")).toEqual(["C1", "C2"]);
  });
});

describe("anchors — content lands where it can be seen", () => {
  test("splitting a COLLAPSED container's borrowed line opens the box, so the tail is visible", () => {
    // The failure this exists to prevent: without the reveal the tail lands as
    // the container's 2nd child, which R2 hides — no row, no Lexical instance —
    // while the executor has already truncated the origin's live doc and queued
    // focus at the new id. The text after the caret would simply disappear.
    const blocks = [
      { ...anchorNode("A", null, a), expanded: false },
      mk("C1", "A", a, { text: "helloworld" }),
      mk("C2", "A", after(a), { text: "hidden" }),
    ];
    const out = run(
      blocks,
      { kind: "split", blockId: "C1", position: 5, newId: "NEW" },
      withAnchors,
    );

    expect(out.find((b) => b.id === "A")!.expanded).toBe(true);
    expect(ids(out, "A")).toEqual(["C1", "NEW", "C2"]);
    expect(textOf(out.find((b) => b.id === "C1")!)).toBe("hello");
    expect(textOf(out.find((b) => b.id === "NEW")!)).toBe("world");
    // The whole point: every line of the container is now a VISIBLE line.
    for (const id of ["C1", "NEW", "C2"]) {
      expect(
        isVisibleLine(
          out,
          out.find((b) => b.id === id)!,
          isAnchorFn,
        ),
      ).toBe(true);
    }
  });

  test("the reveal opens the whole NESTED chain, not just the innermost box", () => {
    const blocks = [
      { ...anchorNode("A", null, a), expanded: false },
      { ...anchorNode("B", "A", a), expanded: false },
      mk("C1", "B", a, { text: "helloworld" }),
      mk("C2", "B", after(a), { text: "hidden" }),
    ];
    const out = run(
      blocks,
      { kind: "split", blockId: "C1", position: 5, newId: "NEW" },
      withAnchors,
    );
    expect(out.find((b) => b.id === "A")!.expanded).toBe(true);
    expect(out.find((b) => b.id === "B")!.expanded).toBe(true);
    expect(
      isVisibleLine(
        out,
        out.find((b) => b.id === "NEW")!,
        isAnchorFn,
      ),
    ).toBe(true);
  });

  test("a REFUSED split stays an exact identity no-op, reveal included", () => {
    // Refusals run before the reveal, so a split that cannot apply never leaves a
    // half-effect behind — `dispatchOp` drops empty diffs, and an op that only
    // toggled `expanded` would slip past that and reach the undo stack.
    const blocks = [
      { ...anchorNode("A", null, a), expanded: false },
      mk("C1", "A", a),
    ];
    expect(
      run(
        blocks,
        { kind: "split", blockId: "A", position: 0, newId: "NEW" },
        withAnchors,
      ),
    ).toBe(blocks);
  });
});

describe("anchors — the empty-anchor prune", () => {
  test("outdenting an anchor's only child leaves it childless, and the prune removes it", () => {
    const blocks = [
      anchorNode("A", null, a),
      mk("C1", "A", a, { text: "only" }),
    ];
    const op: BlockOp = { kind: "outdent", blockIds: ["C1"] };

    const out = run(blocks, op, withAnchors);
    expect(out.find((b) => b.id === "A")).toBeUndefined();
    expect(ids(out, null)).toEqual(["C1"]);

    // Without the context the emptied container survives — today's behavior.
    const bare = run(blocks, op);
    expect(ids(bare, null)).toEqual(["A", "C1"]);
    expect(ids(bare, "A")).toEqual([]);
  });

  test("deleting the last child prunes the container; a container that still has one survives", () => {
    const c1 = a;
    const c2 = after(c1);
    const blocks = [
      anchorNode("A", null, a),
      mk("C1", "A", c1),
      mk("C2", "A", c2),
    ];
    const oneLeft = run(
      blocks,
      { kind: "delete", blockIds: ["C1"] },
      withAnchors,
    );
    expect(ids(oneLeft, "A")).toEqual(["C2"]);
    const emptied = run(
      oneLeft,
      { kind: "delete", blockIds: ["C2"] },
      withAnchors,
    );
    expect(emptied).toEqual([]);
  });

  test("the prune runs to a fixed point through NESTED containers", () => {
    // A1 > A2 > C1. Removing C1 empties A2, which empties A1.
    const blocks = [
      anchorNode("A1", null, a),
      anchorNode("A2", "A1", a),
      mk("C1", "A2", a),
    ];
    const out = run(blocks, { kind: "delete", blockIds: ["C1"] }, withAnchors);
    expect(out).toEqual([]);
  });

  test("NEVER prunes a childless page row, even when the context names the page type", () => {
    // The catastrophic false positive: an empty page is legitimate content, and
    // deleting one here would FK-cascade a whole sub-page away from a keystroke.
    // The guard is unconditional, so even a pathological context cannot reach it.
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    const blocks = [
      pageRow("PG", null, r1),
      anchorNode("A", null, r2),
      mk("T", null, r3),
    ];
    const out = run(
      blocks,
      { kind: "insert", newId: "NEW", type: "text", afterId: "T" },
      {
        anchorTypes: new Set([PAGE_BLOCK_TYPE, ANCHOR]),
      },
    );
    expect(out.find((b) => b.id === "PG")).toBeDefined();
    expect(out.find((b) => b.id === "PG")!.data).toEqual({
      title: "PG",
      icon: null,
    });
    // Non-vacuous: the ordinary empty anchor in the same forest WAS pruned, by
    // the same pass, on an op that named neither of them.
    expect(out.find((b) => b.id === "A")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The container closure — "selecting every line a card owns IS selecting it"
// ---------------------------------------------------------------------------

/**
 * A container ANCHOR renders no line of its own, so a pointer can reach every
 * line inside it and never the box: its row is zero height, carries no rail, and
 * the surface's `rowAtPointer` skips it by a height guard. `withContainersSelected`
 * is what closes that hole — without it, "select the card, copy, paste" pasted the
 * contents with the frame stripped off.
 */
describe("anchors — the container closure", () => {
  /** `[ANCHOR C [c1, c2]], T` — a two-line card followed by a plain block. */
  function card(opts: { expanded?: boolean } = {}): BlockNode[] {
    const r1 = a;
    const r2 = after(r1);
    return [
      { ...anchorNode("C", null, r1), expanded: opts.expanded ?? true },
      mk("c1", "C", a),
      mk("c2", "C", after(a)),
      mk("T", null, r2),
    ];
  }

  test("every visible line selected promotes the container", () => {
    const blocks = card();
    const out = withContainersSelected(
      blocks,
      new Set(["c1", "c2"]),
      isAnchorFn,
    );
    expect(out.has("C")).toBe(true);
    // And the roots collapse onto it: the children travel as its subtree.
    expect(
      blockSelectionRoots(blocks, new Set(["c1", "c2"]), isAnchorFn),
    ).toEqual(["C"]);
  });

  test("a partly covered container is left alone", () => {
    const blocks = card();
    expect(
      withContainersSelected(blocks, new Set(["c1"]), isAnchorFn).has("C"),
    ).toBe(false);
    expect(blockSelectionRoots(blocks, new Set(["c1"]), isAnchorFn)).toEqual([
      "c1",
    ]);
  });

  test("a COLLAPSED container is promoted by its one borrowed line", () => {
    // Collapsed, so `c2` is not on screen at all: `c1` alone is everything the
    // card shows, and selecting it is selecting the card.
    const blocks = card({ expanded: false });
    expect(
      withContainersSelected(blocks, new Set(["c1"]), isAnchorFn).has("C"),
    ).toBe(true);
  });

  test("nesting resolves in one pass, outermost included", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks: BlockNode[] = [
      anchorNode("OUT", null, r1),
      anchorNode("IN", "OUT", a),
      mk("k", "IN", a),
      mk("T", null, r2),
    ];
    const out = withContainersSelected(blocks, new Set(["k"]), isAnchorFn);
    expect(out.has("IN")).toBe(true);
    expect(out.has("OUT")).toBe(true);
    expect(blockSelectionRoots(blocks, new Set(["k"]), isAnchorFn)).toEqual([
      "OUT",
    ]);
  });

  test("a CHILDLESS anchor is never promoted — it has a row of its own", () => {
    const blocks: BlockNode[] = [
      anchorNode("C", null, a),
      mk("T", null, after(a)),
    ];
    expect(
      withContainersSelected(blocks, new Set(["T"]), isAnchorFn).has("C"),
    ).toBe(false);
  });

  test("only ADDS: an anchor the range already carries stays selected", () => {
    const blocks = card();
    const out = withContainersSelected(
      blocks,
      new Set(["C", "c1"]),
      isAnchorFn,
    );
    expect(out.has("C")).toBe(true);
    expect([...out].sort()).toEqual(["C", "c1"]);
  });

  test("no anchor types ⇒ byte-identical to plain selection roots", () => {
    const blocks = card();
    for (const sel of [["c1"], ["c1", "c2"], ["c1", "c2", "T"], ["C", "c1"]]) {
      const ids = new Set(sel);
      expect(blockSelectionRoots(blocks, ids, NO_ANCHOR)).toEqual(
        selectionRoots(blocks, ids),
      );
    }
  });

  test("the paste anchor lands AFTER a fully-selected card, not inside it", () => {
    const blocks = card();
    expect(pasteAnchorId(blocks, new Set(["c1", "c2"]), null, isAnchorFn)).toBe(
      "C",
    );
    // Without the closure it would anchor on the card's last CHILD, i.e. inside.
    expect(pasteAnchorId(blocks, new Set(["c1", "c2"]), null, NO_ANCHOR)).toBe(
      "c2",
    );
  });

  test("does not mutate the input forest", () => {
    const blocks = card();
    const before = JSON.stringify(blocks);
    withContainersSelected(blocks, new Set(["c1", "c2"]), isAnchorFn);
    expect(JSON.stringify(blocks)).toBe(before);
  });
});

describe("unwrap", () => {
  test("promotes the children into the container's slot: order, ids, types and subtrees intact", () => {
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    const c1 = a;
    const c2 = after(c1);
    const c3 = after(c2);
    const blocks = [
      mk("T0", null, r1),
      anchorNode("A", null, r2),
      mk("T2", null, r3),
      mk("C1", "A", c1, { text: "first" }),
      mk("C2", "A", c2, { type: "heading-1", expanded: true }),
      mk("C3", "A", c3),
      mk("G1", "C2", a), // C2's own subtree rides along untouched
    ];
    const out = run(blocks, { kind: "unwrap", blockId: "A" }, withAnchors);

    expect(out.find((b) => b.id === "A")).toBeUndefined();
    // The children occupy exactly the slot the container held (`run` already
    // asserted strictly-ascending sibling ranks, so this order IS rank order).
    expect(ids(out, null)).toEqual(["T0", "C1", "C2", "C3", "T2"]);
    // Identity preserved: ids, types, text and whole subtrees.
    expect(textOf(out.find((b) => b.id === "C1")!)).toBe("first");
    expect(out.find((b) => b.id === "C2")!.type).toBe("heading-1");
    expect(ids(out, "C2")).toEqual(["G1"]);

    for (const id of ["C1", "C2", "C3"]) {
      const rk = Rank.from(out.find((b) => b.id === id)!.rank);
      // Strictly inside the container's former neighbourhood…
      expect(Rank.compare(Rank.from(r1), rk)).toBe(-1);
      expect(Rank.compare(rk, Rank.from(r3))).toBe(-1);
      // …and strictly ABOVE the container's own rank: the server applies the
      // UPDATEs (promoted children) before the DELETE (container), so an equal
      // rank would violate the live `(parent_id, rank)` unique index.
      expect(Rank.compare(Rank.from(r2), rk)).toBe(-1);
    }
  });

  test("a nested container's children are promoted into its PARENT container, not to top level", () => {
    const blocks = [
      anchorNode("A1", null, a),
      mk("X", "A1", a),
      anchorNode("A2", "A1", after(a)),
      mk("C1", "A2", a),
    ];
    const out = run(blocks, { kind: "unwrap", blockId: "A2" }, withAnchors);
    expect(ids(out, "A1")).toEqual(["X", "C1"]);
    expect(ids(out, null)).toEqual(["A1"]);
  });

  test("unwrapping a childless block is a plain delete", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [mk("T0", null, r1), mk("T1", null, r2)];
    const out = run(blocks, { kind: "unwrap", blockId: "T0" });
    expect(ids(out, null)).toEqual(["T1"]);
  });

  test("refuses a page row (unwrapping one would delete the sub-page and strand its content)", () => {
    const blocks = [pageRow("PG", null, a), mk("T", null, after(a))];
    const out = run(blocks, { kind: "unwrap", blockId: "PG" });
    expect(out).toBe(blocks);
  });

  test("an unknown id is a no-op", () => {
    const blocks = [mk("T", null, a)];
    expect(run(blocks, { kind: "unwrap", blockId: "nope" })).toBe(blocks);
  });
});

// ---------------------------------------------------------------------------
// Sub-pages inline: page rows are members of the content forest
// ---------------------------------------------------------------------------

/**
 * `pageBlocksServed` no longer filters `type <> 'page'`, so the client's
 * reducer sees exactly the forest the server's has always seen: every block
 * whose nearest page ancestor is this page, sub-page rows included. Two
 * consequences are load-bearing.
 *
 *  1. `(parent_id, rank)` is ONE complete ordering space. A minted rank must
 *     never collide with a rank already live under the same parent — a duplicate
 *     is precisely the state that makes the next `Rank.between` of that pair
 *     throw (`a0 >= a0`).
 *  2. A sub-page row is a LEAF of this forest: its own content lives under a
 *     different `page_id`. `split`/`merge`/`indent` therefore treat it as an
 *     illegal target, not a conditionally-handled one — reparenting or
 *     text-merging across the boundary would strand rows whose `parent_id` and
 *     `page_id` disagree, unreachable by any page-scoped query. The reducer
 *     upholds the in-page invariant (it never restamps `pageId`), so the only
 *     correct answer is a no-op.
 */

/** The page whose content forest these fixtures describe. Never a member of it. */
const PAGE = "PAGE";

function content(
  id: string,
  parentId: string,
  rank: string,
  text?: string,
): BlockNode {
  return mk(id, parentId, rank, {
    text: text ?? id,
    expanded: true,
    pageId: PAGE,
  });
}

function subPage(id: string, parentId: string, rank: string): BlockNode {
  return {
    ...mk(id, parentId, rank, {
      expanded: true,
      pageId: PAGE,
      type: PAGE_BLOCK_TYPE,
    }),
    data: { title: id, icon: null },
  };
}

describe("page rows — split", () => {
  // Under PAGE: T1 (text), S1 (sub-page), T2 (text). The sub-page sits exactly
  // in the gap a split of T1 mints into — a neighbour the editor could not see
  // before, and whose rank it therefore used to ignore.
  const forest = (): BlockNode[] => {
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    return [
      content("T1", PAGE, r1, "helloworld"),
      subPage("S1", PAGE, r2),
      content("T2", PAGE, r3),
    ];
  };

  test("splitting a text block whose next sibling is a page row mints a rank strictly inside the gap", () => {
    const blocks = forest();
    const out = run(blocks, {
      kind: "split",
      blockId: "T1",
      position: 5,
      newId: "NEW",
    });

    // `run` already asserts strictly-ascending (⇒ distinct) sibling ranks.
    expect(ids(out, PAGE)).toEqual(["T1", "NEW", "S1", "T2"]);
    const minted = out.find((b) => b.id === "NEW")!;
    const s1 = out.find((b) => b.id === "S1")!;
    expect(Rank.compare(Rank.from(minted.rank), Rank.from(s1.rank))).toBe(-1);
    expect(minted.rank).not.toBe(s1.rank);
  });

  test("splitting a page row → no-op", () => {
    const blocks = forest();
    const out = run(blocks, {
      kind: "split",
      blockId: "S1",
      position: 0,
      newId: "NEW",
    });
    expect(out).toEqual(blocks);
  });

  test("splitting a page row asChild → no-op (never seeds into the sub-page's partition)", () => {
    const blocks = forest();
    const out = run(blocks, {
      kind: "split",
      blockId: "S1",
      position: 0,
      newId: "NEW",
      asChild: true,
      childType: "text",
    });
    expect(out).toEqual(blocks);
    expect(ids(out, "S1")).toEqual([]);
  });
});

describe("page rows — indent", () => {
  test("indenting a block whose previous sibling is a page row → no-op", () => {
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    const blocks = [
      content("T1", PAGE, r1),
      subPage("S1", PAGE, r2),
      content("T2", PAGE, r3),
    ];
    const out = run(blocks, { kind: "indent", blockIds: ["T2"] });
    expect(out).toEqual(blocks);
    expect(ids(out, "S1")).toEqual([]);
  });

  test("indenting under a text previous sibling still works (the guard is targeted)", () => {
    const r1 = a;
    const r2 = after(r1);
    const r3 = after(r2);
    const blocks = [
      content("T1", PAGE, r1),
      content("T2", PAGE, r2),
      subPage("S1", PAGE, r3),
    ];
    const out = run(blocks, { kind: "indent", blockIds: ["T2"] });
    expect(out.find((b) => b.id === "T2")!.parentId).toBe("T1");
    expect(ids(out, PAGE)).toEqual(["T1", "S1"]);
  });

  test("indenting a page row under a text sibling is allowed (the sub-page just nests)", () => {
    // Legal: the sub-page's own `pageId` (the outer page) is unchanged, and its
    // content lives in a different partition either way. Only the reverse —
    // nesting content INTO a page row — is forbidden.
    const r1 = a;
    const r2 = after(r1);
    const blocks = [content("T1", PAGE, r1), subPage("S1", PAGE, r2)];
    const out = run(blocks, { kind: "indent", blockIds: ["S1"] });
    expect(out.find((b) => b.id === "S1")!.parentId).toBe("T1");
  });
});

describe("page rows — merge", () => {
  test("merging into a previous page row → no-op, and the page keeps its PageData payload", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [subPage("S1", PAGE, r1), content("T1", PAGE, r2, "tail")];
    const out = run(blocks, { kind: "merge", blockId: "T1" });
    expect(out).toEqual(blocks);
    // No bogus `data.text` written onto a PageDataSchema-shaped payload.
    expect(out.find((b) => b.id === "S1")!.data).toEqual({
      title: "S1",
      icon: null,
    });
  });

  test("the page row is caught as prevVisibleLine, not merely as prevSibling", () => {
    // T1's previous sibling is T0, whose deepest last expanded descendant is the
    // sub-page S1. The guard must inspect the LEAF the caret would land on.
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      content("T0", PAGE, r1),
      subPage("S1", "T0", a),
      content("T1", PAGE, r2, "tail"),
    ];
    const out = run(blocks, { kind: "merge", blockId: "T1" });
    expect(out).toEqual(blocks);
  });

  test("merging a page row away → no-op (a keystroke must not delete a sub-page)", () => {
    // Symmetric to the split guard: `merge` REMOVES the merged block, which for
    // a page row would FK-cascade its entire content away.
    const r1 = a;
    const r2 = after(r1);
    const blocks = [content("T1", PAGE, r1), subPage("S1", PAGE, r2)];
    const out = run(blocks, { kind: "merge", blockId: "S1" });
    expect(out).toEqual(blocks);
  });

  test("merging into a previous text leaf still works, children adopted", () => {
    const r1 = a;
    const r2 = after(r1);
    const blocks = [
      content("T1", PAGE, r1, "head"),
      content("T2", PAGE, r2, "tail"),
      content("C1", "T2", a, "child"),
    ];
    const out = run(blocks, { kind: "merge", blockId: "T2" });
    expect(out.find((b) => b.id === "T2")).toBeUndefined();
    expect(ids(out, "T1")).toEqual(["C1"]);
    expect(textOf(out.find((b) => b.id === "T1")!)).toBe("headtail");
  });
});

// ---------------------------------------------------------------------------
// Property tests over random forests containing page rows
// ---------------------------------------------------------------------------

// Deterministic PRNG (mulberry32) so a fuzz failure is reproducible from its
// seed — `Math.random()` would make a red run impossible to replay. Mirrors
// `plugins/primitives/plugins/tree/core/internal/tree.test.ts`.
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

/**
 * A random content forest rooted at the (absent) page row `PAGE`, with valid
 * acyclic parent links and sibling-unique ranks. Page rows are emitted as leaves
 * — never chosen as a parent — because that is exactly what the `page_id`
 * partition guarantees about `loadPageBlocks`.
 */
function randomForest(rand: () => number, n: number): BlockNode[] {
  const rows: BlockNode[] = [];
  const lastRankUnder = new Map<string, Rank | null>();
  const contentIds: string[] = []; // only content blocks may parent

  for (let i = 0; i < n; i++) {
    const id = `n${i}`;
    const parentId =
      contentIds.length > 0 && rand() < 0.6
        ? contentIds[Math.floor(rand() * contentIds.length)]!
        : PAGE;
    const rank = Rank.between(lastRankUnder.get(parentId) ?? null, null);
    lastRankUnder.set(parentId, rank);

    if (rand() < 0.3) {
      rows.push({
        ...subPage(id, parentId, rank.toJSON()),
        expanded: rand() < 0.5,
      });
    } else {
      contentIds.push(id);
      rows.push({
        ...content(id, parentId, rank.toJSON()),
        expanded: rand() < 0.8,
      });
    }
  }
  return rows;
}

/** Ids of every page row's children, as a `pageRowId -> childIds` map. */
function pageRowChildren(blocks: BlockNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of blocks) {
    if (b.type !== PAGE_BLOCK_TYPE) continue;
    out.set(
      b.id,
      blocks
        .filter((c) => c.parentId === b.id)
        .map((c) => c.id)
        .sort(),
    );
  }
  return out;
}

/**
 * Structure-only canonical form of a forest: per id, its parent, type, expanded
 * flag, child ids in document order, and coalesced runs. Deliberately EXCLUDES
 * rank strings — merge mints fresh ranks, so a split∘merge round-trip is
 * structurally (not byte-) identical. Used to assert that invariant.
 */
function canonicalForest(blocks: BlockNode[]): Record<
  string,
  {
    parentId: string | null;
    type: string;
    expanded: boolean;
    childIds: string[];
    runs: RichText;
  }
> {
  const out: Record<
    string,
    {
      parentId: string | null;
      type: string;
      expanded: boolean;
      childIds: string[];
      runs: RichText;
    }
  > = {};
  for (const b of blocks) {
    out[b.id] = {
      parentId: b.parentId,
      type: b.type,
      expanded: b.expanded,
      childIds: childrenOf(blocks, b.id).map((c) => c.id),
      runs: coalesce(runsOfNode(b)),
    };
  }
  return out;
}

/** One op of every kind, instantiated against a random node of `rows`. */
function randomOp(
  rand: () => number,
  rows: BlockNode[],
  nonce: number,
): BlockOp {
  const kinds = [
    "split",
    "merge",
    "indent",
    "outdent",
    "insert",
    "delete",
    "move",
  ] as const;
  const kind = kinds[Math.floor(rand() * kinds.length)]!;
  const target = rows[Math.floor(rand() * rows.length)]!;
  const newId = `x${nonce}`;

  switch (kind) {
    case "split":
      // Sometimes carry a small tailData payload — free coverage that adoption /
      // rank / pageId / no-mutation invariants hold with a non-inherited tail.
      return {
        kind: "split",
        blockId: target.id,
        position: Math.floor(rand() * 4),
        newId,
        ...(rand() < 0.5 ? { tailData: { checked: rand() < 0.5 } } : {}),
      };
    case "merge":
      return { kind: "merge", blockId: target.id };
    case "indent":
      return { kind: "indent", blockIds: [target.id] };
    case "outdent":
      return { kind: "outdent", blockIds: [target.id] };
    case "delete":
      return { kind: "delete", blockIds: [target.id] };
    case "insert":
      return rand() < 0.5
        ? {
            kind: "insert",
            newId,
            type: "text",
            data: { text: "" },
            afterId: target.id,
          }
        : {
            kind: "insert",
            newId,
            type: "text",
            data: { text: "" },
            parentId: target.id,
          };
    case "move": {
      // POSITIONAL intent: the REDUCER mints the rank against the destination's
      // sibling set. Page rows are not destinations (a move into a sub-page is a
      // cross-partition op the server refuses on this endpoint).
      const dest =
        target.type === PAGE_BLOCK_TYPE || rand() < 0.3 ? PAGE : target.id;
      const kids = childrenOf(rows, dest);
      const anchor =
        kids.length > 0 ? kids[Math.floor(rand() * kids.length)]! : null;
      const moved = rows[Math.floor(rand() * rows.length)]!;
      return {
        kind: "move",
        blockId: moved.id,
        parentId: dest,
        targetId: anchor?.id ?? null,
        zone: rand() < 0.5 ? "before" : "after",
      };
    }
  }
}

describe("page rows — property (no minted rank collides with a live sibling)", () => {
  test("every op kind over a page-row-bearing forest leaves sibling ranks strictly ascending", () => {
    let applied = 0;
    let noOps = 0;

    for (let seed = 1; seed <= 3000; seed++) {
      const rand = rng(seed);
      const rows = randomForest(rand, 3 + Math.floor(rand() * 18));
      assertRankOrdering(rows); // the generator itself never mints a collision

      const before = structuredClone(rows);
      const next = applyBlockOp(rows, randomOp(rand, rows, seed));
      if (next === rows) noOps++;
      else applied++;

      // The load-bearing invariant: no minted rank equals a rank concurrently
      // live under the same parent — for EVERY op kind.
      assertRankOrdering(next);
      // pageId is never rewritten for a surviving node (the in-page invariant).
      assertPageIdInvariant(before, next);
      // The reducer never mutates its input.
      expect(rows).toEqual(before);
    }

    // Non-vacuity floor: the fuzz exercised both real applications and guards.
    expect(applied).toBeGreaterThan(500);
    expect(noOps).toBeGreaterThan(50);
  });

  test("split/merge/indent no-op exactly when a page row is the target, and page rows stay leaves", () => {
    let splitGuarded = 0;
    let mergeGuarded = 0;
    let indentGuarded = 0;

    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      const rows = randomForest(rand, 4 + Math.floor(rand() * 12));
      const leavesBefore = pageRowChildren(rows);
      // Precondition: a page row is a leaf of the content forest.
      for (const [, kids] of leavesBefore) expect(kids).toEqual([]);

      for (const b of rows) {
        const sibs = childrenOf(rows, b.parentId);
        const prev = sibs[sibs.findIndex((s) => s.id === b.id) - 1] ?? null;
        // The previous VISIBLE line, computed independently of the reducer: the
        // prev sibling's deepest last expanded descendant, or — with no prev
        // sibling — the PARENT (the upward branch `prevVisibleLine` gained).
        let leaf: BlockNode | null;
        if (!prev) {
          leaf = b.parentId
            ? (rows.find((r) => r.id === b.parentId) ?? null)
            : null;
        } else {
          leaf = prev;
          while (leaf?.expanded) {
            const kids = childrenOf(rows, leaf.id);
            if (kids.length === 0) break;
            leaf = kids[kids.length - 1]!;
          }
        }

        const split = applyBlockOp(rows, {
          kind: "split",
          blockId: b.id,
          position: 0,
          newId: "x",
        });
        const indent = applyBlockOp(rows, { kind: "indent", blockIds: [b.id] });
        const merge = applyBlockOp(rows, { kind: "merge", blockId: b.id });

        if (b.type === PAGE_BLOCK_TYPE) {
          expect(split).toBe(rows);
          splitGuarded++;
        } else {
          expect(split).not.toBe(rows);
        }

        if (prev === null || prev.type === PAGE_BLOCK_TYPE) {
          expect(indent).toBe(rows);
          if (prev?.type === PAGE_BLOCK_TYPE) indentGuarded++;
        } else {
          expect(indent.find((r) => r.id === b.id)!.parentId).toBe(prev.id);
        }

        if (
          b.type === PAGE_BLOCK_TYPE ||
          leaf === null ||
          leaf.type === PAGE_BLOCK_TYPE
        ) {
          expect(merge).toBe(rows);
          if (leaf?.type === PAGE_BLOCK_TYPE) mergeGuarded++;
        } else {
          expect(merge.find((r) => r.id === b.id)).toBeUndefined();
        }

        // Page rows never gain a child through any of the three guarded ops —
        // a child there would carry the OUTER page's `page_id` forever.
        for (const out of [split, indent, merge]) {
          for (const [, kids] of pageRowChildren(out)) expect(kids).toEqual([]);
        }
      }
    }

    expect(splitGuarded).toBeGreaterThan(100);
    expect(indentGuarded).toBeGreaterThan(50);
    expect(mergeGuarded).toBeGreaterThan(50);
  });
});

describe("page rows — op-sequence simulation", () => {
  test("a long chain of ops keeps every parent's sibling ranks strictly ascending", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      let rows = randomForest(rand, 5 + Math.floor(rand() * 12));

      for (let step = 0; step < 60 && rows.length > 0; step++) {
        rows = applyBlockOp(rows, randomOp(rand, rows, step));
        assertRankOrdering(rows);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// split ∘ merge round-trip — the visible-line invariant, executable
// ---------------------------------------------------------------------------

/**
 * Split turns one visible line into two adjacent visible lines; merge is its
 * exact inverse. The adoption rule (tail adopts the origin's visible children)
 * is what makes it provable: after an adoption-split the head is childless, so
 * `prevVisibleLine(tail)` resolves to the head and the merge re-adopts.
 */
describe("split ∘ merge round-trip", () => {
  test("mergeRuns(...splitRuns(runs, p)) equals the coalesced original runs at every position", () => {
    const runs: RichText = [
      { text: "foo", marks: ["bold"] },
      { text: "barbaz", color: "red" },
    ];
    for (let p = 0; p <= runsLength(runs); p++) {
      expect(mergeRuns(...splitRuns(runs, p))).toEqual(coalesce(runs));
    }
  });

  test("split a random content block then merge the tail restores the forest structurally (~500 seeds)", () => {
    let rounds = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      const rows = randomForest(rand, 3 + Math.floor(rand() * 15));
      // Content blocks only — a page row is not a legal split target (guarded).
      const contentBlocks = rows.filter((b) => b.type !== PAGE_BLOCK_TYPE);
      if (contentBlocks.length === 0) continue;
      const target = contentBlocks[Math.floor(rand() * contentBlocks.length)]!;
      const len = runsLength(runsOfNode(target));
      // A NON-EMPTY block is never split at 0 — that is the identity-preserving
      // insert-empty-above case, whose inverse is `delete newId` (its own property
      // below), NOT the tail-becomes-next-visible-line round-trip this covers.
      const position = len === 0 ? 0 : 1 + Math.floor(rand() * len);

      const split = applyBlockOp(rows, {
        kind: "split",
        blockId: target.id,
        position,
        newId: "RT",
      });
      // The tail's previous visible line MUST be the head — that is exactly what
      // makes the merge re-adopt what the split moved. If it ever isn't, the
      // invariant is broken; fail loudly (never skip silently).
      const tail = split.find((b) => b.id === "RT")!;
      expect(prevVisibleLine(split, tail)?.id).toBe(target.id);

      const merged = applyBlockOp(split, { kind: "merge", blockId: "RT" });
      // The tail is gone and the forest is structurally identical to the original
      // (rank strings excluded — merge mints fresh ranks).
      expect(merged.find((b) => b.id === "RT")).toBeUndefined();
      expect(canonicalForest(merged)).toEqual(canonicalForest(rows));
      rounds++;
    }
    // Non-vacuity: the vast majority of seeds yielded a real round-trip.
    expect(rounds).toBeGreaterThan(400);
  });

  test("split then FORWARD-DELETE at the join restores the forest structurally (~500 seeds)", () => {
    let rounds = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      const rows = randomForest(rand, 3 + Math.floor(rand() * 15));
      const contentBlocks = rows.filter((b) => b.type !== PAGE_BLOCK_TYPE);
      if (contentBlocks.length === 0) continue;
      const target = contentBlocks[Math.floor(rand() * contentBlocks.length)]!;
      const len = runsLength(runsOfNode(target));
      // A NON-EMPTY block is never split at 0 — that is the identity-preserving
      // insert-empty-above case, whose inverse is `delete newId` (its own property
      // below), NOT the tail-becomes-next-visible-line round-trip this covers.
      const position = len === 0 ? 0 : 1 + Math.floor(rand() * len);

      const split = applyBlockOp(rows, {
        kind: "split",
        blockId: target.id,
        position,
        newId: "RT",
      });
      // Forward-delete (Delete) fired at the END of the HEAD merges the NEXT
      // visible line UP into it. `mergeNext` resolves that source through
      // `nextVisibleLine` — which, by the completed duality, is exactly the tail
      // RT the split just produced. So Delete-at-the-join is the split's inverse,
      // reached from the OPPOSITE originating block than Backspace's merge.
      const head = split.find((b) => b.id === target.id)!;
      const next = nextVisibleLine(split, head);
      expect(next?.id).toBe("RT");
      // Its previous visible line is the head — the identity that makes
      // Delete-at-end of X exactly Backspace-at-start of the next line.
      expect(prevVisibleLine(split, next!)?.id).toBe(target.id);

      const merged = applyBlockOp(split, { kind: "merge", blockId: next!.id });
      expect(merged.find((b) => b.id === "RT")).toBeUndefined();
      expect(canonicalForest(merged)).toEqual(canonicalForest(rows));
      rounds++;
    }
    expect(rounds).toBeGreaterThan(400);
  });

  test("identity: position-0 split of a non-empty block is inverted by DELETING the new id (~200 seeds)", () => {
    // The inverse of insert-empty-above is `delete newId`, restoring the forest
    // byte-for-byte (ranks included — the origin never moved and the empty sibling
    // is simply removed). A *merge* of newId would NOT invert it: it keeps the
    // empty block and deletes the origin, the opposite of what the split did.
    let rounds = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const rows = randomForest(rand, 3 + Math.floor(rand() * 15));
      const contentBlocks = rows.filter((b) => b.type !== PAGE_BLOCK_TYPE);
      if (contentBlocks.length === 0) continue;
      const origin = contentBlocks[Math.floor(rand() * contentBlocks.length)]!;
      // randomForest seeds every content block with non-empty text (its id).
      expect(runsLength(runsOfNode(origin))).toBeGreaterThan(0);

      const split = applyBlockOp(rows, {
        kind: "split",
        blockId: origin.id,
        position: 0,
        newId: "RT",
      });
      // The new sibling is empty and sits immediately ABOVE the untouched origin.
      const above = split.find((b) => b.id === "RT")!;
      expect(textOf(above)).toBe("");
      expect(
        prevVisibleLine(
          split,
          split.find((b) => b.id === origin.id)!,
        )?.id,
      ).toBe("RT");

      // Deleting RT restores the original forest exactly.
      const inverted = applyBlockOp(split, {
        kind: "delete",
        blockIds: ["RT"],
      });
      expect(inverted).toEqual(rows);
      rounds++;
    }
    expect(rounds).toBeGreaterThan(100);
  });

  test("duality: prevVisibleLine(nextVisibleLine(X)) === X for every VISIBLE X with a next line (over the fuzz forest)", () => {
    // The load-bearing identity behind `mergeNext` needing no new reducer op:
    // Delete-at-end of X is Backspace-at-start of the next visible line, and that
    // is well-defined only because these two helpers are true inverses. It holds
    // for every X the caret can actually sit on — i.e. every VISIBLE node; a node
    // hidden inside a collapsed subtree is not part of the visible sequence, and
    // `nextVisibleLine` from it exits the subtree without a matching
    // predecessor, so it is correctly excluded.
    let checks = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      const rand = rng(seed);
      const rows = randomForest(rand, 3 + Math.floor(rand() * 18));
      for (const x of rows) {
        if (!isVisibleLine(rows, x)) continue;
        const next = nextVisibleLine(rows, x);
        if (!next) continue;
        expect(prevVisibleLine(rows, next)?.id).toBe(x.id);
        checks++;
      }
    }
    // Non-vacuity: the forest is dense enough that most nodes have a next line.
    expect(checks).toBeGreaterThan(3000);
  });

  test("duality holds over an ANCHOR-bearing forest with collapsed containers (~1500 seeds)", () => {
    // The round above mints no anchors at all, so it says nothing about the fold:
    // its `isVisibleLine` would have excluded a collapsed container's borrowed
    // line as hidden and the interesting case would pass vacuously. Here anchors
    // are real, their `expanded` is randomised, and visibility is DERIVED from
    // `visibleChildrenOf` — the same rule the reducer and the surface run — so
    // the property cannot drift from the definition it is checking.
    //
    // The shapes that matter, all reachable from `anchorize` + random collapse:
    // a collapsed container as its parent's LAST child (the upward resume path,
    // where `nextVisibleLine` must resume ABOVE the outermost collapsed anchor),
    // a collapsed container whose first child is itself a container (the nested
    // borrow chain), and a container adjacent to a page row.
    let checks = 0;
    let collapsedAnchorSeeds = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const rand = rng(seed);
      const rows = anchorize(
        randomForest(rand, 4 + Math.floor(rand() * 15)),
        rand,
      ).map((b) =>
        b.type === ANCHOR && rand() < 0.5 ? { ...b, expanded: false } : b,
      );
      if (rows.some((b) => b.type === ANCHOR && !b.expanded))
        collapsedAnchorSeeds++;
      for (const x of rows) {
        if (!isVisibleLine(rows, x, isAnchorFn)) continue;
        const next = nextVisibleLine(rows, x, isAnchorFn);
        if (!next) continue;
        expect(prevVisibleLine(rows, next, isAnchorFn)?.id).toBe(x.id);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(3000);
    // Non-vacuity: the fixture space really does contain COLLAPSED containers.
    expect(collapsedAnchorSeeds).toBeGreaterThan(500);
  });

  test("a collapsed container always shows exactly one line — content never hides behind nothing", () => {
    // The structural guarantee that retires `collapsible: "never"`. Whatever a
    // stray `expanded: false` says (a hand-written PATCH, a pasted
    // `SerializedBlock`), a container keeps painting its borrowed line, so its
    // fold is always visible and always reversible.
    for (let seed = 1; seed <= 400; seed++) {
      const rand = rng(seed);
      const rows = anchorize(
        randomForest(rand, 4 + Math.floor(rand() * 15)),
        rand,
      ).map((b) => (b.type === ANCHOR ? { ...b, expanded: false } : b));
      for (const anchor of rows.filter((b) => b.type === ANCHOR)) {
        if (!isVisibleLine(rows, anchor, isAnchorFn)) continue;
        if (childrenOf(rows, anchor.id).length === 0) continue;
        const visible = visibleChildrenOf(rows, anchor, isAnchorFn);
        expect(visible).toHaveLength(1);
        expect(visible[0]!.id).toBe(childrenOf(rows, anchor.id)[0]!.id);
      }
    }
  });

  test("split ∘ merge round-trips over an ANCHOR-bearing forest with `anchorTypes` supplied (~300 seeds)", () => {
    // The anchors are real members of the forest — parents of the split target,
    // its siblings, its ancestors — so the guards and the prune are live for
    // every seed. Equality stays STRUCTURAL: merge mints fresh ranks, so
    // comparing rank strings would fail even on a correct round-trip.
    let rounds = 0;
    let withAnchorRounds = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const rows = anchorize(
        randomForest(rand, 4 + Math.floor(rand() * 15)),
        rand,
      );
      if (rows.some((b) => b.type === ANCHOR)) withAnchorRounds++;
      // A page row is not a legal split target (guarded), and neither is an
      // anchor — it hosts no text surface. The BORROWED line of a collapsed
      // container is excluded too, and deliberately: splitting there additionally
      // OPENS the box (`revealAround`, so the tail is not written where R2 hides
      // it) and merge does not close it again, so the pair is an inverse on
      // structure but not on the `expanded` flag. That side effect is pinned
      // explicitly below rather than blurred into this property.
      const targets = rows.filter(
        (b) =>
          b.type !== PAGE_BLOCK_TYPE &&
          b.type !== ANCHOR &&
          collapsedAnchorAbove(rows, b, isAnchorFn) === null,
      );
      if (targets.length === 0) continue;
      const target = targets[Math.floor(rand() * targets.length)]!;
      const len = runsLength(runsOfNode(target));
      const position = len === 0 ? 0 : 1 + Math.floor(rand() * len);

      const split = applyBlockOp(
        rows,
        { kind: "split", blockId: target.id, position, newId: "RT" },
        withAnchors,
      );
      const tail = split.find((b) => b.id === "RT")!;
      expect(prevVisibleLine(split, tail)?.id).toBe(target.id);

      const merged = applyBlockOp(
        split,
        { kind: "merge", blockId: "RT" },
        withAnchors,
      );
      expect(merged.find((b) => b.id === "RT")).toBeUndefined();
      expect(canonicalForest(merged)).toEqual(canonicalForest(rows));
      rounds++;
    }
    expect(rounds).toBeGreaterThan(250);
    // Non-vacuity: the fixture space really does contain anchors.
    expect(withAnchorRounds).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------
// `BlockOpContext` — the default is byte-identical to today
// ---------------------------------------------------------------------------

/**
 * Retype a random subset of the fuzz forest's CHILD-BEARING content nodes into
 * container anchors. Child-bearing by construction, because a childless anchor
 * is pruned on the first op — which is correct behavior, but would make a
 * round-trip against the *unpruned* original forest compare unequal for a reason
 * that has nothing to do with split/merge.
 */
function anchorize(rows: BlockNode[], rand: () => number): BlockNode[] {
  const parents = new Set(rows.map((b) => b.parentId));
  return rows.map((b) =>
    b.type !== PAGE_BLOCK_TYPE && parents.has(b.id) && rand() < 0.5
      ? { ...b, type: ANCHOR }
      : b,
  );
}

describe("BlockOpContext", () => {
  test("an omitted / empty `anchorTypes` is byte-identical to a context-free call (~500 seeds)", () => {
    // The property that keeps every test, property test and fuzz seed above
    // valid: the context is purely additive. Run over every op kind.
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      const rows = randomForest(rand, 3 + Math.floor(rand() * 15));
      const op = randomOp(rand, rows, seed);
      const base = applyBlockOp(rows, op);
      expect(applyBlockOp(rows, op, {})).toEqual(base);
      expect(applyBlockOp(rows, op, { anchorTypes: new Set() })).toEqual(base);
    }
  });

  test("a context naming types ABSENT from the forest changes nothing either", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const rows = randomForest(rand, 3 + Math.floor(rand() * 15));
      const op = randomOp(rand, rows, seed);
      expect(applyBlockOp(rows, op, withAnchors)).toEqual(
        applyBlockOp(rows, op),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// splice — a forest pasted AT an insertion point inside a block's text
// ---------------------------------------------------------------------------

describe("splice", () => {
  // Made-up type names, for the reason the text-less merge suite gives: a case
  // passing because the reducer recognised "text" would mean it names a type.
  const PLAIN = "para";
  const HEADING = "title";
  const ctx: BlockOpContext = {
    anchorTypes: new Set([ANCHOR]),
    textBearingTypes: new Set([PLAIN, HEADING]),
    defaultTextType: PLAIN,
  };
  const para = (id: string, text: string): BlockNode =>
    mk(id, "PAGE", a, { type: PLAIN, text, pageId: "PAGE", expanded: true });
  const plain = (
    id: string,
    text: string,
    children: IdentifiedBlock[] = [],
  ): IdentifiedBlock => ({
    id,
    type: PLAIN,
    data: { text: [{ text }] },
    expanded: true,
    children,
  });
  const heading = (id: string, text: string): IdentifiedBlock => ({
    ...plain(id, text),
    type: HEADING,
  });
  const splice = (
    blockId: string,
    text: string,
    position: number,
    forest: IdentifiedBlock[],
  ): Extract<BlockOp, { kind: "splice" }> => ({
    kind: "splice",
    blockId,
    position,
    runs: text === "" ? [] : [{ text }],
    forest,
    granularity: "text",
    tailId: "TAIL",
  });
  const textById = (blocks: BlockNode[], id: string): string =>
    textOf(blocks.find((b) => b.id === id)!);

  test("empty line + one paragraph: the text fills THAT line, and no row is made", () => {
    // The reported case: `The plugin system⏎` into an empty block used to leave
    // the block empty above a new block holding the text.
    const blocks = [para("A", "")];
    const op = splice("A", "", 0, [plain("P1", "The plugin system")]);
    const out = run(blocks, op, ctx);
    expect(out.map((b) => b.id)).toEqual(["A"]);
    expect(textById(out, "A")).toBe("The plugin system");
    expect(planSplice(blocks, op, ctx)!.caret).toEqual({
      blockId: "A",
      offset: "The plugin system".length,
    });
  });

  test("empty line + a heading first: the empty origin is CONSUMED, the forest takes its slot", () => {
    const blocks = [para("A", ""), { ...para("B", "next"), rank: after(a) }];
    const op = splice("A", "", 0, [heading("H", "Title"), plain("P", "body")]);
    const out = run(blocks, op, ctx);
    expect(ids(out, "PAGE")).toEqual(["H", "P", "B"]);
    expect(out.find((b) => b.id === "H")!.type).toBe(HEADING);
    expect(planSplice(blocks, op, ctx)!.caret).toEqual({
      blockId: "P",
      offset: 4,
    });
  });

  test("an empty origin that is NOT a plain paragraph keeps its line", () => {
    const blocks = [{ ...para("A", ""), type: HEADING }];
    const out = run(
      blocks,
      splice("A", "", 0, [heading("H", "X"), plain("P", "y")]),
      ctx,
    );
    expect(ids(out, "PAGE")).toEqual(["A", "H", "P"]);
  });

  test("foo|bar + a⏎b → fooa, bbar, the caret after b", () => {
    const blocks = [
      para("A", "foobar"),
      { ...para("B", "next"), rank: after(a) },
    ];
    const op = splice("A", "foobar", 3, [plain("P1", "a"), plain("P2", "b")]);
    const out = run(blocks, op, ctx);
    expect(ids(out, "PAGE")).toEqual(["A", "P2", "B"]);
    expect(textById(out, "A")).toBe("fooa");
    expect(textById(out, "P2")).toBe("bbar");
    expect(out.some((b) => b.id === "P1" || b.id === "TAIL")).toBe(false);
    expect(planSplice(blocks, op, ctx)!.caret).toEqual({
      blockId: "P2",
      offset: 1,
    });
  });

  test("a single paragraph mid-line is a text edit of the origin alone", () => {
    const blocks = [para("A", "foobar")];
    const op = splice("A", "foobar", 3, [plain("P1", "XY")]);
    const out = run(blocks, op, ctx);
    expect(out.map((b) => b.id)).toEqual(["A"]);
    expect(textById(out, "A")).toBe("fooXYbar");
    expect(planSplice(blocks, op, ctx)!.caret.offset).toBe(5);
  });

  test("mid-line, a non-paragraph last block: the text after lands on a minted tail", () => {
    // The tail is split's: `siblingType` when the intent layer resolved one,
    // `tailData` for its data — here a heading origin whose split yields a
    // plain paragraph.
    const blocks = [{ ...para("A", "foobar"), type: HEADING }];
    const op = {
      ...splice("A", "foobar", 3, [plain("P1", "a"), heading("H", "h")]),
      siblingType: PLAIN,
    };
    const out = run(blocks, op, ctx);
    expect(ids(out, "PAGE")).toEqual(["A", "H", "TAIL"]);
    expect(textById(out, "A")).toBe("fooa");
    const tail = out.find((b) => b.id === "TAIL")!;
    expect(tail.type).toBe(PLAIN);
    expect(textOf(tail)).toBe("bar");
    expect(planSplice(blocks, op, ctx)!.caret).toEqual({
      blockId: "TAIL",
      offset: 0,
    });
  });

  test("the tail line adopts the origin's visible children, as split's tail does", () => {
    const blocks = [
      para("A", "foobar"),
      mk("K", "A", a, { type: PLAIN, text: "kid", pageId: "PAGE" }),
    ];
    const out = run(
      blocks,
      splice("A", "foobar", 3, [plain("P1", "a"), plain("P2", "b")]),
      ctx,
    );
    expect(ids(out, "PAGE")).toEqual(["A", "P2"]);
    expect(ids(out, "A")).toEqual([]);
    expect(ids(out, "P2")).toEqual(["K"]);
  });

  test("the point at the END of a line with visible children: the forest lands as its first children", () => {
    // Where Enter at that point nests — as the immediately-next visible lines,
    // above the children rather than after the whole subtree.
    const blocks = [
      para("A", "foo"),
      mk("K", "A", a, { type: PLAIN, text: "kid", pageId: "PAGE" }),
    ];
    const op = splice("A", "foo", 3, [plain("P1", "a"), heading("H", "h")]);
    const out = run(blocks, op, ctx);
    expect(textById(out, "A")).toBe("fooa");
    expect(ids(out, "A")).toEqual(["H", "K"]);
    expect(planSplice(blocks, op, ctx)!.caret).toEqual({
      blockId: "H",
      offset: 1,
    });
  });

  test("a range replace: the runs arrive with the span cut, and the splice lands at its start", () => {
    // `foo[XX]bar` — the door hands `foobar`, position 3.
    const blocks = [para("A", "fooXXbar")];
    const out = run(
      blocks,
      splice("A", "foobar", 3, [plain("P1", "a"), plain("P2", "b")]),
      ctx,
    );
    expect(textById(out, "A")).toBe("fooa");
    expect(textById(out, "P2")).toBe("bbar");
  });

  test("a NESTED partial copy pasted mid-line joins at both ends (the reported case)", () => {
    // Copied `aa[aa` › `bb]bb`; pasted at `zz|zz`. Notion / Google Docs: the
    // first fragment joins the head, the last the tail, nesting kept.
    const blocks = [para("A", "zzzz")];
    const op = splice("A", "zzzz", 2, [plain("P1", "aa", [plain("C", "bb")])]);
    const out = run(blocks, op, ctx);
    expect(ids(out, "PAGE")).toEqual(["A"]);
    expect(textById(out, "A")).toBe("zzaa");
    expect(ids(out, "A")).toEqual(["C"]);
    expect(textById(out, "C")).toBe("bbzz");
    expect(out.some((b) => b.id === "P1" || b.id === "TAIL")).toBe(false);
    expect(planSplice(blocks, op, ctx)!.caret).toEqual({
      blockId: "C",
      offset: 2,
    });
  });

  test("a partial copy ending one level deeper under a LATER root joins its tail there", () => {
    // `x[1` / `2` › `3]y` at `ab|cd`: line 1 joins the head, `2` lands after
    // it, `3` keeps its nesting under `2` and takes `cd`.
    const blocks = [para("A", "abcd")];
    const op = splice("A", "abcd", 2, [
      plain("P1", "1"),
      plain("P2", "2", [plain("C", "3")]),
    ]);
    const out = run(blocks, op, ctx);
    expect(ids(out, "PAGE")).toEqual(["A", "P2"]);
    expect(textById(out, "A")).toBe("ab1");
    expect(ids(out, "P2")).toEqual(["C"]);
    expect(textById(out, "C")).toBe("3cd");
  });

  test("the origin's children follow the joined last line, after the holder's own", () => {
    const blocks = [
      para("A", "abcd"),
      mk("K", "A", a, { type: PLAIN, text: "kid", pageId: "PAGE" }),
    ];
    const out = run(
      blocks,
      splice("A", "abcd", 2, [
        plain("P1", "1"),
        plain("P2", "2", [plain("C", "3")]),
      ]),
      ctx,
    );
    expect(ids(out, "A")).toEqual([]);
    expect(ids(out, "P2")).toEqual(["C", "K"]);
  });

  test("a merged head's nested lines sit ABOVE the origin's own children", () => {
    const blocks = [
      para("A", "abcd"),
      mk("K", "A", a, { type: PLAIN, text: "kid", pageId: "PAGE" }),
    ];
    const out = run(
      blocks,
      splice("A", "abcd", 2, [plain("P1", "1", [plain("C", "2")])]),
      ctx,
    );
    expect(textById(out, "A")).toBe("ab1");
    expect(ids(out, "A")).toEqual(["C", "K"]);
    expect(textById(out, "C")).toBe("2cd");
  });

  test("whole blocks (granularity `blocks`) never join — unchanged", () => {
    const blocks = [para("A", "zzzz")];
    const out = run(
      blocks,
      {
        ...splice("A", "zzzz", 2, [plain("P1", "aa", [plain("C", "bb")])]),
        granularity: "blocks",
      },
      ctx,
    );
    expect(textById(out, "A")).toBe("zzzz");
    expect(ids(out, "PAGE")).toEqual(["A", "P1"]);
    expect(ids(out, "P1")).toEqual(["C"]);
    expect(textById(out, "P1")).toBe("aa");
    expect(textById(out, "C")).toBe("bb");
  });

  test("the caret lands at the end of the LAST line of a nested last root", () => {
    const blocks = [para("A", "")];
    const op = splice("A", "", 0, [
      heading("H", "t"),
      plain("P", "p", [plain("C", "child")]),
    ]);
    expect(planSplice(blocks, op, ctx)!.caret).toEqual({
      blockId: "C",
      offset: 5,
    });
  });

  test("the forest's ids are EXACTLY the ones handed in — never re-minted", () => {
    const blocks = [para("A", "x")];
    const out = run(
      blocks,
      splice("A", "x", 1, [
        heading("H1", "h"),
        plain("P", "p", [plain("C", "c")]),
      ]),
      ctx,
    );
    expect(out.map((b) => b.id).sort()).toEqual(["A", "C", "H1", "P"]);
    expect(out.find((b) => b.id === "C")!.parentId).toBe("P");
  });

  describe("refusals are the identity", () => {
    const forest = [plain("P1", "a"), plain("P2", "b")];
    test("a missing block", () => {
      const blocks = [para("A", "x")];
      expect(run(blocks, splice("GONE", "x", 0, forest), ctx)).toEqual(blocks);
    });
    test("a page row", () => {
      const blocks = [{ ...para("A", ""), type: PAGE_BLOCK_TYPE }];
      expect(run(blocks, splice("A", "", 0, forest), ctx)).toEqual(blocks);
    });
    test("a container anchor", () => {
      const blocks = [
        { ...para("A", ""), type: ANCHOR, data: {} },
        mk("K", "A", a, { type: PLAIN, pageId: "PAGE" }),
      ];
      expect(run(blocks, splice("A", "", 0, forest), ctx)).toEqual(blocks);
    });
    test("a text-less row", () => {
      const blocks = [{ ...para("A", ""), type: "rule", data: {} }];
      expect(run(blocks, splice("A", "", 0, forest), ctx)).toEqual(blocks);
    });
  });

  test("with no default-text type, nothing is absorbed: it degrades to split + insert", () => {
    const blocks = [para("A", "foobar")];
    const noPlain: BlockOpContext = { ...ctx, defaultTextType: undefined };
    const out = run(
      blocks,
      splice("A", "foobar", 3, [plain("P1", "a")]),
      noPlain,
    );
    expect(ids(out, "PAGE")).toEqual(["A", "P1", "TAIL"]);
    expect(textById(out, "A")).toBe("foo");
    expect(textById(out, "TAIL")).toBe("bar");
  });

  // A block copied WHOLE pastes as whole blocks: `granularity: "blocks"` merges
  // no head and no tail, and lands where `paste` lands a forest.
  describe('whole blocks (`granularity: "blocks"`)', () => {
    const whole = (
      blockId: string,
      text: string,
      position: number,
      forest: IdentifiedBlock[],
    ) => ({
      ...splice(blockId, text, position, forest),
      granularity: "blocks" as const,
    });

    test("mid-line: the origin keeps its whole text, the copies land after it", () => {
      const blocks = [
        para("A", "foobar"),
        { ...para("B", "next"), rank: after(a) },
      ];
      const op = whole("A", "foobar", 3, [plain("P1", "a"), plain("P2", "b")]);
      const out = run(blocks, op, ctx);
      expect(ids(out, "PAGE")).toEqual(["A", "P1", "P2", "B"]);
      expect(textById(out, "A")).toBe("foobar");
      expect(textById(out, "P1")).toBe("a");
      expect(textById(out, "P2")).toBe("b");
      expect(planSplice(blocks, op, ctx)!.caret).toEqual({
        blockId: "P2",
        offset: 1,
      });
    });

    test("a copied paragraph into an EMPTY line replaces the line", () => {
      const blocks = [para("A", "")];
      const out = run(blocks, whole("A", "", 0, [plain("P1", "x")]), ctx);
      expect(out.map((b) => b.id)).toEqual(["P1"]);
    });

    test("with visible children, the copies land after the whole subtree — paste's rule", () => {
      const blocks = [
        para("A", "foo"),
        mk("K", "A", a, { type: PLAIN, text: "kid", pageId: "PAGE" }),
      ];
      const out = run(blocks, whole("A", "foo", 3, [plain("P1", "x")]), ctx);
      expect(ids(out, "PAGE")).toEqual(["A", "P1"]);
      expect(ids(out, "A")).toEqual(["K"]);
    });

    test("a selected range is replaced: the origin takes the runs with the span cut", () => {
      const blocks = [para("A", "fooXXbar")];
      const out = run(blocks, whole("A", "foobar", 3, [plain("P1", "x")]), ctx);
      expect(textById(out, "A")).toBe("foobar");
      expect(ids(out, "PAGE")).toEqual(["A", "P1"]);
    });
  });
});
