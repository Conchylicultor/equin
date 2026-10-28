import { describe, expect, test } from "bun:test";
import { firstSentence } from "./annotation";

describe("firstSentence", () => {
  test("drops headings and emphasis, cuts at the first sentence end", () => {
    expect(
      firstSentence("## Problem\n\n**Problem** — the cache leaked. It grew."),
    ).toBe("Problem");
    expect(firstSentence("**Problem** — the cache leaked. It grew.")).toBe(
      "Problem — the cache leaked.",
    );
  });
  test("caps a long first line", () => {
    const s = firstSentence("x".repeat(500));
    expect(s.length).toBe(120);
    expect(s.endsWith("…")).toBe(true);
  });
});
