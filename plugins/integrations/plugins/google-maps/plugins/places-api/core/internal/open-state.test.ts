import { expect, test } from "bun:test";
import { openState } from "./open-state";
import type { OpeningHours } from "./rich-details";

const at = (day: number, hour: number, minute = 0) => ({ day, hour, minute });
const week = (periods: OpeningHours["periods"]): OpeningHours => ({
  periods,
  weekdayDescriptions: [],
});
// Wednesday 14 Oct 2026, in UTC; the place's offset is given explicitly.
const wed = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 14, h, m));

const office = week(
  [1, 2, 3, 4, 5].map((d) => ({ open: at(d, 9), close: at(d, 18) })),
);

test("open, with when it closes", () => {
  expect(openState(office, 0, wed(10))).toEqual({
    kind: "open",
    until: at(3, 18),
  });
});

test("closing soon in its last hour", () => {
  expect(openState(office, 0, wed(17, 30)).kind).toBe("closing-soon");
});

test("closed, with when it next opens — tomorrow, or after the weekend", () => {
  expect(openState(office, 0, wed(20))).toEqual({
    kind: "closed",
    until: at(4, 9),
  });
  const fri = new Date(Date.UTC(2026, 9, 17, 20));
  expect(openState(office, 0, fri)).toEqual({
    kind: "closed",
    until: at(1, 9),
  });
});

test("a period past midnight, and one across the week's end", () => {
  const bar = week([
    { open: at(3, 19), close: at(4, 2) },
    { open: at(6, 20), close: at(0, 3) },
  ]);
  expect(openState(bar, 0, new Date(Date.UTC(2026, 9, 15, 1))).kind).toBe(
    "closing-soon",
  ); // Thu 01:00
  expect(openState(bar, 0, new Date(Date.UTC(2026, 9, 18, 0, 30))).kind).toBe(
    "open",
  ); // Sun 00:30
});

test("read in the place's clock, not the caller's", () => {
  // 08:30 UTC is 10:30 in Paris (UTC+2): open there.
  expect(openState(office, 120, wed(8, 30)).kind).toBe("open");
  expect(openState(office, 0, wed(8, 30)).kind).toBe("closed");
});

test("around the clock, and no periods at all", () => {
  expect(openState(week([{ open: at(0, 0) }]), 0, wed(3))).toEqual({
    kind: "always-open",
  });
  expect(openState(week([]), 0, wed(3))).toEqual({
    kind: "closed",
    until: null,
  });
});
