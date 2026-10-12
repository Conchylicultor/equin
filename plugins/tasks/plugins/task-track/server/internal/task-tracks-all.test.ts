/**
 * `task-tracks.all` holds EVERY stored track: the task list's `track` field
 * reads the whole set, so a sidequest past the old window's `maxLimit` (2000)
 * must still be in it — read before as main. The real declaration, compiled
 * with the served binding against a throwaway database carrying the real
 * schema, loads the whole set FULL.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/tasks/plugins/task-track`.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { taskTracks } from "../../shared/resources";
import { tasksTrack } from "./tables";

setDefaultTimeout(120_000);

/** The old window's `maxLimit`, plus one. */
const COUNT = 2001;
const LAST = `tt-${COUNT}`;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "task_tracks_all" });
  await runMigrations(t.db);
  await t.db.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank)
    SELECT 'tt-' || g, 'task ' || g, false, 'a' || lpad(g::text, 6, '0')
    FROM generate_series(1, ${COUNT}) g`);
  await t.db.insert(tasksTrack.table).values(
    Array.from({ length: COUNT }, (_, i) => ({
      taskId: `tt-${i + 1}`,
      track: "sidequest" as const,
    })),
  );
});

afterAll(async () => {
  await t?.drop();
});

test("the whole set holds the sidequest past the old window's maxLimit", async () => {
  const specs = compileCollection(taskTracks, {
    from: tasksTrack,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  expect(rows.find((r) => r.taskId === LAST)?.track).toBe("sidequest");
});
