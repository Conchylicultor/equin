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
import { asc, eq } from "drizzle-orm";
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
import type { FileScan } from "./scan";
import { writeUsage } from "./write";
import { _claudeUsageHours } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
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
    authorKind: "human",
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
    launchCause: "direct",
  } as typeof _conversations.$inferInsert);
});

afterAll(async () => {
  await t.drop();
});

const tiers = (below: number) => ({ below, above: 0 });
function fileRow(path: string, offset: number): FileScan {
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
  };
}
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
  test("files and the agent count land in one statement, then update in place", async () => {
    await writeUsage(t.db, "conv-w", [fileRow("/a.jsonl", 10)], 1);
    expect(await filesOf()).toMatchObject([{ path: "/a.jsonl", offset: 10 }]);
    const first = await usageOf();
    expect(first).toMatchObject({ agentCount: 1, costUsd: 0, tokens: 0 });

    // Both arms take their conflict branch; the totals' derived updatedAt
    // trigger still fires inside the CTE.
    await writeUsage(t.db, "conv-w", [fileRow("/a.jsonl", 20)], 2);
    const files = await filesOf();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      offset: 20,
      tailHashes: [{ hash: "h20", bucket: "b", output: 1 }],
    });
    const second = await usageOf();
    expect(second).toMatchObject({ agentCount: 2, costUsd: 0, tokens: 0 });
    expect(second?.updatedAt.getTime()).toBeGreaterThan(
      first?.updatedAt.getTime() ?? Infinity,
    );
  });

  test("files alone leave the totals untouched; totals alone leave the files", async () => {
    const before = await usageOf();
    await writeUsage(t.db, "conv-w", [fileRow("/b.jsonl", 5)], null);
    expect((await filesOf()).map((f) => f.path).sort()).toEqual([
      "/a.jsonl",
      "/b.jsonl",
    ]);
    expect(await usageOf()).toEqual(before);

    await writeUsage(t.db, "conv-w", [], 3);
    expect(await usageOf()).toMatchObject({ agentCount: 3 });
    expect(await filesOf()).toHaveLength(2);
  });

  test("tokens add to each account's hour under the conversation's source, in the same statement as the files", async () => {
    const ledgerOf = () =>
      t.db
        .select({
          accountId: _claudeUsageHours.accountId,
          hour: _claudeUsageHours.hour,
          source: _claudeUsageHours.source,
          input: _claudeUsageHours.inputBelow,
        })
        .from(_claudeUsageHours)
        .orderBy(asc(_claudeUsageHours.accountId), asc(_claudeUsageHours.hour));
    const h = (iso: string) => new Date(iso);
    const row = (accountId: string, hour: string, input: number) => ({
      accountId,
      hour: h(hour),
      model: "test-model",
      speed: "standard" as const,
      tokens: {
        input: tiers(input),
        output: tiers(0),
        cacheRead: tiers(0),
        cacheCreate5m: tiers(0),
        cacheCreate1h: tiers(0),
      },
    });
    await writeUsage(t.db, "conv-w", [fileRow("/c.jsonl", 7)], 4, [
      row("api", "2026-11-04T10:00:00Z", 25),
      row("max", "2026-11-04T10:00:00Z", 100),
    ]);
    // A later pass adds to the hour it already holds, and starts the next.
    await writeUsage(t.db, "conv-w", [fileRow("/c.jsonl", 9)], null, [
      row("api", "2026-11-04T10:00:00Z", 50),
      row("api", "2026-11-04T11:00:00Z", 200),
    ]);
    expect(await ledgerOf()).toEqual([
      {
        accountId: "api",
        hour: h("2026-11-04T10:00:00Z"),
        source: "conv:conv-w",
        input: 75,
      },
      {
        accountId: "api",
        hour: h("2026-11-04T11:00:00Z"),
        source: "conv:conv-w",
        input: 200,
      },
      {
        accountId: "max",
        hour: h("2026-11-04T10:00:00Z"),
        source: "conv:conv-w",
        input: 100,
      },
    ]);
    expect(await usageOf()).toMatchObject({ agentCount: 4 });
  });

  test("a failed write files no tokens", async () => {
    const before = await t.db.select().from(_claudeUsageHours);
    // The conversation does not exist: the file rows' FK fails the statement.
    expect(
      writeUsage(t.db, "conv-missing", [fileRow("/x.jsonl", 1)], null, [
        {
          accountId: "api",
          hour: new Date("2026-11-04T12:00:00Z"),
          model: "test-model",
          speed: "standard",
          tokens: {
            input: tiers(1),
            output: tiers(0),
            cacheRead: tiers(0),
            cacheCreate5m: tiers(0),
            cacheCreate1h: tiers(0),
          },
        },
      ]),
    ).rejects.toThrow();
    expect(await t.db.select().from(_claudeUsageHours)).toEqual(before);
  });

  test("a row under an old spelling moves to the new path in the same statement", async () => {
    await writeUsage(t.db, "conv-w", [fileRow("/old/c.jsonl", 7)], null);
    await writeUsage(
      t.db,
      "conv-w",
      [fileRow("/new/c.jsonl", 7)],
      null,
      [],
      null,
      [],
      ["/old/c.jsonl"],
    );
    const paths = (await filesOf()).map((f) => f.path);
    expect(paths).toContain("/new/c.jsonl");
    expect(paths).not.toContain("/old/c.jsonl");
  });
});
