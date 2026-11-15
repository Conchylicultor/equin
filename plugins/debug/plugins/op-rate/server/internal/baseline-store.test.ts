/**
 * The call history against a real Postgres (db-test-fixture, seeded with the
 * REAL migration chain): one row per op and UTC day, its counters an array the
 * upsert adds to element by element, read back as the per-bucket and per-hour
 * history the monitor judges against.
 *
 * Run: `./equin test plugins/debug/plugins/op-rate`
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { readHistory, readHourHistory, recordWindow } from "./baseline-store";
import { bucketOf, HOUR_MS, MIN_WINDOWS_PER_HOUR } from "./op-rate-baseline";
import { _opRateDayBuckets, _opRateDayHours } from "./tables";

const DAY_MS = 24 * HOUR_MS;
// 2026-11-10T00:00Z, a UTC day start.
const DAY0 = Date.UTC(2026, 10, 10);
const at = (day: number, hour: number, minute = 30) =>
  DAY0 + day * DAY_MS + hour * HOUR_MS + minute * 60_000;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "op_rate_store" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(
    sql`TRUNCATE op_rate_day_buckets, op_rate_day_hours, op_rate_windows`,
  );
});

describe("recordWindow → readHistory", () => {
  test("a day's windows fold into one row per op, its buckets summed over days", async () => {
    // Day 0: "a" lands in bucket(3) twice and bucket(200) once; "b" once.
    await recordWindow(
      t.db,
      "steady",
      at(0, 1),
      new Map([
        ["a", 3],
        ["b", 5],
      ]),
    );
    await recordWindow(t.db, "steady", at(0, 1, 40), new Map([["a", 3]]));
    await recordWindow(
      t.db,
      "steady",
      at(0, 2),
      new Map([
        ["a", 200],
        ["c", 0],
      ]),
    );
    // Day 1: "a" in bucket(3) again.
    await recordWindow(t.db, "steady", at(1, 5), new Map([["a", 3]]));

    const rows = await t.db
      .select({ op: _opRateDayBuckets.op, windows: _opRateDayBuckets.windows })
      .from(_opRateDayBuckets);
    // One row per (op, day): a ×2 days, b ×1; "c" (0 calls) is not stored.
    expect(rows.map((r) => r.op).sort()).toEqual(["a", "a", "b"]);
    const day0A = rows.find(
      (r) => r.op === "a" && r.windows.length === bucketOf(200) + 1,
    );
    expect(day0A?.windows[bucketOf(3)]).toBe(2);
    expect(day0A?.windows[bucketOf(200)]).toBe(1);

    // Judged on day 2: both past days, today left out.
    await recordWindow(t.db, "steady", at(2, 1), new Map([["a", 3]]));
    const h = await readHistory(t.db, "steady", at(2, 3), ["a", "b", "never"]);
    expect(h.windows).toBe(4);
    expect(Object.fromEntries(h.ops.get("a")?.buckets ?? [])).toEqual({
      [bucketOf(3)]: 3,
      [bucketOf(200)]: 1,
    });
    expect(Object.fromEntries(h.ops.get("b")?.buckets ?? [])).toEqual({
      [bucketOf(5)]: 1,
    });
    expect(h.ops.get("never")?.buckets.size).toBe(0);
  });

  test("regimes are kept apart", async () => {
    await recordWindow(t.db, "boot", at(0, 1), new Map([["a", 40]]));
    await recordWindow(t.db, "steady", at(0, 1, 45), new Map([["a", 2]]));
    const boot = await readHistory(t.db, "boot", at(1, 0), ["a"]);
    const steady = await readHistory(t.db, "steady", at(1, 0), ["a"]);
    expect(boot.windows).toBe(1);
    expect([...(boot.ops.get("a")?.buckets ?? [])]).toEqual([
      [bucketOf(40), 1],
    ]);
    expect([...(steady.ops.get("a")?.buckets ?? [])]).toEqual([
      [bucketOf(2), 1],
    ]);
  });
});

describe("recordWindow → readHourHistory", () => {
  test("each hour's calls land in its slot of the day's row", async () => {
    // Day 0, hours 3 and 7 covered (enough windows to be a sample); "a" called
    // 10 per window in hour 3, 50 per window in hour 7.
    for (let i = 0; i < MIN_WINDOWS_PER_HOUR; i++) {
      await recordWindow(t.db, "steady", at(0, 3, i), new Map([["a", 10]]));
      await recordWindow(t.db, "steady", at(0, 7, i), new Map([["a", 50]]));
    }
    const [row] = await t.db
      .select({ calls: _opRateDayHours.calls })
      .from(_opRateDayHours);
    expect(row?.calls).toEqual([
      0,
      0,
      0,
      10 * MIN_WINDOWS_PER_HOUR,
      0,
      0,
      0,
      50 * MIN_WINDOWS_PER_HOUR,
    ]);

    // Day 1, hour 7: 30 already recorded this hour, 25 in the window judged.
    await recordWindow(t.db, "steady", at(1, 7, 5), new Map([["a", 30]]));
    const h = await readHourHistory(
      t.db,
      at(1, 7, 10),
      new Map([
        ["a", 25],
        ["quiet", 1],
      ]),
      40,
    );
    expect(h.coveredHours).toBe(2);
    // "quiet" is under the floor; "a" has its hour so far and both past hours.
    expect([...h.ops.keys()]).toEqual(["a"]);
    expect(h.ops.get("a")).toEqual({
      hourSoFar: 55,
      pastHours: [10 * MIN_WINDOWS_PER_HOUR, 50 * MIN_WINDOWS_PER_HOUR],
    });
  });
});
