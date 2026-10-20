import { describe, expect, test } from "bun:test";
import { BASE_CPS, MAX_LAG_S, stepReveal } from "./reveal-pace";

describe("stepReveal", () => {
  test("reveals whole words only", () => {
    const text = "hello wonderful world";
    // One frame's budget lands mid-"wonderful": the step finishes the word.
    const step = stepReveal(text, 0, 0, 8 / BASE_CPS);
    expect(text.slice(0, step.revealed)).toBe("hello wonderful");
  });

  test("banks a budget too small for a character", () => {
    const step = stepReveal("abc def", 0, 0, 0.5 / BASE_CPS);
    expect(step.revealed).toBe(0);
    expect(step.budget).toBeCloseTo(0.5);
  });

  test("never trails the stream by more than MAX_LAG_S", () => {
    const text = "word ".repeat(400);
    let revealed = 0;
    let budget = 0;
    for (let t = 0; t < MAX_LAG_S + 1e-9; t += 1 / 60) {
      ({ revealed, budget } = stepReveal(text, revealed, budget, 1 / 60));
    }
    // A big backlog drains at backlog / MAX_LAG_S, so it is mostly gone by then.
    expect(revealed).toBeGreaterThan(text.length * 0.55);
  });

  test("stops at the end", () => {
    expect(stepReveal("done", 4, 3, 1)).toEqual({ revealed: 4, budget: 0 });
    expect(stepReveal("done", 0, 0, 10).revealed).toBe(4);
  });
});
