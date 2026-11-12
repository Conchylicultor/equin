import { describe, expect, test } from "bun:test";
import { exactIdOf } from "./canonical-text";

describe("exactIdOf: which ids a point read matches under their own spelling alone", () => {
  test("text: every id is its own spelling", () => {
    const exact = exactIdOf("text");
    expect(exact("conv-1")).toBe(true);
    expect(exact("CONV-1")).toBe(true);
  });

  test("uuid: only the lower-case canonical form", () => {
    const exact = exactIdOf("uuid");
    expect(exact("0b8f2c3e-1a2b-4c3d-9e8f-0123456789ab")).toBe(true);
    expect(exact("0B8F2C3E-1A2B-4C3D-9E8F-0123456789AB")).toBe(false);
    expect(exact("not-a-uuid")).toBe(false);
  });

  test("integer: only the canonical decimal text within range", () => {
    const exact = exactIdOf("integer");
    expect(exact("7")).toBe(true);
    expect(exact("-7")).toBe(true);
    expect(exact("007")).toBe(false);
    expect(exact("+7")).toBe(false);
    expect(exact("4294967296")).toBe(false);
  });

  test("a type with no canonical text proves nothing", () => {
    const exact = exactIdOf("timestamp with time zone");
    expect(exact("2026-11-12 19:00:00+00")).toBe(false);
  });
});
