/**
 * Real-DB suite for the sweep body (`sweepExpired`), including the
 * `beforeDelete` coordinated-teardown seam the trash purge rides on. The sweep
 * is table-generic, so it runs against a session-scoped TEMP scratch table on a
 * throwaway database (db-test-fixture) — TEMP is deliberate: it is per-session
 * (hence the dedicated single `pg.Client`, never the fixture's pool) and can
 * never become a persistent orphan, which is exactly why the
 * imperative-create-table-allowlisted check scopes itself to persistent tables.
 *
 * Run: `bun test plugins/infra/plugins/retention`
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
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { Client } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { defineChangeProducer } from "@plugins/database/plugins/change-feed/server";
import { mountProducersForTest } from "@plugins/database/plugins/change-feed/server/testing";
import { retentionCutoff } from "./retention-sql";
import { sweepExpired } from "./define-retention";

const _scratch = pgTable("retention_sweep_scratch", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// A table with a change producer: its sweep must route through the producer.
const _produced = pgTable("retention_sweep_produced", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
const producedProducer = defineChangeProducer({
  table: _produced,
  durability: "volatile",
  reason: "retention suite fixture",
  coalesce: "none",
});

let t: TestDb;
let client: Client;
let dbc: NodePgDatabase;

beforeAll(async () => {
  t = await createTestDb({ prefix: "retention_test" });
  // One dedicated session: a TEMP table only exists on the connection that
  // created it, so every statement must ride this single client.
  client = new Client({ connectionString: t.connectionString });
  await client.connect();
  dbc = drizzle(client);
  await dbc.execute(
    sql`CREATE TEMP TABLE retention_sweep_scratch (id text PRIMARY KEY, created_at timestamptz NOT NULL)`,
  );
  await dbc.execute(
    sql`CREATE TEMP TABLE retention_sweep_produced (id text PRIMARY KEY, created_at timestamptz NOT NULL)`,
  );
});

afterAll(async () => {
  await client.end();
  await t.drop();
});

beforeEach(async () => {
  await dbc.execute(sql`DELETE FROM retention_sweep_scratch`);
  await dbc.execute(sql`DELETE FROM retention_sweep_produced`);
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(id: string, ageDays: number): Promise<void> {
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  await dbc.insert(_scratch).values({ id, createdAt });
}

async function remainingIds(): Promise<string[]> {
  const rows = await dbc.select().from(_scratch);
  return rows.map((r) => r.id).sort();
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (see the
 * host-semaphore suite's identical helper), so this asserts the rejection for
 * real and hands back the error to pin its message.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("sweepExpired", () => {
  test("without beforeDelete: deletes only rows past the cutoff", async () => {
    await seed("old", 40);
    await seed("fresh", 5);

    await sweepExpired(dbc, {
      table: _scratch,
      column: _scratch.createdAt,
      cutoff: retentionCutoff(new Date(), 30),
    });

    expect(await remainingIds()).toEqual(["fresh"]);
  });

  test("beforeDelete sees exactly the expiring rows, before the DELETE", async () => {
    await seed("old-a", 31);
    await seed("old-b", 45);
    await seed("fresh", 1);

    const seen: string[][] = [];
    await sweepExpired(dbc, {
      table: _scratch,
      column: _scratch.createdAt,
      cutoff: retentionCutoff(new Date(), 30),
      beforeDelete: async (rows) => {
        // Rows must still exist while the callback runs (callback-first order).
        seen.push((await remainingIds()).slice());
        expect(rows.map((r) => r.id as string).sort()).toEqual([
          "old-a",
          "old-b",
        ]);
      },
    });

    expect(seen[0]).toEqual(["fresh", "old-a", "old-b"]);
    expect(await remainingIds()).toEqual(["fresh"]);
  });

  test("a throwing beforeDelete aborts the sweep — rows survive for the next tick", async () => {
    await seed("old", 40);

    const err = await rejection(
      sweepExpired(dbc, {
        table: _scratch,
        column: _scratch.createdAt,
        cutoff: retentionCutoff(new Date(), 30),
        beforeDelete: async () => {
          throw new Error("purge boom");
        },
      }),
    );
    expect(err.message).toBe("purge boom");

    expect(await remainingIds()).toEqual(["old"]);
  });

  test("beforeDelete is skipped entirely when nothing expired", async () => {
    await seed("fresh", 2);

    let called = false;
    await sweepExpired(dbc, {
      table: _scratch,
      column: _scratch.createdAt,
      cutoff: retentionCutoff(new Date(), 30),
      beforeDelete: async () => {
        called = true;
      },
    });

    expect(called).toBe(false);
    expect(await remainingIds()).toEqual(["fresh"]);
  });
});

describe("sweepExpired on a produced table", () => {
  test("deletes through the producer, which emits exactly the deleted PKs", async () => {
    const routed: Array<{
      source: string;
      op: string;
      ids: readonly string[] | null;
    }> = [];
    const unmount = mountProducersForTest([producedProducer], {
      route: (c) => routed.push(c),
    });
    try {
      const at = (ageDays: number) => new Date(Date.now() - ageDays * DAY_MS);
      await dbc.insert(_produced).values([
        { id: "old-a", createdAt: at(40) },
        { id: "old-b", createdAt: at(31) },
        { id: "fresh", createdAt: at(1) },
      ]);

      await sweepExpired(dbc, {
        table: _produced,
        column: _produced.createdAt,
        cutoff: retentionCutoff(new Date(), 30),
      });

      const rows = await dbc.select().from(_produced);
      expect(rows.map((r) => r.id)).toEqual(["fresh"]);
      expect(routed).toHaveLength(1);
      const [change] = routed;
      expect(change).toMatchObject({
        source: "producer",
        table: "retention_sweep_produced",
        op: "D",
      });
      expect([...(change!.ids ?? [])].sort()).toEqual(["old-a", "old-b"]);
    } finally {
      unmount();
    }
  });

  test("a transaction executor is refused for a produced table", async () => {
    const unmount = mountProducersForTest([producedProducer], {
      route: () => {},
    });
    try {
      const err = await rejection(
        dbc.transaction((tx) =>
          sweepExpired(tx, {
            table: _produced,
            column: _produced.createdAt,
            cutoff: retentionCutoff(new Date(), 30),
          }),
        ),
      );
      expect(err.message).toContain("must run on the pool");
    } finally {
      unmount();
    }
  });
});
