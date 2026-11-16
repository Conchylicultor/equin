/**
 * The one pricing function, `claude_spend_hours_v`, against a real Postgres:
 * an hour is priced with the newest version in force at it (a version boundary
 * inside one day), a past correction re-prices exactly the hours it covers, a
 * model with no rate reads NULL (never 0), and tiered rates price each half of
 * the split at its own rate. Also the version recorder: the first version is
 * effective from -infinity, an unchanged table records nothing, a changed one
 * is effective from now, and a model first seen is priced in every version.
 *
 * Run: `./equin test plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing`
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { compileCreateView } from "@plugins/database/plugins/derived-views/core";
import { writeAtomically } from "@plugins/database/server";
import {
  usageLedgerUpsert,
  type UsageLedgerRow,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import type {
  SpendSource,
  UsageTokens,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import {
  priceVersionIdKind,
  type ModelPrice,
  type PriceTable,
} from "../../core";
import { _claudeModelRates, _claudePriceVersions } from "./tables";
import { ensureModelRates, ratesOf, recordPriceVersion } from "./versions";
import { claudeSpendHoursView } from "./views";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "claude_pricing_test" });
  await runMigrations(t.db);
  await t.db.execute(
    sql.raw(
      compileCreateView({
        name: "claude_spend_hours_v",
        view: claudeSpendHoursView,
        dependsOn: [],
      }),
    ),
  );
});

afterAll(async () => {
  await t.drop();
});

const flat = (input: number, output = input * 5): ModelPrice => ({
  input,
  output,
  cacheCreate5m: input,
  cacheCreate1h: input,
  cacheRead: input,
});
const table = (models: Record<string, ModelPrice>): PriceTable => ({
  fetchedAt: 0,
  models,
});

const none = { below: 0, above: 0 };
const tokens = (over: Partial<UsageTokens>): UsageTokens => ({
  input: none,
  output: none,
  cacheRead: none,
  cacheCreate5m: none,
  cacheCreate1h: none,
  ...over,
});

const use = (
  hour: string,
  model: string,
  counts: Partial<UsageTokens>,
  source: SpendSource,
) =>
  writeAtomically(t.db, [
    usageLedgerUpsert(t.db, [
      {
        accountId: "max",
        hour: new Date(hour),
        source,
        model,
        speed: "standard",
        tokens: tokens(counts),
      } satisfies UsageLedgerRow,
    ]),
  ]);

const costs = (source: string) =>
  t.db
    .select({
      hour: claudeSpendHoursView.hour,
      model: claudeSpendHoursView.model,
      costUsd: claudeSpendHoursView.costUsd,
    })
    .from(claudeSpendHoursView)
    .where(eq(claudeSpendHoursView.source, source))
    .orderBy(asc(claudeSpendHoursView.hour), asc(claudeSpendHoursView.model));

const versions = () =>
  t.db
    .select({
      effectiveFrom: _claudePriceVersions.effectiveFrom,
      source: _claudePriceVersions.source,
    })
    .from(_claudePriceVersions)
    .orderBy(asc(_claudePriceVersions.effectiveFrom));

const close = (a: number | null | undefined, b: number) =>
  expect(Math.abs((a ?? Number.NaN) - b)).toBeLessThan(1e-12);

describe("recordPriceVersion and the priced view", () => {
  test("an hour with no version in force is unpriced", async () => {
    await use(
      "2026-11-10T08:00:00Z",
      "m-a",
      { input: { below: 1_000, above: 0 } },
      "conv:early",
    );
    expect(await costs("conv:early")).toEqual([
      { hour: new Date("2026-11-10T08:00:00Z"), model: "m-a", costUsd: null },
    ]);
  });

  test("the first version is effective from -infinity and prices what the ledger already holds", async () => {
    const first = await recordPriceVersion(
      t.db,
      table({ "m-a": flat(1e-6) }),
      "fallback",
      new Date("2026-11-12T00:00:00Z"),
    );
    expect(first.kind).toBe("recorded");
    expect(await versions()).toEqual([
      { effectiveFrom: "-infinity", source: "fallback" },
    ]);
    const [early] = await costs("conv:early");
    close(early?.costUsd, 1_000 * 1e-6);
  });

  test("an unchanged table records no version", async () => {
    const again = await recordPriceVersion(
      t.db,
      table({ "m-a": flat(1e-6) }),
      "litellm",
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(again.kind).toBe("unchanged");
    expect(await versions()).toHaveLength(1);
  });

  test("a version boundary inside a day: earlier hours keep their price", async () => {
    await use(
      "2026-11-15T09:00:00Z",
      "m-a",
      { input: { below: 1_000, above: 0 } },
      "conv:day",
    );
    await use(
      "2026-11-15T11:00:00Z",
      "m-a",
      { input: { below: 1_000, above: 0 } },
      "conv:day",
    );
    const changed = await recordPriceVersion(
      t.db,
      table({ "m-a": flat(3e-6) }),
      "litellm",
      new Date("2026-11-15T10:00:00Z"),
    );
    expect(changed.kind).toBe("recorded");
    const [before, after] = await costs("conv:day");
    close(before?.costUsd, 1_000 * 1e-6);
    close(after?.costUsd, 1_000 * 3e-6);
  });

  test("a model with no rate reads NULL, never 0 — then is priced once the table knows it", async () => {
    await use(
      "2026-11-15T12:00:00Z",
      "m-unknown",
      { output: { below: 10, above: 0 } },
      "conv:unk",
    );
    await ensureModelRates(t.db, ["m-unknown"]);
    expect(await costs("conv:unk")).toEqual([
      {
        hour: new Date("2026-11-15T12:00:00Z"),
        model: "m-unknown",
        costUsd: null,
      },
    ]);
    await recordPriceVersion(
      t.db,
      table({ "m-a": flat(3e-6), "m-unknown": flat(1e-6, 2e-6) }),
      "litellm",
      new Date("2026-11-15T11:30:00Z"),
    );
    const [priced] = await costs("conv:unk");
    close(priced?.costUsd, 10 * 2e-6);
  });

  test("a model first seen is priced in every version, against that version's own table", async () => {
    // `m-a-2026` resolves to `m-a` by substring in every version.
    await use(
      "2026-11-11T00:00:00Z",
      "m-a-2026",
      { input: { below: 100, above: 0 } },
      "conv:new",
    );
    await use(
      "2026-11-15T13:00:00Z",
      "m-a-2026",
      { input: { below: 100, above: 0 } },
      "conv:new",
    );
    await ensureModelRates(t.db, ["m-a-2026"]);
    const [old, recent] = await costs("conv:new");
    close(old?.costUsd, 100 * 1e-6);
    close(recent?.costUsd, 100 * 3e-6);
  });

  test("a past correction re-prices exactly the hours it covers", async () => {
    // Corrects m-a from the 15th 09:00 on: the 09:00 hour moves; 11:00 stays
    // with the newer refreshed version, which is in force after it.
    const id = priceVersionIdKind.mint();
    await t.db.insert(_claudePriceVersions).values({
      id,
      effectiveFrom: "2026-11-15T09:00:00Z",
      source: "correction",
      models: { "m-a": flat(2e-6) },
    });
    await t.db
      .insert(_claudeModelRates)
      .values(ratesOf(id, "m-a", "standard", flat(2e-6)));
    const [before, after] = await costs("conv:day");
    close(before?.costUsd, 1_000 * 2e-6);
    close(after?.costUsd, 1_000 * 3e-6);
    const [early] = await costs("conv:early");
    close(early?.costUsd, 1_000 * 1e-6);
  });

  test("tiered rates price each half of the split at its own rate; untiered ones at the base", async () => {
    const tiered: ModelPrice = {
      ...flat(1e-6),
      inputAbove200k: 4e-6,
      cacheCreate1hAbove200k: 8e-6,
    };
    await recordPriceVersion(
      t.db,
      table({
        "m-a": flat(3e-6),
        "m-unknown": flat(1e-6, 2e-6),
        "m-tier": tiered,
      }),
      "litellm",
      new Date("2026-11-16T00:00:00Z"),
    );
    await use(
      "2026-11-16T01:00:00Z",
      "m-tier",
      {
        input: { below: 200_000, above: 50_000 },
        output: { below: 10, above: 20 },
        cacheCreate1h: { below: 1, above: 2 },
      },
      "conv:tier",
    );
    await ensureModelRates(t.db, ["m-tier"]);
    const [row] = await costs("conv:tier");
    close(
      row?.costUsd,
      200_000 * 1e-6 + 50_000 * 4e-6 + 30 * 5e-6 + 1 * 1e-6 + 2 * 8e-6,
    );
  });

  test("fast rows carry the version's fast multiplier", () => {
    const rates = ratesOf(priceVersionIdKind.mint(), "m", "fast", {
      ...flat(1e-6),
      fastMultiplier: 6,
    });
    close(rates.inputBelow, 6e-6);
    close(rates.inputAbove, 6e-6);
  });
});
