/**
 * The Stats → Cost answers over the real priced ledger (db-test-fixture, the
 * real migration chain, `claude_spend_hours_v`): per UTC day and model, per
 * session (a `conv:` / `session:` source — `cli:` spend counts per day only),
 * the repo scope read off `claude_usage_sources`, an unpriced hour's tokens
 * counted with no dollars — read from the trigger-kept rollups, which a price
 * correction and a repo flag re-aggregate and the repair rebuilds equal.
 *
 * Run: `./equin test plugins/stats/plugins/cost`
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { writeAtomically } from "@plugins/database/server";
import {
  usageLedgerUpsert,
  usageSourcesUpsert,
  type UsageLedgerRow,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import type { SpendSource } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import {
  _claudeModelRates,
  _claudePriceVersions,
  recordPriceVersion,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { priceVersionIdKind } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/core";
import { installSpendHoursView } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server/testing";
import { installDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import {
  dailyAnswer,
  distributionAnswer,
  sessionsDailyAnswer,
  topSessionsAnswer,
} from "./answers";
import { costRollupTriggers, reconcileCostRollups } from "./rollups";

setDefaultTimeout(120_000);

let t: TestDb;

const FLAT = {
  input: 1e-6,
  output: 1e-6,
  cacheCreate5m: 1e-6,
  cacheCreate1h: 1e-6,
  cacheRead: 1e-6,
};

const none = { below: 0, above: 0 };
/** `input` tokens and `cacheRead` tokens of `model` at `hour`. */
const use = (
  source: SpendSource,
  hour: string,
  input: number,
  model = "m-a",
  cacheRead = 0,
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

beforeAll(async () => {
  t = await createTestDb({ prefix: "stats_cost_answers_test" });
  await runMigrations(t.db);
  await installSpendHoursView(t.db);
  await installDbTriggers(t.db, [costRollupTriggers]);
  await writeAtomically(t.db, [
    usageLedgerUpsert(t.db, [
      // A repo conversation over two days, two models.
      use("conv:conv-a", "2026-11-10T08:00:00Z", 1_000_000, "m-a", 500),
      use("conv:conv-a", "2026-11-11T09:00:00Z", 2_000_000, "m-b"),
      // A session equin did not launch, outside the repo.
      use("session:s-b", "2026-11-10T10:00:00Z", 4_000_000),
      // A background call: repo spend, never a session.
      use("cli:task-title", "2026-11-10T11:00:00Z", 8_000_000),
      // An unpriced model in a repo session: tokens, no dollars.
      use("session:s-c", "2026-11-11T12:00:00Z", 16_000_000, "m-unknown"),
    ]),
    usageSourcesUpsert(t.db, [
      { source: "conv:conv-a", projectDir: "-r", isRepo: true, title: null },
      { source: "session:s-b", projectDir: "-o", isRepo: false, title: "B" },
      { source: "cli:task-title", projectDir: null, isRepo: true, title: null },
      { source: "session:s-c", projectDir: "-r", isRepo: true, title: "C" },
    ]),
  ]);
  await recordPriceVersion(
    t.db,
    {
      fetchedAt: 0,
      models: { "m-a": FLAT, "m-b": FLAT },
    },
    "fallback",
  );
});

afterAll(async () => {
  await t.drop();
});

describe("Stats → Cost over the priced ledger", () => {
  test("daily: cost by model and tokens per UTC day; sessions exclude cli:", async () => {
    const all = await dailyAnswer(t.db, "all");
    expect(all.days.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-11"]);
    expect(all.sessionCount).toBe(3);
    expect(all.truncated).toBe(false);
    const [d10, d11] = all.days;
    expect(d10).toMatchObject({ input: 13_000_000, cacheRead: 500 });
    expect(d10!.cost).toBeCloseTo(13.0005, 9);
    expect(d11).toMatchObject({ input: 18_000_000 });
    expect(d11!.cost).toBeCloseTo(2, 9);
    expect(all.models).toContain("m-unknown");
    expect(d11!.byModel["m-unknown"]).toBe(0);

    const repo = await dailyAnswer(t.db, "repo");
    expect(repo.sessionCount).toBe(2);
    expect(repo.days[0]!.cost).toBeCloseTo(9.0005, 9);
  });

  test("top sessions: dearest first, identity off the source", async () => {
    const { rows } = await topSessionsAnswer(t.db, "all");
    expect(rows.map((r) => r.sessionId)).toEqual(["s-b", "conv-a", "s-c"]);
    expect(rows[1]).toMatchObject({
      conversationId: "conv-a",
      title: null,
      totalCost: 3,
      inputTokens: 3_000_000,
      cacheReadTokens: 500,
      lastActivity: "2026-11-11",
    });
    expect(rows[2]).toMatchObject({
      conversationId: null,
      title: "C",
      totalCost: 0,
    });
  });

  test("sessions per day and the distribution count sessions, not calls", async () => {
    const daily = await sessionsDailyAnswer(t.db, "repo");
    expect(daily.days.map((d) => [d.date, d.sessionCount])).toEqual([
      ["2026-11-11", 2],
    ]);
    const { buckets } = await distributionAnswer(t.db, "all");
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(3);
  });

  test("the triggers keep the rollups equal to their repair", async () => {
    const before = await Promise.all([
      dailyAnswer(t.db, "all"),
      topSessionsAnswer(t.db, "all"),
    ]);
    await t.db.execute(sql`TRUNCATE claude_spend_days, claude_spend_sources`);
    expect((await dailyAnswer(t.db, "all")).days).toEqual([]);
    await reconcileCostRollups(t.db);
    expect(
      await Promise.all([
        dailyAnswer(t.db, "all"),
        topSessionsAnswer(t.db, "all"),
      ]),
    ).toEqual(before);
  });

  test("a price correction re-prices the rollups; a repo flag moves its days", async () => {
    // A correction from 2026-11-11 that prices the unknown model too.
    const id = priceVersionIdKind.mint();
    await t.db.insert(_claudePriceVersions).values({
      id,
      effectiveFrom: "2026-11-11T00:00:00Z",
      source: "correction",
      models: { "m-a": FLAT, "m-b": FLAT, "m-unknown": FLAT },
    });
    const rate = (model: string) => ({
      versionId: id,
      model,
      speed: "standard" as const,
      inputBelow: 1e-6,
      inputAbove: 1e-6,
      outputBelow: 1e-6,
      outputAbove: 1e-6,
      cacheReadBelow: 1e-6,
      cacheReadAbove: 1e-6,
      cacheCreate5mBelow: 1e-6,
      cacheCreate5mAbove: 1e-6,
      cacheCreate1hBelow: 1e-6,
      cacheCreate1hAbove: 1e-6,
    });
    await t.db
      .insert(_claudeModelRates)
      .values([rate("m-a"), rate("m-b"), rate("m-unknown")]);
    const all = await dailyAnswer(t.db, "all");
    // The unknown model, priced from the 11th: 16M tokens at $1/M.
    expect(all.days[1]!.cost).toBeCloseTo(2 + 16, 9);
    expect(all.days[0]!.cost).toBeCloseTo(13.0005, 9);

    // session:s-b becomes the repo's: its day joins the repo scope.
    await writeAtomically(t.db, [
      usageSourcesUpsert(t.db, [
        { source: "session:s-b", projectDir: "-o", isRepo: true, title: "B" },
      ]),
    ]);
    const repo = await dailyAnswer(t.db, "repo");
    expect(repo.days[0]!.cost).toBeCloseTo(13.0005, 9);
    expect(repo.sessionCount).toBe(3);
  });
});
