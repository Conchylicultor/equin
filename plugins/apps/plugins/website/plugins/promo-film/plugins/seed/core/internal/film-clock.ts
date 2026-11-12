// The film's calendar: the day and hour the story is set on, whatever day it
// is recorded. A Sunday recording showed every shop "Closed today" in the
// opening-times payoff (and a Monday, two of its four piano shops — Paris
// shops keep Sunday and Monday as their weekend); the film is set on a
// Tuesday-to-Friday afternoon instead.
//
// The seed picks the instant (`filmNowAfter` its own real time), stamps every
// "x ago" of the story relative to it, and leaves it in the workspace
// (`FILM_CLOCK_FILE`, read back with `FilmClockSchema`); the recording pins
// every page's Date to it (media/film's `installRecorderClock({ date })`).
// Rows the app itself writes at real time (a Wish's task, a page's blocks)
// read as old as the gap between the seed and the film's instant: at most a
// few days, since the instant is the FIRST such afternoon after the seed.

import { z } from "zod";
import {
  wallClockToInstant,
  zoneWallClock,
} from "@plugins/packages/plugins/wall-clock/core";

/** Where the story is set: its places, and the time of day the film shows. */
export const FILM_ZONE = "Europe/Paris";

/** The hour of the film's afternoon (in {@link FILM_ZONE}): every shop of the story is open then. */
export const FILM_HOUR = 15;

/** The seed's record of the film's instant, beside its workspace (`promoFilmWorkspaceDir`). */
export const FILM_CLOCK_FILE = "film-clock.json";

export const FilmClockSchema = z.object({
  /** The film's "now" (epoch ms): a {@link FILM_WEEKDAYS} day at {@link FILM_HOUR} in {@link FILM_ZONE}. */
  now: z.number().int(),
});
export type FilmClock = z.infer<typeof FilmClockSchema>;

/**
 * The days the film may be set on (`getUTCDay` numbers): Tuesday to Friday —
 * the days every shop of the story is open (the places' opening-times
 * payoff; the promo film's `pages` segment asserts it on the cards).
 */
export const FILM_WEEKDAYS: readonly number[] = [2, 3, 4, 5];

/**
 * The first {@link FILM_WEEKDAYS} day's {@link FILM_HOUR}:00 in
 * {@link FILM_ZONE} at or after `realMs`.
 */
export function filmNowAfter(realMs: number): number {
  const DAY = 24 * 60 * 60 * 1000;
  // Calendar days counted from the local date of `realMs`, never by adding
  // 24 h to an instant (a clock change would shift the hour).
  const today = zoneWallClock(new Date(realMs), FILM_ZONE);
  for (let k = 0; k < 8; k++) {
    // The k-th calendar day after today, read at noon UTC (no DST edge).
    const d = new Date(
      Date.UTC(today.year, today.month - 1, today.day) + k * DAY + DAY / 2,
    );
    if (!FILM_WEEKDAYS.includes(d.getUTCDay())) continue;
    const at = wallClockToInstant(
      {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: FILM_HOUR,
      },
      FILM_ZONE,
    ).getTime();
    if (at >= realMs) return at;
  }
  throw new Error(`filmNowAfter(${realMs}): no film day in the next 8 days`);
}
