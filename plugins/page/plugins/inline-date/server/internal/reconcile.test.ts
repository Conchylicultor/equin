/**
 * Real-DB suite for the reminder reconciler's trash symmetry: a block delete is
 * a TRASH (the `page_reminders` row is not cascaded away — the reconciler
 * cancels it when the token leaves the live text), so an undo brings the same
 * token back and the reconciler must REVIVE the canceled row rather than leave
 * it silently dead.
 *
 * Headless against a throwaway Postgres (db-test-fixture) with the real
 * migration chain plus graphile's queue schema (the reconcile enqueues its fire
 * job on the same transaction as its row writes).
 *
 * Run: `./equin test plugins/page/plugins/inline-date`
 * (requires the running embedded cluster — `./equin build` first).
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
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { installQueueSchema } from "@plugins/infra/plugins/jobs/server/testing";
import { TrashEntrySchema } from "@plugins/infra/plugins/trash/core";
import { _trashEntries } from "@plugins/infra/plugins/trash/server";
import {
  _blocks,
  Editor,
  deleteBlocksSubtree,
} from "@plugins/page/plugins/editor/server";
import { untrashBlocks } from "@plugins/page/plugins/editor/server/testing";
import {
  defineBlock,
  pageBlockHandle,
  textBlockSchema,
} from "@plugins/page/plugins/editor/core";
import { reminderToken } from "../../core/tokens";
import { _pageReminders } from "./tables";
import { reconcileReminders } from "./reconcile";

// Stand-in for `page/text` (importing the real one would form a cycle with the
// editor plugin this test drives through).
const textBlockStub = defineBlock({
  type: "text",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});

let t: TestDb;

const REMINDER_ID = "11111111-2222-4333-8444-555555555555";
const FIRE_AT = "2030-06-17T09:00:00.000Z";

beforeAll(async () => {
  t = await createTestDb({ prefix: "reminders_test" });
  await runMigrations(t.db);
  await installQueueSchema(t.connectionString);
  collectContributions([
    {
      id: "inline-date-reconcile-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
      ],
    },
  ]);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
});

async function seedPageWithReminder(): Promise<void> {
  await t.db.execute(
    sql`INSERT INTO page_blocks (id, parent_id, page_id, type, rank, data)
        VALUES ('P', NULL, NULL, 'page', 'a0', '{"title":"P","icon":null}'::jsonb)`,
  );
  const data = JSON.stringify({
    text: [{ text: `remind me ${reminderToken(REMINDER_ID, FIRE_AT)}` }],
  });
  await t.db.execute(
    sql`INSERT INTO page_blocks (id, parent_id, page_id, type, rank, data)
        VALUES ('b1', 'P', 'P', 'text', 'a0', ${data}::jsonb)`,
  );
}

async function reminder() {
  const [r] = await t.db
    .select()
    .from(_pageReminders)
    .where(eq(_pageReminders.id, REMINDER_ID));
  return r;
}

/** Rows in graphile's queue — this throwaway database holds only this suite's fire jobs. */
async function queuedFireJobs(): Promise<number> {
  const res = await t.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM graphile_worker.jobs`,
  );
  return res.rows[0]!.n;
}

describe("reconcileReminders across a block trash + restore", () => {
  test("token present → pending; block trashed → canceled; block restored → pending again, same id", async () => {
    await seedPageWithReminder();

    await reconcileReminders("P", t.db);
    const created = await reminder();
    expect(created?.status).toBe("pending");
    expect(created?.blockId).toBe("b1");
    expect(created?.fireAt.toISOString()).toBe(FIRE_AT);
    expect(await queuedFireJobs()).toBe(1);

    // Delete the block: a trash, so the row survives the delete — and the
    // reconciler (bound to blocksChanged in production) cancels it.
    const outcome = await deleteBlocksSubtree(["b1"], t.db);
    expect(outcome.trashed).toBe(true);
    expect(
      (await t.db.select().from(_blocks).where(eq(_blocks.id, "b1")))[0]
        ?.deletedAt,
    ).toBeInstanceOf(Date);
    await reconcileReminders("P", t.db);
    expect((await reminder())?.status).toBe("canceled");

    // Undo: the token is back in the live text with the SAME reminder id.
    const [entryRow] = await t.db.select().from(_trashEntries);
    await untrashBlocks(TrashEntrySchema.parse(entryRow), t.db);
    await reconcileReminders("P", t.db);

    const revived = await reminder();
    expect(revived?.status).toBe("pending");
    expect(revived?.blockId).toBe("b1");
    expect(revived?.fireAt.toISOString()).toBe(FIRE_AT);
    // Re-scheduled: the job key dedups on the reminder id, so the queue still
    // holds exactly one fire job for it (replaced, not stacked).
    expect(await queuedFireJobs()).toBe(1);
  });

  test("a fired reminder is left alone when its token reappears", async () => {
    await seedPageWithReminder();
    await reconcileReminders("P", t.db);
    await t.db
      .update(_pageReminders)
      .set({ status: "fired" })
      .where(eq(_pageReminders.id, REMINDER_ID));

    await reconcileReminders("P", t.db);
    expect((await reminder())?.status).toBe("fired");
  });
});
