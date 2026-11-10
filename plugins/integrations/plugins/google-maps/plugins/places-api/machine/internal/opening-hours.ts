import type { OpeningHours } from "../../core";

type Point = { day?: number; hour?: number; minute?: number };

/** Google's opening-hours wire shape (`regularOpeningHours`, `currentOpeningHours`). */
export interface OpeningHoursResponse {
  periods?: { open?: Point; close?: Point }[];
  weekdayDescriptions?: string[];
}

// Google drops zero-valued fields of a point (`hour: 0` is absent).
const point = (p: Point) => ({
  day: p.day ?? 0,
  hour: p.hour ?? 0,
  minute: p.minute ?? 0,
});

/** The neutral `OpeningHours` (unvalidated — the caller's schema parses it). */
export function openingHours(
  hours: OpeningHoursResponse | undefined,
): OpeningHours | undefined {
  if (hours === undefined) return undefined;
  return {
    periods: (hours.periods ?? []).map((p) => ({
      open: point(p.open ?? {}),
      close: p.close === undefined ? undefined : point(p.close),
    })),
    weekdayDescriptions: hours.weekdayDescriptions ?? [],
  };
}
