/**
 * Pure unit tests for the hierarchical views' row projection (`projectRows`) — the
 * alias (reference) rank minting in particular.
 * Run with `./singularity test plugins/primitives/plugins/data-view`.
 *
 * No DOM, no React render: the projection and the tree's drop resolution are
 * both pure, so these are bun:test (not the jsdom vitest suite).
 */

import { describe, expect, test } from "bun:test";
import { resolveDropParent } from "@plugins/primitives/plugins/tree/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { HierarchyConfig } from "../../../core";
import { projectRows, realNodeId } from "./project-rows";

/**
 * A row in the shape the pages sidebar feeds the tree: `parentId` is the
 * display parent and `rank` is minted PER SIBLING GROUP (`a0, a1, …`), which is
 * what makes cross-group alias ranks collide.
 */
type Row = {
  id: string;
  parentId: string | null;
  rank: string;
  /**
   * The row's ALIAS PARENTS: the ids under which this row ALSO appears as a
   * reference leaf. Mirrors the pages sidebar's `linkSourcesByTarget.get(b.id)`
   * — the pages that link TO this one, not the pages it links to.
   */
  aliasParents: string[];
};

const row = (
  id: string,
  parentId: string | null,
  rank: string,
  aliasParents: string[] = [],
): Row => ({ id, parentId, rank, aliasParents });

const hierarchy: HierarchyConfig<Row> = {
  getParentId: (r) => r.parentId,
  getRank: (r) => Rank.from(r.rank),
  getAliasParents: (r) => r.aliasParents,
};

const project = (rows: Row[]) =>
  projectRows({
    rows,
    rowKey: (r) => r.id,
    hierarchy,
    expanded: undefined,
    defaultExpanded: undefined,
  });

describe("alias rank minting", () => {
  test("gives two aliases under one parent distinct ranks, both after the last real sibling", () => {
    // `host` has real children c1(a0), c2(a1). Two OTHER pages (x, y) are also
    // aliased under `host`, and each is the first child of its own parent — so
    // both carry `a0`, colliding with c1 and with each other under the old
    // "an alias keeps its row's own rank" behavior.
    const rows = [
      row("host", null, "a0"),
      row("c1", "host", "a0"),
      row("c2", "host", "a1"),
      row("otherA", null, "a1"),
      row("otherB", null, "a2"),
      row("x", "otherA", "a0", ["host"]),
      row("y", "otherB", "a0", ["host"]),
    ];

    const { projected } = project(rows);
    const underHost = projected.filter((p) => p.parentId === "host");
    const aliases = underHost.filter((p) => p.alias);
    expect(aliases).toHaveLength(2);

    // Distinct from each other...
    expect(Rank.equals(aliases[0]!.rank, aliases[1]!.rank)).toBe(false);

    // ...and every alias sorts strictly after every real sibling (a1 = c2, the
    // last real child), which is also their display order (appended last).
    const lastReal = Rank.from("a1");
    for (const alias of aliases) {
      expect(Rank.compare(alias.rank, lastReal)).toBe(1);
    }

    // Rank order agrees with array (display) order across the whole child list.
    const byRank = [...underHost].sort((a, b) => Rank.compare(a.rank, b.rank));
    expect(byRank.map((p) => p.id)).toEqual(underHost.map((p) => p.id));
  });

  test("an alias sorts after every real sibling even when it would borrow their rank", () => {
    // The alias of `x` (first child of otherA ⇒ rank a0) lands under `host`
    // beside host's own first child c1 (also a0). Borrowing the referenced
    // row's rank would put the two at the same key; minting keeps the alias
    // strictly last, which is where it renders.
    //
    // This used to also be a DROP hazard — the duplicate made
    // `Rank.between(a0, a0)` throw inside `computeDrop`, silently swallowing
    // drags on the REAL rows beside the alias. The drop path no longer mints a
    // rank at all (`resolveDropParent` is anchor-only), so what is left to pin
    // is the display invariant: rank order agrees with paint order.
    const rows = [
      row("host", null, "a0"),
      row("c1", "host", "a0"),
      row("c2", "host", "a1"),
      row("otherA", null, "a1"),
      row("x", "otherA", "a0", ["host"]),
    ];

    const { projected } = project(rows);
    const underHost = projected.filter((p) => p.parentId === "host");
    expect(underHost.map((p) => realNodeId(p.id))).toEqual(["c1", "c2", "x"]);
    const alias = underHost.find((p) => p.alias)!;
    expect(Rank.compare(alias.rank, Rank.from("a1"))).toBe(1);
    // …and the drop that used to be swallowed resolves normally: `c2` after
    // `c1` is a plain sibling anchor under `host`, with no rank arithmetic.
    expect(resolveDropParent(projected, "c2", "after", "c1")).toEqual({
      parentId: "host",
    });
  });

  test("still mints distinct ranks when the host parent has no real children", () => {
    const rows = [
      row("host", null, "a0"),
      row("otherA", null, "a1"),
      row("x", "otherA", "a0", ["host"]),
      row("y", "otherA", "a1", ["host"]),
    ];

    const { projected } = project(rows);
    const aliases = projected.filter((p) => p.parentId === "host" && p.alias);
    expect(aliases).toHaveLength(2);
    expect(Rank.equals(aliases[0]!.rank, aliases[1]!.rank)).toBe(false);
    expect(Rank.compare(aliases[0]!.rank, aliases[1]!.rank)).toBe(-1);
  });
});
