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
import { _claudeSpendHours } from "@plugins/infra/plugins/claude-cli/plugins/spend-ledger/server";
import {
  writeClaudeCliCall,
  writeRingHorizon,
  type RecordCallInput,
} from "./record-call";
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

describe("a recorded call's spend", () => {
  const call = (over: Partial<RecordCallInput>): RecordCallInput => ({
    model: FALLBACK_MODEL,
    sourceName: "task-title",
    sourceContext: null,
    prompt: "p",
    system: null,
    output: "o",
    error: null,
    durationMs: 1,
    correlationId: null,
    accountId: "max",
    costUsd: 0.25,
    at: new Date("2026-11-15T10:42:13Z"),
    ...over,
  });
  const ledger = () =>
    t.db
      .select()
      .from(_claudeSpendHours)
      .orderBy(asc(_claudeSpendHours.source), asc(_claudeSpendHours.hour));

  test("lands in the ledger under cli:<source>, in the call's hour, beside the log row", async () => {
    await writeClaudeCliCall(t.db, call({}));
    // An error result that reports a cost counts too; another hour starts a row.
    await writeClaudeCliCall(
      t.db,
      call({ output: null, error: "usage limit", costUsd: 0.5 }),
    );
    await writeClaudeCliCall(
      t.db,
      call({ costUsd: 1, at: new Date("2026-11-15T11:00:00Z") }),
    );
    // No result, or a free one: nothing to file.
    await writeClaudeCliCall(t.db, call({ costUsd: null }));
    await writeClaudeCliCall(t.db, call({ costUsd: 0 }));
    await writeClaudeCliCall(
      t.db,
      call({ sourceName: "turn-summary", costUsd: 2 }),
    );
    expect(await ledger()).toEqual([
      {
        accountId: "max",
        hour: new Date("2026-11-15T10:00:00Z"),
        source: "cli:task-title",
        costUsd: 0.75,
      },
      {
        accountId: "max",
        hour: new Date("2026-11-15T11:00:00Z"),
        source: "cli:task-title",
        costUsd: 1,
      },
      {
        accountId: "max",
        hour: new Date("2026-11-15T10:00:00Z"),
        source: "cli:turn-summary",
        costUsd: 2,
      },
    ]);
    const costs = await t.db
      .select({ costUsd: _claudeCliCalls.costUsd })
      .from(_claudeCliCalls)
      .where(eq(_claudeCliCalls.sourceName, "turn-summary"));
    expect(costs).toEqual([{ costUsd: 2 }]);
  });

  test("a trim of the log leaves the ledger as it was", async () => {
    const before = await ledger();
    await trimToNewest(t.db, _claudeCliCalls, {
      key: _claudeCliCalls.id,
      newestFirst: _claudeCliCalls.createdAt,
      keep: 0,
    });
    expect(await t.db.select().from(_claudeCliCalls)).toEqual([]);
    expect(await ledger()).toEqual(before);
  });
});
