import { describe, expect, it } from "bun:test";
import type { SortRule } from "../../core";
import { normalizeSortRules, splitPinned } from "./pinned-sort";

const pin = (fieldId: string): SortRule => ({
  fieldId,
  direction: "asc",
  pinned: true,
});
const user = (fieldId: string): SortRule => ({ fieldId, direction: "desc" });

describe("splitPinned", () => {
  it("partitions into pinned and user rules, each in list order", () => {
    expect(splitPinned([user("a"), pin("b"), user("c"), pin("d")])).toEqual({
      pinned: [pin("b"), pin("d")],
      user: [user("a"), user("c")],
    });
  });

  it("splits an empty list into two empty segments", () => {
    expect(splitPinned([])).toEqual({ pinned: [], user: [] });
  });
});

describe("normalizeSortRules", () => {
  it("moves pinned rules to the front, stably", () => {
    expect(
      normalizeSortRules([user("a"), pin("b"), user("c"), pin("d")]),
    ).toEqual([pin("b"), pin("d"), user("a"), user("c")]);
  });

  it("returns the same array when the invariant already holds", () => {
    const rules = [pin("b"), user("a")];
    expect(normalizeSortRules(rules)).toBe(rules);
    const none: SortRule[] = [user("a"), user("c")];
    expect(normalizeSortRules(none)).toBe(none);
  });
});
