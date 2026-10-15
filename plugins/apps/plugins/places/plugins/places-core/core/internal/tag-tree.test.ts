import { expect, test } from "bun:test";
import {
  NEUTRAL_PLACE_COLOR,
  autoTagsFor,
  flattenTagTree,
  tagPlaceCounts,
  isRoleTag,
  mainColor,
  placeFlags,
  rampShade,
  ringColors,
  tagIdByRole,
  tagColor,
  tagDescendants,
  tagPath,
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
    childColors: null,
    ...extra,
  };
}

const TAGS: TagNode[] = [
  // Readable ids for legibility; the app finds these by role.
  tag("want", null, { color: "#94a3b8", role: "want" }),
  tag("been", null, { color: "#22c55e", rank: 1, role: "been" }),
  tag("food", null, { color: "#f97316", rank: 2 }),
  tag("restaurants", "food", { googleTypes: ["restaurant"] }),
  tag("italian", "restaurants", { googleTypes: ["pizza_restaurant"] }),
  tag("coffee", "food", { rank: 1, googleTypes: ["cafe"] }),
  tag("culture", null, { color: "#3b82f6", rank: 3 }),
  tag("museums", "culture", { color: "#0000ff", googleTypes: ["museum"] }),
  tag("kids", null, { rank: 4 }),
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

test("a ramp parent shades its colourless children light → deep by rank", () => {
  const ramp: TagNode[] = [
    tag("price", null, { color: "#eab308", childColors: "ramp" }),
    tag("p40", "price"),
    tag("p100", "price", { rank: 2 }),
    tag("p20", "price", { rank: -1 }),
    tag("own", "price", { rank: 3, color: "#123456" }),
    tag("p100-deep", "p100"),
    tag("plain", null, { color: "#eab308", rank: 1 }),
    tag("plain-child", "plain"),
  ];
  const shades = ["p20", "p40", "p100"].map((id) => tagColor(id, ramp));
  // Light first, deep last: each darker than the one before.
  const lum = (hex: string) =>
    [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0);
  expect(lum(shades[0]!)).toBeGreaterThan(lum(shades[1]!));
  expect(lum(shades[1]!)).toBeGreaterThan(lum(shades[2]!));
  // A child with its own colour keeps it (and still holds its rank's slot).
  expect(tagColor("own", ramp)).toBe("#123456");
  // A grandchild inherits its parent's shade.
  expect(tagColor("p100-deep", ramp)).toBe(tagColor("p100", ramp));
  // Without the ramp, children inherit the colour as is.
  expect(tagColor("plain-child", ramp)).toBe("#eab308");
  // A colourless ramp parent shades nothing.
  expect(
    tagColor("c", [tag("r", null, { childColors: "ramp" }), tag("c", "r")]),
  ).toBeNull();
});

test("rampShade: white-mixed first, black-mixed last, the colour itself alone", () => {
  expect(rampShade("#eab308", 0, 1)).toBe("#eab308");
  expect(rampShade("#000000", 0, 2)).toBe("#4d4d4d");
  expect(rampShade("#ffffff", 1, 2)).toBe("#999999");
  // The midpoint of an odd ramp leans deep (the ramp is asymmetric).
  expect(rampShade("#808080", 1, 3)).toBe("#7a7a7a");
  expect(() => rampShade("red", 0, 2)).toThrow();
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
    "0:want",
    "0:been",
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
