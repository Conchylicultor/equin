import { describe, expect, test } from "bun:test";
import {
  ALWAYS_SUGGESTIONS,
  ROTATING_SUGGESTIONS,
  pickSuggestions,
} from "./suggestions";

describe("pickSuggestions", () => {
  test("both newcomer questions lead, then one rotating question", () => {
    const picked = pickSuggestions(() => 0);
    expect(picked).toEqual([...ALWAYS_SUGGESTIONS, ROTATING_SUGGESTIONS[0]]);
  });
  test("the random source picks the rotating one", () => {
    expect(pickSuggestions(() => 0.5)[2]).toBe(ROTATING_SUGGESTIONS[1]);
    expect(pickSuggestions(() => 0.999)[2]).toBe(ROTATING_SUGGESTIONS[2]);
  });
  test("every rotating question can come up", () => {
    const seen = new Set(
      ROTATING_SUGGESTIONS.map(
        (_, i) => pickSuggestions(() => i / ROTATING_SUGGESTIONS.length)[2],
      ),
    );
    expect(seen.size).toBe(ROTATING_SUGGESTIONS.length);
  });
  test("a source outside [0, 1) throws", () => {
    expect(() => pickSuggestions(() => 1)).toThrow();
    expect(() => pickSuggestions(() => Number.NaN)).toThrow();
  });
});
