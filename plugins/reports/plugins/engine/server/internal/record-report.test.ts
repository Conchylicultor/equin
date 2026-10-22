/**
 * Suite for shed-replay timestamp honesty (Stage 4 of
 * research/2026-07-11-global-observability-freeze-blind-spots.md): a report
 * buffered during a duress episode replays with its true in-freeze
 * `occurredAt`, and an out-of-order replay can never move last_seen_at
 * backwards (or first_seen_at forwards) nor clobber fresher last-writer-wins
 * attribution. Those semantics live in the ON CONFLICT SQL, so this drives the
 * executor-parametrized writeReport against a throwaway Postgres
 * (db-test-fixture) seeded with the REAL migration chain.
 *
 * writeReport writes through the reports change producer, mounted here with
 * `mountProducersForTest` and its routes captured: every write routes exactly
 * the id its statement returned — the rate-limited path included (its bell is
 * skipped; its row's change is not).
 *
 * Run: `./singularity test plugins/reports/plugins/engine`
 * (requires the running embedded cluster — `./singularity build` first).
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
} from "@plugins/database/plugins/change-feed/server/testing";
import type { routeChange } from "@plugins/database/plugins/change-feed/server";
import { writeReport, type ReportUpsertValues } from "./record-report";
import { reportsProducer } from "./producer";
import { _reports } from "@plugins/reports/server";
import { reportIdKind } from "@plugins/reports/core";

const T0 = new Date("2026-07-11T03:30:00.000Z");
const T1 = new Date("2026-07-11T03:32:00.000Z");
const T2 = new Date("2026-07-11T03:34:00.000Z");

let seq = 0;
const values = (
  over: Partial<ReportUpsertValues> = {},
): ReportUpsertValues => ({
  id: reportIdKind.key(`report-test-${seq++}`),
  kind: "crash",
  fingerprint: "fp-1",
  worktree: "wt-test",
  source: "server-crash",
  message: "m",
  url: null,
  userAgent: null,
  data: {},
  limited: false,
  noise: false,
  clientId: null,
  buildId: null,
  occurredAt: T1,
  ...over,
});

describe("writeReport (real DB)", () => {
  let t: TestDb;
  let routed: Parameters<typeof routeChange>[0][] = [];
  let unmount: () => void;

  beforeAll(async () => {
    t = await createTestDb({ prefix: "report_test" });
    await runMigrations(t.db);
    unmount = mountProducersForTest([reportsProducer], {
      route: (change) => routed.push(change),
    });
  });

  afterAll(async () => {
    unmount();
    await t.drop();
  });

  beforeEach(async () => {
    // Fixture setup on a throwaway database no reader subscribes to.
    await t.db.execute(sql`DELETE FROM reports`);
    flushNow(reportsProducer);
    routed = [];
  });

  test("a shed-then-replayed report lands at its original occurredAt, not write time", async () => {
    // T1 is minutes in the past relative to the write — exactly a duress-shed
    // report replayed after the episode cleared.
    const [row] = await writeReport(values({ occurredAt: T1 }), t.db);

    expect(row?.firstSeenAt.getTime()).toBe(T1.getTime());
    expect(row?.lastSeenAt.getTime()).toBe(T1.getTime());
  });

  test("a replayed older report never moves last_seen_at backwards, and pulls first_seen_at to the true onset", async () => {
    await writeReport(values({ occurredAt: T1, message: "newest" }), t.db);
    const [row] = await writeReport(
      values({
        occurredAt: T0,
        message: "in-freeze",
        data: { stale: true },
        clientId: "old-tab",
      }),
      t.db,
    );

    expect(row?.count).toBe(2);
    expect(row?.lastSeenAt.getTime()).toBe(T1.getTime());
    expect(row?.firstSeenAt.getTime()).toBe(T0.getTime());
    // Last-writer-wins attribution still describes the NEWEST occurrence.
    expect(row?.message).toBe("newest");
    expect(row?.data).toEqual({});
    expect(row?.lastClientId).toBeNull();
  });

  test("a genuinely newer repeat advances last_seen_at and takes over attribution", async () => {
    await writeReport(values({ occurredAt: T1, message: "old" }), t.db);
    const [row] = await writeReport(
      values({
        occurredAt: T2,
        message: "new",
        data: { n: 2 },
        clientId: "tab-2",
      }),
      t.db,
    );

    expect(row?.count).toBe(2);
    expect(row?.lastSeenAt.getTime()).toBe(T2.getTime());
    expect(row?.firstSeenAt.getTime()).toBe(T1.getTime());
    expect(row?.message).toBe("new");
    expect(row?.data).toEqual({ n: 2 });
    expect(row?.lastClientId).toBe("tab-2");
  });

  // The row-level half of the stackless-crash regression: two distinct
  // fingerprints occupy two rows, each counted once, rather than colliding on
  // the (fingerprint, worktree) upsert target. The rule that makes two
  // stackless messages produce two fingerprints is pinned in
  // plugins/reports/plugins/crash/core/crash-kind.test.ts — the engine names no
  // kind, so this suite pins only the row half.
  test("two distinct fingerprints occupy two rows, not one", async () => {
    await writeReport(
      values({ fingerprint: "fp-a", message: "resize observer" }),
      t.db,
    );
    await writeReport(
      values({ fingerprint: "fp-b", message: "jobs sweeper" }),
      t.db,
    );

    const rows = await t.db.select().from(_reports);
    expect(rows.map((r) => r.message).sort()).toEqual([
      "jobs sweeper",
      "resize observer",
    ]);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  test("every write routes the id its statement returned — rate-limited or not", async () => {
    const [first] = await writeReport(
      values({ fingerprint: "fp-route", limited: false }),
      t.db,
    );
    const [repeat] = await writeReport(
      values({ fingerprint: "fp-route", limited: true }),
      t.db,
    );
    // The repeat lands on the existing row: its id, not the freshly minted one.
    expect(repeat?.id).toBe(first?.id);
    expect(routed).toEqual([]); // coalesced: nothing routes before the window
    flushNow(reportsProducer);
    expect(routed).toEqual([
      expect.objectContaining({
        source: "producer",
        table: "reports",
        op: "U",
        ids: [first?.id],
      }),
    ]);
  });

  test("two rows written in one window route together, once", async () => {
    const [a] = await writeReport(values({ fingerprint: "fp-x" }), t.db);
    const [b] = await writeReport(values({ fingerprint: "fp-y" }), t.db);
    flushNow(reportsProducer);
    flushNow(reportsProducer); // an empty window routes nothing
    expect(routed).toHaveLength(1);
    expect([...(routed[0]?.ids ?? [])].sort()).toEqual([a!.id, b!.id].sort());
  });
});
