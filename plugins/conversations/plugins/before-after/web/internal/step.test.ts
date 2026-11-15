import { describe, expect, it } from "bun:test";
import type { BeforeAfterPair } from "../../core";
import { steppedPair } from "./step";

const pair = (id: string) => ({ id }) as BeforeAfterPair;
const PAIRS = [pair("ba-1"), pair("ba-2"), pair("ba-3")];

describe("steppedPair", () => {
  it("steps forward and back", () => {
    expect(steppedPair(PAIRS, "ba-2", 1)).toBe(PAIRS[2]);
    expect(steppedPair(PAIRS, "ba-2", -1)).toBe(PAIRS[0]);
  });
  it("wraps at both ends", () => {
    expect(steppedPair(PAIRS, "ba-3", 1)).toBe(PAIRS[0]);
    expect(steppedPair(PAIRS, "ba-1", -1)).toBe(PAIRS[2]);
  });
  it("answers nothing for a pair not in the list", () => {
    expect(steppedPair(PAIRS, "ba-9", 1)).toBeUndefined();
    expect(steppedPair([], "ba-1", 1)).toBeUndefined();
  });
});
