import { describe, expect, test } from "bun:test";
import {
  formatReportActivity,
  reportActivity,
  type ReportActivityInput,
} from "./activity";

const HOUR = 3_600_000;
// 15:20 UTC: the window is 16:00 the day before (23 whole hours back) → now.
const NOW = Date.parse("2026-11-08T15:20:00.000Z");
const WINDOW_START = Date.parse("2026-11-07T16:00:00.000Z");

const input = (over: Partial<ReportActivityInput>): ReportActivityInput => ({
  count: 1,
  lastSeenAt: new Date(NOW),
  hourly: null,
  recent: [],
  ...over,
});

describe("reportActivity", () => {
  test("counts the current hour and the 23 before it, beside the lifetime total", () => {
    const a = reportActivity(
      input({
        count: 2717,
        hourly: {
          hours: [
            { h: Date.parse("2026-11-08T15:00:00.000Z"), n: 20 },
            { h: WINDOW_START, n: 11 },
            { h: WINDOW_START - HOUR, n: 400 },
          ],
          untrackedBefore: null,
        },
      }),
      NOW,
    );
    expect(a).toEqual({ recent: { n: 31, exact: true }, total: 2717 });
    expect(formatReportActivity(a)).toBe("31 in the last 24 h · 2,717 total");
  });

  test("a report quiet for the whole window is exactly 0, whatever it counted", () => {
    const a = reportActivity(
      input({ count: 500, lastSeenAt: new Date(WINDOW_START - 1) }),
      NOW,
    );
    expect(a.recent).toEqual({ n: 0, exact: true });
  });

  test("counting begun inside the window reads the rest from recent when recent reaches past it", () => {
    const a = reportActivity(
      input({
        count: 900,
        hourly: {
          hours: [{ h: Date.parse("2026-11-08T15:00:00.000Z"), n: 1 }],
          untrackedBefore: NOW - 60_000,
        },
        recent: [
          { at: NOW - 60_000 },
          { at: NOW - 2 * HOUR },
          { at: WINDOW_START - HOUR },
        ],
      }),
      NOW,
    );
    expect(a.recent).toEqual({ n: 2, exact: true });
  });

  test("an untracked report whose recent is all inside the window is a floor, never a guess", () => {
    const recent = Array.from({ length: 10 }, (_, i) => ({
      at: NOW - i * 60_000,
    }));
    const a = reportActivity(input({ count: 2717, recent }), NOW);
    expect(a.recent).toEqual({ n: 10, exact: false });
    expect(formatReportActivity(a)).toBe("≥ 10 in the last 24 h · 2,717 total");
  });

  test("an untracked report whose recent holds every occurrence is exact", () => {
    const a = reportActivity(
      input({ count: 2, recent: [{ at: NOW }, { at: NOW - HOUR }] }),
      NOW,
    );
    expect(a.recent).toEqual({ n: 2, exact: true });
  });
});
