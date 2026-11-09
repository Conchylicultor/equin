/**
 * Suite for the bell's re-alert semantics — the half of the reports engine's
 * re-alert floor that lives in SQL. Per dedup hit, `writeNotification` either
 * coalesces into the key's row or — on a new episode (the row went quiet for
 * the window, or the user dismissed it and it surfaced longer ago than that) —
 * releases the key and files a NEW row. A row is never moved, never
 * un-dismissed. That is the thing `RENOTIFY_FLOOR_MS` steers, so it is driven
 * here against a throwaway Postgres (db-test-fixture) seeded with the REAL
 * migration chain, rather than restated in the test.
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

describe("writeNotification re-alert (real DB)", () => {
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

  // The key's row as the user left it, its timestamps backdated: `createdAt` is
  // when it surfaced (its place in the bell), `lastSeenAt` its latest
  // occurrence. The migration chain installs no triggers, so the backdate is
  // possible here; the app's database refuses a `created_at` change.
  const seed = async (state: {
    dismissed: boolean;
    surfacedAgoMs: number;
    lastSeenAgoMs: number;
  }): Promise<typeof _notifications.$inferSelect> => {
    await writeNotification(notification(), t.db);
    await t.db
      .update(_notifications)
      .set({
        read: true,
        dismissed: state.dismissed,
        createdAt: new Date(Date.now() - state.surfacedAgoMs),
        lastSeenAt: new Date(Date.now() - state.lastSeenAgoMs),
      })
      .where(eq(_notifications.dedupKey, DEDUP_KEY));
    return only();
  };

  const rows = async (): Promise<(typeof _notifications.$inferSelect)[]> =>
    t.db.select().from(_notifications).orderBy(_notifications.createdAt);

  const only = async (): Promise<typeof _notifications.$inferSelect> => {
    const all = await rows();
    const row = all[0];
    if (all.length !== 1 || !row) {
      throw new Error(
        `expected exactly one notification row, got ${all.length}`,
      );
    }
    return row;
  };

  // A new episode: the earlier row stays exactly as it was (place, state,
  // count) and gives up the key; the new row is the unread alert on top.
  const expectNewEpisode = async (
    before: typeof _notifications.$inferSelect,
  ): Promise<void> => {
    const [earlier, fresh] = await rows();
    if (!earlier || !fresh) throw new Error("expected two rows");
    expect(earlier.id).toBe(before.id);
    expect(earlier.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(earlier.dismissed).toBe(before.dismissed);
    expect(earlier.read).toBe(before.read);
    expect(earlier.count).toBe(before.count);
    expect(earlier.dedupKey).toBeNull();
    expect(fresh.id).not.toBe(before.id);
    expect(fresh.dedupKey).toBe(DEDUP_KEY);
    expect(fresh.read).toBe(false);
    expect(fresh.dismissed).toBe(false);
    expect(fresh.count).toBe(1);
  };

  test("a recurrence past the window after a dismiss files a new row; the dismissed one stays dismissed, in place", async () => {
    const before = await seed({
      dismissed: true,
      surfacedAgoMs: 60 * 60 * 1000,
      lastSeenAgoMs: 60 * 1000,
    });

    await writeNotification(notification(), t.db);

    await expectNewEpisode(before);
  });

  test("a recurrence after the row went quiet files a new row; the earlier one keeps its place", async () => {
    const before = await seed({
      dismissed: false,
      surfacedAgoMs: 2 * 60 * 60 * 1000,
      lastSeenAgoMs: 60 * 60 * 1000,
    });

    await writeNotification(notification(), t.db);

    await expectNewEpisode(before);
  });

  test("a problem that keeps firing, undismissed, stays one row: no new row per window", async () => {
    const before = await seed({
      dismissed: false,
      surfacedAgoMs: 60 * 60 * 1000,
      lastSeenAgoMs: 60 * 1000,
    });

    await writeNotification(notification(), t.db);

    const row = await only();
    expect(row.id).toBe(before.id);
    expect(row.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(row.read).toBe(true);
    expect(row.count).toBe(2);
    expect(row.lastSeenAt.getTime()).toBeGreaterThan(
      before.lastSeenAt.getTime(),
    );
  });

  test("a recurrence inside the window leaves a dismissed row dismissed", async () => {
    const before = await seed({
      dismissed: true,
      surfacedAgoMs: 60 * 1000,
      lastSeenAgoMs: 60 * 1000,
    });

    await writeNotification(notification(), t.db);

    const row = await only();
    expect(row.dismissed).toBe(true);
    expect(row.read).toBe(true);
    expect(row.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(row.count).toBe(2);
  });

  test("after a new episode, later hits coalesce into the new row only", async () => {
    const before = await seed({
      dismissed: true,
      surfacedAgoMs: 60 * 60 * 1000,
      lastSeenAgoMs: 60 * 60 * 1000,
    });

    await writeNotification(notification(), t.db);
    await writeNotification(notification(), t.db);

    const [earlier, fresh] = await rows();
    expect(earlier?.id).toBe(before.id);
    expect(earlier?.count).toBe(before.count);
    expect(fresh?.count).toBe(2);
  });

  // The arm for the unique-per-event callers (conversation-created,
  // build-finish, page reminders): no window, never a second row.
  test("no window at all never files a new row, however old the row", async () => {
    await seed({
      dismissed: true,
      surfacedAgoMs: 60 * 60 * 1000,
      lastSeenAgoMs: 60 * 60 * 1000,
    });

    await writeNotification(
      notification({ resurfaceAfterMs: undefined }),
      t.db,
    );

    const row = await only();
    expect(row.dismissed).toBe(true);
    expect(row.read).toBe(true);
    expect(row.count).toBe(2);
  });

  // The bell's state chips filter on `state_tone`, which the database derives
  // from `state` — so a write (or restate) of `state` is all it takes, and the
  // two can never disagree.
  test("state_tone is derived from state, on insert and on every rewrite", async () => {
    await writeNotification(notification(), t.db);
    expect((await only()).stateTone).toBeNull();
    await t.db
      .update(_notifications)
      .set({ state: { tone: "resolved", text: "Fixed by abc123" } })
      .where(eq(_notifications.dedupKey, DEDUP_KEY));
    expect((await only()).stateTone).toBe("resolved");
    await writeNotification(
      notification({
        state: { tone: "recurred", text: "Came back after abc123" },
      }),
      t.db,
    );
    expect((await only()).stateTone).toBe("recurred");
  });
});
