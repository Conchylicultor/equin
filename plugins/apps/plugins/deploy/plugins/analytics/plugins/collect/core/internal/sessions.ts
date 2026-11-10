import { z } from "zod";
import {
  cappedList,
  cappedRecord,
} from "@plugins/packages/plugins/list-bound/core";
import {
  BrowserFamilySchema,
  DeviceFamilySchema,
  OsFamilySchema,
} from "./families";
import { ChannelSchema } from "./channel";
import { GapsSchema } from "./gaps";
import { LoadTimingSchema } from "./load-timing";
import { MAX_EVENT_PROPS } from "./collect-body";
import {
  AnalyticsRangeSchema,
  RAW_RETENTION_DAYS,
  firstRawDay,
  planPeriods,
  type AnalyticsRange,
} from "./periods";
import {
  AnalyticsFilterSchema,
  MAX_FILTERS,
  base64UrlJsonParamSchema,
  encodeBase64UrlJson,
} from "./query";

/**
 * Individual visits ("sessions"), each with its hits in order — what the
 * deploy app's Sessions tab lists. Sessions exist only as raw rows, so a range
 * reaching past the 90-day raw window is refused, never approximated.
 */

/** The usual page of visits a list asks for. */
export const SESSIONS_PAGE = 50;
/**
 * The most visits one answer holds (a caller's `limit` above it is refused):
 * two pages, what a split page of network/live's paged value asks. With
 * {@link MAX_SESSION_HITS} hits each, one answer stays a few MB at worst.
 */
export const MAX_SESSIONS_LIMIT = 2 * SESSIONS_PAGE;
/** Hits returned per visit; a longer visit carries `hitsTruncated`. */
export const MAX_SESSION_HITS = 200;

/**
 * Which visits the list shows. Each one's count over the whole range comes
 * back with every page (`counts`), so the switch can label every option.
 * - `all`
 * - `actions` — at least one custom event
 * - `multi` — two pageviews or more
 * - `bounced` — exactly one pageview (the report's bounce)
 */
export const SESSION_SHAPES = ["all", "actions", "multi", "bounced"] as const;
export const SessionShapeSchema = z.enum(SESSION_SHAPES);
export type SessionShape = z.infer<typeof SessionShapeSchema>;

/**
 * A visit's place in the list, which is newest first: `(startedAt, id)`
 * descending. A page is a KEY RANGE of that order (`after` exclusive, `until`
 * inclusive), so it stays well defined while new visits arrive at the top —
 * the shape network/live's paged value asks its loader for. `startedAt` is
 * the stored instant as `toISOString()` (fixed width, so its text order is its
 * time order).
 */
export const SessionKeySchema = z
  .object({
    /** ISO instant the visit started, exactly as `toISOString()` spells it (ms precision, as stored). */
    startedAt: z.iso.datetime({ precision: 3 }),
    id: z.uuid(),
  })
  .strict();
export type SessionKey = z.infer<typeof SessionKeySchema>;

export const SessionsQuerySchema = z
  .object({
    range: AnalyticsRangeSchema,
    /** The report's filters, applied by the report's own membership SQL. */
    filters: z.array(AnalyticsFilterSchema).max(MAX_FILTERS),
    shape: SessionShapeSchema,
    /** Exclusive: only visits ordered after (older than) this key. Absent = from the newest. */
    after: SessionKeySchema.optional(),
    /** Inclusive: no visit ordered after (older than) this key. Absent = no lower bound. */
    until: SessionKeySchema.optional(),
    /** At most this many visits; an answer holding fewer is the end of the range. */
    limit: z.number().int().min(1).max(MAX_SESSIONS_LIMIT),
  })
  .strict()
  .refine(
    (q) =>
      new Set(q.filters.map((f) => JSON.stringify([f.dimension, f.value])))
        .size === q.filters.length,
    { message: "duplicate filter" },
  );
export type SessionsQuery = z.infer<typeof SessionsQuerySchema>;

/** Whether `range`'s every day still has raw rows at `now` (else sessions are refused). */
export function sessionsAvailableFor(
  range: AnalyticsRange,
  now: Date,
): boolean {
  return planPeriods(range, now).current.from >= firstRawDay(now);
}

export const SessionHitSchema = z
  .object({
    ts: z.iso.datetime(),
    kind: z.enum(["pageview", "event"]),
    path: z.string(),
    /** Events only. */
    eventName: z.string().nullable(),
    eventProps: cappedRecord(z.string(), { max: MAX_EVENT_PROPS }).nullable(),
    /** Pageviews only: how long the page was visible. */
    engagedMs: z.number().int().nonnegative(),
    /**
     * Pageviews only: when the page sat in the background or idle (offsets
     * from `ts`). Null = not recorded (an event, or a pageview from an older
     * tracker) — never "none", which is `[]`.
     */
    gaps: GapsSchema.nullable(),
    /**
     * The pageview that was a hard page load: how long it took. Null = not
     * recorded (an in-app navigation, an event, an older tracker, no beacon
     * yet) — never 0.
     */
    load: LoadTimingSchema.nullable(),
  })
  .strict();
export type SessionHit = z.infer<typeof SessionHitSchema>;

/**
 * One visit. Its visitor id never leaves the box: `visitor` is a short
 * one-way display hash of it, enough to tell two rows of the same returning
 * visitor apart from others in a list, not to look anyone up.
 */
export const SessionSchema = z
  .object({
    id: z.uuid(),
    visitor: z.string().regex(/^[0-9a-f]{8}$/),
    returning: z.boolean(),
    day: z.string(),
    startedAt: z.iso.datetime(),
    lastAt: z.iso.datetime(),
    /** Still open at the time of the answer: a later hit may extend it. A closed visit never changes. */
    live: z.boolean(),
    host: z.string(),
    entryPath: z.string(),
    exitPath: z.string(),
    exitAt: z.iso.datetime(),
    /** How long the exit page was visible; `durationMs` adds its background stretches. */
    exitEngagedMs: z.number().int().nonnegative(),
    /**
     * The report's visit duration (collect's one definition): wall-clock from
     * the start to the end of the exit page — exit − start + the exit page's
     * visible time + its recorded background (`hidden`) stretches.
     */
    durationMs: z.number().int().nonnegative(),
    engagedMs: z.number().int().nonnegative(),
    pageviews: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    channel: ChannelSchema,
    referrerHost: z.string().nullable(),
    referrerPath: z.string().nullable(),
    utmSource: z.string().nullable(),
    utmMedium: z.string().nullable(),
    utmCampaign: z.string().nullable(),
    country: z.string().nullable(),
    language: z.string().nullable(),
    device: DeviceFamilySchema,
    browser: BrowserFamilySchema,
    os: OsFamilySchema,
    /** The visit's first {@link MAX_SESSION_HITS} hits, by time. */
    hits: cappedList(SessionHitSchema, { max: MAX_SESSION_HITS }),
    hitsTruncated: z.boolean(),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;

const CountSchema = z.number().int().nonnegative();
export const SessionCountsSchema = z
  .object(
    Object.fromEntries(SESSION_SHAPES.map((s) => [s, CountSchema])) as Record<
      SessionShape,
      typeof CountSchema
    >,
  )
  .strict();
export type SessionCounts = z.infer<typeof SessionCountsSchema>;

export const SessionsResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sessions"),
      /** ISO instant the box answered at. */
      generatedAt: z.iso.datetime(),
      /** In list order; fewer than the asked `limit` means the range ends here. */
      sessions: cappedList(SessionSchema, { max: MAX_SESSIONS_LIMIT }),
      /** Visits per shape over the whole range and filters, whatever `shape`, `after`, `until` and `limit` are. */
      counts: SessionCountsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("refused"),
      reason: z.literal("beyond-raw-window"),
      rawWindowDays: z.literal(RAW_RETENTION_DAYS),
    })
    .strict(),
]);
export type SessionsResult = z.infer<typeof SessionsResultSchema>;

/** The sessions question on the wire — the report's base64url encoding. */
export function encodeSessionsQuery(query: SessionsQuery): string {
  return encodeBase64UrlJson(query);
}

/** The sessions endpoint's `?q=` schema. */
export const SessionsQueryParamSchema =
  base64UrlJsonParamSchema(SessionsQuerySchema);
