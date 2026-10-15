import { expect, test } from "bun:test";
import type { FilterGroup } from "@plugins/primitives/plugins/data-view/core";
import type { TagNode } from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  applySidebarClick,
  applySidebarState,
  cycleTag,
  hasPickedDescendant,
  removeTag,
  sidebarState,
  withoutSidebarRules,
} from "./sidebar-filter";

function tag(id: string, parentId: string | null): TagNode {
  return {
    id,
    parentId,
    color: null,
    rank: 0,
    googleTypes: [],
    role: null,
    childColors: null,
  };
}

const TAGS: TagNode[] = [
  tag("want", null),
  tag("been", null),
  tag("food", null),
  tag("restaurants", "food"),
  tag("italian", "restaurants"),
  tag("coffee", "food"),
  tag("culture", null),
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

test("an empty filter reads as nothing picked", () => {
  expect(sidebarState(null)).toEqual({ include: [], exclude: [], mode: "any" });
});

test("clicking cycles off → include → exclude → off, keeping other rules", () => {
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
  const excluded = applySidebarClick(included, "food", TAGS, mint);
  expect(sidebarState(excluded)).toEqual({
    include: [],
    exclude: ["food"],
    mode: "any",
  });
  // The include rule's id is reused for the exclude rule: one rule, re-shaped.
  expect(excluded?.children[0]).toMatchObject({
    id: "id1",
    operatorId: "lacks-nested",
  });
  const off = applySidebarClick(excluded, "food", TAGS, mint);
  expect(off).toEqual({ ...start });
});

test("the last sidebar rule removed from a sidebar-only filter clears it", () => {
  const mint = minter();
  const one = applySidebarClick(null, "culture", TAGS, mint);
  const two = applySidebarClick(one, "culture", TAGS, mint);
  expect(applySidebarClick(two, "culture", TAGS, mint)).toBeNull();
});

test("any = one rule with every id; all = one rule per id", () => {
  const mint = minter();
  const state = {
    include: ["food", "culture"],
    exclude: ["been"],
    mode: "any" as const,
  };
  const any = applySidebarState(null, state, mint);
  expect(any?.children.map((c) => c.kind === "rule" && c.value)).toEqual([
    ["food", "culture"],
    ["been"],
  ]);
  expect(sidebarState(any)).toEqual(state);

  const all = applySidebarState(any, { ...state, mode: "all" }, mint);
  expect(all?.children.map((c) => c.kind === "rule" && c.value)).toEqual([
    ["food"],
    ["culture"],
    ["been"],
  ]);
  expect(sidebarState(all)).toEqual({ ...state, mode: "all" });
});

test("an or root is wrapped, never rewritten", () => {
  const mint = minter();
  const orRoot: FilterGroup = {
    kind: "group",
    id: "or",
    conjunction: "or",
    children: [CITY_RULE],
  };
  expect(sidebarState(orRoot).include).toEqual([]);
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
  expect(sidebarState(nested).include).toEqual([]);
  expect(withoutSidebarRules(nested)).toBe(nested);
});

test("including a tag replaces the included tags it subsumes or narrows", () => {
  const s0 = {
    include: ["italian", "culture"],
    exclude: [],
    mode: "any" as const,
  };
  expect(cycleTag(s0, "food", TAGS).include).toEqual(["culture", "food"]);
  const s1 = { include: ["food"], exclude: [], mode: "any" as const };
  expect(cycleTag(s1, "coffee", TAGS).include).toEqual(["coffee"]);
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
  const s = { include: ["italian"], exclude: ["been"], mode: "any" as const };
  expect(removeTag(s, "italian").include).toEqual([]);
  expect(removeTag(s, "been").exclude).toEqual([]);
  expect(hasPickedDescendant(s, "food", TAGS)).toBe(true);
  expect(hasPickedDescendant(s, "restaurants", TAGS)).toBe(true);
  expect(hasPickedDescendant(s, "italian", TAGS)).toBe(false);
  expect(hasPickedDescendant(s, "culture", TAGS)).toBe(false);
});
