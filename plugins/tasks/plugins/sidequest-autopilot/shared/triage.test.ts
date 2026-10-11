import { describe, expect, test } from "bun:test";
import { triageScore, triageStaleness } from "./triage";

const at = new Date("2026-10-01T00:00:00Z");
const row = { triagedAt: at, sourceTitle: "T", sourceDescription: "D" };
const task = { title: "T", description: "D" };
const days = (n: number) => new Date(at.getTime() + n * 24 * 60 * 60 * 1000);

describe("triageStaleness", () => {
  test("is fresh right after the read", () => {
    expect(triageStaleness(row, task, days(1), 7)).toEqual({ stale: false });
  });

  test("goes stale past staleDays", () => {
    expect(triageStaleness(row, task, days(8), 7)).toEqual({
      stale: true,
      reason: "old",
    });
  });

  test("goes stale at once when the task was edited", () => {
    expect(triageStaleness(row, { ...task, title: "T2" }, days(0), 7)).toEqual({
      stale: true,
      reason: "edited",
    });
    expect(
      triageStaleness(row, { ...task, description: "D2" }, days(0), 7),
    ).toEqual({ stale: true, reason: "edited" });
  });

  test("reads a missing description as the empty one triage read", () => {
    expect(
      triageStaleness(
        { ...row, sourceDescription: "" },
        { title: "T", description: null },
        days(0),
        7,
      ),
    ).toEqual({ stale: false });
  });
});

describe("triageScore", () => {
  test("ranks value per hour of work", () => {
    expect(triageScore({ value: 4, sizeMinutes: 30 })).toBeGreaterThan(
      triageScore({ value: 4, sizeMinutes: 180 }),
    );
  });

  test("floors tiny estimates so a 1-minute guess does not dominate", () => {
    expect(triageScore({ value: 1, sizeMinutes: 1 })).toBe(
      triageScore({ value: 1, sizeMinutes: 15 }),
    );
  });

  test("ranks untriaged after every triaged one", () => {
    expect(triageScore(undefined)).toBeLessThan(
      triageScore({ value: 1, sizeMinutes: 2000 }),
    );
  });
});
