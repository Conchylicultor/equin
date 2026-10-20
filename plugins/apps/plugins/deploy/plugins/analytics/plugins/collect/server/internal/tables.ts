import { z } from "zod";
import {
  boolean,
  date,
  index,
  integer,
  bigint,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import {
  BrowserFamilySchema,
  ChannelSchema,
  DailyDimensionSchema,
  DeviceFamilySchema,
  FilterLevelSchema,
  OsFamilySchema,
} from "../../core";

/**
 * One random salt per UTC day. A day's visitor hash is `sha256(salt ‖ ip ‖ ua
 * ‖ host)`. The nightly rollup deletes every salt older than
 * `IDENTITY_WINDOW_DAYS`, after which that day's hashes can no longer be
 * reproduced from anyone's IP.
 */
export const analyticsSalts = pgTable("analytics_salts", {
  day: date("day", { mode: "string" }).primaryKey(),
  /** 32 random bytes, hex. */
  salt: text("salt").notNull(),
});

/**
 * "On this day, this hash was this visitor." Written on a visitor's first hit
 * of each day; a later day's first hit recomputes its hash under every retained
 * salt and follows the newest matching link to the same `visitor_id`. Pruned
 * with its salt, so a visitor absent `IDENTITY_WINDOW_DAYS` is forgotten.
 */
export const analyticsVisitorLinks = pgTable(
  "analytics_visitor_links",
  {
    day: date("day", { mode: "string" }).notNull(),
    hash: text("hash").notNull(),
    visitorId: text("visitor_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.hash] })],
);

/**
 * One visit: a run of activity from the same visitor with no gap of 30
 * minutes or more. Kept 90 days (`retention.ts`); its hits cascade.
 *
 * Source attributes (referrer, campaign, device…) are set when the visit is
 * created and never change. `exit*`, `pageviews`, `events`, `engagedMs` and
 * `lastAt` move with each hit.
 */
export const analyticsVisits = pgTable(
  "analytics_visits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Opaque visitor id: a random UUID, stable while the visitor keeps
     * returning (see {@link analyticsVisitorLinks}). Visits recorded before
     * the sliding identity carry their daily hash here instead.
     */
    visitorId: text("visitor_id").notNull(),
    /**
     * The visitor had a visit before this one: their id was already linked
     * when it opened (see {@link analyticsVisitorLinks}). Set once, never
     * changes; a first visit is `false`.
     */
    returning: boolean("returning").notNull().default(false),
    /** UTC day the visit started on — the day every report attributes it to. */
    day: date("day", { mode: "string" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Last activity of any kind (pageview, event, engagement beacon). */
    lastAt: timestamp("last_at", { withTimezone: true }).notNull(),
    host: text("host").notNull(),
    entryPath: text("entry_path").notNull(),
    exitPath: text("exit_path").notNull(),
    /** When the exit page was viewed. */
    exitAt: timestamp("exit_at", { withTimezone: true }).notNull(),
    /** The exit pageview's hit; null for a visit that has only events. */
    exitPageviewId: uuid("exit_pageview_id"),
    /** How long the exit page was visible. Duration = exitAt − startedAt + this. */
    exitEngagedMs: integer("exit_engaged_ms").notNull().default(0),
    pageviews: integer("pageviews").notNull().default(0),
    events: integer("events").notNull().default(0),
    /** Visible time summed over every page of the visit. */
    engagedMs: bigint("engaged_ms", { mode: "number" }).notNull().default(0),
    referrerHost: text("referrer_host"),
    referrerPath: text("referrer_path"),
    channel: parsedText("channel", ChannelSchema).notNull(),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    country: text("country"),
    language: text("language"),
    device: parsedText("device", DeviceFamilySchema).notNull(),
    browser: parsedText("browser", BrowserFamilySchema).notNull(),
    os: parsedText("os", OsFamilySchema).notNull(),
  },
  (t) => [
    index("analytics_visits_visitor_last_at_idx").on(t.visitorId, t.lastAt),
    index("analytics_visits_day_idx").on(t.day),
    index("analytics_visits_started_at_idx").on(t.startedAt),
  ],
);

export const HitKindSchema = z.enum(["pageview", "event"]);

/** One pageview or custom event inside a visit. */
export const analyticsHits = pgTable(
  "analytics_hits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visitId: uuid("visit_id")
      .notNull()
      .references(() => analyticsVisits.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    kind: parsedText("kind", HitKindSchema).notNull(),
    path: text("path").notNull(),
    eventName: text("event_name"),
    eventProps: parsedJson("event_props", z.record(z.string(), z.string())),
    /** Pageviews only: the highest cumulative visible time a beacon reported. */
    engagedMs: integer("engaged_ms").notNull().default(0),
  },
  (t) => [index("analytics_hits_visit_idx").on(t.visitId)],
);

/**
 * Which (dimension, value) pairs each visit had, and whose it was — the
 * membership relation of `aggregate-sql.ts` materialised by the nightly rollup
 * and kept forever (no FK: visits go after 90 days). It is what counts unique
 * visitors exactly over ranges past the raw window, where the additive daily
 * totals cannot: a visitor spans days, so daily visitor counts do not sum.
 * `dim = "total"` holds one row per visit.
 */
export const analyticsVisitMembers = pgTable(
  "analytics_visit_members",
  {
    visitId: uuid("visit_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    visitorId: text("visitor_id").notNull(),
    dim: parsedText("dim", DailyDimensionSchema).notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.visitId, t.dim, t.value] }),
    index("analytics_visit_members_level_idx").on(t.dim, t.value, t.day),
    index("analytics_visit_members_day_idx").on(t.day),
  ],
);

/**
 * Daily totals, kept forever. One row per (day, filter level, dimension, value).
 *
 * - `filter_dim = "none"`, `filter_value = ""`: unfiltered.
 * - any other (filter_dim, filter_value): the same breakdown restricted to the
 *   visits that have that one value — e.g. every page's counts among visits
 *   whose channel is Search.
 * - `dimension = "total"`, `value = ""`: the level's summary line.
 *
 * Every column is additive (see `AdditiveMetrics` in core), so any range is a
 * SUM. Unique visitors are not additive and are counted from
 * {@link analyticsVisitMembers} instead.
 */
export const analyticsDaily = pgTable(
  "analytics_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    filterDim: parsedText("filter_dim", FilterLevelSchema).notNull(),
    filterValue: text("filter_value").notNull(),
    dimension: parsedText("dimension", DailyDimensionSchema).notNull(),
    value: text("value").notNull(),
    visits: integer("visits").notNull(),
    pageviews: integer("pageviews").notNull(),
    bounces: integer("bounces").notNull(),
    returningVisits: integer("returning_visits").notNull().default(0),
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
    events: integer("events").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.day, t.filterDim, t.filterValue, t.dimension, t.value],
    }),
    index("analytics_daily_level_idx").on(
      t.filterDim,
      t.filterValue,
      t.dimension,
      t.day,
    ),
  ],
);
