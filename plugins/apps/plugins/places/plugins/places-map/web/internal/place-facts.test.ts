import { expect, test } from "bun:test";
import { compactCount, openLine, weekRows } from "./place-facts";

const at = (day: number, hour: number, minute = 0) => ({ day, hour, minute });
const weekdays = {
  periods: [1, 2, 3, 4, 5].map((d) => ({
    open: at(d, 9),
    close: at(d, 18, 30),
  })),
  weekdayDescriptions: [
    "Monday: 9:00 AM – 6:30 PM",
    "Tuesday: 9:00 AM – 6:30 PM",
    "Wednesday: 9:00 AM – 6:30 PM",
    "Thursday: 9:00 AM – 6:30 PM",
    "Friday: 9:00 AM – 6:30 PM",
    "Saturday: Closed",
    "Sunday: Closed",
  ],
};
// Wednesday 14 Oct 2026, read in UTC (offset 0).
const wed = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 14, h, m));

test("open, closing soon, closed until later today / tomorrow / after the weekend", () => {
  expect(openLine(weekdays, 0, wed(10))).toEqual({
    tone: "open",
    word: "Open",
    rest: "closes 18:30",
  });
  expect(openLine(weekdays, 0, wed(18))).toEqual({
    tone: "soon",
    word: "Closes soon",
    rest: "18:30",
  });
  expect(openLine(weekdays, 0, wed(7)).rest).toBe("opens 09:00");
  expect(openLine(weekdays, 0, wed(20)).rest).toBe("opens tomorrow 09:00");
  expect(openLine(weekdays, 0, new Date(Date.UTC(2026, 9, 17, 12))).rest).toBe(
    "opens Mon 09:00",
  );
});

test("the week, Monday first, with the place's today marked", () => {
  const rows = weekRows(weekdays, 0, wed(10));
  expect(rows[0]).toEqual({
    day: "Monday",
    hours: "9:00 AM – 6:30 PM",
    today: false,
  });
  expect(rows[2]!.today).toBe(true);
  expect(rows[5]).toEqual({ day: "Saturday", hours: "Closed", today: false });
});

test("counts compact like Google's", () => {
  expect(compactCount(950)).toBe("950");
  expect(compactCount(2100)).toBe("2.1k");
  expect(compactCount(182000)).toBe("182k");
});
