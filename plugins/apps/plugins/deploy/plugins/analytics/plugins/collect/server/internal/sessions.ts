import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  executeOne,
  executeRows,
} from "@plugins/database/plugins/sql-rows/core";
import type {
  Filter,
  FilterColumn,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { filterSql } from "@plugins/network/plugins/live/plugins/filter/server";
import type { AnalyticsReadDb } from "./collect";
import {
  BrowserFamilySchema,
  ChannelSchema,
  DeviceFamilySchema,
  GapsSchema,
  LoadTimingSchema,
  PageSectionsSchema,
  MAX_SESSION_HITS,
  OsFamilySchema,
  type Session,
  type SessionHit,
  type VisitCut,
  type VisitFilterColumn,
} from "../../core";
import { visitDurationMs, visitMembershipValues } from "./aggregate-sql";
import { liveVisitCutoff } from "./visit-grouping";

// Individual visits ("sessions") as a window of the filter language: the
// deploy app's Sessions tab reads them from its local copy of a site's tables
// (`apps/deploy/site-mirror`), through these functions, on that copy — this
// SQL is the only implementation, wherever the tables are.
//
// Every question reads `analytics_visits v`; a filter names the visit's own
// columns, its duration (`visitDurationMs`, the report's one definition) and
// its memberships (`visitMembershipValues`, the report's one definition), so
// the list keeps exactly the visits the report counts.

/** Anything a read can run on: the database, or a transaction (a replica's read). */
export type VisitReads = AnalyticsReadDb;

/** Each filterable visit column, as the SQL over `v` reads it. */
const VISIT_FILTER_TARGETS: Readonly<Record<VisitFilterColumn, SQL>> = {
  country: sql`v.country`,
  channel: sql`v.channel`,
  device: sql`v.device`,
  browser: sql`v.browser`,
  os: sql`v.os`,
  language: sql`v.language`,
  returning: sql`v.returning`,
  owner: sql`v.owner`,
  entryPath: sql`v.entry_path`,
  exitPath: sql`v.exit_path`,
  referrerHost: sql`v.referrer_host`,
  utmSource: sql`v.utm_source`,
  utmMedium: sql`v.utm_medium`,
  utmCampaign: sql`v.utm_campaign`,
  pageviews: sql`v.pageviews`,
  events: sql`v.events`,
  durationMs: visitDurationMs,
  startedAt: sql`v.started_at`,
  // The filter language's string arrays are jsonb arrays.
  pages: sql`to_jsonb(${visitMembershipValues("v", "page")})`,
  eventNames: sql`to_jsonb(${visitMembershipValues("v", "event")})`,
};

/** The filterable visit columns that are numbers. */
const NUMBER_COLUMNS: ReadonlySet<VisitFilterColumn> = new Set([
  "pageviews",
  "events",
  "durationMs",
]);

/** The filterable visit columns a caller's filter is declared over (a subset of {@link VisitFilterColumn}). */
export type VisitFilterable = Partial<Record<VisitFilterColumn, FilterColumn>>;

/** `where` as a predicate over `v` — `TRUE` for the absent filter. */
function visitFilterSql<F extends VisitFilterable>(
  where: Filter | undefined,
  filterable: F,
): SQL {
  const targets: Record<string, SQL> = {};
  for (const column of Object.keys(filterable)) {
    targets[column] = VISIT_FILTER_TARGETS[column as VisitFilterColumn];
  }
  return (
    filterSql(
      where as Filter<Record<string, FilterColumn>> | undefined,
      targets,
      filterable as Record<string, FilterColumn>,
    ) ?? sql`TRUE`
  );
}

/** The window a visit list asks for: its visits matching `where`, by `started_at` then id (ascending), inside `(after, until]`, at most `limit`. */
export interface VisitWindowQuery<F extends VisitFilterable> {
  where: Filter | undefined;
  filterable: F;
  /** The direction of `started_at`; ties are broken by the visit id ascending (code point). */
  direction: "asc" | "desc";
  after?: VisitCut;
  until?: VisitCut;
  limit: number;
}

/** The rows strictly past `cut` in the window's order. */
function afterSql(cut: VisitCut, desc: boolean): SQL {
  const at = sql`${cut.startedAt}::timestamptz`;
  return sql`(v.started_at ${sql.raw(desc ? "<" : ">")} ${at}
    OR (v.started_at = ${at} AND v.id::text COLLATE "C" > ${cut.id}))`;
}

/** The rows at or before `cut` in the window's order. */
function untilSql(cut: VisitCut, desc: boolean): SQL {
  const at = sql`${cut.startedAt}::timestamptz`;
  return sql`(v.started_at ${sql.raw(desc ? ">" : "<")} ${at}
    OR (v.started_at = ${at} AND v.id::text COLLATE "C" <= ${cut.id}))`;
}

/**
 * One window of visits as of `now`, each with its first
 * {@link MAX_SESSION_HITS} hits in time order.
 *
 * Costs the page, not the range: the read walks `(started_at, id)` from the
 * cut, checks each visit's filter against its own row and hits, and stops at
 * the `limit`-th match; the duration and memberships are computed for the
 * page's rows only.
 */
export async function readVisitWindow<F extends VisitFilterable>(
  dbx: VisitReads,
  q: VisitWindowQuery<F>,
  now: Date,
): Promise<Session[]> {
  const desc = q.direction === "desc";
  const where = sql.join(
    [
      visitFilterSql(q.where, q.filterable),
      ...(q.after ? [afterSql(q.after, desc)] : []),
      ...(q.until ? [untilSql(q.until, desc)] : []),
    ],
    sql` AND `,
  );
  const order = sql.raw(
    `v.started_at ${desc ? "DESC" : "ASC"}, v.id::text COLLATE "C" ASC`,
  );
  return withHits(
    dbx,
    await visitRows(
      dbx,
      sql`SELECT v.* FROM analytics_visits v WHERE ${where} ORDER BY ${order} LIMIT ${q.limit}`,
      order,
      now,
    ),
  );
}

/** The visits with these ids (any order; an id it cannot find is absent). */
export async function readVisitsById(
  dbx: VisitReads,
  ids: readonly string[],
  now: Date,
): Promise<Session[]> {
  const uuids = ids.filter((id) => UUID.test(id));
  if (uuids.length === 0) return [];
  return withHits(
    dbx,
    await visitRows(
      dbx,
      sql`SELECT v.* FROM analytics_visits v WHERE v.id IN (${sql.join(
        uuids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
      sql.raw(`v.started_at DESC, v.id::text COLLATE "C" ASC`),
      now,
    ),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The values `groupBy` takes over the visits matching `where`, with counts: count descending, then value (NULL last); at most `limit`. */
export async function readVisitGroups<F extends VisitFilterable>(
  dbx: VisitReads,
  q: {
    where: Filter | undefined;
    filterable: F;
    groupBy: keyof F & VisitFilterColumn;
    limit: number;
  },
): Promise<{ value: string | number | boolean | null; count: number }[]> {
  // A number column groups as float8 (pg hands a bigint back as text);
  // every other one as it is — text, boolean, NULL — never coerced.
  const target = NUMBER_COLUMNS.has(q.groupBy)
    ? sql`(${VISIT_FILTER_TARGETS[q.groupBy]})::float8`
    : VISIT_FILTER_TARGETS[q.groupBy];
  return executeRows(dbx, {
    label: "analytics.visitGroups",
    row: z.object({
      value: z.union([z.null(), z.boolean(), z.string(), z.number()]),
      count: z.coerce.number().int(),
    }),
    query: sql`SELECT ${target} AS value, count(*)::int AS count
      FROM analytics_visits v
      WHERE ${visitFilterSql(q.where, q.filterable)}
      GROUP BY 1
      ORDER BY count(*) DESC, 1 NULLS LAST
      LIMIT ${q.limit}`,
  });
}

/** How many visits match `where`. */
export async function countVisits<F extends VisitFilterable>(
  dbx: VisitReads,
  q: { where: Filter | undefined; filterable: F },
): Promise<number> {
  const { count } = await executeOne(dbx, {
    label: "analytics.visitCount",
    row: z.object({ count: z.coerce.number().int() }),
    query: sql`SELECT count(*)::int AS count FROM analytics_visits v
      WHERE ${visitFilterSql(q.where, q.filterable)}`,
  });
  return count;
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
  pages: z.array(z.string()),
  eventNames: z.array(z.string()),
});
type VisitRow = z.infer<typeof VisitRow>;

/** The visits `selected` (a `SELECT v.* … ` subquery) yields, in `order`, with their computed columns. */
function visitRows(
  dbx: VisitReads,
  selected: SQL,
  order: SQL,
  now: Date,
): Promise<VisitRow[]> {
  return executeRows(dbx, {
    label: "analytics.visitRows",
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
        v.country, v.language, v.device, v.browser, v.os,
        ${visitMembershipValues("v", "page")} AS "pages",
        ${visitMembershipValues("v", "event")} AS "eventNames"
      FROM (${selected}) v
      ORDER BY ${order}`,
  });
}

/** Each visit with its first {@link MAX_SESSION_HITS} hits. */
async function withHits(
  dbx: VisitReads,
  visits: VisitRow[],
): Promise<Session[]> {
  const hits = await hitsOf(
    dbx,
    visits.map((v) => v.id),
  );
  return visits.map((visit) => {
    const own = hits.get(visit.id) ?? [];
    return {
      ...visit,
      hits: own.slice(0, MAX_SESSION_HITS),
      hitsTruncated: own.length > MAX_SESSION_HITS,
    };
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
  dbx: VisitReads,
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
