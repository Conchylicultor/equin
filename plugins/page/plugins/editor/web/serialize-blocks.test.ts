/**
 * Pure unit tests for THE forest serializer (`web/serialize-blocks.ts`).
 * Run with `bun test plugins/page/plugins/editor/web/serialize-blocks.test.ts`.
 *
 * `serializeForest` is what copy and duplicate BOTH run, which is what makes
 * "duplicate ≡ copy + paste after each source" true by construction. These cases
 * were `core/block-forest.test.ts`'s `serializeSubtree` describe — the
 * server-side twin the duplicate op deleted — retargeted at the surviving
 * signature: `Block[]` rows plus an ARRAY of root ids in, `SerializedBlock[]`
 * out.
 */

import { test, expect, describe } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  planForestInsert,
  withMintedIds,
  withPasteIds,
  type Block,
  type BlockNode,
  type IdentifiedBlock,
  type SerializedBlock,
} from "../core";
import { serializeForest } from "./serialize-blocks";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a document row. Rows carry `rank` as a real `Rank` (the reducer's
 * `BlockNode` carries the string form) — that is the one shape difference from
 * `core/block-forest.test.ts`'s `mk`, and the reason `rowsOf` exists below.
 */
function mk(
  id: string,
  parentId: string | null,
  rank: Rank,
  opts: {
    type?: string;
    pageId?: string | null;
    expanded?: boolean;
    text?: string;
  } = {},
): Block {
  return {
    id,
    pageId: opts.pageId === undefined ? "page-1" : opts.pageId,
    parentId,
    type: opts.type ?? "text",
    data: { text: opts.text ?? id },
    rank,
    expanded: opts.expanded ?? false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const r0 = Rank.between(null, null);
function after(prev: Rank): Rank {
  return Rank.between(prev, null);
}

function leaf(type: string, data?: unknown): SerializedBlock {
  return { type, data, expanded: false, children: [] };
}

/** Drop the stamped row ids, for comparing STRUCTURE against a `SerializedBlock`. */
function withoutIds(forest: IdentifiedBlock[]): SerializedBlock[] {
  return forest.map(({ id: _id, children, ...rest }) => ({
    ...rest,
    children: withoutIds(children),
  }));
}

/** Planner output (`BlockNode[]`, string ranks) as document rows. */
function rowsOf(nodes: BlockNode[]): Block[] {
  return nodes.map((n) => ({
    ...n,
    rank: Rank.from(n.rank),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
}

// ---------------------------------------------------------------------------
// serializeForest
// ---------------------------------------------------------------------------

describe("serializeForest", () => {
  test("captures type/data/expanded and rank-ordered children", () => {
    const r1 = r0;
    const r2 = after(r1);
    const rows = [
      mk("root", null, r1, { type: "callout", expanded: true, text: "root" }),
      // Deliberately unsorted insertion order; serialize must sort by rank.
      mk("c2", "root", r2, { text: "c2" }),
      mk("c1", "root", r1, { text: "c1" }),
    ];
    const [s] = serializeForest(rows, ["root"]);
    expect(s!.type).toBe("callout");
    expect(s!.expanded).toBe(true);
    expect(s!.children.map((c) => (c.data as { text: string }).text)).toEqual([
      "c1",
      "c2",
    ]);
  });

  test("round-trips through a plan → serialize cycle (structure preserved)", () => {
    const original: SerializedBlock = {
      type: "callout",
      data: { text: "note", color: "blue" },
      expanded: true,
      children: [
        leaf("text", { text: "one" }),
        {
          type: "toggle",
          data: { text: "two" },
          expanded: false,
          children: [leaf("text", { text: "nested" })],
        },
      ],
    };
    const { nodes, rootIds } = planForestInsert({
      pageId: "page-1",
      parentId: null,
      rootRanks: Rank.nBetween(null, null, 1),
      forest: withMintedIds([original]),
    });
    // Ids are stripped for the STRUCTURAL comparison: `serializeForest` stamps
    // each node's source row id (the markdown walk needs it — a `<page id="…"/>`
    // tag has no other source of identity), and those ids are freshly minted
    // here. That the ids are the source rows' is pinned by its own test below.
    expect(withoutIds(serializeForest(rowsOf(nodes), rootIds))).toEqual([
      original,
    ]);
  });

  test("stamps each node's SOURCE row id", () => {
    // Provenance, never a destination identity: both consumers (copy→paste and
    // duplicate) run the forest through `withMintedIds`, which overwrites it.
    const rows = [
      mk("root", null, r0, { type: "toggle" }),
      mk("kid", "root", r0),
    ];
    const [s] = serializeForest(rows, ["root"]);
    expect(s!.id).toBe("root");
    expect(s!.children.map((c) => c.id)).toEqual(["kid"]);
    expect(withMintedIds(serializeForest(rows, ["root"]))[0]!.id).not.toBe(
      "root",
    );
  });

  test("a COLLAPSED subtree still serializes whole (rows, not visible lines)", () => {
    // The rows are the source of truth; `expanded` is carried as payload, never
    // read as a traversal gate. A copy/duplicate of a collapsed toggle must
    // bring its hidden children along.
    const rows = [
      mk("root", null, r0, { type: "toggle", expanded: false }),
      mk("hidden", "root", r0),
    ];
    const [s] = serializeForest(rows, ["root"]);
    expect(s!.expanded).toBe(false);
    expect(s!.children.map((c) => c.type)).toEqual(["text"]);
  });

  test("several roots serialize in the ARRAY's order, not in rank order", () => {
    // The caller's array is the order — it is what `bulkDuplicate` document-orders
    // before building its placements, and what a copy hands the clipboard.
    const r1 = r0;
    const r2 = after(r1);
    const rows = [mk("A", null, r1), mk("B", null, r2)];
    expect(
      serializeForest(rows, ["B", "A"]).map(
        (s) => (s.data as { text: string }).text,
      ),
    ).toEqual(["B", "A"]);
  });

  test("a root id absent from the rows is dropped; the others still serialize", () => {
    // Deliberately NOT a throw, unlike the deleted `serializeSubtree`: the rows
    // are a live snapshot, so a root can legitimately vanish under a concurrent
    // delete between selection and copy.
    const rows = [mk("A", null, r0)];
    expect(serializeForest(rows, ["GONE", "A"]).map((s) => s.type)).toEqual([
      "text",
    ]);
  });

  test("no roots → an empty forest", () => {
    expect(serializeForest([mk("A", null, r0)], [])).toEqual([]);
  });
});

describe("a sub-page carries its source, not its content", () => {
  test("a page node names its own row as pageSource; other nodes carry none", () => {
    const rows = [
      mk("S", "root", r0, { type: "page" }),
      mk("root", null, after(r0)),
    ];
    const [root] = serializeForest(rows, ["root"]);
    expect(root!.pageSource).toBeUndefined();
    expect(root!.children[0]!.pageSource).toEqual({ pageId: "S" });
  });

  test("withMintedIds always mints, so a duplicate copies the page", () => {
    const rows = [mk("S", null, r0, { type: "page" })];
    const [n] = withMintedIds(serializeForest(rows, ["S"]));
    expect(n!.id).not.toBe("S");
    expect(n!.pageSource).toEqual({ pageId: "S" });
  });

  test("withPasteIds keeps the source id only for what the claim accepts", () => {
    const forest: SerializedBlock[] = [
      { ...leaf("page"), pageSource: { pageId: "S", cutId: "c1" } },
      { ...leaf("page"), pageSource: { pageId: "T" } },
      leaf("text"),
    ];
    const [s, tNode, text] = withPasteIds(
      forest,
      (source) => source.cutId === "c1",
    );
    expect(s!.id).toBe("S");
    expect(tNode!.id).not.toBe("T");
    expect(text!.id).toMatch(/^block-/);
  });
});

describe("serializeForest — a partial copy (a text span's)", () => {
  test("runsOverride replaces a block's text, exclude drops a descendant", () => {
    const rA = r0;
    const rows = [
      mk("A", null, rA, { text: "alpha" }),
      mk("A1", "A", r0, { text: "child one" }),
      mk("A2", "A", after(r0), { text: "child two" }),
    ];
    const [a] = serializeForest(rows, ["A"], {
      runsOverride: new Map([
        ["A", [{ text: "pha" }]],
        ["A1", [{ text: "chi" }]],
      ]),
      exclude: new Set(["A2"]),
    });
    expect(a!.data).toEqual({ text: [{ text: "pha" }] });
    expect(a!.children.map((c) => c.id)).toEqual(["A1"]);
    expect(a!.children[0]!.data).toEqual({ text: [{ text: "chi" }] });
  });
});
