/**
 * Suite for `writeRestate`, the one statement behind
 * `restateReportOccurrence`: an occurrence is told again without counting as
 * another one. Driven against a throwaway Postgres with the real migration
 * chain, as `record-report.test.ts` drives `writeReport`.
 *
 * Run: `./equin test plugins/reports/plugins/engine`
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import {
  flushNow,
  mountProducersForTest,
} from "@plugins/network/plugins/live/plugins/change-feed/server/testing";
import { reportIdKind } from "@plugins/reports/core";
import { writeReport, type ReportUpsertValues } from "./record-report";
import { writeRestate } from "./restate-report";
import { reportsProducer } from "./producer";

const T0 = new Date("2026-11-05T16:15:00.000Z");
const T1 = new Date("2026-11-05T16:16:00.000Z");
const ID = "report-restate-test";

const values = (over: Partial<ReportUpsertValues>): ReportUpsertValues => ({
  id: reportIdKind.key(ID),
  kind: "job-attempt-failed",
  fingerprint: "fp-restate",
  worktree: "wt-test",
  source: "server-caught",
  message: "m",
  url: null,
  userAgent: null,
  data: {},
  limited: false,
  noise: { ifSkew: false, ifLive: false },
  staleOrigin: false,
  skewProven: false,
  clientId: null,
  buildId: null,
  commit: null,
  occurredAt: T0,
  ...over,
});

describe("writeRestate (real DB)", () => {
  let t: TestDb;
  let unmount: () => void;

  beforeAll(async () => {
    t = await createTestDb({ prefix: "report_restate_test" });
    await runMigrations(t.db);
    unmount = mountProducersForTest([reportsProducer], { route: () => {} });
  });

  afterAll(async () => {
    unmount();
    await t.drop();
  });

  beforeEach(async () => {
    // Fixture setup on a throwaway database no reader subscribes to.
    await t.db.execute(sql`DELETE FROM reports`);
    flushNow(reportsProducer);
  });

  test("the newest occurrence: row message, data and its recent entry restated; count and times kept", async () => {
    await writeReport(
      values({ message: "Retrying · x", data: { fate: "retrying" } }),
      t.db,
    );
    const [row] = await writeRestate(
      {
        reportId: ID,
        kind: "job-attempt-failed",
        occurredAt: T0.getTime(),
        message: "Recovered on attempt 2 · x",
        data: { fate: "recovered" },
      },
      t.db,
    );
    expect(row?.message).toBe("Recovered on attempt 2 · x");
    expect(row?.data).toEqual({ fate: "recovered" });
    expect(row?.count).toBe(1);
    expect(row?.lastSeenAt.getTime()).toBe(T0.getTime());
    expect(row?.recent.map((o) => o.message)).toEqual([
      "Recovered on attempt 2 · x",
    ]);
  });

  test("an older occurrence: only its recent entry; the newer one's words stay on the row", async () => {
    await writeReport(
      values({ message: "Retrying · a", occurredAt: T0 }),
      t.db,
    );
    await writeReport(
      values({ message: "Retrying · b", occurredAt: T1, data: { n: 2 } }),
      t.db,
    );
    const [row] = await writeRestate(
      {
        reportId: ID,
        kind: "job-attempt-failed",
        occurredAt: T0.getTime(),
        message: "Gave up · a",
        data: { n: 1 },
      },
      t.db,
    );
    expect(row?.count).toBe(2);
    expect(row?.message).toBe("Retrying · b");
    expect(row?.data).toEqual({ n: 2 });
    // Newest first, order kept.
    expect(row?.recent.map((o) => o.message)).toEqual([
      "Retrying · b",
      "Gave up · a",
    ]);
  });

  test("another kind's row is never restated", async () => {
    await writeReport(values({ kind: "crash", message: "crash" }), t.db);
    const rows = await writeRestate(
      {
        reportId: ID,
        kind: "job-attempt-failed",
        occurredAt: T0.getTime(),
        message: "nope",
        data: {},
      },
      t.db,
    );
    expect(rows).toEqual([]);
  });
});
