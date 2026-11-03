import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { resolvableSchema, resolved, unresolved } from "./resolvable";

describe("resolvable", () => {
  const schema = resolvableSchema(z.array(z.number()));

  // Compared against the constructors rather than a bare object literal: a
  // literal widens `resolved` to `boolean`, which no longer matches either arm
  // of the discriminated union.
  test("round-trips the resolved arm", () => {
    expect(schema.parse({ resolved: true, value: [1, 2, 3] })).toEqual(resolved([1, 2, 3]));
  });

  test("round-trips the unresolved arm", () => {
    const reason = "conversation has no worktree";
    expect(schema.parse({ resolved: false, reason })).toEqual(unresolved(reason));
  });

  test("rejects a payload missing the `resolved` discriminant", () => {
    expect(() => schema.parse({ value: [1, 2, 3] })).toThrow();
  });

  test("rejects a resolved payload with no `value`", () => {
    expect(() => schema.parse({ resolved: true })).toThrow();
  });

  test("applies the inner schema to the resolved value", () => {
    expect(() => schema.parse({ resolved: true, value: ["a"] })).toThrow();
  });

  test("resolved(value) carries the value", () => {
    const v = [1, 2, 3];
    const r = resolved(v);
    expect(r).toEqual({ resolved: true, value: v });
    expect(r.resolved && r.value).toBe(v);
  });

  test("unresolved(reason) carries the reason", () => {
    const r = unresolved("worktree was removed");
    expect(r).toEqual({ resolved: false, reason: "worktree was removed" });
    expect(!r.resolved && r.reason).toBe("worktree was removed");
  });
});
