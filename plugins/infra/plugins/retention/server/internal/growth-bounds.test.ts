import { describe, expect, test } from "bun:test";
import { declareGrowthBound, getTableGrowthBounds } from "./growth-bounds";

// The registry is process-global, so every test uses a UNIQUE table name to
// avoid cross-test collisions (a table is declared exactly once).

describe("declareGrowthBound / getTableGrowthBounds", () => {
  test("a ttl bound and a cascade bound coexist", () => {
    declareGrowthBound("gb_ttl_table", { kind: "ttl", ttlDays: 7 });
    declareGrowthBound("gb_cascade_table", {
      kind: "cascade",
      owner: "gb_owner",
    });

    const bounds = getTableGrowthBounds();
    expect(bounds.get("gb_ttl_table")).toEqual({ kind: "ttl", ttlDays: 7 });
    expect(bounds.get("gb_cascade_table")).toEqual({
      kind: "cascade",
      owner: "gb_owner",
    });
  });

  test("a conflicting re-declaration of the same table throws", () => {
    declareGrowthBound("gb_conflict", { kind: "ttl", ttlDays: 7 });
    expect(() =>
      declareGrowthBound("gb_conflict", { kind: "cascade", owner: "x" }),
    ).toThrow(/already has a growth bound/);
  });

  test("an identical re-declaration of the same table also throws", () => {
    declareGrowthBound("gb_identical", { kind: "ttl", ttlDays: 3 });
    expect(() =>
      declareGrowthBound("gb_identical", { kind: "ttl", ttlDays: 3 }),
    ).toThrow(/already has a growth bound/);
  });

  test("getTableGrowthBounds returns a copy, not the live map", () => {
    declareGrowthBound("gb_copy", { kind: "ttl", ttlDays: 1 });
    const first = getTableGrowthBounds() as Map<string, unknown>;
    first.delete("gb_copy");
    first.set("gb_intruder", { kind: "ttl", ttlDays: 99 });

    const second = getTableGrowthBounds();
    expect(second.get("gb_copy")).toEqual({ kind: "ttl", ttlDays: 1 });
    expect(second.has("gb_intruder")).toBe(false);
  });
});
