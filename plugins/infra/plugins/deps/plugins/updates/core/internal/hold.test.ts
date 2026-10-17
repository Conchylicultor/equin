import { describe, expect, test } from "bun:test";
import {
  HoldSchema,
  describeHold,
  heldBy,
  heldWaiting,
  holdProblems,
  holdState,
  lapsedHolds,
  latestReviewBy,
  type Hold,
} from "./hold";

const numeric = (a: string, b: string) => Number(a) - Number(b);

const one: Hold = {
  names: ["a"],
  version: "3",
  reason: "r",
  reviewBy: "2026-11-01",
};
const range: Hold = {
  names: ["b"],
  below: "5",
  reason: "r",
  issue: "https://example.com/i/2",
  reviewBy: "2026-11-01",
};

describe("heldBy", () => {
  test("a version hold covers that release only", () => {
    expect(heldBy([one], "a", "3", numeric)).toBe(one);
    expect(heldBy([one], "a", "4", numeric)).toBeUndefined();
    expect(heldBy([one], "b", "3", numeric)).toBeUndefined();
  });
  test("a below hold covers that release and everything after, by the given order", () => {
    expect(heldBy([range], "b", "4", numeric)).toBeUndefined();
    expect(heldBy([range], "b", "5", numeric)).toBe(range);
    expect(heldBy([range], "b", "12", numeric)).toBe(range);
  });
});

describe("review state", () => {
  test("active through its reviewBy day, lapsed after — and still held either way", () => {
    expect(holdState(one, "2026-11-01")).toBe("active");
    expect(holdState(one, "2026-11-02")).toBe("lapsed");
    expect(lapsedHolds([one, range], "2026-11-02")).toEqual([one, range]);
    expect(lapsedHolds([one, range], "2026-10-17")).toEqual([]);
  });
  test("a held row says whether its review is overdue", () => {
    expect(heldWaiting(one, "2026-11-02")).toEqual({
      kind: "held",
      reason: "r",
      reviewBy: "2026-11-01",
      lapsed: true,
    });
    expect(heldWaiting(one, "2026-10-17").lapsed).toBe(false);
  });
  test("describeHold names what, when and why", () => {
    expect(describeHold(one)).toBe("a 3 (review by 2026-11-01): r");
    expect(describeHold(range)).toBe(
      "b 5 and up (review by 2026-11-01): r — https://example.com/i/2",
    );
  });
});

describe("holdProblems", () => {
  const reviewBy = (d: string): Hold => ({
    names: ["a"],
    version: "1",
    reason: "r",
    reviewBy: d,
  });
  test("at most 90 days unreviewed; a lapsed hold is not a problem", () => {
    expect(latestReviewBy("2026-10-17")).toBe("2027-01-15");
    expect(
      holdProblems([reviewBy("2027-01-15")], "2026-10-17", "f.ts"),
    ).toEqual([]);
    expect(
      holdProblems([reviewBy("2020-01-01")], "2026-10-17", "f.ts"),
    ).toEqual([]);
    expect(
      holdProblems([reviewBy("2027-01-16")], "2026-10-17", "f.ts"),
    ).toEqual([
      "f.ts: the hold on a is next reviewed 2027-01-16, past 2027-01-15 — a hold goes at most 90 days unreviewed",
    ]);
  });
});

describe("HoldSchema", () => {
  test("requires a reviewBy and exactly one of version or below", () => {
    const base = { names: ["a"], reason: "r" };
    expect(HoldSchema.safeParse({ ...base, version: "1" }).success).toBe(false);
    expect(
      HoldSchema.safeParse({
        ...base,
        version: "1",
        below: "2",
        reviewBy: "2026-11-01",
      }).success,
    ).toBe(false);
    expect(
      HoldSchema.safeParse({ ...base, below: "2", reviewBy: "2026-11-01" })
        .success,
    ).toBe(true);
  });
});
