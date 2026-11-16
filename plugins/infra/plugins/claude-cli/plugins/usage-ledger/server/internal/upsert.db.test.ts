/**
 * The token ledger's one write against a real Postgres: deltas add up per
 * (account, hour, source, model, speed), a negative delta takes tokens back,
 * rows sharing a key in one call are summed, and malformed rows throw.
 *
 * Run: `./equin test plugins/infra/plugins/claude-cli/plugins/usage-ledger`
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { writeAtomically } from "@plugins/database/server";
import type { UsageTokens } from "../../core";
import { _claudeUsageHours, _claudeUsageSources } from "./tables";
import {
  usageLedgerUpsert,
  usageSourcesUpsert,
  type UsageLedgerRow,
} from "./upsert";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "usage_ledger_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

const tokens = (input: number, outputAbove = 0): UsageTokens => ({
  input: { below: input, above: 0 },
  output: { below: 0, above: outputAbove },
  cacheRead: { below: 0, above: 0 },
  cacheCreate5m: { below: 0, above: 0 },
  cacheCreate1h: { below: 0, above: 0 },
});

const row = (over: Partial<UsageLedgerRow>): UsageLedgerRow => ({
  accountId: "max",
  hour: new Date("2026-11-15T10:00:00Z"),
  source: "conv:conv-1",
  model: "model-a",
  speed: "standard",
  tokens: tokens(0),
  ...over,
});

const write = (rows: UsageLedgerRow[]) =>
  writeAtomically(t.db, [usageLedgerUpsert(t.db, rows)]);

const ledger = () =>
  t.db
    .select({
      model: _claudeUsageHours.model,
      speed: _claudeUsageHours.speed,
      inputBelow: _claudeUsageHours.inputBelow,
      outputAbove: _claudeUsageHours.outputAbove,
    })
    .from(_claudeUsageHours)
    .orderBy(asc(_claudeUsageHours.model), asc(_claudeUsageHours.speed));

describe("usageLedgerUpsert", () => {
  test("adds deltas; a negative delta takes tokens back", async () => {
    await write([row({ tokens: tokens(100, 7) })]);
    await write([row({ tokens: tokens(50) })]);
    await write([row({ tokens: tokens(-30, -2) })]);
    expect(await ledger()).toEqual([
      {
        model: "model-a",
        speed: "standard",
        inputBelow: 120,
        outputAbove: 5,
      },
    ]);
  });

  test("sums rows sharing a key; model and speed are key dimensions", async () => {
    await write([
      row({ model: "model-b", tokens: tokens(10) }),
      row({ model: "model-b", tokens: tokens(5) }),
      row({ model: "model-b", speed: "fast", tokens: tokens(1) }),
    ]);
    expect(await ledger()).toEqual([
      {
        model: "model-a",
        speed: "standard",
        inputBelow: 120,
        outputAbove: 5,
      },
      {
        model: "model-b",
        speed: "fast",
        inputBelow: 1,
        outputAbove: 0,
      },
      {
        model: "model-b",
        speed: "standard",
        inputBelow: 15,
        outputAbove: 0,
      },
    ]);
  });

  test("writes nothing for rows that add nothing", () => {
    expect(usageLedgerUpsert(t.db, [])).toBeNull();
    expect(usageLedgerUpsert(t.db, [row({ tokens: tokens(0) })])).toBeNull();
    // Deltas that cancel out within one call add nothing either.
    expect(
      usageLedgerUpsert(t.db, [
        row({ tokens: tokens(4) }),
        row({ tokens: tokens(-4) }),
      ]),
    ).toBeNull();
  });

  test("refuses an hour off the hour and a fractional count", () => {
    expect(() =>
      usageLedgerUpsert(t.db, [
        row({ hour: new Date("2026-11-15T10:30:00Z"), tokens: tokens(1) }),
      ]),
    ).toThrow(/not on an hour/);
    expect(() =>
      usageLedgerUpsert(t.db, [row({ tokens: tokens(1.5) })]),
    ).toThrow(/non-whole/);
  });
});

describe("usageSourcesUpsert", () => {
  test("merges facts: a known dir or title is never replaced by an unknown one", async () => {
    const write = (
      projectDir: string | null,
      isRepo: boolean,
      title: string | null,
    ) =>
      writeAtomically(t.db, [
        usageSourcesUpsert(t.db, [
          { source: "session:s-1", projectDir, isRepo, title },
        ]),
      ]);
    await write("-Users-x-repo", true, null);
    await write(null, false, "A title");
    expect(await t.db.select().from(_claudeUsageSources)).toEqual([
      {
        source: "session:s-1",
        projectDir: "-Users-x-repo",
        isRepo: true,
        title: "A title",
      },
    ]);
  });
});
