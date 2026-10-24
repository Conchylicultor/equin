import { expect, test } from "bun:test";
import type { FilterGroup } from "@plugins/primitives/plugins/data-view/core";
import type { TagNode } from "@plugins/tag-tree/plugins/engine/core";
import {
  EMPTY_SIDEBAR_STATE,
  applySidebarClick,
  applySidebarState,
  hasPickedDescendant,
  includeTag,
  mergeRows,
  moveTag,
  presetAutoName,
  presetIcon,
  removeTag,
  rootOf,
  sidebarState,
  splitRow,
  tagFilterState,
  toggleTag,
  withoutSidebarRules,
  type SidebarState,
} from "./sidebar-filter";

interface TestTag extends TagNode {
  name: string;
  icon: string | null;
}

function tag(
  id: string,
  parentId: string | null,
  name = id,
  icon: string | null = null,
): TestTag {
  return {
    id,
    parentId,
    name,
    icon,
    color: null,
    rank: "a0",
    childColors: null,
  };
}

const TAGS: TestTag[] = [
  tag("want", null, "Want to go", "bookmark"),
  tag("been", null, "Been"),
  tag("food", null, "Food", "restaurant"),
  tag("restaurants", "food", "Restaurants"),
  tag("italian", "restaurants", "Italian"),
  tag("coffee", "food", "Coffee"),
  tag("culture", null, "Culture"),
  tag("museums", "culture", "Museums", "museum"),
  tag("viewpoints", "culture", "Viewpoints"),
];

function minter() {
  let n = 0;
  return () => `id${++n}`;
}

const CITY_RULE = {
  kind: "rule",
  id: "city",
  fieldId: "address",
  operatorId: "contains",
  value: "Paris",
} as const;

function values(filter: FilterGroup | null): unknown[] {
  return (filter?.children ?? []).map((c) => c.kind === "rule" && c.value);
}

test("an empty filter reads as nothing picked", () => {
  expect(sidebarState(null)).toEqual(EMPTY_SIDEBAR_STATE);
});

test("rootOf is the top ancestor", () => {
  expect(rootOf("italian", TAGS)).toBe("food");
  expect(rootOf("food", TAGS)).toBe("food");
  expect(rootOf("museums", TAGS)).toBe("culture");
});

test("clicking toggles off ↔ include, keeping other rules", () => {
  const mint = minter();
  const start: FilterGroup = {
    kind: "group",
    id: "root",
    conjunction: "and",
    children: [CITY_RULE],
  };
  const included = applySidebarClick(start, "food", TAGS, mint);
  expect(included).toEqual({
    kind: "group",
    id: "root",
    conjunction: "and",
    children: [
      {
        kind: "rule",
        id: "id1",
        fieldId: "tags",
        operatorId: "has-nested",
        value: ["food"],
      },
      CITY_RULE,
    ],
  });
  expect(applySidebarClick(included, "food", TAGS, mint)).toEqual(start);
});

test("a click never excludes; clicking a tag excluded in the advanced filter drops it", () => {
  const s: SidebarState = { rows: [["food"]], exclude: ["been"] };
  expect(toggleTag(s, "been", TAGS)).toEqual({ rows: [["food"]], exclude: [] });
});

test("the last sidebar rule removed from a sidebar-only filter clears it", () => {
  const mint = minter();
  const one = applySidebarClick(null, "culture", TAGS, mint);
  expect(applySidebarClick(one, "culture", TAGS, mint)).toBeNull();
});

test("(Museums or Viewpoints) and Want to go, built by clicks", () => {
  const mint = minter();
  let f = applySidebarClick(null, "museums", TAGS, mint);
  f = applySidebarClick(f, "want", TAGS, mint);
  // Viewpoints shares Museums' root (Culture): it joins that row, or-ed.
  f = applySidebarClick(f, "viewpoints", TAGS, mint);
  expect(sidebarState(f)).toEqual({
    rows: [["museums", "viewpoints"], ["want"]],
    exclude: [],
  });
  expect(f?.children).toEqual([
    {
      kind: "rule",
      id: "id2",
      fieldId: "tags",
      operatorId: "has-nested",
      value: ["museums", "viewpoints"],
    },
    {
      kind: "rule",
      id: "id3",
      fieldId: "tags",
      operatorId: "has-nested",
      value: ["want"],
    },
  ]);
  expect(presetAutoName(sidebarState(f), TAGS)).toBe(
    "Museums or Viewpoints · Want to go",
  );
  expect(presetIcon(sidebarState(f), TAGS)).toBe("museum");
});

test("the same filter built by clicks across roots, then a merge", () => {
  // Want to go and Museums are different roots: two rows, AND-ed.
  let s: SidebarState = EMPTY_SIDEBAR_STATE;
  s = includeTag(s, "museums", TAGS);
  s = includeTag(s, "want", TAGS);
  expect(s.rows).toEqual([["museums"], ["want"]]);
  // Merge them: Museums or Want to go.
  expect(mergeRows(s, 0).rows).toEqual([["museums", "want"]]);
});

test("split, merge and move", () => {
  const s0 = { rows: [["museums", "viewpoints"], ["want"]], exclude: [] };
  // Split the culture row at its `or`: three rows, all AND-ed.
  const split = splitRow(s0, 0, 1);
  expect(split.rows).toEqual([["museums"], ["viewpoints"], ["want"]]);
  // Merge the last two: Viewpoints or Want to go.
  expect(mergeRows(split, 1).rows).toEqual([
    ["museums"],
    ["viewpoints", "want"],
  ]);
  // Drag Want to go onto the first row; its own row empties and goes.
  expect(moveTag(split, "want", 0).rows).toEqual([
    ["museums", "want"],
    ["viewpoints"],
  ]);
  // Drag Museums onto "and …": a row of its own, last.
  expect(moveTag(s0, "museums", "new").rows).toEqual([
    ["viewpoints"],
    ["want"],
    ["museums"],
  ]);
  // A move to a row after an emptied one keeps aiming at the same row.
  expect(moveTag(split, "museums", 2).rows).toEqual([
    ["viewpoints"],
    ["want", "museums"],
  ]);
});

test("split / merge / move out of range throw", () => {
  const s = { rows: [["museums", "viewpoints"]], exclude: [] };
  expect(() => splitRow(s, 0, 0)).toThrow();
  expect(() => splitRow(s, 0, 2)).toThrow();
  expect(() => splitRow(s, 1, 1)).toThrow();
  expect(() => mergeRows(s, 0)).toThrow();
  expect(() => moveTag(s, "museums", 3)).toThrow();
});

test("old any / all filters read back as rows", () => {
  const rule = (id: string, operatorId: string, value: string[]) => ({
    kind: "rule" as const,
    id,
    fieldId: "tags",
    operatorId,
    value,
  });
  const any: FilterGroup = {
    kind: "group",
    id: "root",
    conjunction: "and",
    children: [
      rule("a", "has-nested", ["food", "culture"]),
      rule("x", "lacks-nested", ["been"]),
    ],
  };
  expect(sidebarState(any)).toEqual({
    rows: [["food", "culture"]],
    exclude: ["been"],
  });
  const all: FilterGroup = {
    ...any,
    children: [
      rule("a", "has-nested", ["food"]),
      rule("b", "has-nested", ["culture"]),
      rule("x", "lacks-nested", ["been"]),
    ],
  };
  expect(sidebarState(all)).toEqual({
    rows: [["food"], ["culture"]],
    exclude: ["been"],
  });
  // Round trip: same rules, same ids.
  expect(applySidebarState(all, sidebarState(all), minter())).toEqual(all);
});

test("rows write one rule each, ids reused in order", () => {
  const mint = minter();
  const state: SidebarState = {
    rows: [["food", "coffee"], ["culture"]],
    exclude: ["been"],
  };
  const f = applySidebarState(null, state, mint);
  expect(values(f)).toEqual([["food", "coffee"], ["culture"], ["been"]]);
  expect(sidebarState(f)).toEqual(state);
  const merged = applySidebarState(f, mergeRows(state, 0), mint);
  expect(values(merged)).toEqual([["food", "coffee", "culture"], ["been"]]);
  expect(merged?.children.map((c) => c.id)).toEqual(["id2", "id3"]);
});

test("an or root is wrapped, never rewritten", () => {
  const mint = minter();
  const orRoot: FilterGroup = {
    kind: "group",
    id: "or",
    conjunction: "or",
    children: [CITY_RULE],
  };
  expect(sidebarState(orRoot).rows).toEqual([]);
  const next = applySidebarClick(orRoot, "food", TAGS, mint);
  expect(next?.conjunction).toBe("and");
  expect(next?.children[1]).toBe(orRoot);
});

test("nested groups are not the sidebar's", () => {
  const nested: FilterGroup = {
    kind: "group",
    id: "root",
    conjunction: "and",
    children: [
      {
        kind: "group",
        id: "g",
        conjunction: "or",
        children: [
          {
            kind: "rule",
            id: "r",
            fieldId: "tags",
            operatorId: "has-nested",
            value: ["food"],
          },
        ],
      },
    ],
  };
  expect(sidebarState(nested).rows).toEqual([]);
  expect(withoutSidebarRules(nested)).toBe(nested);
});

test("including a tag replaces the included tags it subsumes or narrows", () => {
  const s0 = { rows: [["italian"], ["culture"]], exclude: [] };
  expect(includeTag(s0, "food", TAGS).rows).toEqual([["culture"], ["food"]]);
  const s1 = { rows: [["food"]], exclude: [] };
  expect(includeTag(s1, "coffee", TAGS).rows).toEqual([["coffee"]]);
  // Same root, not nested: joins the row.
  const s2 = { rows: [["italian"], ["want"]], exclude: [] };
  expect(includeTag(s2, "coffee", TAGS).rows).toEqual([
    ["italian", "coffee"],
    ["want"],
  ]);
  // Including an excluded tag clears its exclusion.
  expect(includeTag({ rows: [], exclude: ["been"] }, "been", TAGS)).toEqual({
    rows: [["been"]],
    exclude: [],
  });
});

test("toggleTag takes an included tag out of its row, never into the excludes", () => {
  const s = { rows: [["museums", "viewpoints"], ["want"]], exclude: [] };
  expect(toggleTag(s, "want", TAGS)).toEqual({
    rows: [["museums", "viewpoints"]],
    exclude: [],
  });
  expect(toggleTag(s, "museums", TAGS)).toEqual({
    rows: [["viewpoints"], ["want"]],
    exclude: [],
  });
  // Off → include runs includeTag: it joins its root's row.
  expect(toggleTag({ rows: [["want"]], exclude: [] }, "coffee", TAGS)).toEqual({
    rows: [["want"], ["coffee"]],
    exclude: [],
  });
  expect(tagFilterState(s, "viewpoints")).toBe("include");
  expect(tagFilterState(s, "been")).toBe("off");
});

test("withoutSidebarRules keeps the rest, null when nothing is left", () => {
  const mint = minter();
  const f = applySidebarClick(
    { kind: "group", id: "root", conjunction: "and", children: [CITY_RULE] },
    "food",
    TAGS,
    mint,
  );
  expect(withoutSidebarRules(f)?.children).toEqual([CITY_RULE]);
  expect(
    withoutSidebarRules(applySidebarClick(null, "food", TAGS, mint)),
  ).toBeNull();
});

test("removeTag and the partial mark", () => {
  const s = { rows: [["italian"], ["want"]], exclude: ["been"] };
  expect(removeTag(s, "italian").rows).toEqual([["want"]]);
  expect(removeTag(s, "been").exclude).toEqual([]);
  expect(hasPickedDescendant(s, "food", TAGS)).toBe(true);
  expect(hasPickedDescendant(s, "restaurants", TAGS)).toBe(true);
  expect(hasPickedDescendant(s, "italian", TAGS)).toBe(false);
  expect(hasPickedDescendant(s, "culture", TAGS)).toBe(false);
});

test("preset name and icon", () => {
  expect(presetAutoName(EMPTY_SIDEBAR_STATE, TAGS)).toBe("New preset");
  expect(presetIcon(EMPTY_SIDEBAR_STATE, TAGS)).toBeNull();
  const s = { rows: [["italian"]], exclude: ["been"] };
  expect(presetAutoName(s, TAGS)).toBe("Italian · not Been");
  // Italian has no icon of its own: its nearest ancestor's (Food).
  expect(presetIcon(s, TAGS)).toBe("restaurant");
});
