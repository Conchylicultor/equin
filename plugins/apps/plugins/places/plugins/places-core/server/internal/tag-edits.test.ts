import { expect, test } from "bun:test";
import type { TagNode, TagRole } from "../../core";
import { editPlaceTags, replaceDeletedTag } from "./tag-edits";

// Readable ids for legibility; the status tags are found by role, not id.
function tag(id: string, role: TagRole | null = null): TagNode {
  return { id, parentId: null, color: null, rank: 0, googleTypes: [], role };
}
const KNOWN = [
  tag("todo", "todo"),
  tag("done", "done"),
  tag("food"),
  tag("coffee"),
  tag("kids"),
];
const PLACE = { tags: ["coffee", "kids", "todo"], autoTags: ["coffee"] };

test("a tag list without a status keeps the current one", () => {
  expect(editPlaceTags(PLACE, { tags: ["kids"] }, KNOWN)).toEqual({
    ok: true,
    tags: ["kids", "todo"],
    autoTags: [],
  });
});

test("status swaps todo / done", () => {
  expect(editPlaceTags(PLACE, { status: "done" }, KNOWN)).toEqual({
    ok: true,
    tags: ["coffee", "kids", "done"],
    autoTags: ["coffee"],
  });
});

test("unknown tags and a double status are refused", () => {
  expect(editPlaceTags(PLACE, { tags: ["nope"] }, KNOWN).ok).toBe(false);
  expect(editPlaceTags(PLACE, { tags: ["todo", "done"] }, KNOWN).ok).toBe(
    false,
  );
});

test("a deleted tag is replaced by its parent, once, and leaves autoTags", () => {
  expect(
    replaceDeletedTag(
      { tags: ["coffee", "food", "todo"], autoTags: ["coffee"] },
      "coffee",
      "food",
    ),
  ).toEqual({ tags: ["food", "todo"], autoTags: [] });
  expect(replaceDeletedTag(PLACE, "kids", null)).toEqual({
    tags: ["coffee", "todo"],
    autoTags: ["coffee"],
  });
});
