import { describe, expect, test } from "bun:test";
import { canonicalParams } from "./canonical-params";

describe("canonicalParams", () => {
  test("returns the same object when nothing is absent", () => {
    const p = { path: "a", scopeId: "app:x" };
    expect(canonicalParams(p, ["scopeId"])).toBe(p);
  });

  test("drops an undefined key, declared optional or not", () => {
    const p = { path: "a", scopeId: undefined } as unknown as Record<
      string,
      string
    >;
    expect(canonicalParams(p, ["scopeId"])).toEqual({ path: "a" });
    expect(canonicalParams(p, undefined)).toEqual({ path: "a" });
  });

  test("an optional param given '' is absent — one tuple for every spelling of base", () => {
    const p: Record<string, string> = { path: "a", scopeId: "" };
    expect(canonicalParams(p, ["scopeId"])).toEqual({ path: "a" });
  });

  test("a required param's '' is a value, left alone", () => {
    const p = { id: "" };
    expect(canonicalParams(p, undefined)).toBe(p);
    const both: Record<string, string> = { path: "", scopeId: "" };
    expect(canonicalParams(both, ["scopeId"])).toEqual({ path: "" });
  });

  test("never mutates its input", () => {
    const p = { path: "a", scopeId: "" };
    canonicalParams(p, ["scopeId"]);
    expect(p).toEqual({ path: "a", scopeId: "" });
  });
});
