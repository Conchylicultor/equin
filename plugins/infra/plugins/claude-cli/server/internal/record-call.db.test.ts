/**
 * Real-Postgres suite for the call log's two typed ring writes: the trim to
 * the newest RECENT_CALLS_LIMIT rows (database's `trimToNewest`) and the
 * horizon upsert (`writeRingHorizon`, an INSERT … SELECT whose unchanged row
 * is not rewritten). Both were hand-written SQL before; this pins that the
 * typed spellings mean the same statements.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { trimToNewest } from "@plugins/database/server";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { CLAUDE_CLI_RING_ID } from "../../core/resources";
import { writeRingHorizon } from "./record-call";
import { _claudeCliCallHorizon, _claudeCliCalls } from "./tables";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "claude_cli_ring_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

async function insertCalls(n: number, startMinute: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await t.db.insert(_claudeCliCalls).values({
      model: FALLBACK_MODEL,
      sourceName: "ring-test",
      prompt: `p${startMinute + i}`,
      durationMs: 1,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, startMinute + i)),
    });
  }
}

const horizon = () =>
  t.db
    .select({
      total: _claudeCliCallHorizon.total,
      oldest: _claudeCliCallHorizon.oldest,
      xmin: sql<string>`xmin::text`,
    })
    .from(_claudeCliCallHorizon)
    .where(eq(_claudeCliCallHorizon.id, CLAUDE_CLI_RING_ID));

describe("claude-cli call ring", () => {
  test("trimToNewest keeps exactly the newest rows", async () => {
    await insertCalls(7, 0);
    await trimToNewest(t.db, _claudeCliCalls, {
      key: _claudeCliCalls.id,
      newestFirst: _claudeCliCalls.createdAt,
      keep: 3,
    });
    const left = await t.db
      .select({ prompt: _claudeCliCalls.prompt })
      .from(_claudeCliCalls)
      .orderBy(asc(_claudeCliCalls.createdAt));
    expect(left.map((r) => r.prompt)).toEqual(["p4", "p5", "p6"]);
  });

  test("writeRingHorizon records the ring's size and oldest call, and leaves an unchanged row alone", async () => {
    await writeRingHorizon(t.db);
    const [first] = await horizon();
    expect(first?.total).toBe(3);
    expect(first?.oldest?.toISOString()).toBe("2026-01-01T00:04:00.000Z");

    // Nothing moved: the guarded upsert writes no new row version.
    await writeRingHorizon(t.db);
    const [same] = await horizon();
    expect(same?.xmin).toBe(first?.xmin);

    await insertCalls(1, 10);
    await writeRingHorizon(t.db);
    const [moved] = await horizon();
    expect(moved?.total).toBe(4);
    expect(moved?.xmin).not.toBe(first?.xmin);
  });

  test("keep: 0 empties the ring; a negative keep throws", async () => {
    await trimToNewest(t.db, _claudeCliCalls, {
      key: _claudeCliCalls.id,
      newestFirst: _claudeCliCalls.createdAt,
      keep: 0,
    });
    expect(await t.db.select().from(_claudeCliCalls)).toEqual([]);
    expect(() =>
      trimToNewest(t.db, _claudeCliCalls, {
        key: _claudeCliCalls.id,
        newestFirst: _claudeCliCalls.createdAt,
        keep: -1,
      }),
    ).toThrow(/non-negative/);
  });
});
