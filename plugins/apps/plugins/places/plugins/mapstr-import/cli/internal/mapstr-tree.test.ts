import { expect, test } from "bun:test";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { MAPSTR_TREE } from "./mapstr-tree";
import { MAPSTR_TAGS } from "./tag-map";

test("tree keys are unique, every parent precedes its children, icons are installed", () => {
  const seen = new Set<string>();
  for (const tag of MAPSTR_TREE) {
    expect(seen.has(tag.key)).toBe(false);
    if (tag.parent !== undefined) expect(seen.has(tag.parent)).toBe(true);
    seen.add(tag.key);
  }
  expect(
    MAPSTR_TREE.filter((t) => !isSavedSymbolName(t.icon)).map((t) => t.icon),
  ).toEqual([]);
});

test("each role is held by exactly one tree tag", () => {
  expect(MAPSTR_TREE.filter((t) => t.role === "want")).toHaveLength(1);
  expect(MAPSTR_TREE.filter((t) => t.role === "been")).toHaveLength(1);
});

test("every tree tag but the parents of mapped children is some Mapstr tag's target", () => {
  const targets = new Set<string>(Object.values(MAPSTR_TAGS));
  const parents = new Set(MAPSTR_TREE.map((t) => t.parent));
  expect(
    MAPSTR_TREE.filter((t) => !targets.has(t.key) && !parents.has(t.key)).map(
      (t) => t.key,
    ),
  ).toEqual([]);
});
