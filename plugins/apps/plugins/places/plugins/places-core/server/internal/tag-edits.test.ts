import { expect, test } from "bun:test";
import type { TagNode, TagRole } from "../../core";
import { editPlaceTags, replaceDeletedTag } from "./tag-edits";

// Readable ids for legibility; the role tags are found by role, not id.
function tag(id: string, role: TagRole | null = null): TagNode {
  return {
    id,
    parentId: null,
    color: null,
    rank: 0,
    googleTypes: [],
    role,
    childColors: null,
  };
}
const KNOWN = [
  tag("want", "want"),
  tag("been", "been"),
  tag("food"),
  tag("coffee"),
  tag("kids"),
];
const PLACE = { tags: ["coffee", "kids", "want"], autoTags: ["coffee"] };

test("tags replace the list, deduplicated; autoTags follow", () => {
  expect(editPlaceTags(PLACE, { tags: ["kids", "kids"] }, KNOWN)).toEqual({
    ok: true,
    tags: ["kids"],
    autoTags: [],
  });
});

test("Been and Want to go are independent: both, either or neither", () => {
  expect(
    editPlaceTags(PLACE, { tags: ["coffee", "want", "been"] }, KNOWN),
  ).toEqual({
    ok: true,
    tags: ["coffee", "want", "been"],
    autoTags: ["coffee"],
  });
  expect(editPlaceTags(PLACE, { tags: ["coffee"] }, KNOWN)).toEqual({
    ok: true,
    tags: ["coffee"],
    autoTags: ["coffee"],
  });
});

test("no tags in the patch keeps the list", () => {
  expect(editPlaceTags(PLACE, {}, KNOWN)).toEqual({ ok: true, ...PLACE });
});

test("unknown tags are refused", () => {
  expect(editPlaceTags(PLACE, { tags: ["nope"] }, KNOWN).ok).toBe(false);
});

test("a deleted tag is replaced by its parent, once, and leaves autoTags", () => {
  expect(
    replaceDeletedTag(
      { tags: ["coffee", "food", "want"], autoTags: ["coffee"] },
      "coffee",
      "food",
    ),
  ).toEqual({ tags: ["food", "want"], autoTags: [] });
  expect(replaceDeletedTag(PLACE, "kids", null)).toEqual({
    tags: ["coffee", "want"],
    autoTags: ["coffee"],
  });
});
