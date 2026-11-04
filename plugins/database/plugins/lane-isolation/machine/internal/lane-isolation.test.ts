import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  installSpanContextRuntime,
  recordEntrySpan,
  type EntryContext,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { readDatabaseConfig } from "@plugins/database/core";
import {
  laneUser,
  PGBOUNCER_LANES,
} from "@plugins/database/plugins/pgbouncer/core";
import {
  createLanePools,
  type LanePools,
} from "@plugins/database/machine/testing";

const BACKGROUND_POOL_SIZE = PGBOUNCER_LANES.background.poolSize;

// ---------------------------------------------------------------------------
// Lane isolation, end to end, on the real cluster: every background PgBouncer
// server slot of a database held — the 2026-11-03 shape, where 16 abandoned
// background connections sat idle in a transaction and `/home`'s `SELECT 1`
// queued forever — and interactive work still answers.
//
// The holders come from a SECOND set of lane pools on the same database: like
// abandoned connections, they are invisible to the app pools under test, so
// what runs out is PgBouncer's background pool, not the app's own.
//
// Needs the machine's PgBouncer serving the lanes (the background role and its
// PgBouncer user), which every backend's boot converges — `./equin build`.
// ---------------------------------------------------------------------------

const als = new AsyncLocalStorage<EntryContext>();
installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

const NOT_ANSWERED = Symbol("not answered");

/** `p`'s value, or NOT_ANSWERED if it has not settled within `ms`. */
async function within<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | typeof NOT_ANSWERED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof NOT_ANSWERED>((resolve) => {
    timer = setTimeout(() => resolve(NOT_ANSWERED), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("PgBouncer pool per lane", () => {
  let testDb: TestDb;
  let app: LanePools;
  let leakers: LanePools;
  const held: PoolClient[] = [];

  beforeAll(async () => {
    testDb = await createTestDb({ prefix: "lanes_test" });
    app = createLanePools(testDb.name);
    leakers = createLanePools(testDb.name);
  });

  afterAll(async () => {
    for (const client of held.splice(0)) client.release();
    await app.front.end();
    await app.background.end();
    await leakers.front.end();
    await leakers.background.end();
    await testDb.drop();
  });

  it("answers interactive queries while every background slot is held", async () => {
    // Take every background server slot and leave each idle in a transaction.
    for (let i = 0; i < BACKGROUND_POOL_SIZE; i++) {
      const client = await leakers.background.connect();
      held.push(client);
      await client.query("BEGIN");
      await client.query("SELECT 1");
    }

    // The database sees them, by lane: the background role is their session user.
    const backgroundUser = laneUser(
      readDatabaseConfig().connection.user,
      "background",
    );
    const sessions = await app.front.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
       WHERE datname = current_database() AND usename = $1 AND state = 'idle in transaction'`,
      [backgroundUser],
    );
    expect(sessions.rows[0]?.n).toBe(String(BACKGROUND_POOL_SIZE));

    // The background lane really is exhausted: a background statement queues.
    const background = recordEntrySpan("job", "lanes.test", () =>
      app.front.query("SELECT 'background' AS lane"),
    );
    expect(await within(background, 1_000)).toBe(NOT_ANSWERED);

    // …and the interactive lane answers: a human's request, and boot work.
    const interactive = recordEntrySpan("http", "GET /home", () =>
      app.front.query("SELECT 'interactive' AS lane"),
    );
    const answered = await within(interactive, 5_000);
    expect(answered).not.toBe(NOT_ANSWERED);
    const contextLess = await within(app.front.query("SELECT 1 AS one"), 5_000);
    expect(contextLess).not.toBe(NOT_ANSWERED);

    // Freeing the background slots lets the queued background statement through.
    for (const client of held.splice(0)) {
      await client.query("ROLLBACK");
      client.release();
    }
    const result = await within(background, 5_000);
    expect(result).not.toBe(NOT_ANSWERED);
  });
});
