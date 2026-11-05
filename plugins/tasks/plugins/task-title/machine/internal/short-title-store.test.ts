/**
 * `storeIfTitleUnchanged` against a real Postgres: the guarded upsert is one
 * hand-built statement (INSERT … SELECT … ON CONFLICT), a shape only the server
 * can judge — it writes when the task still has the title that was shortened,
 * replaces an older short title, and writes nothing once the task was renamed.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { storeIfTitleUnchanged } from "./short-title-job";
import { _tasksShortTitleExt } from "../../server/internal/tables";

setDefaultTimeout(120_000);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "short_title_store_test" });
  await runMigrations(t.db);
  await t.db.insert(_tasks).values({
    id: "task-s",
    clusterId: "task-s",
    title: "Fix the flaky upload test",
    titleAuto: false,
    rank: "a0",
    mandateRef: "interactive",
  } as typeof _tasks.$inferInsert);
});

afterAll(async () => {
  await t.drop();
});

async function stored() {
  return t.db
    .select({
      shortTitle: _tasksShortTitleExt.shortTitle,
      sourceTitle: _tasksShortTitleExt.sourceTitle,
    })
    .from(_tasksShortTitleExt);
}

describe("storeIfTitleUnchanged", () => {
  test("writes while the title is the one shortened, and replaces an older one", async () => {
    await storeIfTitleUnchanged(
      t.db,
      "task-s",
      "Fix the flaky upload test",
      "Flaky upload",
    );
    expect(await stored()).toEqual([
      { shortTitle: "Flaky upload", sourceTitle: "Fix the flaky upload test" },
    ]);
    await storeIfTitleUnchanged(
      t.db,
      "task-s",
      "Fix the flaky upload test",
      "Upload flake",
    );
    expect(await stored()).toEqual([
      { shortTitle: "Upload flake", sourceTitle: "Fix the flaky upload test" },
    ]);
  });

  test("writes nothing once the task was renamed", async () => {
    await t.db
      .update(_tasks)
      .set({ title: "Fix the upload test for good" })
      .where(eq(_tasks.id, "task-s"));
    await storeIfTitleUnchanged(
      t.db,
      "task-s",
      "Fix the flaky upload test",
      "Stale",
    );
    expect(await stored()).toEqual([
      { shortTitle: "Upload flake", sourceTitle: "Fix the flaky upload test" },
    ]);
  });

  test("writes nothing for a deleted task", async () => {
    await storeIfTitleUnchanged(t.db, "task-gone", "Anything", "Gone");
    expect(await stored()).toHaveLength(1);
  });
});
