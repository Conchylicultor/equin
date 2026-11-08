import { describe, expect, test } from "bun:test";
import { fixStandingOf, regresses, type ReportFixFacts } from "./fix-state";

const landedAt = new Date("2026-11-01T10:00:00Z");
const deployedAt = new Date("2026-11-01T10:20:00Z");
const regressedAt = new Date("2026-11-07T20:33:00Z");
const fix = (over: Partial<ReportFixFacts> = {}): ReportFixFacts => ({
  commit: "51f9fdf0000000000000000000000000000000aa",
  landedAt,
  deployedAt: null,
  regressedAt: null,
  ...over,
});

describe("fixStandingOf", () => {
  test("no fix: open, nothing named", () => {
    expect(fixStandingOf(null)).toEqual({
      fixState: "open",
      fixCommit: null,
      fixStateAt: null,
    });
  });
  test("landed, not live: pending since it landed", () => {
    expect(fixStandingOf(fix())).toMatchObject({
      fixState: "pending",
      fixStateAt: landedAt,
    });
  });
  test("live: fixed since it went live", () => {
    expect(fixStandingOf(fix({ deployedAt }))).toMatchObject({
      fixState: "fixed",
      fixStateAt: deployedAt,
    });
  });
  test("a regression wins over the deploy, and names the fix", () => {
    expect(fixStandingOf(fix({ deployedAt, regressedAt }))).toEqual({
      fixState: "regressed",
      fixCommit: fix().commit,
      fixStateAt: regressedAt,
    });
  });
});

describe("regresses", () => {
  test("code that contains the fix regresses it, live or not", () => {
    expect(regresses({ deployedAt: null }, true)).toBe(true);
    expect(regresses({ deployedAt }, true)).toBe(true);
  });
  test("code without the fix (a worktree behind main) changes nothing", () => {
    expect(regresses({ deployedAt }, false)).toBe(false);
  });
  test("unknown code counts once the fix is live, not before", () => {
    expect(regresses({ deployedAt }, null)).toBe(true);
    expect(regresses({ deployedAt: null }, null)).toBe(false);
  });
});
