/**
 * Tests for the whole-set expand-all — the pure half of `useFlatExpandAll`,
 * shared by a tree's toolbar expand-all and a group header's per-section
 * toggle.
 *
 * Two things it must keep getting right: `hasExpandable` is what decides whether
 * the button is rendered at all (a flat set has nothing to unfold, so it is
 * hidden rather than shown inert), and a flip writes only the rows that actually
 * change — the sink re-serializes its whole expand map per call.
 */

import { describe, expect, test } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { flatExpandAll } from "./use-flat-expand-all";

type Row = {
  id: string;
  parentId: string | null;
  rank: Rank;
  expanded: boolean;
};

/** `["a", "b<a", "c<a!"]` — `<p` names the parent, `!` marks it expanded. */
function rows(spec: string[]): Row[] {
  return spec.map((token) => {
    const expanded = token.endsWith("!");
    const [id, parentId] = token.replace("!", "").split("<");
    return {
      id: id!,
      parentId: parentId ?? null,
      rank: Rank.between(null, null),
      expanded,
    };
  });
}

describe("flatExpandAll", () => {
  test("a flat set has nothing to expand", () => {
    const state = flatExpandAll(rows(["a", "b", "c"]));
    expect(state.hasExpandable).toBe(false);
    // `allExpanded` is false rather than vacuously true, so the hidden button
    // cannot be revived reading "collapse all" over a set with no folders.
    expect(state.allExpanded).toBe(false);
    expect(state.changes(true)).toEqual([]);
  });

  test("only rows that some other row calls parent are expandable", () => {
    // `b` is a leaf, so its own `expanded: false` never makes the set partial.
    const state = flatExpandAll(rows(["a!", "b<a", "c<a!", "d<c"]));
    expect(state.hasExpandable).toBe(true);
    expect(state.allExpanded).toBe(true);
  });

  test("one closed parent makes the whole set partial", () => {
    const state = flatExpandAll(rows(["a!", "b<a", "c<a", "d<c"]));
    expect(state.allExpanded).toBe(false);
  });

  test("expanding emits only the rows that change", () => {
    const state = flatExpandAll(rows(["a!", "b<a", "c<a", "d<c"]));
    expect(state.changes(true)).toEqual([{ id: "c", expanded: true }]);
  });

  test("collapsing emits every open parent, in row order", () => {
    const state = flatExpandAll(rows(["a!", "b<a", "c<a!", "d<c"]));
    expect(state.changes(false)).toEqual([
      { id: "a", expanded: false },
      { id: "c", expanded: false },
    ]);
  });

  test("a flip to the state already held emits an empty batch", () => {
    const state = flatExpandAll(rows(["a!", "b<a", "c<a!", "d<c"]));
    expect(state.changes(true)).toEqual([]);
  });

  test("a parent that is not itself in the set is not written", () => {
    // A section bucket or a `rootId`-scoped tree can hold rows whose parent was
    // filtered out; naming it in the batch would write an id the host's expand
    // map has no row for.
    const state = flatExpandAll(rows(["b<missing", "c<b"]));
    expect(state.changes(true)).toEqual([{ id: "b", expanded: true }]);
  });
});
