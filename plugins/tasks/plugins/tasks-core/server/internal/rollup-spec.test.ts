/**
 * Real-DB suite for the `attempt_conv_agg` rollup — the generated DDL and
 * reconcile `rebuildDerivedTables` runs on EVERY backend boot (through
 * `installRollups`, the same path). A syntax error or a shape change that
 * silently fails to apply wedges every worktree's boot, so this exercises the
 * actual SQL against a throwaway database (db-test-fixture) rather than
 * asserting on strings.
 *
 * What it pins:
 *   - the two liveness notions are genuinely different (`gone` is live=false but
 *     open=true — the distinction the worktree reaper depends on);
 *   - the boot rebuild is idempotent, and a clean reconcile heals nothing;
 *   - a PRE-EXISTING rollup table of an older shape is rebuilt to the declared
 *     one and refilled from source. `CREATE TABLE IF NOT EXISTS` is a no-op
 *     against an existing table, so without the shape check a new column would
 *     never reach any DB that already had the rollup — i.e. every real one.
 *
 * Run: `bun test plugins/tasks/plugins/tasks-core`
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
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import type { RollupReconcile } from "@plugins/database/plugins/derived-tables/core";
import { attemptConvAgg } from "./rollup-spec";

let t: TestDb;

// The columns the rollup's aggregate reads off `conversations`. Deliberately a
// minimal stand-in for the real table: this suite tests the rollup SQL, not the
// conversations schema.
const CREATE_CONVERSATIONS = sql`
  CREATE TABLE conversations (
    id         text PRIMARY KEY,
    attempt_id text NOT NULL,
    status     text NOT NULL,
    ended_at   timestamptz
  )
`;

async function runSpec(): Promise<RollupReconcile> {
  const [result] = await installRollups(t.db, [attemptConvAgg]);
  if (result === undefined) throw new Error("installRollups returned no row");
  return result;
}

async function addConversation(
  id: string,
  attemptId: string,
  status: string,
): Promise<void> {
  await t.db.execute(
    sql`INSERT INTO conversations (id, attempt_id, status) VALUES (${id}, ${attemptId}, ${status})`,
  );
}

async function rollupFor(attemptId: string): Promise<
  | {
      has_conv: boolean;
      has_live_conv: boolean | null;
      has_open_conv: boolean | null;
    }
  | undefined
> {
  const res = await t.db.execute(
    sql`SELECT has_conv, has_live_conv, has_open_conv FROM attempt_conv_agg WHERE attempt_id = ${attemptId}`,
  );
  return res.rows[0] as
    | {
        has_conv: boolean;
        has_live_conv: boolean | null;
        has_open_conv: boolean | null;
      }
    | undefined;
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "rollup_conv_agg_test" });
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`DROP TABLE IF EXISTS attempt_conv_agg`);
  await t.db.execute(sql`DROP TABLE IF EXISTS conversations CASCADE`);
  await t.db.execute(CREATE_CONVERSATIONS);
});

describe("attempt_conv_agg — the two liveness notions", () => {
  beforeEach(async () => {
    await runSpec();
  });

  test("a waiting conversation is both live and open", async () => {
    await addConversation("c1", "att-1", "waiting");
    expect(await rollupFor("att-1")).toEqual({
      has_conv: true,
      has_live_conv: true,
      has_open_conv: true,
    });
  });

  // THE distinction the worktree reaper turns on: a conversation whose process
  // vanished is not live, but the user has not finished with it — `gone` is the
  // status `resumeConversation` requires in order to resume.
  test("a gone conversation is NOT live but IS still open", async () => {
    await addConversation("c1", "att-1", "gone");
    expect(await rollupFor("att-1")).toEqual({
      has_conv: true,
      has_live_conv: false,
      has_open_conv: true,
    });
  });

  test("an explicitly closed conversation is neither live nor open", async () => {
    await addConversation("c1", "att-1", "done");
    expect(await rollupFor("att-1")).toEqual({
      has_conv: true,
      has_live_conv: false,
      has_open_conv: false,
    });
  });

  test("one open conversation keeps the whole attempt open", async () => {
    await addConversation("c1", "att-1", "done");
    await addConversation("c2", "att-1", "gone");
    expect(await rollupFor("att-1")).toEqual({
      has_conv: true,
      has_live_conv: false,
      has_open_conv: true,
    });
  });

  test("the triggers track a status update", async () => {
    await addConversation("c1", "att-1", "waiting");
    await t.db.execute(
      sql`UPDATE conversations SET status = 'gone' WHERE id = 'c1'`,
    );
    expect(await rollupFor("att-1")).toMatchObject({
      has_live_conv: false,
      has_open_conv: true,
    });

    await t.db.execute(
      sql`UPDATE conversations SET status = 'done' WHERE id = 'c1'`,
    );
    expect(await rollupFor("att-1")).toMatchObject({
      has_live_conv: false,
      has_open_conv: false,
    });
  });

  test("deleting the last conversation drops the rollup row", async () => {
    await addConversation("c1", "att-1", "waiting");
    await t.db.execute(sql`DELETE FROM conversations WHERE id = 'c1'`);
    expect(await rollupFor("att-1")).toBeUndefined();
  });

  test("the boot rebuild is idempotent and a clean reconcile heals nothing", async () => {
    await addConversation("c1", "att-1", "gone");
    await runSpec();
    expect(await runSpec()).toEqual({
      table: "attempt_conv_agg",
      upserted: 0,
      deleted: 0,
      definitionChanged: false,
    });
    expect(await rollupFor("att-1")).toEqual({
      has_conv: true,
      has_live_conv: false,
      has_open_conv: true,
    });
  });
});

describe("attempt_conv_agg — upgrading a pre-existing rollup table", () => {
  // `CREATE TABLE IF NOT EXISTS` cannot add a column, so a DB that already has
  // the rollup (every real one) only gets `has_open_conv` because the install
  // compares the live shape to the declared one and rebuilds a mismatch. Without
  // it the reaper would read NULL and treat every attempt as un-retained — worse
  // than the bug being fixed.
  test("an old-shape table is rebuilt with the column and refilled", async () => {
    await t.db.execute(sql`
      CREATE TABLE attempt_conv_agg (
        attempt_id    text PRIMARY KEY,
        has_conv      boolean NOT NULL,
        has_live_conv boolean,
        max_ended_at  timestamptz
      )
    `);
    await t.db.execute(
      sql`INSERT INTO attempt_conv_agg (attempt_id, has_conv, has_live_conv) VALUES ('att-1', true, false)`,
    );
    await addConversation("c1", "att-1", "gone");

    expect(await runSpec()).toMatchObject({
      upserted: 1,
      definitionChanged: true,
    });

    // Column exists AND the boot reconcile filled it from source in the same pass.
    expect(await rollupFor("att-1")).toEqual({
      has_conv: true,
      has_live_conv: false,
      has_open_conv: true,
    });
  });
});
