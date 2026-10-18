import { describe, expect, test } from "bun:test";
import { nextCronFiring, parseCrontab } from "./cron";

const at = (iso: string) => new Date(iso);
const next = (expr: string, from: string) =>
  nextCronFiring(parseCrontab(expr), at(from))?.toISOString() ?? null;

describe("nextCronFiring", () => {
  test("every minute fires on the next minute", () => {
    expect(next("* * * * *", "2026-10-18T10:15:30Z")).toBe(
      "2026-10-18T10:16:00.000Z",
    );
  });

  test("steps, ranges and lists", () => {
    expect(next("*/15 * * * *", "2026-10-18T10:15:00Z")).toBe(
      "2026-10-18T10:30:00.000Z",
    );
    expect(next("0 9-17 * * *", "2026-10-18T17:30:00Z")).toBe(
      "2026-10-19T09:00:00.000Z",
    );
    expect(next("5,10 0 * * *", "2026-10-18T00:07:00Z")).toBe(
      "2026-10-18T00:10:00.000Z",
    );
  });

  test("day of week (7 is Sunday) and day of month", () => {
    // 2026-10-18 is a Sunday.
    expect(next("0 3 * * 7", "2026-10-18T04:00:00Z")).toBe(
      "2026-10-25T03:00:00.000Z",
    );
    expect(next("0 0 1 * *", "2026-10-18T00:00:00Z")).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  test("both day fields restricted: either matches", () => {
    // The 20th, or any Monday — the 19th is a Monday.
    expect(next("0 0 20 * 1", "2026-10-18T12:00:00Z")).toBe(
      "2026-10-19T00:00:00.000Z",
    );
  });

  test("a crontab that never fires answers null", () => {
    expect(next("0 0 31 2 *", "2026-10-18T00:00:00Z")).toBeNull();
  });

  test("an unreadable crontab throws", () => {
    expect(() => parseCrontab("* * *")).toThrow(/expected 5 fields/);
    expect(() => parseCrontab("61 * * * *")).toThrow(/outside/);
  });
});
