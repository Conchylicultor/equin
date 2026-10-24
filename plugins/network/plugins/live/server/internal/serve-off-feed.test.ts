/**
 * The SQL arm of `serveCollection` OFF the change feed (`changes` —
 * `./serve-off-feed`, B6 of
 * research/2026-10-22-global-live-bounds-independent-of-freshness.md), on a
 * throwaway database with NO feed installed — the table is outside it:
 *
 * - **parity**: the off-feed loaders (`compileOffFeedQuery`) read exactly the
 *   rows the routed ones (`compileWindowQuery`) do, for a filter, a `$key`
 *   cut, a join (sorted and filtered by the joined column) and a point set;
 * - **serve**: every minted resource registers external — the window keyed
 *   and paged, `:rows`, `:groups`, `:count` — and `notify` re-reads a
 *   subscribed window as a keyed delta, its watcher (`whileSubscribed`)
 *   started by the first tuple and stopped by the last;
 * - **route coverage**: every table the SQL reads is declared unfed, and
 *   change-feed's boot check refuses it until the owner opts it out;
 * - **refusals**: an `all` set, a `columnScope`, a hook on a silent collection.
 *
 * Requires a running Postgres cluster (started by ./equin build);
 * createTestDb() throws loudly when it is unreachable.
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { assertUnfedTablesOptedOut } from "@plugins/database/plugins/change-feed/server/testing";
import {
  notificationsWsHandler,
  unfedResourceTables,
  type ResourceParams,
} from "@plugins/framework/plugins/server-core/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import {
  compileOffFeedQuery,
  type QueryDb,
} from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection, serveCollection } from "./serve-collection";

const ITEMS = "sof_items";
const OWNERS = "sof_owners";

const itemsRef = entityRef(ITEMS, {
  id: textField({ label: "Id", filterable: false }),
  title: textField({ label: "Title" }),
  rank: intField({ label: "Rank" }),
  ownerId: nullable(textField({ label: "Owner" })),
});
const items = defineEntity(itemsRef, { primaryKey: "id" });
const owners = pgTable(OWNERS, {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const ownerJoin: LookupJoin<"owner", typeof owners> = {
  kind: "lookup",
  alias: "owner",
  table: owners,
  pk: owners.id,
  on: { from: "base", col: items.table.ownerId },
  required: false,
};

let seq = 0;
const itemsCollection = () =>
  liveCollection(`test.live.off-feed-${seq++}`, {
    from: itemsRef,
    pick: ["title", "rank", "ownerId"],
    fields: { ownerName: nullable(textField({ label: "Owner name" })) },
    carry: { pick: ["id"] },
    id: "id",
    sortable: ["rank", "title", "ownerName"],
    default: { orderBy: [["rank", "asc"]], limit: 2 },
    maxLimit: 20,
    count: true,
  });

let testDb: TestDb;
let client: Client;
let db: QueryDb;

const handler = notificationsWsHandler as unknown as {
  open(ws: unknown): void;
  message(ws: unknown, raw: string): void;
  close(ws: unknown, code: number, reason: string): void;
};
const frames: Record<string, unknown>[] = [];
const ws = {
  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.kind !== "ping") frames.push(frame);
  },
};

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "live_off_feed_test" });
  client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  const conn = drizzle(client);
  db = conn as unknown as QueryDb;
  await conn.execute(
    sql.raw(
      `CREATE TABLE ${OWNERS} (id text PRIMARY KEY, name text NOT NULL);
       CREATE TABLE ${ITEMS} (id text PRIMARY KEY, title text NOT NULL,
                              rank integer NOT NULL, owner_id text);
       INSERT INTO ${OWNERS} VALUES ('o1', 'alice'), ('o2', 'bob');
       INSERT INTO ${ITEMS} VALUES
         ('a', 'Alpha', 1, 'o1'), ('b', 'Beta', 2, 'o2'), ('c', 'Gamma', 3, NULL),
         ('d', 'Delta', 4, 'o1'), ('e', 'Eps', 5, 'o2');`,
    ),
  );
  handler.open(ws);
}, 30_000);

afterAll(async () => {
  handler.close(ws, 1000, "test");
  await client?.end();
  await testDb?.drop();
});

describe("parity — the off-feed loaders read the routed loaders' rows", () => {
  test("a filter, a $key cut, a join and a point set", async () => {
    const c = itemsCollection();
    const specs = compileCollection(c, {
      from: items,
      joins: [ownerJoin],
      columns: { ownerName: (j) => j.owner.name },
      db,
    });
    const routed = compileWindowQuery(c.window, specs.window).serverOpts;
    const off = compileOffFeedQuery(c.window, specs.window);
    const w = c.window.window;
    const both = async (params: ResourceParams) => {
      const a = await routed.loader(params as never);
      const b = await off.loader(params as never);
      expect(b).toEqual(a);
      return a as Record<string, unknown>[];
    };

    // A filter.
    const filtered = await both(w.encode({ where: { rank: { gte: 2 } } }));
    expect(filtered.map((r) => r.id)).toEqual(["b", "c"]);
    // A `$key` cut: the page after the first page's last row.
    const page0 = await both(w.encode());
    const cut = page0.at(-1)!.$key as string;
    const page1 = await both(w.encode({}, { after: cut }));
    expect(page1.map((r) => r.id)).toEqual(["c", "d"]);
    // A join: sorted and filtered by the joined column.
    const joined = await both(
      w.encode({
        where: { ownerName: "alice" },
        orderBy: [["ownerName", "asc"]],
        limit: 5,
      }),
    );
    expect(joined.map((r) => [r.id, r.ownerName])).toEqual([
      ["a", "alice"],
      ["d", "alice"],
    ]);
    // The point set.
    const rowsRouted = compileWindowQuery(c.rows, specs.rows).serverOpts;
    const rowsOff = compileOffFeedQuery(c.rows, specs.rows);
    const ids = c.rows.point.encode(["e", "a", "zz"]);
    expect(await rowsOff.loader(ids)).toEqual(await rowsRouted.loader(ids));
    // The off-feed membership: the window's clamped size and family, the
    // point set's ids — and the tables the SQL reads.
    expect(off.membership.kind).toBe("window");
    expect(rowsOff.membership).toMatchObject({ kind: "point" });
    expect([...off.reads].sort()).toEqual([ITEMS, OWNERS]);
  });
});

describe("serveCollection with `changes` — served off the feed", () => {
  test("registers every minted resource external; notify re-reads a subscribed window", async () => {
    const c = itemsCollection();
    let watching = 0;
    let started = 0;
    const served = serveCollection(c, {
      from: items,
      joins: [ownerJoin],
      columns: { ownerName: (j) => j.owner.name },
      db,
      changes: "notified",
      whileSubscribed: () => {
        watching += 1;
        started += 1;
        return () => {
          watching -= 1;
        };
      },
      throttleMs: 5,
    });
    expect(served.source).toBe("external");
    expect(served.keys).toEqual([
      c.rows.key,
      c.key,
      c.groups.key,
      c.count!.key,
    ]);
    expect(served.declare.map((d) => d.key)).toEqual(served.keys);

    // Every resource answers through the compiled SQL.
    const page0 = await served.window.load(c.window.window.encode());
    expect(page0.map((r) => r.id)).toEqual(["a", "b"]);
    expect(
      (await served.rows.load(c.rows.point.encode(["b", "zz"]))).map(
        (r) => r.id,
      ),
    ).toEqual(["b"]);
    expect(
      await served.groups!.load(
        c.groups.groups.encode({ groupBy: "ownerName" }),
      ),
    ).toEqual([
      { value: "alice", count: 2 },
      { value: "bob", count: 2 },
      { value: null, count: 1 },
    ]);
    expect(await served.count!.load(c.count!.count.encode({ where: {} }))).toBe(
      5,
    );

    // A subscribed window: the watcher starts with the first tuple.
    const params = c.window.window.encode();
    const from = frames.length;
    handler.message(ws, JSON.stringify({ op: "sub", key: c.key, params }));
    await until(
      () =>
        frames.slice(from).some((f) => f.kind === "sub-ack" && f.key === c.key),
      "the window's sub-ack",
    );
    expect(started).toBe(1);
    expect(watching).toBe(1);

    // A write the feed never sees, then the collection's own notify.
    await client.query(`INSERT INTO ${ITEMS} VALUES ('z', 'Zero', 0, 'o2')`);
    const at = frames.length;
    served.notify();
    await until(
      () => frames.slice(at).some((f) => f.kind === "delta" && f.key === c.key),
      "the window's delta after notify",
    );
    const delta = frames
      .slice(at)
      .find((f) => f.kind === "delta" && f.key === c.key)!;
    const upserts = delta.upserts as [string, Record<string, unknown>][];
    expect(upserts.map(([id]) => id)).toEqual(["z"]);
    expect(upserts[0]![1]).toMatchObject({
      id: "z",
      ownerName: "bob",
    });
    expect(delta.order).toEqual(["z", "a"]);

    // The last tuple released: the watcher stops.
    handler.message(ws, JSON.stringify({ op: "unsub", key: c.key, params }));
    await until(() => watching === 0, "the watcher's stop");
    await client.query(`DELETE FROM ${ITEMS} WHERE id = 'z'`);
  });

  test("every table the SQL reads is unfed: refused until the owner opts it out", () => {
    const c = itemsCollection();
    const served = serveCollection(c, {
      from: items,
      joins: [ownerJoin],
      columns: { ownerName: (j) => j.owner.name },
      db,
      changes: { fixed: { reason: "a test archive" } },
    });
    const ours = unfedResourceTables().filter((u) =>
      served.keys.includes(u.key),
    );
    expect(
      ours
        .map((u) => `${u.key} ${u.table}`)
        .sort()
        .filter((s) => s.startsWith(`${c.key} `)),
    ).toEqual([`${c.key} ${ITEMS}`, `${c.key} ${OWNERS}`]);
    expect(new Set(ours.map((u) => u.key))).toEqual(new Set(served.keys));
    // The from table (and the joined one) not opted out: boot refuses.
    expect(() => assertUnfedTablesOptedOut(ours, new Set([OWNERS]))).toThrow(
      new RegExp(`${c.key}: "${ITEMS}"`),
    );
    // Opted out: it passes.
    expect(() =>
      assertUnfedTablesOptedOut(ours, new Set([ITEMS, OWNERS])),
    ).not.toThrow();
    // A silent collection has no notify.
    expect("notify" in served).toBe(false);
  });

  test("refuses an `all` set, a column scope, and a hook on a silent collection", () => {
    const all = liveCollection(`test.live.off-feed-all-${seq++}`, {
      from: itemsRef,
      pick: ["title", "rank", "ownerId"],
      carry: { pick: ["id"] },
      id: "id",
      all: { orderBy: [["rank", "asc"]], unbounded: { reason: "a test set" } },
    });
    expect(() =>
      serveCollection(all, {
        from: items,
        db,
        ...({ changes: "notified" } as object),
      }),
    ).toThrow(/declared `all`/);
    const scoped = liveCollection(`test.live.off-feed-scoped-${seq++}`, {
      from: itemsRef,
      pick: ["title", "rank", "ownerId"],
      carry: { pick: ["id"] },
      id: "id",
      sortable: ["rank"],
      default: { orderBy: [["rank", "asc"]], limit: 2 },
      maxLimit: 20,
      columnScope: "test-surface",
    });
    expect(() =>
      serveCollection(scoped, { from: items, db, changes: "notified" }),
    ).toThrow(/columnScope/);
    expect(() =>
      serveCollection(itemsCollection(), {
        from: items,
        joins: [ownerJoin],
        columns: { ownerName: (j) => j.owner.name },
        db,
        changes: { immutable: { reason: "never" } },
        ...({ throttleMs: 10 } as object),
      }),
    ).toThrow(/reacts to a change signal/);
  });
});
