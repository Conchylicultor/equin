import { expect, test } from "bun:test";
import {
  NEUTRAL_PLACE_COLOR,
  autoTagsFor,
  flattenTagTree,
  tagPlaceCounts,
  isStatusTag,
  mainColor,
  placeStatus,
  ringColors,
  statusTagIds,
  tagIdByRole,
  tagColor,
  tagDescendants,
  tagPath,
  withPlaceStatus,
  wouldCycle,
  type TagNode,
} from "./tag-tree";

function tag(
  id: string,
  parentId: string | null,
  extra: Partial<TagNode> = {},
): TagNode {
  return {
    id,
    parentId,
    color: null,
    rank: 0,
    googleTypes: [],
    role: null,
    ...extra,
  };
}

const TAGS: TagNode[] = [
  // Readable ids for legibility; the status logic finds these by role.
  tag("status", null, { role: "status" }),
  tag("todo", "status", { color: "#94a3b8", role: "todo" }),
  tag("done", "status", { color: "#22c55e", rank: 1, role: "done" }),
  tag("someday", "status", { rank: 2 }),
  tag("food", null, { color: "#f97316", rank: 1 }),
  tag("restaurants", "food", { googleTypes: ["restaurant"] }),
  tag("italian", "restaurants", { googleTypes: ["pizza_restaurant"] }),
  tag("coffee", "food", { rank: 1, googleTypes: ["cafe"] }),
  tag("culture", null, { color: "#3b82f6", rank: 2 }),
  tag("museums", "culture", { color: "#0000ff", googleTypes: ["museum"] }),
  tag("kids", null, { rank: 3 }),
];

test("tagColor is the tag's own colour, else its nearest ancestor's", () => {
  expect(tagColor("museums", TAGS)).toBe("#0000ff");
  expect(tagColor("italian", TAGS)).toBe("#f97316");
  expect(tagColor("kids", TAGS)).toBeNull();
  expect(tagColor("nope", TAGS)).toBeNull();
});

test("tagPath runs root first; tagDescendants depth-first in rank order", () => {
  expect(tagPath("italian", TAGS).map((t) => t.id)).toEqual([
    "food",
    "restaurants",
    "italian",
  ]);
  expect(tagPath("nope", TAGS)).toEqual([]);
  expect(tagDescendants("food", TAGS).map((t) => t.id)).toEqual([
    "restaurants",
    "italian",
    "coffee",
  ]);
});

test("helpers survive a cycle in the stored tree", () => {
  const cyclic = [tag("a", "b"), tag("b", "a")];
  expect(tagColor("a", cyclic)).toBeNull();
  expect(tagPath("a", cyclic).map((t) => t.id)).toEqual(["b", "a"]);
});

test("status tags resolve by role, not id", () => {
  expect(tagIdByRole(TAGS, "done")).toBe("done");
  expect(statusTagIds(TAGS)).toEqual({ todo: "todo", done: "done" });
  const renamed = TAGS.map((t) =>
    t.role === "done" ? { ...t, id: "ptag-1-abc" } : t,
  );
  expect(placeStatus({ tags: ["ptag-1-abc"] }, renamed)).toBe("done");
  expect(() => statusTagIds(TAGS.filter((t) => t.role !== "todo"))).toThrow();
});

test("status: done wins, else todo; withPlaceStatus swaps it", () => {
  expect(placeStatus({ tags: ["food", "done"] }, TAGS)).toBe("done");
  expect(placeStatus({ tags: ["food"] }, TAGS)).toBe("todo");
  expect(withPlaceStatus(["food", "todo"], "done", TAGS)).toEqual([
    "food",
    "done",
  ]);
  expect(isStatusTag("todo", TAGS)).toBe(true);
  expect(isStatusTag("status", TAGS)).toBe(true);
  expect(isStatusTag("someday", TAGS)).toBe(true);
  expect(isStatusTag("food", TAGS)).toBe(false);
});

test("ringColors: distinct non-status colours in the place's tag order", () => {
  const place = { tags: ["museums", "italian", "coffee", "kids", "done"] };
  expect(ringColors(place, TAGS)).toEqual(["#0000ff", "#f97316"]);
  expect(mainColor(place, TAGS)).toBe("#0000ff");
  expect(ringColors({ tags: ["kids", "todo"] }, TAGS)).toEqual([]);
  expect(mainColor({ tags: ["kids", "todo"] }, TAGS)).toBe(NEUTRAL_PLACE_COLOR);
});

test("autoTagsFor: every tag naming one of the types, in tree order", () => {
  expect(
    autoTagsFor(["museum", "pizza_restaurant", "restaurant", "food"], TAGS),
  ).toEqual(["restaurants", "italian", "museums"]);
  expect(autoTagsFor([], TAGS)).toEqual([]);
});

test("wouldCycle refuses a move under itself or a descendant", () => {
  expect(wouldCycle("food", "italian", TAGS)).toBe(true);
  expect(wouldCycle("food", "food", TAGS)).toBe(true);
  expect(wouldCycle("italian", "culture", TAGS)).toBe(false);
  expect(wouldCycle("italian", null, TAGS)).toBe(false);
});

test("flattenTagTree lists the tree depth-first in rank order with depths", () => {
  expect(
    flattenTagTree(TAGS).map(({ tag, depth }) => `${depth}:${tag.id}`),
  ).toEqual([
    "0:status",
    "1:todo",
    "1:done",
    "1:someday",
    "0:food",
    "1:restaurants",
    "2:italian",
    "1:coffee",
    "0:culture",
    "1:museums",
    "0:kids",
  ]);
});

test("tagPlaceCounts counts each place once per tag, nested tags included", () => {
  const counts = tagPlaceCounts(
    [
      { tags: ["italian", "restaurants", "todo"] },
      { tags: ["coffee", "done"] },
      { tags: ["museums", "todo"] },
    ],
    TAGS,
  );
  expect(counts.get("food")).toBe(2);
  expect(counts.get("restaurants")).toBe(1);
  expect(counts.get("italian")).toBe(1);
  expect(counts.get("status")).toBe(3);
  expect(counts.get("todo")).toBe(2);
  expect(counts.get("kids")).toBeUndefined();
});
