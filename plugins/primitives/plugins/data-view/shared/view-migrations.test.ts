import { describe, expect, test } from "bun:test";
import type { JsonValue } from "@plugins/config_v2/core";
import { treeViewToTable } from "./view-migrations";

const filter: JsonValue = {
  kind: "group",
  id: "hide-done",
  conjunction: "and",
  children: [
    {
      kind: "rule",
      id: "status",
      fieldId: "status",
      operatorId: "is-none-of",
      value: ["done"],
    },
  ],
};

describe("tree-view-to-table", () => {
  test("a tree row becomes an outline table, keeping every other key", () => {
    const doc: JsonValue = {
      views: [
        {
          id: "deps",
          name: "Dependencies",
          icon: "account-tree",
          source: "deps",
          view: {
            type: "tree",
            sort: [{ fieldId: "title", direction: "asc" }],
            filter,
            filterScope: "roots",
            groupBy: { fieldId: "status", groupingId: "value" },
            visibleFields: ["title", "status"],
            hideWhenEmpty: true,
          },
        },
      ],
      filterPresets: [],
    };
    expect(treeViewToTable.apply(doc)).toEqual({
      views: [
        {
          id: "deps",
          name: "Dependencies",
          icon: "account-tree",
          source: "deps",
          view: {
            type: "table",
            presentation: "outline",
            sort: [{ fieldId: "title", direction: "asc" }],
            filter,
            filterScope: "roots",
            groupBy: { fieldId: "status", groupingId: "value" },
            visibleFields: ["title", "status"],
            hideWhenEmpty: true,
          },
        },
      ],
      filterPresets: [],
    });
  });

  test("writes `type`, `presentation`, then the rest, in that order", () => {
    // The hash of a config is over its serialized JSON: a migrated user
    // origin must serialize exactly as the hand-edited committed row does.
    const doc: JsonValue = {
      views: [
        {
          id: "t",
          name: "T",
          view: { type: "tree", sort: [], visibleFields: ["a"] },
        },
      ],
    };
    const out = treeViewToTable.apply(doc) as { views: { view: object }[] };
    expect(Object.keys(out.views[0]!.view)).toEqual([
      "type",
      "presentation",
      "sort",
      "visibleFields",
    ]);
  });

  test("a row with no picked icon keeps the tree's glyph", () => {
    const doc: JsonValue = {
      views: [
        { id: "a", name: "A", view: { type: "tree" } },
        { id: "b", name: "B", icon: "star", view: { type: "tree" } },
      ],
    };
    const out = treeViewToTable.apply(doc) as {
      views: { icon?: string }[];
    };
    expect(out.views.map((r) => r.icon)).toEqual(["account-tree", "star"]);
  });

  test("other view types are untouched", () => {
    const doc: JsonValue = {
      views: [
        { id: "grid", name: "Grid", view: { type: "table" } },
        { id: "list", name: "List", view: { type: "list", sort: [] } },
        { id: "tree", name: "Tree", view: { type: "tree" } },
      ],
    };
    const out = treeViewToTable.apply(doc) as {
      views: { view: JsonValue }[];
    };
    expect(out.views.map((r) => r.view)).toEqual([
      { type: "table" },
      { type: "list", sort: [] },
      { type: "table", presentation: "outline" },
    ]);
  });

  test("idempotent: a migrated document comes back unchanged", () => {
    const doc: JsonValue = {
      views: [{ id: "t", name: "T", view: { type: "tree", sort: [] } }],
    };
    const once = treeViewToTable.apply(doc);
    const twice = treeViewToTable.apply(once);
    expect(twice).toEqual(once);
    // Nothing to do → the very same document, not a copy.
    expect(twice).toBe(once);
  });

  test("a document without views, or not an object, passes through", () => {
    const empty: JsonValue = { sortPresets: [] };
    expect(treeViewToTable.apply(empty)).toBe(empty);
    expect(treeViewToTable.apply(null)).toBeNull();
    expect(treeViewToTable.apply([1, 2])).toEqual([1, 2]);
  });
});
