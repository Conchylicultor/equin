import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { IpCountryResult } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country/server";
import {
  IDENTITY_WINDOW_DAYS,
  addDays,
  channelOf,
  utcDay,
  type CollectBody,
  type CollectResponse,
  type EngagementBody,
  type EventBody,
  type PageviewBody,
} from "../../core";
import { parseReferrer, primaryLanguage, visitorHash } from "./request-context";
import {
  analyticsHits,
  analyticsSalts,
  analyticsVisitorLinks,
  analyticsVisits,
} from "./tables";
import { isBotUserAgent, parseUserAgent } from "./user-agent";
import { liveVisitCutoff } from "./visit-grouping";

/** Any drizzle handle collect can write through: the app's `db`, or a test DB. */
export type AnalyticsDb = NodePgDatabase;
type Tx = Parameters<Parameters<AnalyticsDb["transaction"]>[0]>[0];

/** What the request itself says about the visitor. Used in memory, never stored as-is. */
export interface CollectContext {
  ip: string;
  userAgent: string;
  acceptLanguage: string | null;
  now: Date;
}

/**
 * Which country an IP is in. The route passes the machine's DB-IP lookup
 * (`lookupCountry`); a test passes one over its own snapshot fixture.
 */
export type CountryLookup = (ip: string) => IpCountryResult;

/**
 * The stored country for a new visit: the code when the lookup found one,
 * otherwise null — an unlisted address and "no snapshot downloaded yet" both
 * read as `(none)` in the report.
 */
function countryOf(lookupCountry: CountryLookup, ip: string): string | null {
  const result = lookupCountry(ip);
  return result.kind === "found" ? result.country : null;
}

/**
 * Record one collect body. Bots are ignored before anything touches the DB.
 * Pageviews and events resolve the visitor and find or open their visit under
 * a per-hash advisory lock, so two hits racing from one page load land in ONE
 * visit of ONE visitor.
 */
export async function recordCollect(
  dbx: AnalyticsDb,
  body: CollectBody,
  ctx: CollectContext,
  lookupCountry: CountryLookup,
): Promise<CollectResponse> {
  if (isBotUserAgent(ctx.userAgent)) {
    return { outcome: "ignored", reason: "bot" };
  }
  switch (body.kind) {
    case "pageview":
      return recordPageview(dbx, body, ctx, lookupCountry);
    case "event":
      return recordEvent(dbx, body, ctx, lookupCountry);
    case "engagement":
      return recordEngagement(dbx, body, ctx.now);
  }
}

// ── salt ─────────────────────────────────────────────────────────────────

/**
 * The oldest day whose salt (and hash → visitor links) is still kept on
 * `today`. A visitor whose last visit is older than this is forgotten.
 */
export function firstIdentityDay(today: string): string {
  return addDays(today, -IDENTITY_WINDOW_DAYS);
}

interface DaySalt {
  day: string;
  salt: string;
}

// Per-handle memo of the window's salts: one read per UTC day per process
// instead of one per hit. Keyed by the handle so a test DB never sees the app
// DB's salts.
const saltMemo = new WeakMap<object, { day: string; salts: DaySalt[] }>();

/**
 * Every retained salt on `today`, newest first — today's first, created on
 * first use (concurrent creators converge on one row).
 */
export async function windowSalts(
  dbx: AnalyticsDb,
  today: string,
): Promise<DaySalt[]> {
  const memo = saltMemo.get(dbx);
  if (memo?.day === today) return memo.salts;
  await dbx
    .insert(analyticsSalts)
    .values({ day: today, salt: randomBytes(32).toString("hex") })
    .onConflictDoNothing();
  const salts = await dbx
    .select({ day: analyticsSalts.day, salt: analyticsSalts.salt })
    .from(analyticsSalts)
    .where(
      and(
        gte(analyticsSalts.day, firstIdentityDay(today)),
        lte(analyticsSalts.day, today),
      ),
    )
    .orderBy(desc(analyticsSalts.day));
  if (salts[0]?.day !== today) {
    throw new Error(
      `analytics: salt for ${today} vanished right after it was ensured`,
    );
  }
  saltMemo.set(dbx, { day: today, salts });
  return salts;
}

// ── visitor ──────────────────────────────────────────────────────────────

interface VisitorKey {
  today: string;
  /** Today's hash — the advisory-lock key and today's link. */
  hash: string;
  /** The visitor's hash under every retained salt, newest day first. */
  hashes: { day: string; hash: string }[];
}

async function visitorKeyFor(
  dbx: AnalyticsDb,
  host: string,
  ctx: CollectContext,
): Promise<VisitorKey> {
  const today = utcDay(ctx.now);
  const hashes = (await windowSalts(dbx, today)).map(({ day, salt }) => ({
    day,
    hash: visitorHash({ salt, ip: ctx.ip, userAgent: ctx.userAgent, host }),
  }));
  const [first] = hashes;
  if (!first) throw new Error("analytics: no salt for today");
  return { today, hash: first.hash, hashes };
}

interface ResolvedVisitor {
  visitorId: string;
  /** They were already linked — today or within the window — so they came before. */
  known: boolean;
}

/**
 * The visitor's id. The newest link among the visitor's hashes under every
 * retained salt wins: today's (the common case), else the last day they came
 * within the window. Neither → a new random id. Today's link is written so
 * the rest of the day is a single-row hit, and the chain slides forward: as
 * long as they return within the window, they keep their id.
 *
 * Runs under the visitor's advisory lock, so a burst of first hits of the day
 * agrees on one id.
 */
async function resolveVisitor(
  tx: Tx,
  key: VisitorKey,
): Promise<ResolvedVisitor> {
  const [found] = await tx
    .select({
      day: analyticsVisitorLinks.day,
      visitorId: analyticsVisitorLinks.visitorId,
    })
    .from(analyticsVisitorLinks)
    .where(
      sql`(${analyticsVisitorLinks.day}, ${analyticsVisitorLinks.hash}) IN (${sql.join(
        key.hashes.map((h) => sql`(${h.day}::date, ${h.hash})`),
        sql`, `,
      )})`,
    )
    .orderBy(desc(analyticsVisitorLinks.day))
    .limit(1);
  if (found?.day === key.today)
    return { visitorId: found.visitorId, known: true };
  const visitorId = found?.visitorId ?? randomUUID();
  await tx
    .insert(analyticsVisitorLinks)
    .values({ day: key.today, hash: key.hash, visitorId });
  return { visitorId, known: found !== undefined };
}

// ── visits ───────────────────────────────────────────────────────────────

async function withVisitorLock<T>(
  dbx: AnalyticsDb,
  hash: string,
  body: (tx: Tx) => Promise<T>,
): Promise<T> {
  return dbx.transaction(async (tx) => {
    // Transaction-scoped, so PgBouncer's transaction pooling keeps it sound.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`analytics:${hash}`}, 0))`,
    );
    return body(tx);
  });
}

async function findLiveVisitId(
  tx: Tx,
  visitorId: string,
  now: Date,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: analyticsVisits.id })
    .from(analyticsVisits)
    .where(
      and(
        eq(analyticsVisits.visitorId, visitorId),
        gt(analyticsVisits.lastAt, liveVisitCutoff(now)),
      ),
    )
    .orderBy(desc(analyticsVisits.lastAt))
    .limit(1);
  return row?.id ?? null;
}

async function openVisit(
  tx: Tx,
  opts: {
    visitor: ResolvedVisitor;
    host: string;
    path: string;
    referrer: string | undefined;
    utm: PageviewBody["utm"];
    ctx: CollectContext;
    lookupCountry: CountryLookup;
  },
): Promise<string> {
  const { ctx } = opts;
  const referrer = parseReferrer(opts.referrer, opts.host);
  const [row] = await tx
    .insert(analyticsVisits)
    .values({
      visitorId: opts.visitor.visitorId,
      returning: opts.visitor.known,
      day: utcDay(ctx.now),
      startedAt: ctx.now,
      lastAt: ctx.now,
      host: opts.host,
      entryPath: opts.path,
      exitPath: opts.path,
      exitAt: ctx.now,
      referrerHost: referrer?.host ?? null,
      referrerPath: referrer?.path ?? null,
      channel: channelOf(referrer?.host ?? null, opts.utm),
      utmSource: opts.utm?.source ?? null,
      utmMedium: opts.utm?.medium ?? null,
      utmCampaign: opts.utm?.campaign ?? null,
      // Looked up once, when the visit opens: a hit joining a live visit keeps
      // its country, like device and entry page. The IP itself is not stored.
      country: countryOf(opts.lookupCountry, ctx.ip),
      language: primaryLanguage(ctx.acceptLanguage),
      ...parseUserAgent(ctx.userAgent),
    })
    .returning({ id: analyticsVisits.id });
  if (!row) throw new Error("analytics: visit insert returned no row");
  return row.id;
}

// ── hits ─────────────────────────────────────────────────────────────────

async function recordPageview(
  dbx: AnalyticsDb,
  body: PageviewBody,
  ctx: CollectContext,
  lookupCountry: CountryLookup,
): Promise<CollectResponse> {
  const key = await visitorKeyFor(dbx, body.host, ctx);
  return withVisitorLock(dbx, key.hash, async (tx) => {
    const visitor = await resolveVisitor(tx, key);
    const visitId =
      (await findLiveVisitId(tx, visitor.visitorId, ctx.now)) ??
      (await openVisit(tx, {
        visitor,
        host: body.host,
        path: body.path,
        referrer: body.referrer,
        utm: body.utm,
        ctx,
        lookupCountry,
      }));
    const [hit] = await tx
      .insert(analyticsHits)
      .values({ visitId, ts: ctx.now, kind: "pageview", path: body.path })
      .returning({ id: analyticsHits.id });
    if (!hit) throw new Error("analytics: pageview insert returned no row");
    await tx
      .update(analyticsVisits)
      .set({
        pageviews: sql`${analyticsVisits.pageviews} + 1`,
        exitPath: body.path,
        exitAt: ctx.now,
        exitPageviewId: hit.id,
        exitEngagedMs: 0,
        lastAt: ctx.now,
      })
      .where(eq(analyticsVisits.id, visitId));
    return { outcome: "pageview", pageviewId: hit.id };
  });
}

/**
 * An event joins the visitor's live visit. With none (the tab sat open past
 * the 30-minute gap) it opens one at the event's page: an event is still a
 * sign someone is there.
 */
async function recordEvent(
  dbx: AnalyticsDb,
  body: EventBody,
  ctx: CollectContext,
  lookupCountry: CountryLookup,
): Promise<CollectResponse> {
  const key = await visitorKeyFor(dbx, body.host, ctx);
  return withVisitorLock(dbx, key.hash, async (tx) => {
    const visitor = await resolveVisitor(tx, key);
    const visitId =
      (await findLiveVisitId(tx, visitor.visitorId, ctx.now)) ??
      (await openVisit(tx, {
        visitor,
        host: body.host,
        path: body.path,
        referrer: undefined,
        utm: undefined,
        ctx,
        lookupCountry,
      }));
    await tx.insert(analyticsHits).values({
      visitId,
      ts: ctx.now,
      kind: "event",
      path: body.path,
      eventName: body.name,
      eventProps: body.props ?? null,
    });
    await tx
      .update(analyticsVisits)
      .set({ events: sql`${analyticsVisits.events} + 1`, lastAt: ctx.now })
      .where(eq(analyticsVisits.id, visitId));
    return { outcome: "event" };
  });
}

/**
 * The beacon carries the pageview's CUMULATIVE visible time, so the stored
 * value only ever rises to the largest one reported and a repeated beacon adds
 * nothing. The visit's sum moves by the same delta, and its exit time on page
 * follows when this pageview is still the visit's last one.
 */
async function recordEngagement(
  dbx: AnalyticsDb,
  body: EngagementBody,
  now: Date,
): Promise<CollectResponse> {
  return dbx.transaction(async (tx) => {
    const [hit] = await tx
      .select({
        visitId: analyticsHits.visitId,
        engagedMs: analyticsHits.engagedMs,
      })
      .from(analyticsHits)
      .where(
        and(
          eq(analyticsHits.id, body.pageviewId),
          eq(analyticsHits.kind, "pageview"),
        ),
      )
      .for("update");
    if (!hit) return { outcome: "ignored", reason: "unknown-pageview" };
    const engagedMs = Math.max(hit.engagedMs, body.engagedMs);
    const delta = engagedMs - hit.engagedMs;
    await tx
      .update(analyticsHits)
      .set({ engagedMs })
      .where(eq(analyticsHits.id, body.pageviewId));
    await tx
      .update(analyticsVisits)
      .set({
        engagedMs: sql`${analyticsVisits.engagedMs} + ${delta}`,
        exitEngagedMs: sql`CASE WHEN ${analyticsVisits.exitPageviewId} = ${body.pageviewId} THEN ${engagedMs} ELSE ${analyticsVisits.exitEngagedMs} END`,
        lastAt: sql`GREATEST(${analyticsVisits.lastAt}, ${now})`,
      })
      .where(eq(analyticsVisits.id, hit.visitId));
    return { outcome: "engagement" };
  });
}
