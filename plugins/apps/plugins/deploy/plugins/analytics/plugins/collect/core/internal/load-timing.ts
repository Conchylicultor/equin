import { z } from "zod";

/**
 * How long a hard page load took, from the navigation's start (ms, the page's
 * own `performance` clock):
 *
 * - `ttfbMs` — the document's first byte arrived (server response time).
 * - `fcpMs` — the first contentful paint.
 * - `readyMs` — the app was up: the later of the first contentful paint and
 *   the first commit showing the active app's content.
 *
 * Each is null when the browser did not measure it, or measured something that
 * is not load time (a page loaded in a background tab paints when it is first
 * shown). Never 0: a missing value is null.
 *
 * The tracker sends it once per page load, on the first engagement beacon of
 * the page load's first pageview — the hard load; later pageviews are in-app
 * navigations, which have no load of their own.
 */

/** A load phase past this is a stuck or suspended page, not a load: dropped (null). */
export const MAX_LOAD_MS = 10 * 60 * 1000;

const LoadMsSchema = z.number().int().positive().max(MAX_LOAD_MS).nullable();

export const LoadTimingSchema = z
  .object({
    ttfbMs: LoadMsSchema,
    fcpMs: LoadMsSchema,
    readyMs: LoadMsSchema,
  })
  .strict();
export type LoadTiming = z.infer<typeof LoadTimingSchema>;

/**
 * A measured instant as a stored phase: whole ms, rounded up so a sub-ms phase
 * stays positive; null for an unmeasured (null, ≤ 0, non-finite) or
 * implausible (> {@link MAX_LOAD_MS}) one.
 */
export function loadMs(ms: number | null): number | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const whole = Math.ceil(ms);
  return whole > MAX_LOAD_MS ? null : whole;
}
