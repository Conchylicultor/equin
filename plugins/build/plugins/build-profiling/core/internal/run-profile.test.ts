import { describe, expect, test } from "bun:test";
import { buildRunProfile } from "./run-profile";

describe("build.run-profile", () => {
  test("its spans are capped, never a bare list", () => {
    expect(buildRunProfile.shape.bare).toEqual([]);
    expect(buildRunProfile.shape.bounds).toEqual([
      { path: "spans", max: 2000 },
    ]);
  });

  test("a profile past the cap fails its parse", () => {
    const span = {
      id: "s",
      phase: "build:checks",
      label: "s",
      startMs: 0,
      durationMs: 1,
    };
    const parse = (n: number) =>
      buildRunProfile.schema.safeParse({
        spans: Array.from({ length: n }, () => span),
        totalMs: 1,
      }).success;
    expect(parse(2000)).toBe(true);
    expect(parse(2001)).toBe(false);
  });
});
