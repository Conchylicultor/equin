import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  BrowserFamilySchema,
  ChannelSchema,
  DeviceFamilySchema,
  MAX_SESSION_HITS,
  OsFamilySchema,
  RAW_RETENTION_DAYS,
  planPeriods,
  sessionsAvailableFor,
  type SessionCounts,
  type SessionHit,
  type SessionKey,
  type SessionShape,
  type SessionsQuery,
  type SessionsResult,
} from "../../core";
import { keptVisitsWith } from "./aggregate-sql";
import type { AnalyticsDb } from "./collect";
import { liveVisitCutoff } from "./visit-grouping";

/**
 * Answer one sessions question as of `now`: the visits of `query.range` that
 * pass its filters (the report's membership SQL — no second filter dialect)
 * and its shape, newest first by `(started_at, id)`, inside the key range
 * `(after, until]`, at most `limit` of them, each with its first
 * {@link MAX_SESSION_HITS} hits in time order; plus every shape's count over
 * the whole range. A range past the raw window is refused: sessions are raw
 * rows only.
 */
export async function runSessionsQuery(
  dbx: AnalyticsDb,
  query: SessionsQuery,
  now: Date,
): Promise<SessionsResult> {
  if (!sessionsAvailableFor(query.range, now)) {
    return {
      kind: "refused",
      reason: "beyond-raw-window",
      rawWindowDays: RAW_RETENTION_DAYS,
    };
  }
  const { from, to } = planPeriods(query.range, now).current;
  const inRange = sql`v.day BETWEEN ${from} AND ${to}`;
  const [counts, visits] = await Promise.all([
    shapeCounts(dbx, inRange, query),
    pageOfVisits(dbx, inRange, query, now),
  ]);
  const hits = await hitsOf(
    dbx,
    visits.map((v) => v.id),
  );
  return {
    kind: "sessions",
    generatedAt: now.toISOString(),
    counts,
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
  query: SessionsQuery,
): Promise<SessionCounts> {
  const shaped = (shape: SessionShape) =>
    sql`(count(*) FILTER (WHERE ${shapeCondition(shape)}))::int`;
  const rows = await executeRows(dbx, {
    label: "analytics.sessionCounts",
    row: CountsRow,
    query: sql`
      ${keptVisitsWith(inRange, query.filters)}
      SELECT ${shaped("all")} AS "all", ${shaped("actions")} AS "actions",
        ${shaped("multi")} AS "multi", ${shaped("bounced")} AS "bounced"
      FROM kept v`,
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
  // The key range and shape are per-visit facts, so they narrow `base` itself:
  // a visit's memberships (and so the filters) do not depend on its neighbours.
  const where = sql.join(
    [
      inRange,
      shapeCondition(query.shape),
      ...(query.after ? [keyBound("<", query.after)] : []),
      ...(query.until ? [keyBound(">=", query.until)] : []),
    ],
    sql` AND `,
  );
  return executeRows(dbx, {
    label: "analytics.sessionsPage",
    row: VisitRow,
    query: sql`
      ${keptVisitsWith(where, query.filters)}
      SELECT k.id::text AS "id",
        -- The visitor id never leaves the box: a short one-way display hash only.
        left(encode(sha256(convert_to(k.visitor_id, 'UTF8')), 'hex'), 8) AS "visitor",
        k.returning, k.day::text AS "day",
        ${iso("k.started_at")} AS "startedAt", ${iso("k.last_at")} AS "lastAt",
        (k.last_at > ${liveVisitCutoff(now).toISOString()}::timestamptz) AS "live",
        k.host, k.entry_path AS "entryPath", k.exit_path AS "exitPath",
        ${iso("k.exit_at")} AS "exitAt", k.exit_engaged_ms AS "exitEngagedMs",
        k.duration_ms AS "durationMs", k.engaged_ms AS "engagedMs",
        k.pageviews, k.events, k.channel,
        k.referrer_host AS "referrerHost", k.referrer_path AS "referrerPath",
        k.utm_source AS "utmSource", k.utm_medium AS "utmMedium",
        k.utm_campaign AS "utmCampaign",
        k.country, k.language, k.device, k.browser, k.os
      FROM kept k
      ORDER BY k.started_at DESC, k.id DESC
      LIMIT ${query.limit}`,
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
        x.engaged_ms AS "engagedMs"
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
