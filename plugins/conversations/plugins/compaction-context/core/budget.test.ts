import { describe, expect, test } from "bun:test";
import { fitToBudget } from "./budget";

const footer = (n: number) => `+${n} more`;

describe("fitToBudget", () => {
  test("text that fits is returned as is", () => {
    expect(fitToBudget("a\nb", 3, footer)).toBe("a\nb");
  });

  test("cuts at a line boundary and says how many lines were cut", () => {
    const text = ["head", "line1", "line2", "line3", "line4"].join("\n");
    const out = fitToBudget(text, 24, footer);
    expect(out).toBe("head\nline1\nline2\n+2 more");
    expect(out.length).toBeLessThanOrEqual(24);
  });

  test("never exceeds the budget", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    for (const budget of [10, 50, 333, 1000]) {
      expect(fitToBudget(text, budget, footer).length).toBeLessThanOrEqual(
        budget,
      );
    }
  });

  test("nothing when not even one line and the footer fit", () => {
    expect(fitToBudget("a long first line\nb", 5, footer)).toBe("");
  });
});
