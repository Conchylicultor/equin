/**
 * The Cost column's derivation against a real Postgres (db-test-fixture, the
 * real migration chain, the priced view, the `conversations.usage.cost`
 * trigger set): a conversation's `conversations_ext_usage` cost and tokens
 * follow its `conv:` ledger rows priced by `claude_spend_hours_v` — on a
 * ledger write (a delta, a take-back), a new model's rates, a correction
 * effective from the past — never touching its agent count, never naming a
 * conversation that no longer exists; and the repair heals a drifted row.
 *
 * Run: `./equin test plugins/conversations/plugins/usage`
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { installDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { writeAtomically } from "@plugins/database/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  usageLedgerUpsert,
  type UsageLedgerRow,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import type { SpendSource } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import {
  _claudeModelRates,
  _claudePriceVersions,
  ensureModelRates,
  recordPriceVersion,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { priceVersionIdKind } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/core";
import { installSpendHoursView } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server/testing";
import { reconcileUsageCosts, usageCostTriggers } from "./cost-triggers";
import { _conversationUsageExt, conversationUsage } from "./tables";

setDefaultTimeout(120_000);

let t: TestDb;

const PER_TOKEN = 1e-6;
const flat = (rate: number) => ({
  input: rate,
  output: rate,
  cacheCreate5m: rate,
  cacheCreate1h: rate,
  cacheRead: rate,
});

beforeAll(async () => {
  t = await createTestDb({ prefix: "usage_cost_triggers_test" });
  await runMigrations(t.db);
  await installSpendHoursView(t.db);
  await installDbTriggers(t.db, [usageCostTriggers]);
  await t.db.insert(_tasks).values({
    id: "task-c",
    clusterId: "task-c",
    title: "usage cost",
    titleAuto: false,
    rank: "a0",
    mandateRef: "interactive",
    authorKind: "human",
  } as typeof _tasks.$inferInsert);
  await t.db.insert(_attempts).values({
    id: "att-c",
    taskId: "task-c",
    worktreePath: "/tmp/usage-cost",
  } as typeof _attempts.$inferInsert);
  for (const id of ["conv-c", "conv-d"])
    await t.db.insert(_conversations).values({
      id,
      attemptId: "att-c",
      title: null,
      status: "working",
      runtime: "sdk",
      model: FALLBACK_MODEL,
      kind: "user",
      launchCause: "direct",
    } as typeof _conversations.$inferInsert);
  await recordPriceVersion(
    t.db,
    { fetchedAt: 0, models: { "m-a": flat(PER_TOKEN) } },
    "fallback",
  );
});

afterAll(async () => {
  await t.drop();
});

const none = { below: 0, above: 0 };
const row = (
  source: SpendSource,
  hour: string,
  input: number,
  cacheRead = 0,
  model = "m-a",
): UsageLedgerRow => ({
  accountId: "max",
  hour: new Date(hour),
  source,
  model,
  speed: "standard",
  tokens: {
    input: { below: input, above: 0 },
    output: none,
    cacheRead: { below: cacheRead, above: 0 },
    cacheCreate5m: none,
    cacheCreate1h: none,
  },
});
const file = async (rows: UsageLedgerRow[]) => {
  await writeAtomically(t.db, [usageLedgerUpsert(t.db, rows)]);
  await ensureModelRates(
    t.db,
    rows.map((r) => r.model),
  );
};

async function usageOf(id: string) {
  const [r] = await t.db
    .select({
      costUsd: _conversationUsageExt.costUsd,
      tokens: _conversationUsageExt.tokens,
      cacheReadTokens: _conversationUsageExt.cacheReadTokens,
      agentCount: _conversationUsageExt.agentCount,
    })
    .from(_conversationUsageExt)
    .where(eq(_conversationUsageExt.conversationId, id));
  return r;
}
const near = (a: number | undefined, b: number) =>
  expect(Math.abs((a ?? Number.NaN) - b)).toBeLessThan(1e-9);

describe("the Cost column follows the priced ledger", () => {
  test("a ledger write derives cost and tokens; a delta and a take-back move them", async () => {
    await file([
      row("conv:conv-c", "2026-11-10T08:00:00Z", 1_000_000, 500),
      row("conv:conv-c", "2026-11-10T09:00:00Z", 2_000_000),
    ]);
    const first = await usageOf("conv-c");
    near(first?.costUsd, 3.0005);
    expect(first).toMatchObject({ tokens: 3_000_000, cacheReadTokens: 500 });

    await file([row("conv:conv-c", "2026-11-10T09:00:00Z", -500_000)]);
    near((await usageOf("conv-c"))?.costUsd, 2.5005);
    expect(await usageOf("conv-c")).toMatchObject({ tokens: 2_500_000 });
  });

  test("the sync's agent count is kept; another conversation is untouched", async () => {
    await t.db.execute(
      conversationUsage.upsertQuery("conv-c", { agentCount: 3 }),
    );
    await file([row("conv:conv-d", "2026-11-10T08:00:00Z", 1_000_000)]);
    expect(await usageOf("conv-c")).toMatchObject({ agentCount: 3 });
    near((await usageOf("conv-c"))?.costUsd, 2.5005);
    near((await usageOf("conv-d"))?.costUsd, 1);
  });

  test("an unpriced model counts its tokens but no cost, until it is priced", async () => {
    await file([
      row("conv:conv-d", "2026-11-10T10:00:00Z", 1_000_000, 0, "m-new"),
    ]);
    expect(await usageOf("conv-d")).toMatchObject({ tokens: 2_000_000 });
    near((await usageOf("conv-d"))?.costUsd, 1);

    // Its rates land later (a refresh that learned it): the cost follows.
    const [version] = await t.db
      .select({ id: _claudePriceVersions.id })
      .from(_claudePriceVersions);
    await t.db.insert(_claudeModelRates).values({
      versionId: version!.id,
      model: "m-new",
      speed: "standard",
      inputBelow: 2 * PER_TOKEN,
      inputAbove: 2 * PER_TOKEN,
      outputBelow: 0,
      outputAbove: 0,
      cacheReadBelow: 0,
      cacheReadAbove: 0,
      cacheCreate5mBelow: 0,
      cacheCreate5mAbove: 0,
      cacheCreate1hBelow: 0,
      cacheCreate1hAbove: 0,
    });
    near((await usageOf("conv-d"))?.costUsd, 3);
  });

  test("a correction effective from the past re-prices the hours it covers", async () => {
    await t.db.transaction(async (tx) => {
      const id = priceVersionIdKind.mint();
      await tx.insert(_claudePriceVersions).values({
        id,
        effectiveFrom: "2026-11-10T09:00:00.000Z",
        source: "correction",
        models: { "m-a": flat(10 * PER_TOKEN) },
      });
      await tx.insert(_claudeModelRates).values({
        versionId: id,
        model: "m-a",
        speed: "standard",
        inputBelow: 10 * PER_TOKEN,
        inputAbove: 10 * PER_TOKEN,
        outputBelow: 0,
        outputAbove: 0,
        cacheReadBelow: 10 * PER_TOKEN,
        cacheReadAbove: 10 * PER_TOKEN,
        cacheCreate5mBelow: 0,
        cacheCreate5mAbove: 0,
        cacheCreate1hBelow: 0,
        cacheCreate1hAbove: 0,
      });
    });
    // conv-c: 08:00 at the first price (1.0005), 09:00's 1.5M at ×10.
    near((await usageOf("conv-c"))?.costUsd, 1.0005 + 15);
    // conv-d: 08:00 only for m-a (1); m-new has no rate in the correction,
    // so its 10:00 hour is unpriced again.
    near((await usageOf("conv-d"))?.costUsd, 1);
  });

  test("a conversation that no longer exists gets no row", async () => {
    await file([row("conv:conv-gone", "2026-11-10T08:00:00Z", 1_000)]);
    expect(await usageOf("conv-gone")).toBeUndefined();
  });

  test("the repair heals a drifted row and writes nothing when none drifted", async () => {
    await t.db.execute(
      sql`UPDATE conversations_ext_usage SET cost_usd = 42 WHERE parent_id = 'conv-c'`,
    );
    near((await usageOf("conv-c"))?.costUsd, 42);
    await reconcileUsageCosts(t.db);
    near((await usageOf("conv-c"))?.costUsd, 1.0005 + 15);
    const before = await t.db.execute<{ xmin: string }>(
      sql`SELECT xmin::text FROM conversations_ext_usage ORDER BY parent_id`,
    );
    await reconcileUsageCosts(t.db);
    const after = await t.db.execute<{ xmin: string }>(
      sql`SELECT xmin::text FROM conversations_ext_usage ORDER BY parent_id`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});
