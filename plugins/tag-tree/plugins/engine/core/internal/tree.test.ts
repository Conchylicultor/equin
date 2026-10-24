import { expect, test } from "bun:test";
import {
  flattenTagTree,
  freeSiblingName,
  isTagUnder,
  rampShade,
  rolledUpTagCounts,
  tagColor,
  tagDescendants,
  tagFieldOptions,
  tagPath,
  tagPathLabel,
  wouldCycle,
  type NamedTagNode,
} from "./tree";

/** A rank key for sibling position `n` (string order = position order). */
const r = (n: number) => `a${String.fromCharCode(0x41 + n)}`;

function tag(
  id: string,
  parentId: string | null,
  extra: Partial<NamedTagNode> = {},
): NamedTagNode {
  return {
    id,
    name: id,
    parentId,
    color: null,
    rank: r(0),
    childColors: null,
    ...extra,
  };
}

const TAGS: NamedTagNode[] = [
  tag("food", null, { color: "#f97316" }),
  tag("restaurants", "food"),
  tag("italian", "restaurants"),
  tag("coffee", "food", { rank: r(1) }),
  tag("culture", null, { color: "#3b82f6", rank: r(1) }),
  tag("museums", "culture", { color: "#0000ff" }),
  tag("kids", null, { rank: r(2) }),
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

test("tagPathLabel joins names root first, with a chosen separator", () => {
  expect(tagPathLabel("italian", TAGS)).toBe("food / restaurants / italian");
  expect(tagPathLabel("italian", TAGS, " › ")).toBe(
    "food › restaurants › italian",
  );
  expect(tagPathLabel("nope", TAGS)).toBe("");
});

test("helpers survive a cycle in the stored tree", () => {
  const cyclic = [tag("a", "b"), tag("b", "a")];
  expect(tagColor("a", cyclic)).toBeNull();
  expect(tagPath("a", cyclic).map((t) => t.id)).toEqual(["b", "a"]);
});

test("an orphan (its parent is not in the set) is listed as a root", () => {
  const tags = [tag("a", null), tag("orphan", "gone", { rank: r(1) })];
  expect(
    flattenTagTree(tags).map(({ tag, depth }) => `${depth}:${tag.id}`),
  ).toEqual(["0:a", "0:orphan"]);
});

test("a ramp parent shades its colourless children light → deep by rank", () => {
  const ramp: NamedTagNode[] = [
    tag("price", null, { color: "#eab308", childColors: "ramp" }),
    tag("p40", "price", { rank: r(1) }),
    tag("p100", "price", { rank: r(2) }),
    tag("p20", "price", { rank: r(0) }),
    tag("own", "price", { rank: r(3), color: "#123456" }),
    tag("p100-deep", "p100"),
    tag("plain", null, { color: "#eab308", rank: r(1) }),
    tag("plain-child", "plain"),
  ];
  const shades = ["p20", "p40", "p100"].map((id) => tagColor(id, ramp));
  const lum = (hex: string) =>
    [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0);
  expect(lum(shades[0]!)).toBeGreaterThan(lum(shades[1]!));
  expect(lum(shades[1]!)).toBeGreaterThan(lum(shades[2]!));
  expect(tagColor("own", ramp)).toBe("#123456");
  expect(tagColor("p100-deep", ramp)).toBe(tagColor("p100", ramp));
  expect(tagColor("plain-child", ramp)).toBe("#eab308");
  expect(
    tagColor("c", [tag("r", null, { childColors: "ramp" }), tag("c", "r")]),
  ).toBeNull();
});

test("rampShade: white-mixed first, black-mixed last, the colour itself alone", () => {
  expect(rampShade("#eab308", 0, 1)).toBe("#eab308");
  expect(rampShade("#000000", 0, 2)).toBe("#4d4d4d");
  expect(rampShade("#ffffff", 1, 2)).toBe("#999999");
  expect(rampShade("#808080", 1, 3)).toBe("#7a7a7a");
  expect(() => rampShade("red", 0, 2)).toThrow();
});

test("wouldCycle refuses a move under itself or a descendant", () => {
  expect(wouldCycle("food", "italian", TAGS)).toBe(true);
  expect(wouldCycle("food", "food", TAGS)).toBe(true);
  expect(wouldCycle("italian", "culture", TAGS)).toBe(false);
  expect(wouldCycle("italian", null, TAGS)).toBe(false);
  expect(isTagUnder("italian", "food", TAGS)).toBe(true);
  expect(isTagUnder("food", "italian", TAGS)).toBe(false);
});

test("flattenTagTree lists the tree depth-first in rank order with depths", () => {
  expect(
    flattenTagTree(TAGS).map(({ tag, depth }) => `${depth}:${tag.id}`),
  ).toEqual([
    "0:food",
    "1:restaurants",
    "2:italian",
    "1:coffee",
    "0:culture",
    "1:museums",
    "0:kids",
  ]);
});

test("rolledUpTagCounts counts each item once per tag, nested tags included", () => {
  const counts = rolledUpTagCounts(
    [["italian", "restaurants"], ["coffee"], ["museums"], []],
    TAGS,
  );
  expect(counts.get("food")).toBe(2);
  expect(counts.get("restaurants")).toBe(1);
  expect(counts.get("italian")).toBe(1);
  expect(counts.get("culture")).toBe(1);
  expect(counts.get("kids")).toBeUndefined();
  // An unknown tag id reaches nothing.
  expect(rolledUpTagCounts([["nope"]], TAGS).size).toBe(0);
});

test("tagFieldOptions: flatten order, parent links, the tag colour as swatch", () => {
  const options = tagFieldOptions([
    ...TAGS,
    tag("orphan", "gone", { rank: r(3) }),
  ]);
  expect(options.map((o) => o.value)).toEqual([
    "food",
    "restaurants",
    "italian",
    "coffee",
    "culture",
    "museums",
    "kids",
    "orphan",
  ]);
  expect(options.find((o) => o.value === "italian")).toEqual({
    value: "italian",
    label: "italian",
    parent: "restaurants",
    swatch: "#f97316",
  });
  // No colour reaches it: no swatch. An orphan is a root: no parent.
  expect(options.find((o) => o.value === "kids")).toEqual({
    value: "kids",
    label: "kids",
  });
  expect(options.find((o) => o.value === "orphan")?.parent).toBeUndefined();
});

test("freeSiblingName numbers past the names its siblings already have", () => {
  expect(freeSiblingName("New tag", null, TAGS)).toBe("New tag");
  const taken = [
    ...TAGS,
    tag("new tag", null, { rank: r(3) }),
    tag("New tag 2", null, { rank: r(4) }),
    tag("x", "food", { name: "New tag 3" }),
  ];
  // Case-insensitive, and only among the siblings under the same parent.
  expect(freeSiblingName("New tag", null, taken)).toBe("New tag 3");
  expect(freeSiblingName("New tag", "food", taken)).toBe("New tag");
  expect(freeSiblingName("Coffee", "food", TAGS)).toBe("Coffee 2");
});
