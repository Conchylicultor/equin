// Pure wording for the place card's Google facts: the open-now line, the
// rating count, the price ramp, today's row of the week. Tested beside.

import {
  openState,
  type OpeningHours,
  type OpeningPoint,
} from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The open-now line's tone: green open, amber closing soon, red closed. */
export type OpenTone = "open" | "soon" | "closed";

/** "Open" · "closes 22:30", "Closed" · "opens Tue 09:00". */
export interface OpenLine {
  tone: OpenTone;
  word: string;
  rest: string | null;
}

const hhmm = (p: OpeningPoint) =>
  `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;

/** The place's weekday now (0 = Sunday), in its own clock. */
export function placeWeekday(
  utcOffsetMinutes: number | undefined,
  now: Date,
): number {
  const offset = utcOffsetMinutes ?? -now.getTimezoneOffset();
  return new Date(now.getTime() + offset * 60_000).getUTCDay();
}

/** Whether the place is open at `now`, as the card words it. */
export function openLine(
  hours: OpeningHours,
  utcOffsetMinutes: number | undefined,
  now: Date,
): OpenLine {
  const state = openState(hours, utcOffsetMinutes, now);
  switch (state.kind) {
    case "always-open":
      return { tone: "open", word: "Open 24 hours", rest: null };
    case "open":
      return {
        tone: "open",
        word: "Open",
        rest: `closes ${hhmm(state.until)}`,
      };
    case "closing-soon":
      return { tone: "soon", word: "Closes soon", rest: hhmm(state.until) };
    case "closed": {
      if (state.until === null)
        return { tone: "closed", word: "Closed", rest: null };
      const today = placeWeekday(utcOffsetMinutes, now);
      const day =
        state.until.day === today
          ? ""
          : state.until.day === (today + 1) % 7
            ? "tomorrow "
            : `${DAY_SHORT[state.until.day]} `;
      return {
        tone: "closed",
        word: "Closed",
        rest: `opens ${day}${hhmm(state.until)}`,
      };
    }
  }
}

/**
 * Google's week as rows, Monday first, split into day and hours
 * ("Monday: 9:00 AM – 6:30 PM" → ["Monday", "9:00 AM – 6:30 PM"]), each
 * flagged when it is the place's today.
 */
export function weekRows(
  hours: OpeningHours,
  utcOffsetMinutes: number | undefined,
  now: Date,
): { day: string; hours: string; today: boolean }[] {
  // Google's lines start on Monday; the place's weekday counts from Sunday.
  const todayRow = (placeWeekday(utcOffsetMinutes, now) + 6) % 7;
  return hours.weekdayDescriptions.map((line, i) => {
    const at = line.indexOf(": ");
    return at < 0
      ? { day: line, hours: "", today: i === todayRow }
      : {
          day: line.slice(0, at),
          hours: line.slice(at + 2),
          today: i === todayRow,
        };
  });
}

/** 182000 → "182k", 2100 → "2.1k", 950 → "950". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}
