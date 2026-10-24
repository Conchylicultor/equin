import { describe, expect, test } from "bun:test";
import type {
  FieldDef,
  FieldOption,
  FieldValue,
  GroupBucket,
} from "@plugins/primitives/plugins/data-view/core";
import { tagGroupings } from "./tag-groupings";

const [tree] = tagGroupings;

function plan(options: FieldOption[]): (v: FieldValue) => GroupBucket | null {
  const field: FieldDef<unknown> = {
    id: "tag",
    label: "Tag",
    type: "tag",
    options,
    value: () => null,
  };
  return tree!.plan({ now: 0, values: [], field });
}

// app ▸ website ▸ homepage, app ▸ chord; infra (a sibling root), in tree order.
const FOREST: FieldOption[] = [
  { value: "app", label: "app", swatch: "#7c5cff" },
  { value: "website", label: "website", parent: "app", swatch: "#22c55e" },
  { value: "homepage", label: "homepage", parent: "website" },
  { value: "chord", label: "chord", parent: "app" },
  { value: "infra", label: "infra", swatch: "#14b8a6" },
];

describe("tag grouping — nested along the option forest", () => {
  test("is the one-bucket-per-value `tree` grouping", () => {
    expect(tagGroupings.map((g) => g.id)).toEqual(["tree"]);
    expect(tree!.oneBucketPerValue).toBe(true);
  });

  test("a bucket carries its ancestors root first, each with its own order and swatch", () => {
    expect(plan(FOREST)("homepage")).toEqual({
      key: "homepage",
      label: "homepage",
      order: 2,
      ancestors: [
        { key: "app", label: "app", order: 0, swatch: "#7c5cff" },
        { key: "website", label: "website", order: 1, swatch: "#22c55e" },
      ],
    });
  });

  test("a root has no ancestors; its swatch rides the bucket", () => {
    expect(plan(FOREST)("infra")).toEqual({
      key: "infra",
      label: "infra",
      order: 4,
      swatch: "#14b8a6",
    });
  });

  test("a value naming no option is null — it joins the one None section", () => {
    expect(plan(FOREST)("deleted-tag")).toBeNull();
  });

  test("a parent naming no option makes its child a root", () => {
    const bucket = plan([{ value: "orphan", label: "orphan", parent: "gone" }])(
      "orphan",
    );
    expect(bucket).toEqual({ key: "orphan", label: "orphan", order: 0 });
  });

  test("cycle-safe: an option on a cycle is a root, and every mention agrees", () => {
    const bucketOf = plan([
      { value: "a", label: "a", parent: "b" },
      { value: "b", label: "b", parent: "a" },
      { value: "c", label: "c", parent: "a" },
      { value: "self", label: "self", parent: "self" },
    ]);
    expect(bucketOf("a")!.ancestors).toBeUndefined();
    expect(bucketOf("b")!.ancestors).toBeUndefined();
    expect(bucketOf("self")!.ancestors).toBeUndefined();
    // Under a cycle, the chain stops at the cycle's member.
    expect(bucketOf("c")!.ancestors!.map((a) => a.key)).toEqual(["a"]);
  });

  test("a duplicated option keeps its first declaration's position", () => {
    const bucketOf = plan([
      { value: "x", label: "first" },
      { value: "y", label: "y" },
      { value: "x", label: "second" },
    ]);
    expect(bucketOf("x")).toEqual({ key: "x", label: "first", order: 0 });
  });
});
