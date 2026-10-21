import { describe, expect, test } from "bun:test";
import { searchCountLine, searchCountOf } from "./search-answer";

describe("search count", () => {
  test("round-trips through the answer", () => {
    for (const n of [0, 1, 12]) {
      expect(searchCountOf(`note\n${searchCountLine(n)}\n[...]`)).toBe(n);
    }
  });
  test("an error is no count", () => {
    expect(searchCountOf("Google Maps is not set up")).toBeNull();
  });
});
