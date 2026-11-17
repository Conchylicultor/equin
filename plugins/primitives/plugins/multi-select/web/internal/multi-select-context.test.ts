import { describe, expect, it } from "bun:test";
import {
  initialMultiSelectState,
  multiSelectReducer,
  type MultiSelectState,
} from "./multi-select-context";

function seeded(ids: readonly string[]): MultiSelectState {
  return multiSelectReducer(
    {
      orderedIds: [],
      selectedIds: new Set(),
      anchorId: null,
      isActive: false,
      restoring: null,
    },
    { type: "SET_ORDERED_IDS", ids },
  );
}

describe("multiSelectReducer SET_RANGE", () => {
  it("returns the same state object for an identical re-dispatch", () => {
    const base = seeded(["a", "b", "c", "d"]);
    const first = multiSelectReducer(base, {
      type: "SET_RANGE",
      anchorId: "a",
      targetId: "c",
    });
    expect(first).not.toBe(base);
    expect([...first.selectedIds]).toEqual(["a", "b", "c"]);

    const second = multiSelectReducer(first, {
      type: "SET_RANGE",
      anchorId: "a",
      targetId: "c",
    });
    expect(second).toBe(first);
  });

  it("still mints new state when the range genuinely changes", () => {
    const base = seeded(["a", "b", "c", "d"]);
    const first = multiSelectReducer(base, {
      type: "SET_RANGE",
      anchorId: "a",
      targetId: "b",
    });
    const grown = multiSelectReducer(first, {
      type: "SET_RANGE",
      anchorId: "a",
      targetId: "c",
    });
    expect(grown).not.toBe(first);
    expect([...grown.selectedIds]).toEqual(["a", "b", "c"]);
  });

  it("still mints new state when the set is identical but the anchor moved", () => {
    const base = seeded(["a", "b", "c", "d"]);
    const forward = multiSelectReducer(base, {
      type: "SET_RANGE",
      anchorId: "a",
      targetId: "c",
    });
    // Same three ids, opposite anchor — extendTo / shift-arrow grow from the
    // anchor, so this is a real change even though the selection looks equal.
    const flipped = multiSelectReducer(forward, {
      type: "SET_RANGE",
      anchorId: "c",
      targetId: "a",
    });
    expect(flipped).not.toBe(forward);
    expect(flipped.anchorId).toBe("c");
    expect([...flipped.selectedIds]).toEqual(["a", "b", "c"]);
  });

  it("keeps the selection identity stable across a drag that re-enters a row", () => {
    const base = seeded(["a", "b", "c", "d"]);
    let state = multiSelectReducer(base, {
      type: "SET_RANGE",
      anchorId: "b",
      targetId: "c",
    });
    const settled = state;
    // A pointer parked over row "c" re-applies the same range every frame.
    for (let i = 0; i < 10; i++) {
      state = multiSelectReducer(state, {
        type: "SET_RANGE",
        anchorId: "b",
        targetId: "c",
      });
    }
    expect(state).toBe(settled);
  });

  it("ignores a range whose endpoints are not in the ordered ids", () => {
    const base = seeded(["a", "b"]);
    expect(
      multiSelectReducer(base, {
        type: "SET_RANGE",
        anchorId: "a",
        targetId: "zzz",
      }),
    ).toBe(base);
  });
});

describe("multiSelectReducer CLEAR_ALL", () => {
  it("returns the same state object when nothing is selected", () => {
    const base = seeded(["a", "b"]);
    expect(multiSelectReducer(base, { type: "CLEAR_ALL" })).toBe(base);
  });

  it("still clears a live selection and drops the anchor", () => {
    const ranged = multiSelectReducer(seeded(["a", "b", "c"]), {
      type: "SET_RANGE",
      anchorId: "a",
      targetId: "b",
    });
    const cleared = multiSelectReducer(ranged, { type: "CLEAR_ALL" });
    expect(cleared).not.toBe(ranged);
    expect(cleared.selectedIds.size).toBe(0);
    expect(cleared.anchorId).toBeNull();
    expect(cleared.isActive).toBe(false);
  });
});

describe("a kept selection", () => {
  const kept = { selected: ["b", "gone"], anchor: "b" };

  it("is applied at mount for the rows already there; an absent row's id keeps waiting", () => {
    const state = initialMultiSelectState({ kept, orderedIds: ["a", "b"] });
    expect([...state.selectedIds]).toEqual(["b"]);
    expect(state.anchorId).toBe("b");
    expect(state.isActive).toBe(true);
    // Not in this list (yet, or ever): it never shows, and is dropped by the
    // next gesture on the selection.
    expect(state.restoring).toEqual({ selected: ["gone"], anchor: null });
  });

  it("waits through an empty (loading) list for its rows", () => {
    const loading = initialMultiSelectState({ kept, orderedIds: [] });
    expect(loading.selectedIds.size).toBe(0);
    expect(loading.restoring).toBe(kept);
    const loaded = multiSelectReducer(loading, {
      type: "SET_ORDERED_IDS",
      ids: ["a", "b", "c"],
    });
    expect([...loaded.selectedIds]).toEqual(["b"]);
    expect(loaded.restoring).toEqual({ selected: ["gone"], anchor: null });
  });
});

describe("multiSelectReducer — a kept selection arriving with its rows", () => {
  const kept = { selected: ["root", "child-1", "child-2"], anchor: "child-1" };

  it("adds each kept id when its row arrives, never pruning one that has not yet", () => {
    // The root level lands first; the open parent's children later.
    let state = initialMultiSelectState({
      kept,
      orderedIds: ["root", "other"],
    });
    expect([...state.selectedIds]).toEqual(["root"]);
    expect(state.restoring).toEqual({
      selected: ["child-1", "child-2"],
      anchor: "child-1",
    });

    state = multiSelectReducer(state, {
      type: "SET_ORDERED_IDS",
      ids: ["root", "child-1", "child-2", "other"],
    });
    expect([...state.selectedIds].sort()).toEqual([
      "child-1",
      "child-2",
      "root",
    ]);
    expect(state.anchorId).toBe("child-1");
    expect(state.restoring).toBeNull();
  });

  it("ends the restore on a clear made before the kept rows landed", () => {
    let state = initialMultiSelectState({ kept, orderedIds: [] });
    state = multiSelectReducer(state, { type: "CLEAR_ALL" });
    expect(state.restoring).toBeNull();
    state = multiSelectReducer(state, {
      type: "SET_ORDERED_IDS",
      ids: ["root", "child-1", "child-2"],
    });
    expect(state.selectedIds.size).toBe(0);
  });
});
