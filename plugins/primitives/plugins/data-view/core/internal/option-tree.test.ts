import { describe, expect, it } from "bun:test";
import { optionDescendants } from "./option-tree";

const o = (value: string, parent?: string) => ({ value, label: value, parent });

describe("optionDescendants", () => {
  const opts = [
    o("food"),
    o("cafe", "food"),
    o("bar", "food"),
    o("espresso", "cafe"),
    o("park"),
  ];
  it("value plus all descendants", () => {
    expect(optionDescendants(opts, "food").sort()).toEqual([
      "bar",
      "cafe",
      "espresso",
      "food",
    ]);
    expect(optionDescendants(opts, "cafe")).toEqual(["cafe", "espresso"]);
  });
  it("leaf, flat and unknown values are themselves", () => {
    expect(optionDescendants(opts, "park")).toEqual(["park"]);
    expect(optionDescendants(opts, "nope")).toEqual(["nope"]);
  });
  it("is cycle-safe", () => {
    expect(optionDescendants([o("a", "b"), o("b", "a")], "a").sort()).toEqual([
      "a",
      "b",
    ]);
  });
});
