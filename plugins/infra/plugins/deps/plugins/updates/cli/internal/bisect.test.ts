import { describe, expect, test } from "bun:test";
import type { GateResult } from "../../core/internal/compare";
import { isBreakingMove, narrow, riskFirstSplit } from "./bisect";

const fail = (u: string): GateResult[] => [{ gate: "tests", failures: [u] }];

/** A probe failing whenever a set holds a culprit, naming the first. */
function probeFor(culprits: readonly string[]) {
  const sets: string[][] = [];
  return {
    sets,
    probe: async (units: readonly string[]) => {
      sets.push([...units]);
      const bad = units.find((u) => culprits.includes(u));
      return bad === undefined
        ? ({ passed: true } as const)
        : ({ passed: false, failures: fail(bad) } as const);
    },
  };
}

const halves = riskFirstSplit<string>(() => false);
const UNITS = ["a", "b", "c", "d", "e", "f", "g", "h"];

describe("narrow", () => {
  test("keeps everything but the culprits, each with the failures it caused", async () => {
    const { probe } = probeFor(["c", "g"]);
    const out = await narrow({
      units: UNITS,
      failures: fail("c"),
      probe,
      split: halves,
      budget: 40,
    });
    expect(out.accepted.sort()).toEqual(["a", "b", "d", "e", "f", "h"]);
    expect(out.culprits).toEqual([
      { unit: "c", regressions: fail("c") },
      { unit: "g", regressions: fail("g") },
    ]);
    expect(out.untested).toEqual([]);
    expect(out.probes).toBeLessThanOrEqual(2 * 2 * Math.log2(8 / 2) + 4);
  });

  test("each probe carries what was already accepted", async () => {
    const { probe, sets } = probeFor(["d"]);
    await narrow({
      units: ["a", "b", "c", "d"],
      failures: fail("d"),
      probe,
      split: halves,
      budget: 40,
    });
    expect(sets).toEqual([
      ["a", "b"],
      ["a", "b", "c", "d"],
      ["a", "b", "c"],
      ["a", "b", "c", "d"],
    ]);
  });

  test("a single unit known to fail is a culprit without a probe", async () => {
    const { probe, sets } = probeFor(["a"]);
    const out = await narrow({
      units: ["a"],
      failures: fail("a"),
      probe,
      split: halves,
      budget: 40,
    });
    expect(out.culprits).toEqual([{ unit: "a", regressions: fail("a") }]);
    expect(sets).toEqual([]);
  });

  test("an exhausted budget leaves the undecided units untested", async () => {
    const { probe } = probeFor(["c", "g"]);
    const out = await narrow({
      units: UNITS,
      failures: fail("c"),
      probe,
      split: halves,
      budget: 2,
    });
    expect(out.probes).toBe(2);
    expect(
      [
        ...out.accepted,
        ...out.culprits.map((c) => c.unit),
        ...out.untested,
      ].sort(),
    ).toEqual(UNITS);
    expect(out.untested.length).toBeGreaterThan(0);
  });
});

describe("riskFirstSplit", () => {
  test("separates low-risk from risky units first, then halves", () => {
    const split = riskFirstSplit<string>((u) => u.startsWith("major"));
    expect(split(["p1", "major1", "p2", "major2"])).toEqual([
      ["p1", "p2"],
      ["major1", "major2"],
    ]);
    expect(split(["p1", "p2", "p3"])).toEqual([["p1", "p2"], ["p3"]]);
  });
});

describe("isBreakingMove", () => {
  test("by semver: a major, a 0.x minor, a fresh input or an unparsable version", () => {
    expect(isBreakingMove("6.4.2", "8.3.4")).toBe(true);
    expect(isBreakingMove("0.36.4", "0.45.4")).toBe(true);
    expect(isBreakingMove(null, "1.0.0")).toBe(true);
    expect(isBreakingMove("a", "b")).toBe(true);
    expect(isBreakingMove("4.2.2", "4.3.3")).toBe(false);
    expect(isBreakingMove("0.36.4", "0.36.9")).toBe(false);
  });
});
