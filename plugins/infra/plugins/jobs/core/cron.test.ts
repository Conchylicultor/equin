import { describe, expect, test } from "bun:test";
import { cronMatches, nextCronFiring, parseCrontab } from "./cron";

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

describe("parseCrontab", () => {
  test("fields come out sorted and unique, day of week 7 folded into 0", () => {
    const tab = parseCrontab(" 30,5,5 9-11 * * 7,1 ");
    expect(tab.expr).toBe("30,5,5 9-11 * * 7,1");
    expect(tab.minutes).toEqual([5, 30]);
    expect(tab.hours).toEqual([9, 10, 11]);
    expect(tab.dows).toEqual([0, 1]);
    expect(tab.dates).toHaveLength(31);
    expect(tab.domRestricted).toBe(false);
    expect(tab.dowRestricted).toBe(true);
  });
});

describe("nextCronFiring", () => {
  test("crosses a year boundary and reaches a leap day", () => {
    expect(next("0 0 1 1 *", "2026-12-31T23:59:00Z")).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(next("0 0 29 2 *", "2026-10-18T00:00:00Z")).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  // The day walk against the definition: probe minute by minute with
  // `cronMatches`, from random instants, over random readable crontabs.
  test("equals a minute-by-minute probe of cronMatches", () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const field = (min: number, max: number): string => {
      switch (rand(4)) {
        case 0:
          return "*";
        case 1:
          return `*/${1 + rand(max - min)}`;
        case 2: {
          const a = min + rand(max - min);
          return `${a}-${a + rand(max - a + 1)}`;
        }
        default:
          return `${min + rand(max - min + 1)},${min + rand(max - min + 1)}`;
      }
    };
    for (let i = 0; i < 200; i++) {
      // The probe looks 40 days ahead; a rarer crontab is skipped below.
      const expr = [
        field(0, 59),
        field(0, 23),
        field(1, 31),
        rand(2) === 0 ? "*" : field(1, 12),
        field(0, 7),
      ].join(" ");
      const tab = parseCrontab(expr);
      const from = new Date(
        Date.UTC(2026, rand(12), 1 + rand(28), rand(24), rand(60), rand(60)),
      );
      const t = new Date(from.getTime());
      t.setUTCSeconds(0, 0);
      let brute: string | null = null;
      for (let m = 0; m < 40 * 24 * 60; m++) {
        t.setUTCMinutes(t.getUTCMinutes() + 1);
        const digest = {
          min: t.getUTCMinutes(),
          hour: t.getUTCHours(),
          date: t.getUTCDate(),
          month: t.getUTCMonth() + 1,
          dow: t.getUTCDay(),
        };
        if (cronMatches(tab, digest)) {
          brute = t.toISOString();
          break;
        }
      }
      if (brute === null) continue; // past the probe's reach — not comparable
      expect([expr, nextCronFiring(tab, from)?.toISOString()]).toEqual([
        expr,
        brute,
      ]);
    }
  });
});
