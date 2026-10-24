import { describe, expect, it } from "bun:test";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { canonicalJson, cleanView, sameView, withDraft } from "./draft-values";

const v = (value: Record<string, unknown>) =>
  ({ type: "map", ...value }) as VariantValue;

describe("canonicalJson", () => {
  it("spells one value one way: keys sorted, undefined members dropped", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [3] } })).toBe(
      canonicalJson({ a: { e: [3], d: 2 }, b: 1 }),
    );
  });

  it("keeps array order", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("sameView", () => {
  it("compares the canonical JSON of the two values", () => {
    expect(
      sameView(v({ sort: [1], q: undefined }), v({ sort: [1] }), undefined),
    ).toBe(true);
    expect(sameView(v({ sort: [1] }), v({ sort: [2] }), undefined)).toBe(false);
  });

  it("compares under the consumer's projection", () => {
    const withoutId = (view: VariantValue) => ({ ...view, id: undefined });
    expect(sameView(v({ id: "x" }), v({ id: "y" }), withoutId)).toBe(true);
    expect(sameView(v({ id: "x" }), v({ id: "y" }), undefined)).toBe(false);
  });

  it("round-trips a cleaned write back to the saved value", () => {
    const saved = v({ filter: { kind: "group" } });
    const edited = cleanView({ ...saved, sort: [{ fieldId: "a" }] });
    const reverted = cleanView({ ...edited, sort: undefined });
    expect(Object.keys(reverted)).not.toContain("sort");
    expect(sameView(reverted, saved, undefined)).toBe(true);
  });
});

describe("withDraft", () => {
  it("sets and drops one view's draft, keeping the map when nothing changes", () => {
    const empty = {};
    const a = v({ sort: [1] });
    const one = withDraft(empty, "a", a);
    expect(one).toEqual({ a });
    expect(withDraft(one, "a", a)).toBe(one);
    expect(withDraft(one, "b", null)).toBe(one);
    expect(withDraft(one, "a", null)).toEqual({});
  });
});
