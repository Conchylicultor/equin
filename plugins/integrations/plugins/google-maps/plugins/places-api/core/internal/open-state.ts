import type { OpeningHours, OpeningPoint } from "./rich-details";

const WEEK = 7 * 24 * 60;
/** How close to closing time a place counts as closing soon. */
const CLOSING_SOON_MIN = 60;

/**
 * Whether a place is open at `now`, from its regular week, read in the place's
 * own clock (`utcOffsetMinutes`, else the caller's). `until` is the next change:
 * when it closes (open / closing soon) or next opens (closed), in the place's
 * clock. A week whose one period never closes is open around the clock.
 */
export type OpenState =
  | { kind: "always-open" }
  | { kind: "open" | "closing-soon"; until: OpeningPoint }
  | { kind: "closed"; until: OpeningPoint | null };

const minuteOfWeek = (p: OpeningPoint): number =>
  (p.day * 24 + p.hour) * 60 + p.minute;

const pointAt = (m: number): OpeningPoint => {
  const w = ((m % WEEK) + WEEK) % WEEK;
  return {
    day: Math.floor(w / 1440),
    hour: Math.floor((w % 1440) / 60),
    minute: w % 60,
  };
};

export function openState(
  hours: OpeningHours,
  utcOffsetMinutes: number | undefined,
  now: Date,
): OpenState {
  const periods: { open: OpeningPoint; close: OpeningPoint }[] = [];
  for (const { open, close } of hours.periods) {
    if (close === undefined) return { kind: "always-open" };
    periods.push({ open, close });
  }
  const offset = utcOffsetMinutes ?? -now.getTimezoneOffset();
  // The place's wall clock as minutes into its week (Sunday 00:00 = 0).
  const local = new Date(now.getTime() + offset * 60_000);
  const t =
    (local.getUTCDay() * 24 + local.getUTCHours()) * 60 + local.getUTCMinutes();

  let nextOpen: number | null = null;
  for (const p of periods) {
    const open = minuteOfWeek(p.open);
    // A period that closes on an earlier weekday than it opened crosses the
    // week's end (Saturday night into Sunday).
    let close = minuteOfWeek(p.close);
    if (close <= open) close += WEEK;
    for (const shift of [0, -WEEK]) {
      const [a, b] = [open + shift, close + shift];
      if (t >= a && t < b) {
        return {
          kind: b - t <= CLOSING_SOON_MIN ? "closing-soon" : "open",
          until: pointAt(b),
        };
      }
    }
    const ahead = (((open - t) % WEEK) + WEEK) % WEEK;
    if (nextOpen === null || ahead < nextOpen) nextOpen = ahead;
  }
  return {
    kind: "closed",
    until: nextOpen === null ? null : pointAt(t + nextOpen),
  };
}
