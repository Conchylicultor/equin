/**
 * The account month read over the real priced ledger (db-test-fixture, the
 * real migration chain, `claude_spend_hours_v`): the account's priced hours
 * summed per UTC day, every source, plus its carried-over legacy days — and
 * only the asked account and month. An unpriced hour adds nothing.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { writeAtomically } from "@plugins/database/server";
import { usageLedgerUpsert } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import type { SpendSource } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { recordPriceVersion } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { installSpendHoursView } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server/testing";
import { accountSpendDays } from "./served";
import { _claudeAccountSpendCarryover } from "./tables";

setDefaultTimeout(120_000);

let t: TestDb;

const none = { below: 0, above: 0 };
/** `dollars` worth of input at $1 per million tokens. */
const use = (
  accountId: string,
  hour: string,
  source: SpendSource,
  dollars: number,
  model = "m-a",
) => ({
  accountId,
  hour: new Date(hour),
  source,
  model,
  speed: "standard" as const,
  tokens: {
    input: { below: dollars * 1e6, above: 0 },
    output: none,
    cacheRead: none,
    cacheCreate5m: none,
    cacheCreate1h: none,
  },
});

beforeAll(async () => {
  t = await createTestDb({ prefix: "usage_account_spend_test" });
  await runMigrations(t.db);
  await installSpendHoursView(t.db);
  await writeAtomically(t.db, [
    usageLedgerUpsert(t.db, [
      use("max", "2026-11-03T09:00:00Z", "conv:conv-a", 1),
      use("max", "2026-11-03T23:00:00Z", "cli:task-title", 0.5),
      use("max", "2026-11-04T00:00:00Z", "conv:conv-a", 2),
      // An unpriced model: its tokens add nothing.
      use("max", "2026-11-04T01:00:00Z", "conv:conv-a", 64, "m-unknown"),
      // Another month, another account: not in the read.
      use("max", "2026-10-31T23:00:00Z", "conv:conv-a", 8),
      use("max", "2026-12-01T00:00:00Z", "conv:conv-a", 16),
      use("api", "2026-11-03T09:00:00Z", "conv:conv-b", 32),
    ]),
  ]);
  // Recorded after the ledger rows, so it prices every model they name.
  await recordPriceVersion(
    t.db,
    {
      fetchedAt: 0,
      models: {
        "m-a": {
          input: 1e-6,
          output: 1e-6,
          cacheCreate5m: 1e-6,
          cacheCreate1h: 1e-6,
          cacheRead: 1e-6,
        },
      },
    },
    "fallback",
  );
  await t.db.insert(_claudeAccountSpendCarryover).values([
    // The legacy unattributed history, carried over in dollars.
    { accountId: "max", day: "2026-11-02", costUsd: 4 },
    { accountId: "max", day: "2026-11-03", costUsd: 0.25 },
    { accountId: "max", day: "2026-10-30", costUsd: 100 },
    { accountId: "api", day: "2026-11-02", costUsd: 100 },
  ]);
});

afterAll(async () => {
  await t.drop();
});

const close = (
  days: { date: string; costUsd: number }[],
  want: { date: string; costUsd: number }[],
) => {
  expect(days.map((d) => d.date)).toEqual(want.map((d) => d.date));
  days.forEach((d, i) =>
    expect(Math.abs(d.costUsd - want[i]!.costUsd)).toBeLessThan(1e-9),
  );
};

describe("accountSpendDays", () => {
  test("sums the account's priced hours and carried days per UTC day of the month", async () => {
    close(await accountSpendDays(t.db, "max", "2026-11"), [
      { date: "2026-11-02", costUsd: 4 },
      { date: "2026-11-03", costUsd: 1.75 },
      { date: "2026-11-04", costUsd: 2 },
    ]);
  });

  test("a month with no spend reads no days; a malformed month throws", async () => {
    expect(await accountSpendDays(t.db, "max", "2026-09")).toEqual([]);
    expect(accountSpendDays(t.db, "max", "Nov")).rejects.toThrow(/not a month/);
  });
});
