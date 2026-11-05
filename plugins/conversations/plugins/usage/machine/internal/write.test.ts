/**
 * `writeUsage` against a real Postgres (db-test-fixture, the real migration
 * chain, the usage extension's derived-`updatedAt` trigger): the one-statement
 * write must run, land both tables, and keep the trigger's effect — a CTE is a
 * shape a fake `db` cannot judge (drizzle parenthesising an embedded builder
 * renders a syntax error only Postgres reports).
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import { installDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import {
  _attempts,
  _conversations,
  _tasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import type { FilePricing, FileScan, UsageTotals } from "./scan";
import { writeUsage } from "./write";
import {
  _conversationUsageExt,
  _conversationUsageFiles,
} from "../../server/internal/tables";

// The real migration chain on a fresh database, under a loaded host.
setDefaultTimeout(120_000);

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "usage_write_test" });
  await runMigrations(t.db);
  const spec = registeredDerivedUpdatedAt().filter(
    (s) => s.table === "conversations_ext_usage",
  );
  expect(spec).toHaveLength(1);
  await installDbTriggers(
    t.db,
    spec.map((s) => s.triggerSet),
  );
  await t.db.insert(_tasks).values({
    id: "task-w",
    clusterId: "task-w",
    title: "usage write",
    titleAuto: false,
    rank: "a0",
    mandateRef: "interactive",
  } as typeof _tasks.$inferInsert);
  await t.db.insert(_attempts).values({
    id: "att-w",
    taskId: "task-w",
    worktreePath: "/tmp/usage-write",
  } as typeof _attempts.$inferInsert);
  await t.db.insert(_conversations).values({
    id: "conv-w",
    attemptId: "att-w",
    title: null,
    status: "working",
    runtime: "sdk",
    model: FALLBACK_MODEL,
    kind: "user",
  } as typeof _conversations.$inferInsert);
});

afterAll(async () => {
  await t.drop();
});

const tiers = (below: number) => ({ below, above: 0 });
function fileRow(
  path: string,
  offset: number,
  costUsd: number,
): FileScan & FilePricing {
  return {
    path,
    kind: "session",
    offset,
    buckets: [
      {
        date: "2026-11-04",
        model: "test-model",
        speed: "standard",
        input: tiers(offset),
        output: tiers(1),
        cacheRead: tiers(2),
        cacheCreate5m: tiers(0),
        cacheCreate1h: tiers(0),
      },
    ],
    tailHashes: [{ hash: `h${offset}`, bucket: "b", output: 1 }],
    costUsd,
    unpricedModels: [],
  };
}
const totals = (costUsd: number, tokens: number): UsageTotals => ({
  costUsd,
  tokens,
  cacheReadTokens: 2,
  agentCount: 0,
});

const filesOf = () =>
  t.db
    .select()
    .from(_conversationUsageFiles)
    .where(eq(_conversationUsageFiles.conversationId, "conv-w"));
async function usageOf() {
  const [row] = await t.db
    .select()
    .from(_conversationUsageExt)
    .where(eq(_conversationUsageExt.conversationId, "conv-w"));
  return row;
}

describe("writeUsage", () => {
  test("files and totals land in one statement, then update in place", async () => {
    await writeUsage(
      t.db,
      "conv-w",
      [fileRow("/a.jsonl", 10, 0.5)],
      totals(0.5, 13),
    );
    expect(await filesOf()).toMatchObject([
      { path: "/a.jsonl", offset: 10, costUsd: 0.5 },
    ]);
    const first = await usageOf();
    expect(first).toMatchObject({ costUsd: 0.5, tokens: 13 });

    // Both arms take their conflict branch; the totals' derived updatedAt
    // trigger still fires inside the CTE.
    await writeUsage(
      t.db,
      "conv-w",
      [fileRow("/a.jsonl", 20, 0.9)],
      totals(0.9, 23),
    );
    const files = await filesOf();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      offset: 20,
      costUsd: 0.9,
      tailHashes: [{ hash: "h20", bucket: "b", output: 1 }],
    });
    const second = await usageOf();
    expect(second).toMatchObject({ costUsd: 0.9, tokens: 23 });
    expect(second?.updatedAt.getTime()).toBeGreaterThan(
      first?.updatedAt.getTime() ?? Infinity,
    );
  });

  test("files alone leave the totals untouched; totals alone leave the files", async () => {
    const before = await usageOf();
    await writeUsage(t.db, "conv-w", [fileRow("/b.jsonl", 5, 0.1)], null);
    expect((await filesOf()).map((f) => f.path).sort()).toEqual([
      "/a.jsonl",
      "/b.jsonl",
    ]);
    expect(await usageOf()).toEqual(before);

    await writeUsage(t.db, "conv-w", [], totals(1, 31));
    expect(await usageOf()).toMatchObject({ costUsd: 1, tokens: 31 });
    expect(await filesOf()).toHaveLength(2);
  });
});
