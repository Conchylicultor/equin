import { useEffect, useState } from "react";

const DAY_MS = 86_400_000;

/** UTC midnight of the current UTC day, as epoch ms. */
function utcMidnight(): number {
  return Math.floor(Date.now() / DAY_MS) * DAY_MS;
}

/**
 * The current UTC day (its midnight, epoch ms), moving at each UTC midnight —
 * the clock the cost days are keyed by (`YYYY-MM-DD` in UTC). A card left open
 * overnight then drops the oldest day of a rolling window instead of adding
 * new days to a window frozen at mount.
 *
 * One `setTimeout` at the next boundary, re-armed: not polling — it fires at
 * the one instant the value changes, which the calendar fixes in advance (the
 * same reasoning as data-view's day clock, which counts LOCAL days). UTC has no
 * DST, so the next boundary is exactly a day on.
 */
export function useUtcDay(): number {
  const [day, setDay] = useState(utcMidnight);
  useEffect(() => {
    // The extra second keeps a timer firing a hair early from re-arming on
    // the day it just left.
    const timer = setTimeout(
      () => setDay(utcMidnight()),
      Math.max(0, day + DAY_MS + 1_000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [day]);
  return day;
}
