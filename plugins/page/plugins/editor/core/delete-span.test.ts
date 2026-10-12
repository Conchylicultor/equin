/**
 * `deleteSpan` — the one op behind deleting a text span that crosses blocks
 * (`applyDeleteSpan` in `block-ops.ts`).
 */
import { test, expect, describe } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { PAGE_BLOCK_TYPE } from "./schemas";
import {
  applyBlockOp,
  BlockOpSchema,
  childrenOf,
  opNamedIds,
  textOf,
  type BlockNode,
  type BlockOp,
  type BlockOpContext,
} from "./block-ops";
import { joinAroundSpan } from "./text-span";
import { runsOf } from "./rich-text";

const r1 = Rank.between(null, null).toJSON();
const next = (prev: string): string =>
  Rank.between(Rank.from(prev), null).toJSON();
const r2 = next(r1);
const r3 = next(r2);
const r4 = next(r3);
const r5 = next(r4);

function mk(
  id: string,
  parentId: string | null,
  rank: string,
  opts: { text?: string; type?: string; expanded?: boolean } = {},
): BlockNode {
  const type = opts.type ?? "text";
  return {
    id,
    pageId: "page-1",
    parentId,
    type,
    data:
      type === "callout" || type === PAGE_BLOCK_TYPE
        ? {}
        : { text: opts.text ?? id },
    rank,
    expanded: opts.expanded ?? true,
  };
}

const ctx: BlockOpContext = {
  anchorTypes: new Set(["callout"]),
  textBearingTypes: new Set(["text", "heading-1"]),
};

/** The op a client issues for a span from `offA` in A to `offC` in C. */
function spanOp(
  blocks: BlockNode[],
  a: string,
  offA: number,
  c: string,
  offC: number,
): Extract<BlockOp, { kind: "deleteSpan" }> {
  const runsOfId = (id: string) =>
    runsOf((blocks.find((b) => b.id === id)!.data as { text?: unknown }).text);
  return {
    kind: "deleteSpan",
    targetId: a,
    sourceId: c,
    runs: joinAroundSpan(runsOfId(a), offA, runsOfId(c), offC),
  };
}

function run(blocks: BlockNode[], op: BlockOp): BlockNode[] {
  const snapshot = structuredClone(blocks);
  const out = applyBlockOp(blocks, op, ctx);
  expect(blocks).toEqual(snapshot);
  return out;
}

const kids = (blocks: BlockNode[], parent: string | null) =>
  childrenOf(blocks, parent).map((b) => b.id);
const text = (blocks: BlockNode[], id: string) =>
  textOf(blocks.find((b) => b.id === id)!);

describe("deleteSpan", () => {
  test("A / B / C siblings: A's head joins C's tail, B and C go", () => {
    const blocks = [
      mk("A", null, r1, { text: "hello" }),
      mk("B", null, r2, { text: "middle" }),
      mk("C", null, r3, { text: "world" }),
      mk("D", null, r4, { text: "after" }),
    ];
    const out = run(blocks, spanOp(blocks, "A", 2, "C", 2));
    expect(kids(out, null)).toEqual(["A", "D"]);
    expect(text(out, "A")).toBe("herld");
  });

  test("A with children: the children are lines in the span, so they go too", () => {
    const blocks = [
      mk("A", null, r1, { text: "aaaa" }),
      mk("a1", "A", r1),
      mk("a2", "A", r2),
      mk("C", null, r2, { text: "cccc" }),
      mk("c1", "C", r1),
    ];
    const out = run(blocks, spanOp(blocks, "A", 1, "C", 3));
    expect(out.map((b) => b.id).sort()).toEqual(["A", "c1"]);
    expect(text(out, "A")).toBe("ac");
    // C's child is not covered: it is adopted by A, at the slot C held.
    expect(kids(out, "A")).toEqual(["c1"]);
  });

  test("C nested under B: B is unwrapped, and what follows C inside B is lifted, not deleted", () => {
    const blocks = [
      mk("A", null, r1, { text: "aaaa" }),
      mk("B", null, r2, { text: "bbbb" }),
      mk("x", "B", r1),
      mk("C", "B", r2, { text: "cccc" }),
      mk("y", "B", r3),
      mk("Z", null, r3),
    ];
    const out = run(blocks, spanOp(blocks, "A", 2, "C", 2));
    expect(out.find((b) => b.id === "B")).toBeUndefined();
    expect(out.find((b) => b.id === "x")).toBeUndefined();
    expect(kids(out, null)).toEqual(["A", "y", "Z"]);
    expect(text(out, "A")).toBe("aacc");
  });

  test("two ancestor levels: both unwrap, every uncovered follower survives in order", () => {
    const blocks = [
      mk("A", null, r1, { text: "aa" }),
      mk("B", null, r2),
      mk("P", "B", r1),
      mk("C", "P", r1, { text: "cc" }),
      mk("y", "P", r2),
      mk("z", "B", r2),
    ];
    const out = run(blocks, spanOp(blocks, "A", 1, "C", 1));
    expect(kids(out, null)).toEqual(["A", "y", "z"]);
    expect(text(out, "A")).toBe("ac");
  });

  test("A is C's ancestor: A's lines before C go, C's children take C's slot under A", () => {
    const blocks = [
      mk("A", null, r1, { text: "aa" }),
      mk("x", "A", r1),
      mk("C", "A", r2, { text: "cc" }),
      mk("c1", "C", r1),
      mk("y", "A", r3),
    ];
    const out = run(blocks, spanOp(blocks, "A", 2, "C", 0));
    expect(text(out, "A")).toBe("aacc");
    expect(kids(out, "A")).toEqual(["c1", "y"]);
  });

  test("a container the span only enters is kept; C's children stay inside it", () => {
    const blocks = [
      mk("A", null, r1, { text: "aa" }),
      mk("BOX", null, r2, { type: "callout" }),
      mk("C", "BOX", r1, { text: "cc" }),
      mk("c1", "C", r1),
      mk("w", "BOX", r2),
    ];
    const out = run(blocks, spanOp(blocks, "A", 1, "C", 1));
    expect(text(out, "A")).toBe("ac");
    expect(kids(out, null)).toEqual(["A", "BOX"]);
    expect(kids(out, "BOX")).toEqual(["c1", "w"]);
  });

  test("a container the span empties is pruned", () => {
    const blocks = [
      mk("A", null, r1, { text: "aa" }),
      mk("BOX", null, r2, { type: "callout" }),
      mk("C", "BOX", r1, { text: "cc" }),
    ];
    const out = run(blocks, spanOp(blocks, "A", 1, "C", 1));
    expect(kids(out, null)).toEqual(["A"]);
  });

  test("a sub-page row between the ends is deleted like any covered line", () => {
    const blocks = [
      mk("A", null, r1, { text: "aa" }),
      mk("SUB", null, r2, { type: PAGE_BLOCK_TYPE }),
      mk("C", null, r3, { text: "cc" }),
    ];
    const out = run(blocks, spanOp(blocks, "A", 1, "C", 1));
    expect(kids(out, null)).toEqual(["A"]);
  });

  test("a collapsed line between the ends takes its hidden children with it", () => {
    const blocks = [
      mk("A", null, r1, { text: "aa" }),
      mk("B", null, r2, { expanded: false }),
      mk("hidden", "B", r1),
      mk("C", null, r3, { text: "cc" }),
    ];
    const out = run(blocks, spanOp(blocks, "A", 1, "C", 1));
    expect(out.map((b) => b.id)).toEqual(["A"]);
  });

  describe("refusals are the identity (merge's, on both ends)", () => {
    const base = [
      mk("A", null, r1, { text: "aa" }),
      mk("BOX", null, r2, { type: "callout" }),
      mk("inner", "BOX", r1, { text: "ii" }),
      mk("SUB", null, r3, { type: PAGE_BLOCK_TYPE }),
      mk("IMG", null, r4, { type: "image" }),
      mk("C", null, r5, { text: "cc" }),
    ];
    const op = (targetId: string, sourceId: string): BlockOp => ({
      kind: "deleteSpan",
      targetId,
      sourceId,
      runs: [{ text: "x" }],
    });
    test.each([
      ["C before A", "C", "A"],
      ["same block", "A", "A"],
      ["missing end", "A", "nope"],
      ["anchor start", "BOX", "C"],
      ["page-row start", "SUB", "C"],
      ["page-row end", "A", "SUB"],
      ["text-less start", "IMG", "C"],
      ["text-less end", "A", "IMG"],
    ])("%s", (_label, t, s) => {
      expect(applyBlockOp(base, op(t, s), ctx)).toEqual(base);
    });
  });

  test("names both ends; the lines between are the reducer's to find", () => {
    expect(
      opNamedIds({
        kind: "deleteSpan",
        targetId: "A",
        sourceId: "C",
        runs: [],
      }),
    ).toEqual(["A", "C"]);
  });

  test("client/server parity: the wire schema round-trips the op, and the server's parse reduces identically", () => {
    const blocks = [
      mk("A", null, r1, { text: "hello" }),
      mk("B", null, r2),
      mk("C", null, r3, { text: "world" }),
    ];
    const op = spanOp(blocks, "A", 2, "C", 2);
    const parsed = BlockOpSchema.parse(JSON.parse(JSON.stringify(op)));
    expect(parsed).toEqual(op);
    expect(applyBlockOp(blocks, parsed, ctx)).toEqual(
      applyBlockOp(blocks, op, ctx),
    );
  });
});
