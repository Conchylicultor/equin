import { describe, expect, it } from "bun:test";
import { zoneWallClock } from "@plugins/packages/plugins/wall-clock/core";
import {
  FILM_HOUR,
  FILM_WEEKDAYS,
  FILM_ZONE,
  filmNowAfter,
} from "./film-clock";

const paris = (iso: string) => new Date(iso).getTime();
const weekdayInParis = (ms: number) => {
  const w = zoneWallClock(new Date(ms), FILM_ZONE);
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
};

describe("filmNowAfter", () => {
  it("a Sunday evening moves to Tuesday 15:00 in Paris (Monday the shops are shut)", () => {
    const at = filmNowAfter(paris("2026-11-08T20:00:00+01:00"));
    expect(new Date(at).toISOString()).toBe("2026-11-10T14:00:00.000Z");
  });

  it("a Tuesday morning is that afternoon; a Tuesday evening the next day", () => {
    expect(
      new Date(filmNowAfter(paris("2026-11-10T09:00:00+01:00"))).toISOString(),
    ).toBe("2026-11-10T14:00:00.000Z");
    expect(
      new Date(filmNowAfter(paris("2026-11-10T16:00:00+01:00"))).toISOString(),
    ).toBe("2026-11-11T14:00:00.000Z");
  });

  it("is always a film day at the film's hour, never before the seed", () => {
    for (let d = 0; d < 21; d++) {
      const real = paris("2026-03-20T07:30:00+01:00") + d * 86_400_000;
      const at = filmNowAfter(real);
      expect(at).toBeGreaterThanOrEqual(real);
      expect(FILM_WEEKDAYS).toContain(weekdayInParis(at));
      expect(zoneWallClock(new Date(at), FILM_ZONE).hour).toBe(FILM_HOUR);
    }
  });
});
