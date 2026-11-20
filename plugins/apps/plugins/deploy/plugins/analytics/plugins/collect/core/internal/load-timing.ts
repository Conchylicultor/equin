import { z } from "zod";
import {
  MAX_PROTOCOL_LENGTH,
  type FIRST_BYTE_GAPS,
  type FirstByteSplit,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/core";

/**
 * How long a hard page load took, from the navigation's start (ms, the page's
 * own `performance` clock):
 *
 * - `ttfbMs` — the document's first byte arrived (server response time).
 * - `fcpMs` — the first contentful paint.
 * - `readyMs` — the app was up: the later of the first contentful paint and
 *   the first commit showing the active app's content.
 * - `firstByte` — where `ttfbMs` went (boot-trace's `FirstByteSplit`:
 *   redirects and unload, DNS, TCP, TLS, request → response), so a slow first
 *   byte says whether the visitor waited on the server or on their network.
 *   Null when not measured; absent on loads recorded before it existed.
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

const PartMsSchema = z.number().int().nonnegative().max(MAX_LOAD_MS);

/**
 * A first-byte split as stored: boot-trace's `FirstByteSplit`, its three named
 * gaps optional — the splits recorded before they were named (2026-11-20) hold
 * only their sum, `otherMs`.
 */
export type StoredFirstByteSplit = Omit<
  FirstByteSplit,
  (typeof FIRST_BYTE_GAPS)[number]
> &
  Partial<Pick<FirstByteSplit, (typeof FIRST_BYTE_GAPS)[number]>>;

/** The wire form of boot-trace's `FirstByteSplit` (whole ms, parts add up). */
export const FirstByteSplitSchema = z
  .object({
    totalMs: PartMsSchema,
    beforeFetchMs: PartMsSchema,
    dnsMs: PartMsSchema,
    tcpMs: PartMsSchema,
    tlsMs: PartMsSchema,
    waitMs: PartMsSchema,
    queueMs: PartMsSchema.optional(),
    stallMs: PartMsSchema.optional(),
    sendMs: PartMsSchema.optional(),
    otherMs: PartMsSchema,
    protocol: z.string().max(MAX_PROTOCOL_LENGTH).nullable(),
  })
  .strict() satisfies z.ZodType<StoredFirstByteSplit>;

export const LoadTimingSchema = z
  .object({
    ttfbMs: LoadMsSchema,
    fcpMs: LoadMsSchema,
    readyMs: LoadMsSchema,
    firstByte: FirstByteSplitSchema.nullable().optional(),
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

/**
 * A measured split as stored: null when the browser gave none, or one whose
 * total is not a plausible load (the same bound as every other phase).
 */
export function firstByteOf(
  split: FirstByteSplit | null,
): FirstByteSplit | null {
  if (split === null || split.totalMs <= 0 || split.totalMs > MAX_LOAD_MS)
    return null;
  return split;
}
