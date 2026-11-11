import { describe, expect, test } from "bun:test";
import { cooldownEnd } from "./cooldown";

describe("cooldownEnd", () => {
  test("a release cools down until the start of the day it is old enough", () => {
    expect(cooldownEnd("2026-11-09T17:46:09Z", 3)).toBe(
      "2026-11-13T00:00:00.000Z",
    );
  });

  test("a release published at the start of a day is old enough exactly then", () => {
    expect(cooldownEnd("2026-11-09T00:00:00Z", 3)).toBe(
      "2026-11-12T00:00:00.000Z",
    );
  });

  test("a non-instant throws", () => {
    expect(() => cooldownEnd("yesterday", 3)).toThrow("not an instant");
  });
});
