/**
 * The bell badge's loader against a throwaway Postgres seeded with the REAL
 * migration chain: it counts `countedUnread` over the WHOLE undismissed
 * collection — including unread errors and warnings older than the newest 200
 * rows the default window loads — and agrees row for row with the panel's
 * in-memory `matchesFilter` over the same predicate.
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
import { and, desc, eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { matchesFilter } from "@plugins/network/plugins/live/plugins/filter/core";
import { countUnreadNotifications } from "./resources";
import { _notifications } from "./tables";
import type { NotificationVariant } from "../../shared/schema";
import { countedUnread, countedUnreadFilterable } from "../../shared/unread";
import { notificationIdKind } from "../../core";

type Seed = {
  variant: NotificationVariant;
  read?: boolean;
  muted?: boolean;
  dismissed?: boolean;
  ageMs: number;
};

const HOUR = 60 * 60 * 1000;

describe("countUnreadNotifications (real DB)", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb({ prefix: "notif_unread_test" });
    await runMigrations(t.db);
  });

  afterAll(async () => {
    await t.drop();
  });

  let seq = 0;
  const seed = async (n: number, row: Seed): Promise<void> => {
    const now = Date.now();
    await t.db.insert(_notifications).values(
      Array.from({ length: n }, (_, i) => ({
        id: notificationIdKind.key(`n-${seq++}`),
        type: "test",
        title: `${row.variant} ${i}`,
        description: "",
        variant: row.variant,
        read: row.read ?? false,
        muted: row.muted ?? false,
        dismissed: row.dismissed ?? false,
        // Spread within the bucket so the order is total.
        createdAt: new Date(now - row.ageMs - i * 1000),
      })),
    );
  };

  beforeEach(async () => {
    await t.db.execute(sql`DELETE FROM notifications`);
    // 260 undismissed rows. The counted ones (3 unread errors, 5 unread
    // warnings) are a day old — behind 200 fresh info rows, so none of them is
    // in the default window the bell used to count.
    await seed(3, { variant: "error", ageMs: 24 * HOUR });
    await seed(5, { variant: "warning", ageMs: 24 * HOUR });
    await seed(200, { variant: "info", ageMs: 0 });
    await seed(20, { variant: "error", muted: true, ageMs: 2 * HOUR });
    await seed(20, { variant: "warning", read: true, ageMs: 2 * HOUR });
    await seed(12, { variant: "success", ageMs: 2 * HOUR });
    // Dismissed rows are outside the collection, unread or not.
    await seed(10, { variant: "error", dismissed: true, ageMs: HOUR });
  });

  test("counts the whole collection, not the newest 200", async () => {
    const window = await t.db
      .select({ variant: _notifications.variant })
      .from(_notifications)
      .where(eq(_notifications.dismissed, false))
      .orderBy(desc(_notifications.createdAt))
      .limit(200);
    expect(window.every((r) => r.variant === "info")).toBe(true);

    expect(await countUnreadNotifications(t.db)).toEqual({
      errors: 3,
      warnings: 5,
    });
  });

  test("agrees with the panel's in-memory matchesFilter", async () => {
    const rows = await t.db
      .select()
      .from(_notifications)
      .where(eq(_notifications.dismissed, false));
    expect(rows).toHaveLength(260);
    const counted = rows.filter((r) =>
      matchesFilter(r, countedUnread, countedUnreadFilterable),
    );
    expect({
      errors: counted.filter((r) => r.variant === "error").length,
      warnings: counted.filter((r) => r.variant === "warning").length,
    }).toEqual(await countUnreadNotifications(t.db));
  });

  test("dismissing one counted row moves the count", async () => {
    const [first] = await t.db
      .select({ id: _notifications.id })
      .from(_notifications)
      .where(
        and(
          eq(_notifications.variant, "error"),
          eq(_notifications.muted, false),
          eq(_notifications.dismissed, false),
        ),
      )
      .limit(1);
    if (first === undefined) throw new Error("seed has no unmuted error");
    await t.db
      .update(_notifications)
      .set({ dismissed: true })
      .where(eq(_notifications.id, first.id));
    expect(await countUnreadNotifications(t.db)).toEqual({
      errors: 2,
      warnings: 5,
    });
  });

  test("marking all read clears it", async () => {
    // The mark-all-read endpoint's write.
    await t.db
      .update(_notifications)
      .set({ read: true })
      .where(
        and(
          eq(_notifications.dismissed, false),
          eq(_notifications.read, false),
        ),
      );
    expect(await countUnreadNotifications(t.db)).toEqual({
      errors: 0,
      warnings: 0,
    });
  });
});
