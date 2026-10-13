import { describe, expect, it } from "bun:test";
import type { SortRule } from "../../core";
import { cyclePrimarySort } from "./sort-cycle";

describe("cyclePrimarySort", () => {
  it("seeds a primary asc rule from an empty list", () => {
    expect(cyclePrimarySort([], "name")).toEqual([
      { fieldId: "name", direction: "asc" },
    ]);
  });

  it("flips primary asc → desc, preserving secondary rules in order", () => {
    const rules: SortRule[] = [
      { fieldId: "name", direction: "asc" },
      { fieldId: "num", direction: "desc" },
    ];
    expect(cyclePrimarySort(rules, "name")).toEqual([
      { fieldId: "name", direction: "desc" },
      { fieldId: "num", direction: "desc" },
    ]);
  });

  it("drops primary on desc, promoting the secondary list up", () => {
    const rules: SortRule[] = [
      { fieldId: "name", direction: "desc" },
      { fieldId: "num", direction: "asc" },
    ];
    expect(cyclePrimarySort(rules, "name")).toEqual([
      { fieldId: "num", direction: "asc" },
    ]);
  });

  it("promotes a secondary field to primary asc, removing its old slot (no dup)", () => {
    const rules: SortRule[] = [
      { fieldId: "name", direction: "asc" },
      { fieldId: "num", direction: "desc" },
    ];
    expect(cyclePrimarySort(rules, "num")).toEqual([
      { fieldId: "num", direction: "asc" },
      { fieldId: "name", direction: "asc" },
    ]);
  });

  it("prepends an absent field asc, keeping existing rules after it", () => {
    const rules: SortRule[] = [
      { fieldId: "name", direction: "asc" },
      { fieldId: "num", direction: "desc" },
    ];
    expect(cyclePrimarySort(rules, "when")).toEqual([
      { fieldId: "when", direction: "asc" },
      { fieldId: "name", direction: "asc" },
      { fieldId: "num", direction: "desc" },
    ]);
  });

  it("preserves the remaining secondary rules when cycling a 3-rule list", () => {
    const rules: SortRule[] = [
      { fieldId: "a", direction: "asc" },
      { fieldId: "b", direction: "asc" },
      { fieldId: "c", direction: "desc" },
    ];
    // primary asc → desc: tail (b, c) untouched.
    expect(cyclePrimarySort(rules, "a")).toEqual([
      { fieldId: "a", direction: "desc" },
      { fieldId: "b", direction: "asc" },
      { fieldId: "c", direction: "desc" },
    ]);
    // promote secondary `c`: removed from its old slot, b stays in order.
    expect(cyclePrimarySort(rules, "c")).toEqual([
      { fieldId: "c", direction: "asc" },
      { fieldId: "a", direction: "asc" },
      { fieldId: "b", direction: "asc" },
    ]);
  });

  it("does not mutate the input array", () => {
    const rules: SortRule[] = [
      { fieldId: "name", direction: "asc" },
      { fieldId: "num", direction: "desc" },
    ];
    const snapshot = JSON.parse(JSON.stringify(rules));
    cyclePrimarySort(rules, "num");
    expect(rules).toEqual(snapshot);
  });

  describe("pinned rules", () => {
    const folders: SortRule = {
      fieldId: "folders",
      direction: "asc",
      pinned: true,
    };

    it("a header click on a user field keeps the pinned prefix in front", () => {
      expect(cyclePrimarySort([folders], "when")).toEqual([
        folders,
        { fieldId: "when", direction: "asc" },
      ]);
      expect(
        cyclePrimarySort(
          [folders, { fieldId: "when", direction: "asc" }],
          "when",
        ),
      ).toEqual([folders, { fieldId: "when", direction: "desc" }]);
    });

    it("cycling the primary to empty keeps the pinned rules", () => {
      expect(
        cyclePrimarySort(
          [folders, { fieldId: "when", direction: "desc" }],
          "when",
        ),
      ).toEqual([folders]);
    });

    it("a click on a pinned field flips its direction, never removing it", () => {
      const rules: SortRule[] = [
        folders,
        { fieldId: "when", direction: "asc" },
      ];
      const once = cyclePrimarySort(rules, "folders");
      expect(once).toEqual([
        { ...folders, direction: "desc" },
        { fieldId: "when", direction: "asc" },
      ]);
      expect(cyclePrimarySort(once, "folders")).toEqual(rules);
    });
  });
});
