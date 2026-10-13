import { describe, expect, it } from "bun:test";
import type { FieldDef, SortRule } from "../../core";
import { summarizeSort } from "./summarize-sort";

const sortableFields: FieldDef<unknown>[] = [
  { id: "updatedAt", label: "Updated", type: "date", value: () => 0 },
  { id: "title", label: "Title", type: "text", value: () => "" },
];

describe("summarizeSort", () => {
  it("says nothing when nothing is sorted", () => {
    expect(summarizeSort([], sortableFields)).toBeNull();
  });

  it("describes the top sort level with a direction glyph and a spoken word", () => {
    const rules: SortRule[] = [{ fieldId: "updatedAt", direction: "desc" }];
    expect(summarizeSort(rules, sortableFields)).toEqual({
      label: "Updated ↓",
      spoken: "Updated, descending",
      more: 0,
    });
  });

  it("counts the further levels as `more`", () => {
    const rules: SortRule[] = [
      { fieldId: "title", direction: "asc" },
      { fieldId: "updatedAt", direction: "desc" },
    ];
    expect(summarizeSort(rules, sortableFields)).toEqual({
      label: "Title ↑",
      spoken: "Title, ascending",
      more: 1,
    });
  });

  it("drops dangling rules exactly as the rule count does", () => {
    // A rule whose field left the schema (a removed custom column, a source
    // switch) sorts nothing, so it must not be described or counted — the same
    // filter `SortController.ruleCount` applies.
    const rules: SortRule[] = [
      { fieldId: "gone", direction: "asc" },
      { fieldId: "title", direction: "asc" },
      { fieldId: "alsoGone", direction: "desc" },
    ];
    expect(summarizeSort(rules, sortableFields)).toEqual({
      label: "Title ↑",
      spoken: "Title, ascending",
      more: 0,
    });
  });

  it("says nothing when every rule is dangling", () => {
    expect(
      summarizeSort([{ fieldId: "gone", direction: "asc" }], sortableFields),
    ).toBeNull();
  });

  it("marks a pinned top level with a pin glyph and says so aloud", () => {
    const rules: SortRule[] = [
      { fieldId: "title", direction: "asc", pinned: true },
      { fieldId: "updatedAt", direction: "desc" },
    ];
    expect(summarizeSort(rules, sortableFields)).toEqual({
      label: "📌 Title ↑",
      spoken: "Title, ascending, pinned",
      more: 1,
    });
  });
});
