import { describe, expect, it } from "bun:test";
import type { VariantValue } from "@plugins/fields/plugins/variant/core";
import { canonicalViewValue } from "./canonical-view";

const tree = (groupId: string, ruleId: string) => ({
  kind: "group",
  id: groupId,
  conjunction: "and",
  children: [
    {
      kind: "rule",
      id: ruleId,
      fieldId: "tags",
      operatorId: "has",
      value: ["t1"],
    },
  ],
});

describe("canonicalViewValue", () => {
  it("drops filter-node ids, so a rebuilt filter reads as the same view", () => {
    const a = { type: "map", filter: tree("g1", "r1") } as VariantValue;
    const b = { type: "map", filter: tree("g2", "r2") } as VariantValue;
    expect(canonicalViewValue(a)).toEqual(canonicalViewValue(b));
  });

  it("drops them from the fold's keep tree too", () => {
    const a = {
      type: "list",
      fold: { keep: tree("g1", "r1") },
    } as VariantValue;
    const b = {
      type: "list",
      fold: { keep: tree("g2", "r2") },
    } as VariantValue;
    expect(canonicalViewValue(a)).toEqual(canonicalViewValue(b));
  });

  it("keeps what makes two filters different", () => {
    const a = { type: "map", filter: tree("g", "r") } as VariantValue;
    const other = tree("g", "r");
    other.children[0]!.value = ["t2"];
    const b = { type: "map", filter: other } as VariantValue;
    expect(canonicalViewValue(a)).not.toEqual(canonicalViewValue(b));
  });

  it("leaves a view without filters as it is", () => {
    const view = {
      type: "map",
      sort: [{ fieldId: "name", direction: "asc" }],
    } as VariantValue;
    expect(canonicalViewValue(view)).toEqual({
      ...view,
      filter: undefined,
      fold: undefined,
    });
  });
});
