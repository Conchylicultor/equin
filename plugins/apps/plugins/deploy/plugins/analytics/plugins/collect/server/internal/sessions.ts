import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  BrowserFamilySchema,
  ChannelSchema,
  DeviceFamilySchema,
  GapsSchema,
  LoadTimingSchema,
  PageSectionsSchema,
  MAX_SESSION_HITS,
  OsFamilySchema,
  RAW_RETENTION_DAYS,
  planPeriods,
  sessionsAvailableFor,
  type SessionCounts,
  type SessionCountsQuery,
  type SessionCountsResult,
  type SessionHit,
  type SessionKey,
  type SessionShape,
  type SessionsQuery,
  type SessionsResult,
} from "../../core";
import {
  audienceCondition,
  visitDurationMs,
  visitHasAll,
} from "./aggregate-sql";
import type { AnalyticsDb } from "./collect";
import { liveVisitCutoff } from "./visit-grouping";

const REFUSED = {
  kind: "refused",
  reason: "beyond-raw-window",
  rawWindowDays: RAW_RETENTION_DAYS,
} as const;

/**
 * Over visit alias `v`: it started on one of days `from..to` — its `day`
 * (the UTC day it started, `utcDay(started_at)`), also spelled as the
 * `started_at` interval it is, so the list walks `analytics_visits_started_at_id_idx`
 * straight from the range's end instead of sorting the range.
 */
function startedInDays(from: string, to: string): SQL {
  return sql`v.day BETWEEN ${from} AND ${to}
    AND v.started_at >= (${from}::date)::timestamp AT TIME ZONE 'UTC'
    AND v.started_at < (${to}::date + 1)::timestamp AT TIME ZONE 'UTC'`;
}

/**
 * Answer one sessions question as of `now`: the visits of `query.range` that
 * pass its filters (the report's membership definition, `visitHasAll` — no
 * second filter dialect) and its shape, newest first by `(started_at, id)`,
 * inside the key range `(after, until]`, at most `limit` of them, each with
 * its first {@link MAX_SESSION_HITS} hits in time order. A range past the raw
 * window is refused: sessions are raw rows only.
 *
 * Costs the page, not the range: the read walks `(started_at, id)` down from
 * `after`, checks each visit's filters against its own hits, and stops at the
 * `limit`-th match — so a scroll step deep in a busy range costs what the first
 * one does. (A filter that few visits pass walks further for its page: the
 * visits it skips over, never the whole range unless nothing passes.)
 */
export async function runSessionsQuery(
  dbx: AnalyticsDb,
  query: SessionsQuery,
  now: Date,
): Promise<SessionsResult> {
  if (!sessionsAvailableFor(query.range, now)) return REFUSED;
  const { from, to } = planPeriods(query.range, now).current;
  const visits = await pageOfVisits(dbx, startedInDays(from, to), query, now);
  const hits = await hitsOf(
    dbx,
    visits.map((v) => v.id),
  );
  return {
    kind: "sessions",
    generatedAt: now.toISOString(),
    sessions: visits.map((visit) => {
      const own = hits.get(visit.id) ?? [];
      return {
        ...visit,
        hits: own.slice(0, MAX_SESSION_HITS),
        hitsTruncated: own.length > MAX_SESSION_HITS,
      };
    }),
  };
}

/**
 * How many visits of `query.range` pass its filters, per shape, as of `now`.
 * An exact count of a range costs the range's visits (each checked against
 * its own hits, as the list does) — which is why it is its own question,
 * asked once per range and filters rather than with every page.
 */
export async function runSessionCountsQuery(
  dbx: AnalyticsDb,
  query: SessionCountsQuery,
  now: Date,
): Promise<SessionCountsResult> {
  if (!sessionsAvailableFor(query.range, now)) return REFUSED;
  const { from, to } = planPeriods(query.range, now).current;
  return {
    kind: "counts",
    generatedAt: now.toISOString(),
    counts: await shapeCounts(dbx, startedInDays(from, to), query),
  };
}

/** Over visit alias `v`: the visit has `shape`. Bounced is the report's bounce (exactly one pageview). */
function shapeCondition(shape: SessionShape): SQL {
  switch (shape) {
    case "all":
      return sql`TRUE`;
    case "actions":
      return sql`v.events > 0`;
    case "multi":
      return sql`v.pageviews >= 2`;
    case "bounced":
      return sql`v.pageviews = 1`;
  }
}

const CountsRow = z.object({
  all: z.coerce.number().int(),
  actions: z.coerce.number().int(),
  multi: z.coerce.number().int(),
  bounced: z.coerce.number().int(),
});

async function shapeCounts(
  dbx: AnalyticsDb,
  inRange: SQL,
  query: SessionCountsQuery,
): Promise<SessionCounts> {
  const shaped = (shape: SessionShape) =>
    sql`(count(*) FILTER (WHERE ${shapeCondition(shape)}))::int`;
  const rows = await executeRows(dbx, {
    label: "analytics.sessionCounts",
    row: CountsRow,
    query: sql`
      SELECT ${shaped("all")} AS "all", ${shaped("actions")} AS "actions",
        ${shaped("multi")} AS "multi", ${shaped("bounced")} AS "bounced"
      FROM analytics_visits v
      WHERE ${inRange} AND ${audienceCondition(query.audience)}
        AND ${visitHasAll("v", query.filters)}`,
  });
  const [row] = rows;
  if (!row || rows.length !== 1)
    throw new Error("analytics: session counts must be one row");
  return row;
}

/** `(v.started_at, v.id)` compared to a key, in the list's descending order. */
function keyBound(op: "<" | ">=", key: SessionKey): SQL {
  return sql`(v.started_at, v.id) ${sql.raw(op)} (${key.startedAt}::timestamptz, ${key.id}::uuid)`;
}

// Instants are spelled by Postgres as `toISOString()` would (fixed width, UTC,
// milliseconds — what collect stores), so a key's text order is its time order.
const instant = z.iso.datetime();
function iso(column: string): SQL {
  return sql.raw(
    `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  );
}

const VisitRow = z.object({
  id: z.string(),
  visitor: z.string(),
  returning: z.boolean(),
  owner: z.boolean(),
  day: z.string(),
  startedAt: instant,
  lastAt: instant,
  live: z.boolean(),
  host: z.string(),
  entryPath: z.string(),
  exitPath: z.string(),
  exitAt: instant,
  exitEngagedMs: z.coerce.number().int(),
  durationMs: z.coerce.number().int(),
  engagedMs: z.coerce.number().int(),
  pageviews: z.coerce.number().int(),
  events: z.coerce.number().int(),
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
});
type VisitRow = z.infer<typeof VisitRow>;

async function pageOfVisits(
  dbx: AnalyticsDb,
  inRange: SQL,
  query: SessionsQuery,
  now: Date,
): Promise<VisitRow[]> {
  // Every condition is a per-visit fact (a visit's memberships do not depend
  // on its neighbours), so the walk down `(started_at, id)` checks each visit
  // once and stops at the `limit`-th that passes; the duration is computed
  // for the page's visits only.
  const where = sql.join(
    [
      inRange,
      audienceCondition(query.audience),
      shapeCondition(query.shape),
      ...(query.after ? [keyBound("<", query.after)] : []),
      ...(query.until ? [keyBound(">=", query.until)] : []),
      visitHasAll("v", query.filters),
    ],
    sql` AND `,
  );
  return executeRows(dbx, {
    label: "analytics.sessionsPage",
    row: VisitRow,
    query: sql`
      SELECT v.id::text AS "id",
        -- The visitor id never leaves the box: a short one-way display hash only.
        left(encode(sha256(convert_to(v.visitor_id, 'UTF8')), 'hex'), 8) AS "visitor",
        v.returning, v.owner, v.day::text AS "day",
        ${iso("v.started_at")} AS "startedAt", ${iso("v.last_at")} AS "lastAt",
        (v.last_at > ${liveVisitCutoff(now).toISOString()}::timestamptz) AS "live",
        v.host, v.entry_path AS "entryPath", v.exit_path AS "exitPath",
        ${iso("v.exit_at")} AS "exitAt", v.exit_engaged_ms AS "exitEngagedMs",
        ${visitDurationMs} AS "durationMs", v.engaged_ms AS "engagedMs",
        v.pageviews, v.events, v.channel,
        v.referrer_host AS "referrerHost", v.referrer_path AS "referrerPath",
        v.utm_source AS "utmSource", v.utm_medium AS "utmMedium",
        v.utm_campaign AS "utmCampaign",
        v.country, v.language, v.device, v.browser, v.os
      FROM (
        SELECT v.* FROM analytics_visits v
        WHERE ${where}
        ORDER BY v.started_at DESC, v.id DESC
        LIMIT ${query.limit}
      ) v
      ORDER BY v.started_at DESC, v.id DESC`,
  });
}

const HitRow = z.object({
  visitId: z.string(),
  ts: instant,
  kind: z.enum(["pageview", "event"]),
  path: z.string(),
  eventName: z.string().nullable(),
  eventProps: z.record(z.string(), z.string()).nullable(),
  engagedMs: z.coerce.number().int(),
  gaps: GapsSchema.nullable(),
  load: LoadTimingSchema.nullable(),
  sections: PageSectionsSchema.nullable(),
});

/**
 * Each visit's hits in time order, one read for the whole page, at most
 * `MAX_SESSION_HITS + 1` per visit — the extra one only says "truncated".
 */
async function hitsOf(
  dbx: AnalyticsDb,
  visitIds: readonly string[],
): Promise<Map<string, SessionHit[]>> {
  const byVisit = new Map<string, SessionHit[]>();
  if (visitIds.length === 0) return byVisit;
  const rows = await executeRows(dbx, {
    label: "analytics.sessionHits",
    row: HitRow,
    query: sql`
      SELECT x.visit_id::text AS "visitId", ${iso("x.ts")} AS "ts", x.kind, x.path,
        x.event_name AS "eventName", x.event_props AS "eventProps",
        x.engaged_ms AS "engagedMs", x.gaps, x.load, x.sections
      FROM (
        SELECT h.*, row_number() OVER (PARTITION BY h.visit_id ORDER BY h.ts, h.id) AS n
        FROM analytics_hits h
        WHERE h.visit_id IN (${sql.join(
          visitIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      ) x
      WHERE x.n <= ${MAX_SESSION_HITS + 1}
      ORDER BY x.visit_id, x.n`,
  });
  for (const { visitId, ...hit } of rows) {
    const list = byVisit.get(visitId);
    if (list) list.push(hit);
    else byVisit.set(visitId, [hit]);
  }
  return byVisit;
}
