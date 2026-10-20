/**
 * Real-Postgres suite for the collect pipeline: ingest → visits → nightly
 * rollup → report (raw and totals) → retention guard. Runs the real migration
 * chain on a throwaway database (db-test-fixture), so the SQL under test is the
 * SQL production runs.
 *
 * The parity test is the load-bearing one: for a seeded day, every level of
 * `analytics_daily` (unfiltered and each single filter) must equal the same
 * breakdown computed from raw rows. That equality is what lets a 12-month
 * report read totals while a 30-day report reads raw rows and still agree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import {
  buildSnapshot,
  createIpCountryLookup,
  type IpCountryLookup,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/ip-country/server/testing";
import {
  UNFILTERED_LEVEL,
  addDays,
  type AnalyticsFilter,
  type AnalyticsQuery,
  type AnalyticsReport,
  type CollectResponse,
} from "../../core";
import { CollectBodySchema } from "../../core/internal/collect-body";
import { DimensionSchema } from "../../core/internal/dimensions";
import {
  rawDailyRows,
  dailyTotalsRows,
  visitorCounts,
  type KeyedRow,
  type VisitorRow,
} from "./aggregate-sql";
import { firstIdentityDay, recordCollect } from "./collect";
import { runAnalyticsQuery } from "./report";
import { assertDaysRolledUp } from "./retention";
import { runRollup } from "./rollup";
import {
  analyticsDaily,
  analyticsHits,
  analyticsSalts,
  analyticsVisitMembers,
  analyticsVisitorLinks,
  analyticsVisits,
} from "./tables";

const DAY = "2026-09-10";

const canonicalVisitors = (rows: VisitorRow[]) =>
  [...rows].sort((a, b) =>
    `${a.dimension}\t${a.value}`.localeCompare(`${b.dimension}\t${b.value}`),
  );
const NEXT = "2026-09-11";
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`);

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
};

let t: TestDb;
let countries: IpCountryLookup;
const snapshotDir = mkdtempSync(join(tmpdir(), "analytics-ip-country-"));

async function hit(
  body: z.input<typeof CollectBodySchema>,
  who: { ip: string; ua: string; lang?: string },
  now: Date,
): Promise<CollectResponse> {
  // Decode exactly as the route does, so the schema's server-side guards
  // (query-string stripping included) are part of what is under test.
  return recordCollect(
    t.db,
    CollectBodySchema.parse(body),
    {
      ip: who.ip,
      userAgent: who.ua,
      acceptLanguage: who.lang ?? "en-US,en;q=0.9",
      now,
    },
    (ip) => countries.lookup(ip),
  );
}

function pageviewId(res: CollectResponse): string {
  if (res.outcome !== "pageview")
    throw new Error(`expected a pageview, got ${res.outcome}`);
  return res.pageviewId;
}

const A = { ip: "203.0.113.1", ua: UA.chromeMac };
const B = { ip: "203.0.113.2", ua: UA.safariIphone, lang: "fr-FR,fr;q=0.9" };
const C = { ip: "203.0.113.3", ua: UA.firefoxLinux };
const host = "equin.dev";

beforeAll(async () => {
  // A DB-IP snapshot fixture: A's address is in France, B's is reserved (ZZ),
  // C's is in no range at all.
  const snapshotPath = join(snapshotDir, "ip-country.bin");
  writeFileSync(
    snapshotPath,
    await buildSnapshot(
      "203.0.113.1,203.0.113.1,FR\n203.0.113.2,203.0.113.2,ZZ\n",
      202609,
    ),
  );
  countries = createIpCountryLookup(() => snapshotPath);

  t = await createTestDb({ prefix: "analytics_test" });
  await runMigrations(t.db);

  // Visitor A, visit 1: HN → / → /harness, opens Improve, reads /harness a minute.
  await hit(
    {
      kind: "pageview",
      host,
      path: "/",
      referrer: "https://news.ycombinator.com/item?id=1",
    },
    A,
    at(DAY, "10:00"),
  );
  const harness = pageviewId(
    await hit(
      { kind: "pageview", host, path: "/harness?x=1" },
      A,
      at(DAY, "10:05"),
    ),
  );
  await hit(
    {
      kind: "event",
      host,
      path: "/harness",
      name: "improve_open",
      props: { from: "nav" },
    },
    A,
    at(DAY, "10:06"),
  );
  await hit(
    { kind: "engagement", pageviewId: harness, engagedMs: 60_000 },
    A,
    at(DAY, "10:07"),
  );
  // A repeated, smaller cumulative beacon changes nothing.
  await hit(
    { kind: "engagement", pageviewId: harness, engagedMs: 20_000 },
    A,
    at(DAY, "10:08"),
  );

  // Visitor A, visit 2 (more than 30 minutes later): a direct bounce.
  await hit({ kind: "pageview", host, path: "/" }, A, at(DAY, "11:00"));

  // Visitor B: a campaign landing on /apps, from a phone, in French.
  const apps = pageviewId(
    await hit(
      {
        kind: "pageview",
        host,
        path: "/apps",
        utm: { source: "newsletter", campaign: "launch" },
      },
      B,
      at(DAY, "10:30"),
    ),
  );
  await hit(
    { kind: "engagement", pageviewId: apps, engagedMs: 5_000 },
    B,
    at(DAY, "10:31"),
  );

  // Visitor C: Google → / → /story, and opens Improve too.
  await hit(
    { kind: "pageview", host, path: "/", referrer: "https://www.google.com/" },
    C,
    at(DAY, "12:00"),
  );
  await hit({ kind: "pageview", host, path: "/story" }, C, at(DAY, "12:10"));
  await hit(
    { kind: "event", host, path: "/story", name: "improve_open" },
    C,
    at(DAY, "12:11"),
  );
  await hit(
    { kind: "event", host, path: "/story", name: "improve_show_me" },
    C,
    at(DAY, "12:12"),
  );
});

afterAll(async () => {
  rmSync(snapshotDir, { recursive: true, force: true });
  await t.drop();
});

describe("collect", () => {
  test("bots are ignored before touching the database", async () => {
    const res = await hit(
      { kind: "pageview", host, path: "/" },
      { ip: "1.1.1.1", ua: "curl/8.5.0" },
      at(DAY, "13:00"),
    );
    expect(res).toEqual({ outcome: "ignored", reason: "bot" });
  });

  test("an engagement for an unknown pageview is ignored", async () => {
    const res = await hit(
      {
        kind: "engagement",
        pageviewId: "00000000-0000-4000-8000-000000000000",
        engagedMs: 1,
      },
      A,
      at(DAY, "13:00"),
    );
    expect(res).toEqual({ outcome: "ignored", reason: "unknown-pageview" });
  });

  test("a 30-minute gap splits visits; source attributes come from the first hit", async () => {
    const visits = await t.db
      .select()
      .from(analyticsVisits)
      .orderBy(analyticsVisits.startedAt);
    expect(visits).toHaveLength(4);
    const [a1, b, a2, c] = visits;
    expect(a1).toMatchObject({
      entryPath: "/",
      exitPath: "/harness",
      pageviews: 2,
      events: 1,
      referrerHost: "news.ycombinator.com",
      referrerPath: "/item",
      channel: "Social",
      device: "Desktop",
      browser: "Chrome",
      os: "macOS",
      language: "en",
      engagedMs: 60_000,
      exitEngagedMs: 60_000,
      country: "FR",
    });
    expect(a2).toMatchObject({ pageviews: 1, channel: "Direct" });
    expect(a1!.visitorId).toBe(a2!.visitorId);
    // A's second visit is a return; everyone's first is not.
    expect([a1, b, a2, c].map((v) => v!.returning)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(b).toMatchObject({
      channel: "Campaign",
      utmCampaign: "launch",
      device: "Mobile",
      os: "iOS",
      language: "fr",
      exitEngagedMs: 5_000,
      country: null,
    });
    expect(c).toMatchObject({
      channel: "Search",
      referrerHost: "google.com",
      events: 2,
      country: null,
    });
  });

  test("the query string never reaches storage", async () => {
    const paths = await t.db
      .select({ path: analyticsHits.path })
      .from(analyticsHits);
    expect(paths.every((p) => !p.path.includes("?"))).toBe(true);
  });
});

describe("rollup", () => {
  let rolled: string[];

  beforeAll(async () => {
    ({ days: rolled } = await runRollup(t.db, at(NEXT, "00:15")));
  });

  test("sums the completed day and keeps salts inside the identity window", async () => {
    expect(rolled).toContain(DAY);
    const salts = await t.db.select().from(analyticsSalts);
    expect(salts.map((s) => s.day)).toContain(DAY);
  });

  test("materialises each visit's memberships with its visitor", async () => {
    const totals = await t.db
      .select()
      .from(analyticsVisitMembers)
      .where(
        and(
          eq(analyticsVisitMembers.day, DAY),
          eq(analyticsVisitMembers.dim, "total"),
        ),
      );
    expect(totals).toHaveLength(4);
    expect(new Set(totals.map((m) => m.visitorId)).size).toBe(3);
  });

  test("the unfiltered summary line", async () => {
    const [total] = await t.db
      .select()
      .from(analyticsDaily)
      .where(
        sql`${analyticsDaily.day} = ${DAY} AND ${analyticsDaily.filterDim} = 'none' AND ${analyticsDaily.dimension} = 'total'`,
      );
    expect(total).toMatchObject({
      visits: 4,
      pageviews: 6,
      bounces: 2, // A's second visit and B's single page
      returningVisits: 1, // A's second visit
      events: 3,
    });
  });

  test("rerunning is idempotent", async () => {
    const before = await t.db.select().from(analyticsDaily);
    await runRollup(t.db, at(NEXT, "00:15"));
    const after = await t.db.select().from(analyticsDaily);
    expect(after.length).toBe(before.length);
  });

  test("parity: every stored level equals the same breakdown from raw rows", async () => {
    const levels = await executeRows(t.db, {
      label: "test.levels",
      row: z.object({ filterDim: z.string(), filterValue: z.string() }),
      query: sql`SELECT DISTINCT filter_dim AS "filterDim", filter_value AS "filterValue" FROM analytics_daily WHERE day = ${DAY}`,
    });
    expect(levels.length).toBeGreaterThan(10);
    const canonical = (rows: KeyedRow[]) =>
      [...rows].sort((a, b) =>
        `${a.dimension}\t${a.value}`.localeCompare(
          `${b.dimension}\t${b.value}`,
        ),
      );
    for (const level of levels) {
      const filters: AnalyticsFilter[] =
        level.filterDim === UNFILTERED_LEVEL
          ? []
          : [
              {
                dimension: DimensionSchema.parse(level.filterDim),
                value: level.filterValue,
              },
            ];
      const stored = await dailyTotalsRows(t.db, {
        from: DAY,
        to: DAY,
        level: filters[0]
          ? { kind: "filter", filter: filters[0] }
          : { kind: "unfiltered" },
        dimensions: "all",
      });
      const raw = await rawDailyRows(t.db, {
        from: DAY,
        to: DAY,
        filters,
        onlyNotRolledUp: false,
      });
      expect({ level, rows: canonical(stored) }).toEqual({
        level,
        rows: canonical(raw),
      });
      const visitors = (source: "raw" | "totals") =>
        visitorCounts(t.db, {
          from: DAY,
          to: DAY,
          filters,
          source,
          groupBy: { kind: "dimension" },
        }).then(canonicalVisitors);
      expect({ level, visitors: await visitors("totals") }).toEqual({
        level,
        visitors: await visitors("raw"),
      });
    }
  });
});

describe("report", () => {
  const now = at(NEXT, "09:00");

  test("raw: a source filter narrows the pages to where its visitors went", async () => {
    const result = await runAnalyticsQuery(
      t.db,
      {
        range: "7d",
        compare: true,
        filters: [{ dimension: "channel", value: "Search" }],
      },
      now,
    );
    if (result.kind !== "report") throw new Error("expected a report");
    const { report } = result;
    expect(report.source).toBe("raw");
    expect(report.current.summary).toMatchObject({
      visitors: 1,
      visits: 1,
      pageviews: 2,
    });
    expect(report.rows.page.map((r) => r.value).sort()).toEqual([
      "/",
      "/story",
    ]);
    expect(report.rows.event.map((r) => [r.value, r.events])).toEqual([
      ["improve_open", 1],
      ["improve_show_me", 1],
    ]);
    expect(report.current.series).toHaveLength(7);
    expect(report.previous?.series).toHaveLength(7);
  });

  test("raw: stacked filters intersect", async () => {
    const result = await runAnalyticsQuery(
      t.db,
      {
        range: "30d",
        compare: false,
        filters: [
          { dimension: "event", value: "improve_open" },
          { dimension: "browser", value: "Chrome" },
        ],
      },
      now,
    );
    if (result.kind !== "report") throw new Error("expected a report");
    expect(result.report.current.summary).toMatchObject({
      visitors: 1,
      visits: 1,
    });
    expect(result.report.previous).toBeNull();
  });

  test("totals agrees with raw on the same days, and refuses a second filter", async () => {
    const filter = { dimension: "page", value: "/" } as const;
    const raw = await runAnalyticsQuery(
      t.db,
      { range: "30d", compare: false, filters: [filter] },
      now,
    );
    const totals = await runAnalyticsQuery(
      t.db,
      { range: "12m", compare: false, filters: [filter] },
      now,
    );
    if (raw.kind !== "report" || totals.kind !== "report")
      throw new Error("expected reports");
    expect(totals.report.source).toBe("totals");
    expect(totals.report.current.summary).toEqual(raw.report.current.summary);
    expect(totals.report.rows).toEqual(raw.report.rows);
    expect(totals.report.current.series).toHaveLength(12);

    const refused = await runAnalyticsQuery(
      t.db,
      {
        range: "12m",
        compare: false,
        filters: [filter, { dimension: "os", value: "macOS" }],
      },
      now,
    );
    expect(refused).toEqual({
      kind: "refused",
      reason: "stacked-filters-beyond-raw-window",
      maxFilters: 1,
      rawWindowDays: 90,
    });
  });

  test("totals includes today's not-yet-rolled-up visits from raw rows", async () => {
    await hit({ kind: "pageview", host, path: "/" }, C, at(NEXT, "08:00"));
    const result = await runAnalyticsQuery(
      t.db,
      { range: "12m", compare: false, filters: [] },
      now,
    );
    if (result.kind !== "report") throw new Error("expected a report");
    expect(result.report.current.summary.visits).toBe(5);
  });

  test("today is hourly, and the hours add up to the day's visits", async () => {
    const result = await runAnalyticsQuery(
      t.db,
      { range: "today", compare: false, filters: [] },
      at(DAY, "23:00"),
    );
    if (result.kind !== "report") throw new Error("expected a report");
    const { current } = result.report;
    expect(current.series).toHaveLength(24);
    expect(current.series.reduce((n, p) => n + p.metrics.visits, 0)).toBe(
      current.summary.visits,
    );
    expect(
      current.series.find((p) => p.bucket === `${DAY}T10:00:00Z`)?.metrics
        .visits,
    ).toBe(2);
  });
});

describe("retention guard", () => {
  test("passes for rolled-up days", async () => {
    await assertDaysRolledUp(t.db, [DAY, DAY]);
  });

  test("throws for a day with no totals, naming it", async () => {
    const outcome = await assertDaysRolledUp(t.db, [DAY, NEXT]).then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(outcome).toContain(NEXT);
    expect(outcome).not.toContain(DAY);
  });

  test("deleting a visit reclaims its hits", async () => {
    const [visit] = await t.db
      .select({ id: analyticsVisits.id })
      .from(analyticsVisits)
      .where(eq(analyticsVisits.day, NEXT));
    if (!visit) throw new Error("expected today's visit");
    await t.db.delete(analyticsVisits).where(eq(analyticsVisits.id, visit.id));
    const hits = await t.db
      .select()
      .from(analyticsHits)
      .where(eq(analyticsHits.visitId, visit.id));
    expect(hits).toEqual([]);
  });
});

describe("sliding identity", () => {
  // Every day after the rollup has run for the one before, as in production.
  const START = "2026-10-01";
  const DAILY = { ip: "198.51.100.7", ua: UA.firefoxLinux };

  async function night(day: string): Promise<void> {
    await runRollup(t.db, at(day, "00:15"));
  }

  async function report(
    query: AnalyticsQuery,
    now: Date,
  ): Promise<AnalyticsReport> {
    const result = await runAnalyticsQuery(t.db, query, now);
    if (result.kind !== "report") throw new Error("expected a report");
    return result.report;
  }

  async function visitorIdsOn(path: string): Promise<string[]> {
    const rows = await t.db
      .selectDistinct({ id: analyticsVisits.visitorId })
      .from(analyticsVisits)
      .where(eq(analyticsVisits.entryPath, path));
    return rows.map((r) => r.id);
  }

  beforeAll(async () => {
    // One reader, every day for 40 days, on a page nobody else visits.
    for (let i = 0; i < 40; i++) {
      const day = addDays(START, i);
      await night(day);
      await hit(
        { kind: "pageview", host, path: "/daily" },
        DAILY,
        at(day, "09:00"),
      );
    }
  });

  test("a visitor returning every day keeps one id", async () => {
    expect(await visitorIdsOn("/daily")).toHaveLength(1);
  });

  test("they count once over 30 days and over 12 months, visits still count each day", async () => {
    const now = at(addDays(START, 40), "12:00");
    await night(addDays(START, 40));
    const filters = [{ dimension: "page", value: "/daily" }] as const;
    const month = await report(
      { range: "30d", compare: false, filters: [...filters] },
      now,
    );
    expect(month.source).toBe("raw");
    expect(month.current.summary.visitors).toBe(1);
    expect(month.current.summary.visits).toBeGreaterThan(1);
    expect(month.rows.page.find((r) => r.value === "/daily")?.visitors).toBe(1);

    const year = await report(
      { range: "12m", compare: false, filters: [...filters] },
      now,
    );
    expect(year.source).toBe("totals");
    // Only the first of the 40 visits is new.
    expect(year.current.summary).toMatchObject({
      visitors: 1,
      visits: 40,
      returningVisits: 39,
    });
    expect(month.current.summary.returningVisits).toBe(
      month.current.summary.visits,
    );
    // A month bucket counts the visitor once, however many days they came.
    const october = year.current.series.find((p) => p.bucket === "2026-10-01");
    expect(october?.metrics).toMatchObject({ visitors: 1, visits: 31 });
  });

  test("away 30 days they are recognised; away 31 they are a new visitor", async () => {
    const X = "2027-01-01";
    const back30 = { ip: "198.51.100.30", ua: UA.chromeMac };
    const back31 = { ip: "198.51.100.31", ua: UA.chromeMac };
    await night(X);
    await hit(
      { kind: "pageview", host, path: "/back30" },
      back30,
      at(X, "09:00"),
    );
    await hit(
      { kind: "pageview", host, path: "/back31" },
      back31,
      at(X, "09:00"),
    );
    for (let i = 1; i <= 30; i++) await night(addDays(X, i));
    await hit(
      { kind: "pageview", host, path: "/back30" },
      back30,
      at(addDays(X, 30), "09:00"),
    );
    // Tonight's rollup deletes day X's salt and links.
    await night(addDays(X, 31));
    await hit(
      { kind: "pageview", host, path: "/back31" },
      back31,
      at(addDays(X, 31), "09:00"),
    );
    expect(await visitorIdsOn("/back30")).toHaveLength(1);
    expect(await visitorIdsOn("/back31")).toHaveLength(2);
    const returns = await t.db
      .select({
        path: analyticsVisits.entryPath,
        returning: analyticsVisits.returning,
      })
      .from(analyticsVisits)
      .where(sql`${analyticsVisits.entryPath} IN ('/back30', '/back31')`)
      .orderBy(analyticsVisits.startedAt, analyticsVisits.entryPath);
    expect(returns).toEqual([
      { path: "/back30", returning: false },
      { path: "/back31", returning: false },
      { path: "/back30", returning: true },
      // Forgotten: a new visitor again.
      { path: "/back31", returning: false },
    ]);

    const today = addDays(X, 31);
    const salts = await t.db.select().from(analyticsSalts);
    expect(salts.every((s) => s.day >= firstIdentityDay(today))).toBe(true);
    const links = await t.db.select().from(analyticsVisitorLinks);
    expect(links.every((l) => l.day >= firstIdentityDay(today))).toBe(true);
  });

  test("a visit across midnight stays one visit", async () => {
    const D = "2027-03-01";
    const owl = { ip: "198.51.100.99", ua: UA.safariIphone };
    await night(D);
    await hit({ kind: "pageview", host, path: "/owl" }, owl, at(D, "23:50"));
    await night(addDays(D, 1));
    await hit(
      { kind: "pageview", host, path: "/owl-2" },
      owl,
      at(addDays(D, 1), "00:05"),
    );
    const visits = await t.db
      .select()
      .from(analyticsVisits)
      .where(eq(analyticsVisits.entryPath, "/owl"));
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({
      pageviews: 2,
      exitPath: "/owl-2",
      day: D,
    });
  });

  test("a filter past the raw window matches within one visit, not across a visitor's days", async () => {
    const S = "2027-05-01";
    const who = { ip: "198.51.100.50", ua: UA.firefoxLinux };
    await night(S);
    await hit(
      {
        kind: "pageview",
        host,
        path: "/searched",
        referrer: "https://www.google.com/",
      },
      who,
      at(S, "09:00"),
    );
    await night(addDays(S, 1));
    await hit(
      { kind: "pageview", host, path: "/direct-only" },
      who,
      at(addDays(S, 1), "09:00"),
    );
    await night(addDays(S, 2));
    const year = await report(
      {
        range: "12m",
        compare: false,
        filters: [{ dimension: "channel", value: "Search" }],
      },
      at(addDays(S, 2), "12:00"),
    );
    expect(year.source).toBe("totals");
    const pages = year.rows.page.map((r) => r.value);
    expect(pages).toContain("/searched");
    expect(pages).not.toContain("/direct-only");
  });

  test("the retention guard wants memberships too", async () => {
    const day = addDays(START, 1);
    await assertDaysRolledUp(t.db, [day]);
    await t.db
      .delete(analyticsVisitMembers)
      .where(eq(analyticsVisitMembers.day, day));
    const outcome = await assertDaysRolledUp(t.db, [day]).then(
      () => "resolved",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(outcome).toContain(day);
    // The next rollup heals it.
    await night(addDays(START, 45));
    await assertDaysRolledUp(t.db, [day]);
  });
});
