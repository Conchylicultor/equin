import { z } from "zod";
import {
  cappedList,
  cappedRecord,
  wholeList,
} from "@plugins/packages/plugins/list-bound/core";
import {
  BrowserFamilySchema,
  DeviceFamilySchema,
  OsFamilySchema,
} from "./families";
import { ChannelSchema } from "./channel";
import { GapsSchema } from "./gaps";
import { LoadTimingSchema } from "./load-timing";
import { ViewportSchema } from "./viewport";
import { PageSectionsSchema } from "./page-sections";
import { MAX_EVENT_PROPS } from "./collect-body";
/**
 * Individual visits ("sessions"), each with its hits in order — what the
 * deploy app's Sessions tab lists, from its local copy of the site's tables
 * (raw rows only: 90 days).
 */

/** The usual page of visits a list asks for. */
export const SESSIONS_PAGE = 50;
/**
 * The most visits one window holds: two pages, what a split page of
 * network/live's window asks. With
 * {@link MAX_SESSION_HITS} hits each, one answer stays a few MB at worst.
 */
export const MAX_SESSIONS_LIMIT = 2 * SESSIONS_PAGE;
/** Hits returned per visit; a longer visit carries `hitsTruncated`. */
export const MAX_SESSION_HITS = 200;

/**
 * A visit's place in a list ordered by when it started: its start instant
 * exactly as `toISOString()` spells it (ms precision, as stored — fixed width,
 * so its text order is its time order), then its id. A window is cut between
 * two such places (`readVisitWindow`'s `after` / `until`).
 */
export const VisitCutSchema = z
  .object({
    startedAt: z.iso.datetime({ precision: 3 }),
    id: z.string().min(1),
  })
  .strict();
export type VisitCut = z.infer<typeof VisitCutSchema>;

/**
 * The visit fields a visit list may filter on, each run by collect's own SQL
 * (`server/internal/sessions.ts`): the visit's columns, its duration (the
 * report's one definition) and its memberships — `pages` and `eventNames`,
 * the report's `page` / `event` dimensions.
 */
export const VISIT_FILTER_COLUMNS = [
  "country",
  "channel",
  "device",
  "browser",
  "os",
  "language",
  "returning",
  "owner",
  "entryPath",
  "exitPath",
  "referrerHost",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "pageviews",
  "events",
  "durationMs",
  "startedAt",
  "pages",
  "eventNames",
] as const;
export type VisitFilterColumn = (typeof VISIT_FILTER_COLUMNS)[number];

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
    /**
     * Pageviews only: the page's full section list, in page order. Null =
     * not recorded (an event, an older tracker, a page with no sections, no
     * beacon yet) — the reader then only knows the sections someone reached.
     */
    sections: PageSectionsSchema.nullable(),
    /**
     * Pageviews only: the page's viewport in CSS pixels. Null = not recorded
     * (an event, an older tracker) — never a guessed size.
     */
    viewport: ViewportSchema.nullable(),
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
    /**
     * The visit came from a device the site's owner marked as theirs
     * (`audience.ts`). Absent from an older release, which had no mark.
     */
    owner: z.boolean().default(false),
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
    /** The distinct paths the visit hit (the report's `page` memberships), in code-point order. */
    pages: wholeList(z.string(), {
      reason:
        "one visit's distinct paths — what one visitor opened in one visit",
    }),
    /** The distinct custom events the visit sent (the report's `event` memberships), in code-point order. */
    eventNames: wholeList(z.string(), {
      reason:
        "one visit's distinct event names — the site's own small event vocabulary",
    }),
    /** The visit's first {@link MAX_SESSION_HITS} hits, by time. */
    hits: cappedList(SessionHitSchema, { max: MAX_SESSION_HITS }),
    hitsTruncated: z.boolean(),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;
