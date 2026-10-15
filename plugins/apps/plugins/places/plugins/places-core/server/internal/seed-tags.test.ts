import { expect, test } from "bun:test";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { TAG_ROLES } from "../../core/internal/tag-tree";
import { SEED_TAGS } from "./seed-tags";

test("seed keys are unique and every parent precedes its children", () => {
  const seen = new Set<string>();
  for (const tag of SEED_TAGS) {
    expect(seen.has(tag.key)).toBe(false);
    if (tag.parent !== undefined) expect(seen.has(tag.parent)).toBe(true);
    seen.add(tag.key);
  }
});

test("each role is held by exactly one seed tag", () => {
  for (const role of TAG_ROLES) {
    expect(SEED_TAGS.filter((t) => t.role === role)).toHaveLength(1);
  }
});

test("every seed icon is an installed Material Symbols name", () => {
  const bad = SEED_TAGS.filter((t) => !isSavedSymbolName(t.icon));
  expect(bad.map((t) => t.icon)).toEqual([]);
});

test("seed google types are unique per tag and colours are #rrggbb", () => {
  for (const tag of SEED_TAGS) {
    const types = tag.googleTypes ?? [];
    expect(new Set(types).size).toBe(types.length);
    if (tag.color !== undefined) expect(tag.color).toMatch(/^#[0-9a-f]{6}$/);
  }
});
