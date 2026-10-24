/**
 * Real-DB suite for the session chain: the ON CONFLICT append guard, the tail
 * no-op, and the oldest→newest ordering all live in SQL, so a fake `db` would
 * prove nothing. Drives the db-parametrized functions against a throwaway
 * Postgres (db-test-fixture) seeded with the REAL migration chain.
 *
 * Run: `bun test plugins/conversations/plugins/session-chain/server/internal`
 * (requires the running embedded cluster — `./equin build` first).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import {
  recordSessionId,
  listSessionChain,
  listSharedClaudeSessionIds,
} from "./record";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "sc_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`DELETE FROM conversation_sessions`);
});

const ids = async (conversationId: string): Promise<string[]> =>
  (await listSessionChain(conversationId, t.db)).map((e) => e.claudeSessionId);

async function countRows(): Promise<number> {
  const res = await t.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM conversation_sessions`,
  );
  return res.rows[0]?.n ?? 0;
}

describe("recordSessionId", () => {
  test("the first call seeds the chain", async () => {
    await recordSessionId("conv-a", "sid-1", t.db);

    expect(await ids("conv-a")).toEqual(["sid-1"]);
  });

  test("repeating the tail id is a no-op — still one row", async () => {
    await recordSessionId("conv-a", "sid-1", t.db);
    await recordSessionId("conv-a", "sid-1", t.db);
    await recordSessionId("conv-a", "sid-1", t.db);

    expect(await ids("conv-a")).toEqual(["sid-1"]);
    expect(await countRows()).toBe(1);
  });

  test("a genuinely new id appends", async () => {
    await recordSessionId("conv-a", "sid-1", t.db);
    await recordSessionId("conv-a", "sid-2", t.db);

    expect(await ids("conv-a")).toEqual(["sid-1", "sid-2"]);
  });

  test("a session that flaps back is not re-appended (unique guard)", async () => {
    await recordSessionId("conv-a", "sid-1", t.db);
    await recordSessionId("conv-a", "sid-2", t.db);
    await recordSessionId("conv-a", "sid-1", t.db);

    // `sid-1` stays pinned at its first-seen position — the chain is a set of
    // transcript files in first-seen order, never a repeating trail.
    expect(await ids("conv-a")).toEqual(["sid-1", "sid-2"]);
    expect(await countRows()).toBe(2);
  });

  test("concurrent ticks observing the same new id append exactly one row", async () => {
    await Promise.all([
      recordSessionId("conv-a", "sid-1", t.db),
      recordSessionId("conv-a", "sid-1", t.db),
      recordSessionId("conv-a", "sid-1", t.db),
    ]);

    expect(await ids("conv-a")).toEqual(["sid-1"]);
    expect(await countRows()).toBe(1);
  });
});

describe("listSessionChain", () => {
  test("returns entries oldest → newest, with seenAt stamps", async () => {
    await recordSessionId("conv-a", "sid-1", t.db);
    await recordSessionId("conv-a", "sid-2", t.db);
    await recordSessionId("conv-a", "sid-3", t.db);

    const chain = await listSessionChain("conv-a", t.db);
    expect(chain.map((e) => e.claudeSessionId)).toEqual([
      "sid-1",
      "sid-2",
      "sid-3",
    ]);
    for (const entry of chain) expect(entry.seenAt).toBeInstanceOf(Date);
    expect(chain[0]!.seenAt.getTime()).toBeLessThanOrEqual(
      chain[2]!.seenAt.getTime(),
    );
  });

  test("a conversation with no observed session has an empty chain", async () => {
    expect(await listSessionChain("conv-unknown", t.db)).toEqual([]);
  });

  test("two conversations keep independent chains", async () => {
    await recordSessionId("conv-a", "sid-1", t.db);
    await recordSessionId("conv-b", "sid-2", t.db);
    await recordSessionId("conv-a", "sid-3", t.db);

    expect(await ids("conv-a")).toEqual(["sid-1", "sid-3"]);
    expect(await ids("conv-b")).toEqual(["sid-2"]);
  });

  test("the same session id may appear in two different conversations", async () => {
    await recordSessionId("conv-a", "sid-shared", t.db);
    await recordSessionId("conv-b", "sid-shared", t.db);

    expect(await ids("conv-a")).toEqual(["sid-shared"]);
    expect(await ids("conv-b")).toEqual(["sid-shared"]);
  });
});

// The table permits the shape above — the UNIQUE index is per conversation, so
// nothing at the DB level stops two chains from claiming one session. That is
// the gap the 2026-08-19 cross-talk incident fell through, and this query is how
// a monitor sees it. GROUP BY / HAVING / array_agg all live in SQL, so like the
// suites above it is exercised against the real database.
describe("listSharedClaudeSessionIds", () => {
  test("a healthy database reports nothing", async () => {
    await recordSessionId("conv-a", "sid-1", t.db);
    await recordSessionId("conv-a", "sid-2", t.db);
    await recordSessionId("conv-b", "sid-3", t.db);

    expect(await listSharedClaudeSessionIds(t.db)).toEqual([]);
  });

  test("names the shared id and every conversation holding it", async () => {
    await recordSessionId("conv-a", "sid-own", t.db);
    await recordSessionId("conv-a", "sid-shared", t.db);
    await recordSessionId("conv-b", "sid-shared", t.db);

    expect(await listSharedClaudeSessionIds(t.db)).toEqual([
      {
        claudeSessionId: "sid-shared",
        conversationIds: ["conv-a", "conv-b"],
      },
    ]);
  });

  test("one conversation recording an id twice is not a share", async () => {
    // The second call is a no-op (the id is already the tail), so there is one
    // row — but the point is the DISTINCT: even two rows for one conversation
    // must not read as two conversations.
    await recordSessionId("conv-a", "sid-1", t.db);
    await recordSessionId("conv-a", "sid-1", t.db);

    expect(await listSharedClaudeSessionIds(t.db)).toEqual([]);
  });

  test("a three-way share lists all three, sorted", async () => {
    await recordSessionId("conv-c", "sid-shared", t.db);
    await recordSessionId("conv-a", "sid-shared", t.db);
    await recordSessionId("conv-b", "sid-shared", t.db);

    expect(await listSharedClaudeSessionIds(t.db)).toEqual([
      {
        claudeSessionId: "sid-shared",
        conversationIds: ["conv-a", "conv-b", "conv-c"],
      },
    ]);
  });

  test("several shared ids come back sorted by session id", async () => {
    await recordSessionId("conv-a", "sid-x", t.db);
    await recordSessionId("conv-b", "sid-x", t.db);
    await recordSessionId("conv-a", "sid-b", t.db);
    await recordSessionId("conv-c", "sid-b", t.db);

    expect(
      (await listSharedClaudeSessionIds(t.db)).map((r) => r.claudeSessionId),
    ).toEqual(["sid-b", "sid-x"]);
  });
});
