import { describe, expect, test } from "bun:test";
import {
  HoldSchema,
  heldBy,
  holdProblems,
  latestUntil,
  type Hold,
} from "./hold";

const numeric = (a: string, b: string) => Number(a) - Number(b);

describe("heldBy", () => {
  const one: Hold = {
    names: ["a"],
    version: "3",
    reason: "r",
    until: "2026-11-01",
  };
  const range: Hold = {
    names: ["b"],
    below: "5",
    reason: "r",
    until: "2026-11-01",
  };

  test("a version hold covers that release only", () => {
    expect(heldBy([one], "a", "3", "2026-10-17", numeric)).toBe(one);
    expect(heldBy([one], "a", "4", "2026-10-17", numeric)).toBeUndefined();
    expect(heldBy([one], "b", "3", "2026-10-17", numeric)).toBeUndefined();
  });
  test("a below hold covers that release and everything after, by the given order", () => {
    expect(heldBy([range], "b", "4", "2026-10-17", numeric)).toBeUndefined();
    expect(heldBy([range], "b", "5", "2026-10-17", numeric)).toBe(range);
    expect(heldBy([range], "b", "12", "2026-10-17", numeric)).toBe(range);
  });
  test("honoured through its until day, inert the day after", () => {
    expect(heldBy([one], "a", "3", "2026-11-01", numeric)).toBe(one);
    expect(heldBy([one], "a", "3", "2026-11-02", numeric)).toBeUndefined();
  });
});

describe("holdProblems", () => {
  const until = (u: string): Hold => ({
    names: ["a"],
    version: "1",
    reason: "r",
    until: u,
  });
  test("at most 90 days out", () => {
    expect(latestUntil("2026-10-17")).toBe("2027-01-15");
    expect(holdProblems([until("2027-01-15")], "2026-10-17", "f.ts")).toEqual(
      [],
    );
    expect(holdProblems([until("2027-01-16")], "2026-10-17", "f.ts")).toEqual([
      "f.ts: the hold on a lasts until 2027-01-16, past 2027-01-15 — a hold is set for at most 90 days; renew it when it lapses",
    ]);
  });
});

describe("HoldSchema", () => {
  test("requires an until and exactly one of version or below", () => {
    const base = { names: ["a"], reason: "r" };
    expect(HoldSchema.safeParse({ ...base, version: "1" }).success).toBe(false);
    expect(
      HoldSchema.safeParse({
        ...base,
        version: "1",
        below: "2",
        until: "2026-11-01",
      }).success,
    ).toBe(false);
    expect(
      HoldSchema.safeParse({ ...base, below: "2", until: "2026-11-01" })
        .success,
    ).toBe(true);
  });
});
