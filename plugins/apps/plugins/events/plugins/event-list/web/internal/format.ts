import { canParseUrl } from "@plugins/packages/plugins/floor-compat/core";
// Pure display formatters for an event row. Local-calendar (never UTC) and
// locale-pinned to fixed English abbreviations so the output is deterministic
// and unit-testable — the app is English-only today, and `toLocaleString` would
// make both the tests and the row width depend on the host locale.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * When an event happens, as a person reads it: `Thu 14 Aug`, `Thu 14 Aug ·
 * 21:00`, or `14 Aug 2027` once the year differs from `now`'s.
 *
 * Absolute, NOT relative ("in 3d"): an events list is mostly forward-looking and
 * the weekday is load-bearing information — "Thu" is what decides whether you go.
 */
export function formatEventWhen(
  startsAt: Date,
  allDay: boolean,
  now: Date = new Date(),
): string {
  if (Number.isNaN(startsAt.getTime())) return "";
  const day = `${WEEKDAYS[startsAt.getDay()]} ${startsAt.getDate()} ${MONTHS[startsAt.getMonth()]}`;
  const withYear =
    startsAt.getFullYear() === now.getFullYear()
      ? day
      : `${day} ${startsAt.getFullYear()}`;
  if (allDay) return withYear;
  return `${withYear} · ${pad2(startsAt.getHours())}:${pad2(startsAt.getMinutes())}`;
}

/** `Venue · City`, either alone, or `null` when the event says neither. */
export function formatPlace(
  venue: string | null,
  city: string | null,
): string | null {
  const parts = [venue, city].filter(
    (p): p is string => !!p && p.trim() !== "",
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * A URL's host, without `www.`, for a compact link chip. Returns `null` for a
 * value the URL parser rejects — the caller then renders no chip rather than a
 * broken link.
 */
export function urlHost(raw: string): string | null {
  if (!canParseUrl(raw)) return null;
  return new URL(raw).host.replace(/^www\./, "");
}
