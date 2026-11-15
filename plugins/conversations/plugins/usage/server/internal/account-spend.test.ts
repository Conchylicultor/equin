/**
 * The account month read over the real spend ledger (db-test-fixture, the
 * real migration chain): hours summed per UTC day, every source — the
 * `unattributed` history migrated from the old day table included — and only
 * the asked account and month.
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
import { _claudeSpendHours } from "@plugins/infra/plugins/claude-cli/plugins/spend-ledger/server";
import { accountSpendDays } from "./served";

setDefaultTimeout(120_000);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "usage_account_spend_test" });
  await runMigrations(t.db);
  const h = (iso: string) => new Date(iso);
  await t.db.insert(_claudeSpendHours).values([
    // Migrated history: a whole day at 00:00 UTC.
    {
      accountId: "max",
      hour: h("2026-11-03T00:00:00Z"),
      source: "unattributed",
      costUsd: 4,
    },
    {
      accountId: "max",
      hour: h("2026-11-03T09:00:00Z"),
      source: "conv:conv-a",
      costUsd: 1,
    },
    {
      accountId: "max",
      hour: h("2026-11-03T23:00:00Z"),
      source: "cli:task-title",
      costUsd: 0.5,
    },
    {
      accountId: "max",
      hour: h("2026-11-04T00:00:00Z"),
      source: "conv:conv-a",
      costUsd: 2,
    },
    // Another month, another account: not in the read.
    {
      accountId: "max",
      hour: h("2026-10-31T23:00:00Z"),
      source: "conv:conv-a",
      costUsd: 8,
    },
    {
      accountId: "max",
      hour: h("2026-12-01T00:00:00Z"),
      source: "conv:conv-a",
      costUsd: 16,
    },
    {
      accountId: "api",
      hour: h("2026-11-03T09:00:00Z"),
      source: "conv:conv-b",
      costUsd: 32,
    },
  ]);
});

afterAll(async () => {
  await t.drop();
});

describe("accountSpendDays", () => {
  test("sums the account's hours per UTC day of the month, every source", async () => {
    expect(await accountSpendDays(t.db, "max", "2026-11")).toEqual([
      { date: "2026-11-03", costUsd: 5.5 },
      { date: "2026-11-04", costUsd: 2 },
    ]);
  });

  test("a month with no spend reads no days; a malformed month throws", async () => {
    expect(await accountSpendDays(t.db, "max", "2026-09")).toEqual([]);
    expect(accountSpendDays(t.db, "max", "Nov")).rejects.toThrow(/not a month/);
  });
});
