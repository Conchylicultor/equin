import { describe, expect, test } from "bun:test";
import {
  extendTarget,
  nextRowSelection,
  type RowSelectionState,
} from "./row-selection";

// The painted order of a tree whose folder "b" is collapsed: its children
// ("b1", "b2") are not lines, so no range can reach them.
const PAINTED = ["a", "b", "c", "d", "e"];

const EMPTY: RowSelectionState = { selected: new Set(), anchor: null };

function sel(ids: string[], anchor: string | null): RowSelectionState {
  return { selected: new Set(ids), anchor };
}

const ids = (s: RowSelectionState) => [...s.selected].sort();

describe("nextRowSelection", () => {
  test("click selects exactly the row and anchors on it", () => {
    const next = nextRowSelection(
      sel(["a", "c"], "a"),
      { kind: "click", id: "d" },
      PAINTED,
    );
    expect(ids(next)).toEqual(["d"]);
    expect(next.anchor).toBe("d");
  });

  test("toggle flips the row and moves the anchor to it", () => {
    const added = nextRowSelection(
      sel(["a"], "a"),
      { kind: "toggle", id: "c" },
      PAINTED,
    );
    expect(ids(added)).toEqual(["a", "c"]);
    expect(added.anchor).toBe("c");
    const removed = nextRowSelection(
      added,
      { kind: "toggle", id: "a" },
      PAINTED,
    );
    expect(ids(removed)).toEqual(["c"]);
    expect(removed.anchor).toBe("a");
  });

  test("range replaces the selection with the span, keeping the anchor", () => {
    const next = nextRowSelection(
      sel(["a", "e"], "d"),
      { kind: "range", id: "b" },
      PAINTED,
    );
    expect(ids(next)).toEqual(["b", "c", "d"]);
    expect(next.anchor).toBe("d");
  });

  test("range runs over the painted order: a collapsed folder's children are skipped", () => {
    const next = nextRowSelection(
      sel(["a"], "a"),
      { kind: "range", id: "c" },
      PAINTED,
    );
    expect(ids(next)).toEqual(["a", "b", "c"]);
    expect(next.selected.has("b1")).toBe(false);
  });

  test("additive range keeps what is selected outside the span", () => {
    const next = nextRowSelection(
      sel(["e"], "a"),
      { kind: "range", id: "b", additive: true },
      PAINTED,
    );
    expect(ids(next)).toEqual(["a", "b", "e"]);
  });

  test("range without a usable anchor is a click", () => {
    const none = nextRowSelection(EMPTY, { kind: "range", id: "c" }, PAINTED);
    expect(ids(none)).toEqual(["c"]);
    expect(none.anchor).toBe("c");
    const gone = nextRowSelection(
      sel(["x"], "x"),
      { kind: "range", id: "c" },
      PAINTED,
    );
    expect(ids(gone)).toEqual(["c"]);
    const additive = nextRowSelection(
      sel(["a"], null),
      { kind: "range", id: "c", additive: true },
      PAINTED,
    );
    expect(ids(additive)).toEqual(["a", "c"]);
    expect(additive.anchor).toBe("c");
  });

  test("extend grows and shrinks the range from the anchor", () => {
    let s = nextRowSelection(EMPTY, { kind: "click", id: "c" }, PAINTED);
    s = nextRowSelection(s, { kind: "extend", from: "c", delta: 1 }, PAINTED);
    expect(ids(s)).toEqual(["c", "d"]);
    s = nextRowSelection(s, { kind: "extend", from: "d", delta: 1 }, PAINTED);
    expect(ids(s)).toEqual(["c", "d", "e"]);
    // Back up past the anchor: the range flips to the other side.
    s = nextRowSelection(s, { kind: "extend", from: "e", delta: -1 }, PAINTED);
    s = nextRowSelection(s, { kind: "extend", from: "d", delta: -1 }, PAINTED);
    s = nextRowSelection(s, { kind: "extend", from: "c", delta: -1 }, PAINTED);
    expect(ids(s)).toEqual(["b", "c"]);
    expect(s.anchor).toBe("c");
  });

  test("extend clamps at the ends and anchors on the focused row when there is none", () => {
    const s = nextRowSelection(
      EMPTY,
      { kind: "extend", from: "e", delta: 1 },
      PAINTED,
    );
    expect(ids(s)).toEqual(["e"]);
    expect(s.anchor).toBe("e");
    expect(extendTarget(PAINTED, "a", -1)).toBe("a");
    expect(extendTarget(PAINTED, "zzz", 1)).toBeNull();
  });

  test("all selects every painted row and keeps the anchor", () => {
    const next = nextRowSelection(sel(["b"], "b"), { kind: "all" }, PAINTED);
    expect(ids(next)).toEqual([...PAINTED].sort());
    expect(next.anchor).toBe("b");
  });

  test("clear empties the set and drops the anchor", () => {
    const next = nextRowSelection(
      sel(["a", "b"], "a"),
      { kind: "clear" },
      PAINTED,
    );
    expect(next.selected.size).toBe(0);
    expect(next.anchor).toBeNull();
  });

  test("returns the same object when nothing changed", () => {
    const s = sel(["b", "c", "d"], "b");
    expect(nextRowSelection(s, { kind: "range", id: "d" }, PAINTED)).toBe(s);
    expect(nextRowSelection(EMPTY, { kind: "clear" }, PAINTED)).toBe(EMPTY);
    const one = sel(["c"], "c");
    expect(nextRowSelection(one, { kind: "click", id: "c" }, PAINTED)).toBe(
      one,
    );
    // Same members, moved anchor: a real change.
    expect(
      nextRowSelection(sel(["c"], "a"), { kind: "click", id: "c" }, PAINTED),
    ).not.toBe(one);
  });
});
