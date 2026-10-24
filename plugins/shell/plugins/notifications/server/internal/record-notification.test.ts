/**
 * Suite for the bell's re-surface semantics — the half of the reports engine's
 * re-alert floor that lives in SQL. `writeNotification`'s ON CONFLICT set
 * decides, per dedup hit, whether the row comes back as a fresh unread alert
 * (`createdAt < now - resurfaceAfterMs`) or only coalesces. That CASE is the
 * thing `RENOTIFY_FLOOR_MS` steers, so it is driven here against a throwaway
 * Postgres (db-test-fixture) seeded with the REAL migration chain, rather than
 * restated in the test.
 *
 * Run: `./equin test plugins/shell/plugins/notifications`
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import {
  writeNotification,
  type NotificationWrite,
} from "./record-notification";
import { _notifications } from "./tables";

// The reports engine's floor. Named locally on purpose: importing it from
// reports/server would make notifications depend on its own consumer.
const WINDOW_MS = 10 * 60 * 1000;

const DEDUP_KEY = "report-crash-1";

const notification = (
  over: Partial<NotificationWrite> = {},
): NotificationWrite => ({
  type: "report",
  title: "Crash report",
  description: "ResizeObserver loop completed with undelivered notifications.",
  variant: "error",
  dedupeKey: DEDUP_KEY,
  resurfaceAfterMs: WINDOW_MS,
  ...over,
});

describe("writeNotification re-surface window (real DB)", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb({ prefix: "notif_test" });
    await runMigrations(t.db);
  });

  afterAll(async () => {
    await t.drop();
  });

  beforeEach(async () => {
    await t.db.execute(sql`DELETE FROM notifications`);
  });

  // The row as the user left it: they read the alert and dismissed it, and the
  // problem last surfaced longer ago than the window. `createdAt` is the "last
  // surfaced at" marker, so backdating it IS "this has been quiet for an hour".
  const seedDismissed = async (surfacedAgoMs: number): Promise<void> => {
    await writeNotification(notification(), t.db);
    await t.db
      .update(_notifications)
      .set({
        read: true,
        dismissed: true,
        createdAt: new Date(Date.now() - surfacedAgoMs),
      })
      .where(eq(_notifications.dedupKey, DEDUP_KEY));
  };

  // The dedup key is UNIQUE, so "exactly one row" is the invariant every
  // assertion below reads through. Throwing rather than returning a possibly-
  // undefined row keeps the assertions about the semantics under test.
  const only = async (): Promise<typeof _notifications.$inferSelect> => {
    const rows = await t.db.select().from(_notifications);
    const row = rows[0];
    if (rows.length !== 1 || !row) {
      throw new Error(
        `expected exactly one notification row, got ${rows.length}`,
      );
    }
    return row;
  };

  test("a recurrence past the window re-alerts a dismissed row", async () => {
    await seedDismissed(60 * 60 * 1000);
    const before = await only();

    await writeNotification(notification(), t.db);

    const row = await only();
    // Back in the bell, unread, at the top — the whole point of the floor.
    expect(row.read).toBe(false);
    expect(row.dismissed).toBe(false);
    expect(row.createdAt.getTime()).toBeGreaterThan(before.createdAt.getTime());
    // Still ONE row: re-surfacing re-arms the existing row, it does not mint a
    // second one per occurrence (the unbounded-undismissed-set regression).
    expect(row.count).toBe(2);
    expect(row.id).toBe(before.id);
  });

  test("a recurrence inside the window leaves a dismissed row dismissed", async () => {
    await seedDismissed(60 * 1000);
    const before = await only();

    await writeNotification(notification(), t.db);

    const row = await only();
    expect(row.dismissed).toBe(true);
    expect(row.read).toBe(true);
    // Untouched surfacing time — the user is not re-alerted for a problem they
    // dismissed a minute ago.
    expect(row.createdAt.getTime()).toBe(before.createdAt.getTime());
    // But the occurrence is still counted, and the row still reads as fresh.
    expect(row.count).toBe(2);
    expect(row.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      before.lastSeenAt.getTime(),
    );
  });

  // The floor exists because this arm used to be every report kind's default:
  // half of them passed no window at all, so a dismissed problem never came
  // back however many times it recurred. Pinned so the arm stays reachable only
  // for the unique-per-event callers that legitimately want it.
  test("no window at all never re-alerts, however old the row", async () => {
    await seedDismissed(60 * 60 * 1000);

    await writeNotification(
      notification({ resurfaceAfterMs: undefined }),
      t.db,
    );

    const row = await only();
    expect(row.dismissed).toBe(true);
    expect(row.read).toBe(true);
    expect(row.count).toBe(2);
  });
});
