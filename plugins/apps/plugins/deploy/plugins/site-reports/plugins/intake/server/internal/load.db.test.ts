/**
 * Load test for the website's public report intake: many simulated visitors
 * sending the same and different errors at once, against real Postgres (the
 * real migration chain on a throwaway database). What it pins is that the
 * server's work and storage stay bounded by the intake's limits — not by the
 * traffic:
 *
 * - admitted batches ≤ the global budget per window, and one visitor ≤ its own;
 * - rows ≤ the fan-out ceiling per kind per window, and ≤ the row cap overall;
 * - one statement per pending fingerprint per flush, never one per event;
 * - every refused entry is counted in site_report_drops — nothing is lost
 *   silently, nothing is queued.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { createFanOutGate } from "@plugins/reports/server";
import {
  CrashPayloadSchema,
  crashFingerprint,
} from "@plugins/reports/plugins/crash/core";
import {
  SITE_REPORT_LIMITS,
  type SiteReportEntry,
  type SiteReportsResponse,
} from "../../core";
import { SiteReportsBodySchema } from "../../core/internal/body";
import { createAdmissionGate } from "./admission";
import {
  createSiteReportsIntake,
  type IntakeKind,
  type IntakeLimits,
} from "./intake";
import { siteReportDrops, siteReports } from "./tables";
import { createVisitorKey } from "./visitor-key";

const FAN_OUT_PER_WINDOW = 20;
const WINDOW_MS = SITE_REPORT_LIMITS.windowMs;

const crashKind: IntakeKind = {
  kind: "crash",
  schema: CrashPayloadSchema,
  fingerprint: crashFingerprint,
  meta: {},
};

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "site_reports_load" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(siteReports);
  await t.db.delete(siteReportDrops);
});

function crash(fn: string, count = 1): SiteReportEntry {
  return {
    kind: "crash",
    source: "browser-error",
    message: `TypeError: cannot read ${fn}`,
    data: {
      errorType: "TypeError",
      stack: `TypeError: cannot read ${fn}\n    at ${fn} (https://equin.ai/assets/app.js:1:10)\n    at run (https://equin.ai/assets/app.js:2:20)`,
    },
    path: "/",
    count,
    buildId: null,
    commit: null,
  };
}

function setup(limits?: Partial<IntakeLimits>) {
  let now = Date.UTC(2026, 10, 11, 12, 0, 0);
  const intake = createSiteReportsIntake({
    db: t.db,
    kinds: () => [crashKind],
    admission: createAdmissionGate(),
    fanOut: createFanOutGate({
      onStorm: () => undefined,
      now: () => now,
      config: () => ({
        fanOutPerWindow: FAN_OUT_PER_WINDOW,
        fanOutWindowMs: WINDOW_MS,
        stormRosterMax: 50,
      }),
    }),
    visitorKey: createVisitorKey(),
    now: () => now,
    // The flush is driven by the test, as the one-shot timer would.
    schedule: () => undefined,
    limits: { ...SITE_REPORT_LIMITS, ...limits },
  });
  return {
    intake,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function submit(
  intake: ReturnType<typeof setup>["intake"],
  entries: SiteReportEntry[],
  ip: string,
): Promise<SiteReportsResponse> {
  // Decode exactly as the route does, so the body bounds are under test too.
  const body = SiteReportsBodySchema.parse({ reports: entries });
  return intake.submit(body.reports, ip);
}

async function dropTotal(): Promise<number> {
  const [row] = await t.db
    .select({
      n: sql`coalesce(sum(${siteReportDrops.count}), 0)::int`.mapWith(Number),
    })
    .from(siteReportDrops);
  return row!.n;
}

describe("site-reports intake under load", () => {
  test("2,000 visitors in one window: work and storage bounded, every refusal counted", async () => {
    const { intake } = setup();
    let entries = 0;
    let accepted = 0;
    let droppedInResponse = 0;
    let rateLimitedEntries = 0;
    let rateLimitedBatches = 0;
    let admittedSameError = 0;
    const tally = (r: SiteReportsResponse, n: number, same = false) => {
      entries += n;
      if (r.kind === "accepted") {
        accepted += r.accepted;
        droppedInResponse += r.dropped;
        if (same && r.accepted > 0) admittedSameError += 1;
      } else {
        rateLimitedEntries += n;
        rateLimitedBatches += 1;
      }
    };

    // One visitor hammering: its own budget holds it.
    let attackerAdmitted = 0;
    for (let i = 0; i < 100; i++) {
      const r = await submit(intake, [crash("hammer")], "203.0.113.7");
      if (r.kind === "accepted") attackerAdmitted += 1;
      tally(r, 1);
    }
    expect(attackerAdmitted).toBe(SITE_REPORT_LIMITS.perVisitorBatches);

    // 2,000 visitors at once: half hit the same error (folded ×10 on their
    // page), half one of 500 distinct errors — interleaved.
    for (let v = 0; v < 2_000; v++) {
      const ip = `10.0.${Math.floor(v / 250)}.${v % 250}`;
      if (v % 2 === 0)
        tally(await submit(intake, [crash("same", 10)], ip), 1, true);
      else tally(await submit(intake, [crash(`distinct${v % 500}`)], ip), 1);
    }

    // Admitted batches never exceed the global budget for the window.
    expect(2_100 - rateLimitedBatches).toBe(SITE_REPORT_LIMITS.globalBatches);
    // Pending fingerprints: at most the fan-out ceiling per kind per window.
    expect(intake.pendingSize()).toBeLessThanOrEqual(FAN_OUT_PER_WINDOW);

    const stats = await intake.flush();
    // One statement per pending fingerprint, never one per event.
    expect(stats.rowStatements).toBeLessThanOrEqual(FAN_OUT_PER_WINDOW);
    expect(stats.rowStatements).toBeLessThan(accepted);

    const rows = await t.db.select().from(siteReports);
    expect(rows.length).toBe(stats.inserted);
    expect(rows.length).toBeLessThanOrEqual(FAN_OUT_PER_WINDOW);

    // The same error is one row whose count is every admitted occurrence.
    const same = rows.filter((r) => r.message.endsWith("same"));
    expect(same).toHaveLength(1);
    expect(same[0]!.count).toBe(admittedSameError * 10);

    // Every refused entry is accounted for: rate-limited batches, and entries
    // dropped at the fan-out ceiling.
    expect(await dropTotal()).toBe(rateLimitedEntries + droppedInResponse);
    expect(accepted + droppedInResponse + rateLimitedEntries).toBe(entries);
    const reasons = new Set(
      (await t.db.select().from(siteReportDrops)).map((d) => d.reason),
    );
    expect(reasons).toEqual(
      new Set(["visitor-budget", "global-budget", "fan-out"]),
    );
  });

  test("windows of new errors stay under the row cap; a new fingerprint past it is counted", async () => {
    const { intake, advance } = setup({ maxRows: 50 });
    let visitor = 0;
    for (let w = 0; w < 10; w++) {
      for (let e = 0; e < 40; e++) {
        await submit(
          intake,
          [crash(`w${w}e${e}`)],
          `198.51.100.${visitor++ % 250}`,
        );
      }
      await intake.flush();
      // Past both windows (the fan-out gate rolls strictly after windowMs).
      advance(WINDOW_MS + 1_000);
    }
    const [counted] = await t.db
      .select({ n: sql`count(*)::int`.mapWith(Number) })
      .from(siteReports);
    expect(counted?.n).toBe(50);
    const rowCap = await t.db
      .select()
      .from(siteReportDrops)
      .where(eq(siteReportDrops.reason, "row-cap"));
    // 10 windows × 20 admitted fingerprints, 50 rows: 150 refused at the cap.
    expect(rowCap.reduce((s, d) => s + d.count, 0)).toBe(150);

    // A fingerprint that already has its row still counts up at the cap.
    await submit(intake, [crash("w0e0", 7)], "192.0.2.1");
    await intake.flush();
    const [row] = await t.db
      .select()
      .from(siteReports)
      .where(sql`${siteReports.message} like '%w0e0'`);
    expect(row!.count).toBe(8);
  });

  test("an unknown kind or a payload its schema refuses is dropped and counted", async () => {
    const { intake } = setup();
    const r = await submit(
      intake,
      [
        { ...crash("x"), kind: "nope" },
        { ...crash("y"), data: { stack: 42 } },
        crash("z"),
      ],
      "192.0.2.9",
    );
    expect(r).toEqual({ kind: "accepted", accepted: 1, dropped: 2 });
    await intake.flush();
    const drops = await t.db.select().from(siteReportDrops);
    expect(Object.fromEntries(drops.map((d) => [d.reason, d.count]))).toEqual({
      "unknown-kind": 1,
      "invalid-data": 1,
    });
  });

  test("a hot fingerprint's count saturates instead of failing the flush", async () => {
    const { intake } = setup();
    await submit(intake, [crash("hot")], "192.0.2.20");
    await intake.flush();
    await t.db.update(siteReports).set({ count: 2_147_483_000 });
    await submit(intake, [crash("hot", 1_000)], "192.0.2.21");
    await intake.flush();
    const [row] = await t.db.select().from(siteReports);
    expect(row!.count).toBe(2_147_483_647);
  });
});
