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
import { _claudeUsageHours } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import { callModelTokens } from "./call-tokens";
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

describe("a recorded call's tokens", () => {
  const usage = (input: number, output: number) =>
    callModelTokens({
      "model-c": {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 300,
        cacheCreationEphemeral1hInputTokens: 100,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
      },
    });
  const call = (over: Partial<RecordCallInput>): RecordCallInput => ({
    model: FALLBACK_MODEL,
    sourceName: "tokens-test",
    sourceContext: null,
    prompt: "p",
    system: null,
    output: "o",
    error: null,
    durationMs: 1,
    correlationId: null,
    accountId: "max",
    costUsd: 0.01,
    tokens: usage(1_000, 50),
    at: new Date("2026-11-15T10:42:13Z"),
    ...over,
  });
  const ledger = () =>
    t.db
      .select()
      .from(_claudeUsageHours)
      .where(eq(_claudeUsageHours.source, "cli:tokens-test"));

  test("land in the token ledger under cli:<source>, per model, in the call's hour, added up", async () => {
    await writeClaudeCliCall(t.db, call({}));
    await writeClaudeCliCall(t.db, call({ tokens: usage(2_000, 5) }));
    // No account: the call never ran, so it used nothing.
    await writeClaudeCliCall(t.db, call({ accountId: null }));
    expect(await ledger()).toEqual([
      {
        accountId: "max",
        hour: new Date("2026-11-15T10:00:00Z"),
        source: "cli:tokens-test",
        model: "model-c",
        speed: "standard",
        origin: "counted",
        inputBelow: 3_000,
        inputAbove: 0,
        outputBelow: 55,
        outputAbove: 0,
        cacheReadBelow: 0,
        cacheReadAbove: 0,
        cacheCreate5mBelow: 400,
        cacheCreate5mAbove: 0,
        cacheCreate1hBelow: 200,
        cacheCreate1hAbove: 0,
      },
    ]);
    const sources = await t.db.execute<{
      source: string;
      project_dir: string | null;
      is_repo: boolean;
      title: string | null;
    }>(
      sql`SELECT source, project_dir, is_repo, title FROM claude_usage_sources WHERE source = 'cli:tokens-test'`,
    );
    expect(sources.rows).toEqual([
      {
        source: "cli:tokens-test",
        project_dir: null,
        is_repo: true,
        title: null,
      },
    ]);
  });

  test("a trim of the log leaves the ledger as it was", async () => {
    await writeClaudeCliCall(t.db, call({}));
    const before = await ledger();
    expect(before).not.toEqual([]);
    await trimToNewest(t.db, _claudeCliCalls, {
      key: _claudeCliCalls.id,
      newestFirst: _claudeCliCalls.createdAt,
      keep: 0,
    });
    expect(await t.db.select().from(_claudeCliCalls)).toEqual([]);
    expect(await ledger()).toEqual(before);
  });

  test("a call that used no token files no ledger row", async () => {
    await writeClaudeCliCall(
      t.db,
      call({ sourceName: "tokens-none", tokens: [] }),
    );
    expect(
      await t.db
        .select()
        .from(_claudeUsageHours)
        .where(eq(_claudeUsageHours.source, "cli:tokens-none")),
    ).toEqual([]);
  });
});
