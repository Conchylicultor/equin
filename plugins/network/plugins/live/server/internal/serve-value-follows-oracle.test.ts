/**
 * Runtime oracle for `follows` (research/2026-10-24-global-live-narrowed-reads.md)
 * on a throwaway database through the REAL feed: two collections served by
 * `serveCollection` over one table — a lookup-only `:rows` by id and a scoped
 * `all` set by `attempt_id` — and two values following them through
 * `serveValue`'s `follows`, their reach compiled from the collections' own
 * plans. The change-feed's routed triggers (installed from the routes the
 * plans registered: the follow routes' `match` makes them carry `id` and
 * `attempt_id` as keys), its LISTEN consumer, `routeChange` and the
 * server-core runtime run as in a server.
 *
 * Pinned, per statement — each follower converging on a fresh load:
 *
 * - an unrelated write costs 0 loads: a column no collection reads (the
 *   gate), another attempt's row, another conversation's row (the match);
 * - a related write costs exactly 1 load of the tuple it reaches;
 * - a re-pointed `attempt_id` reaches the old tuple AND the new one (the
 *   feed carries the match column old ∪ new);
 * - under `strictRoutes` (a test runner), a loader reading a followed table by
 *   hand fails; a follower whose loader then reads nothing is judged on its
 *   own empty run, never on the earlier capture.
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { nullable } from "@plugins/fields/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { quotedRelationsIn } from "@plugins/database/server";
import {
  routeChange,
  type FeedChange,
} from "@plugins/database/plugins/change-feed/server";
import {
  createChangeFeedListener,
  rebuildTriggers,
} from "@plugins/database/plugins/change-feed/server/testing";
import {
  notificationsWsHandler,
  routedTableRequirements,
  setRelationBases,
  setWatermarkSource,
} from "@plugins/framework/plugins/server-core/core";
import { clearRelationBases } from "@plugins/framework/plugins/server-core/core/testing";
// Installs the profiler a server boots with: the ambient loader entry every
// loader runs in, and its read-set handed to the runtime's drift guard.
import "@plugins/infra/plugins/runtime-profiler/server";
import { recordReadTables } from "@plugins/infra/plugins/runtime-profiler/core";
import { snapshotWatermark } from "@plugins/database/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { liveCollection, liveValue } from "@plugins/network/plugins/live/core";
import { serveCollection } from "./serve-collection";
import { serveValue } from "./serve-value";

const CONVS = "fol_conversations";
const P = "test.live.follows-oracle";

const convsRef = entityRef(CONVS, {
  id: textField({ label: "Id", filterable: false }),
  attemptId: textField({ label: "Attempt", filterable: false }),
  title: nullable(textField({ label: "Title", filterable: false })),
});
const convsEntity = defineEntity(convsRef, { primaryKey: "id" });
const convs = convsEntity.table;

// Each picks what its follower reads — `title` is no collection's: a write
// of it alone is gated out.
const convById = liveCollection(`${P}.conv`, {
  from: convsRef,
  pick: ["id", "attemptId"],
  baseExposures: false,
  id: "id",
});
const convsOfAttempt = liveCollection(`${P}.convs-of-attempt`, {
  from: convsRef,
  pick: ["id", "attemptId"],
  baseExposures: false,
  id: "id",
  all: {
    by: ["attemptId"],
    orderBy: [["id", "asc"]],
    unbounded: { reason: "one attempt's conversations" },
  },
});

const AttemptOf = z.object({ attemptId: z.string().nullable() });
const Convs = z.object({
  ids: wholeList(z.string(), { reason: "one attempt's conversations" }),
});

let testDb: TestDb;
let client: Client;
let db: NodePgDatabase;
let listener: ReturnType<typeof createChangeFeedListener>;
const routed: FeedChange[] = [];
/** Each follower load, as `<key>/<tuple>`. */
const loads: string[] = [];
const frames: {
  kind: string;
  key?: string;
  params?: Record<string, string>;
  value?: unknown;
}[] = [];
/** Whether the conversation follower's loader also reads the table by hand. */
let byHand = false;

const handler = notificationsWsHandler as unknown as {
  open(ws: unknown): void;
  message(ws: unknown, raw: string): void;
  close(ws: unknown, code: number, reason: string): void;
};
const ws = {
  send(raw: string) {
    const frame = JSON.parse(raw) as (typeof frames)[number];
    if (frame.kind !== "ping") frames.push(frame);
  },
};

const attemptOf = liveValue(`${P}.attempt-of`, {
  schema: AttemptOf,
  params: ["conv"],
});
const convsOf = liveValue(`${P}.convs-of`, {
  schema: Convs,
  params: ["attempt"],
});

async function until(cond: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Wait until the feed delivered a change on CONVS past `from`, then until nothing moves. */
async function settled(from: number): Promise<void> {
  await until(
    () => routed.slice(from).some((c) => c.table === CONVS),
    () => `a change on ${CONVS}`,
  );
  const deadline = Date.now() + 8000;
  for (;;) {
    const at = [loads.length, frames.length];
    await new Promise((r) => setTimeout(r, 150));
    if (loads.length === at[0] && frames.length === at[1]) return;
    if (Date.now() > deadline) throw new Error("the runtime never went quiet");
  }
}

async function subscribe(key: string, params: Record<string, string>) {
  const from = frames.length;
  handler.message(ws, JSON.stringify({ op: "sub", key, params }));
  await until(
    () =>
      frames
        .slice(from)
        .some(
          (f) =>
            (f.kind === "sub-ack" || f.kind === "sub-error") &&
            f.key === key &&
            JSON.stringify(f.params) === JSON.stringify(params),
        ),
    () => `sub-ack ${key} ${JSON.stringify(params)}`,
  );
  return frames
    .slice(from)
    .find(
      (f) =>
        f.key === key && JSON.stringify(f.params) === JSON.stringify(params),
    )!;
}

/** The latest value a tuple was sent. */
function latest(key: string, params: Record<string, string>): unknown {
  const p = JSON.stringify(params);
  return frames
    .filter(
      (f) =>
        f.key === key &&
        JSON.stringify(f.params) === p &&
        (f.kind === "sub-ack" || f.kind === "update"),
    )
    .at(-1)?.value;
}

/** Run one statement; the follower loads it cost. */
async function step(statement: string): Promise<string[]> {
  const at = { loads: loads.length, routed: routed.length };
  await db.execute(sql.raw(statement));
  await settled(at.routed);
  return loads.slice(at.loads).sort();
}

beforeAll(async () => {
  setRelationBases((r) => [r]);
  testDb = await createTestDb({ prefix: "live_follows_oracle" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  // The pool chokepoint's capture, on the fixture's own client: every read
  // clause's quoted relation, attributed to the ambient loader.
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
    ...args: unknown[]
  ) => {
    const text =
      typeof args[0] === "string"
        ? args[0]
        : ((args[0] as { text?: string }).text ?? "");
    recordReadTables(quotedRelationsIn(text));
    return query(...args);
  };
  db = drizzle(client);
  setWatermarkSource(() => snapshotWatermark(db));
  await db.execute(
    sql.raw(
      `CREATE TABLE ${CONVS} (id text PRIMARY KEY, attempt_id text NOT NULL, title text);`,
    ),
  );
  const queryDb = db as unknown as QueryDb;
  const rowsServed = serveCollection(convById, {
    from: convsEntity,
    db: queryDb,
  });
  const scopeServed = serveCollection(convsOfAttempt, {
    from: convsEntity,
    db: queryDb,
  });
  // Follows a conversation's row by id: the attempt it is in.
  serveValue(attemptOf, {
    source: "db",
    follows: (follow) => ({
      conv: follow(rowsServed, ({ conv }) => ({ ids: [conv] })),
    }),
    loader: async ({ conv }, { followed }) => {
      loads.push(`attempt-of/${conv}`);
      if (byHand) await db.execute(sql`SELECT 1 FROM ${convs} LIMIT 1`);
      return { attemptId: followed.conv[0]?.attemptId ?? null };
    },
  });
  // Follows an attempt's conversations by scope.
  serveValue(convsOf, {
    source: "db",
    follows: (follow) => ({
      convs: follow(scopeServed, ({ attempt }) => ({
        where: { attemptId: attempt },
      })),
    }),
    loader: ({ attempt }, { followed }) => {
      loads.push(`convs-of/${attempt}`);
      return { ids: followed.convs.map((c) => c.id) };
    },
  });
  await rebuildTriggers(
    testDb.db,
    { feedExempt: new Set(), optedOut: new Set(), produced: new Set() },
    routedTableRequirements(),
  );
  listener = createChangeFeedListener({
    connectionString: () => testDb.connectionString,
    route: (change) => {
      routed.push(change);
      routeChange(change);
    },
    coveredTables: () => [CONVS],
    livenessIntervalMs: 60_000,
  });
  listener.start();
  const deadline = Date.now() + 8000;
  for (;;) {
    const res = await testDb.db.execute(
      sql`SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND query LIKE 'LISTEN live_state%'
            AND pid <> pg_backend_pid()`,
    );
    if (res.rows.length > 0) break;
    if (Date.now() > deadline) throw new Error("timed out waiting for LISTEN");
    await new Promise((r) => setTimeout(r, 20));
  }
  handler.open(ws);
}, 30_000);

afterAll(async () => {
  clearRelationBases();
  setWatermarkSource(null);
  handler.close(ws, 1000, "test");
  await listener?.stop();
  await client?.end();
  await testDb?.drop();
});

describe("follows — runtime oracle over the real feed", () => {
  test("the trigger carries the follow routes' match columns", () => {
    const req = routedTableRequirements().find((r) => r.table === CONVS);
    expect(req?.carry).toEqual(["attempt_id", "id"]);
  });

  test("unrelated writes cost 0 loads, related ones 1, a re-point reaches both tuples", async () => {
    const seed = routed.length;
    await db.execute(
      sql.raw(`INSERT INTO ${CONVS} VALUES ('c1', 'a1', 't'), ('c2', 'a1', 't'),
                                           ('c3', 'a2', 't'), ('c9', 'a9', 't')`),
    );
    await settled(seed);
    await subscribe(attemptOf.key, { conv: "c1" });
    await subscribe(convsOf.key, { attempt: "a1" });
    await subscribe(convsOf.key, { attempt: "a2" });
    expect(latest(attemptOf.key, { conv: "c1" })).toEqual({ attemptId: "a1" });
    expect(latest(convsOf.key, { attempt: "a1" })).toEqual({
      ids: ["c1", "c2"],
    });

    // A column no collection reads: gated out everywhere.
    expect(
      await step(`UPDATE ${CONVS} SET title = 'x' WHERE id = 'c1'`),
    ).toEqual([]);
    // Another attempt's, another conversation's row: matched out.
    expect(
      await step(`UPDATE ${CONVS} SET attempt_id = 'a8' WHERE id = 'c9'`),
    ).toEqual([]);
    // A conversation inserted into a1: that scope only.
    expect(await step(`INSERT INTO ${CONVS} VALUES ('c4', 'a1', 't')`)).toEqual(
      ["convs-of/a1"],
    );
    expect(latest(convsOf.key, { attempt: "a1" })).toEqual({
      ids: ["c1", "c2", "c4"],
    });
    // c1 re-pointed a1 → a2: its own follower, and BOTH scopes.
    expect(
      await step(`UPDATE ${CONVS} SET attempt_id = 'a2' WHERE id = 'c1'`),
    ).toEqual(["attempt-of/c1", "convs-of/a1", "convs-of/a2"]);
    expect(latest(attemptOf.key, { conv: "c1" })).toEqual({ attemptId: "a2" });
    expect(latest(convsOf.key, { attempt: "a1" })).toEqual({
      ids: ["c2", "c4"],
    });
    expect(latest(convsOf.key, { attempt: "a2" })).toEqual({
      ids: ["c1", "c3"],
    });
    // A delete: its scope and its own follower.
    expect(await step(`DELETE FROM ${CONVS} WHERE id = 'c1'`)).toEqual([
      "attempt-of/c1",
      "convs-of/a2",
    ]);
    expect(latest(attemptOf.key, { conv: "c1" })).toEqual({ attemptId: null });
  }, 60_000);

  test("strictRoutes: a followed table read by hand fails the load; a later run reading nothing is judged on itself", async () => {
    byHand = true;
    const refused = await subscribe(attemptOf.key, { conv: "c2" });
    expect(refused.kind).toBe("sub-error");
    byHand = false;
    const served = await subscribe(attemptOf.key, { conv: "c3" });
    expect(served.kind).toBe("sub-ack");
    expect(served.value).toEqual({ attemptId: "a2" });
  }, 30_000);
});
