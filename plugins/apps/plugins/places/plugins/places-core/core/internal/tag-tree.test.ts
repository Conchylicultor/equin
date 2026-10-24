import { expect, test } from "bun:test";
import {
  NEUTRAL_PLACE_COLOR,
  autoTagsFor,
  tagPlaceCounts,
  isRoleTag,
  mainColor,
  placeFlags,
  ringColors,
  tagIdByRole,
  type PlaceTagNode,
} from "./tag-tree";

// The generic tree helpers (paths, colours, ramps, cycles, flattening) are the
// tag-tree engine's and tested there; these are the Places semantics.

function tag(
  id: string,
  parentId: string | null,
  extra: Partial<PlaceTagNode> = {},
): PlaceTagNode {
  return {
    id,
    parentId,
    color: null,
    rank: "a0",
    googleTypes: [],
    role: null,
    childColors: null,
    ...extra,
  };
}

const TAGS: PlaceTagNode[] = [
  // Readable ids for legibility; the app finds these by role.
  tag("want", null, { color: "#94a3b8", role: "want" }),
  tag("been", null, { color: "#22c55e", rank: "a1", role: "been" }),
  tag("food", null, { color: "#f97316", rank: "a2" }),
  tag("restaurants", "food", { googleTypes: ["restaurant"] }),
  tag("italian", "restaurants", { googleTypes: ["pizza_restaurant"] }),
  tag("coffee", "food", { rank: "a1", googleTypes: ["cafe"] }),
  tag("culture", null, { color: "#3b82f6", rank: "a3" }),
  tag("museums", "culture", { color: "#0000ff", googleTypes: ["museum"] }),
  tag("kids", null, { rank: "a4" }),
];

test("role tags resolve by role, not id; flags are independent", () => {
  expect(tagIdByRole(TAGS, "been")).toBe("been");
  const renamed = TAGS.map((t) =>
    t.role === "been" ? { ...t, id: "ptag-1-abc" } : t,
  );
  expect(placeFlags({ tags: ["ptag-1-abc"] }, renamed)).toEqual({
    been: true,
    want: false,
  });
  expect(placeFlags({ tags: ["food", "want", "been"] }, TAGS)).toEqual({
    been: true,
    want: true,
  });
  expect(placeFlags({ tags: ["food"] }, TAGS)).toEqual({
    been: false,
    want: false,
  });
  // A role no tag holds reads as not carried.
  expect(
    placeFlags(
      { tags: ["want"] },
      TAGS.filter((t) => t.role !== "want"),
    ),
  ).toEqual({ been: false, want: false });
  expect(isRoleTag("want", TAGS)).toBe(true);
  expect(isRoleTag("been", TAGS)).toBe(true);
  expect(isRoleTag("food", TAGS)).toBe(false);
  expect(isRoleTag("nope", TAGS)).toBe(false);
});

test("ringColors: distinct non-role colours in the place's tag order", () => {
  const place = { tags: ["museums", "italian", "coffee", "kids", "been"] };
  expect(ringColors(place, TAGS)).toEqual(["#0000ff", "#f97316"]);
  expect(mainColor(place, TAGS)).toBe("#0000ff");
  expect(ringColors({ tags: ["kids", "want"] }, TAGS)).toEqual([]);
  expect(mainColor({ tags: ["kids", "want"] }, TAGS)).toBe(NEUTRAL_PLACE_COLOR);
});

test("autoTagsFor: every tag naming one of the types, in tree order", () => {
  expect(
    autoTagsFor(["museum", "pizza_restaurant", "restaurant", "food"], TAGS),
  ).toEqual(["restaurants", "italian", "museums"]);
  expect(autoTagsFor(["cafe", "restaurant"], TAGS)).toEqual([
    "restaurants",
    "coffee",
  ]);
  expect(autoTagsFor([], TAGS)).toEqual([]);
});

test("tagPlaceCounts counts each place once per tag, nested tags included", () => {
  const counts = tagPlaceCounts(
    [
      { tags: ["italian", "restaurants", "want"] },
      { tags: ["coffee", "been", "want"] },
      { tags: ["museums", "want"] },
    ],
    TAGS,
  );
  expect(counts.get("food")).toBe(2);
  expect(counts.get("restaurants")).toBe(1);
  expect(counts.get("italian")).toBe(1);
  expect(counts.get("want")).toBe(3);
  expect(counts.get("been")).toBe(1);
  expect(counts.get("kids")).toBeUndefined();
});
