/**
 * End-to-end: a `compileWindowQuery`-compiled window / point resource wired
 * into a real `createResourceRuntime`, driven through the L4 change-feed's two
 * routers (`routeTableChange`, which serves these routed resources, and the
 * legacy `applyLegacyFullChange`, which must skip them). The deep membership semantics are pinned by
 * `resource-runtime/core/runtime-window-membership.test.ts`; THIS suite pins
 * that the compiled artifacts (params-decoded windowed loader, `windowIdsOf`,
 * the codec-derived `idsOf`) wire those semantics correctly. The fake `db`
 * dispatches on the RENDERED SQL over a live in-memory table, so the loader,
 * the scoped refill, and `windowIdsOf` all read one consistent truth.
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  integer,
  pgTable,
  text,
  PgDialect,
  QueryBuilder,
} from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  createResourceRuntime,
  type ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import type { WindowQueryResourceContract } from "@plugins/infra/plugins/query-resource/core";
import type {
  QueryDb,
  SelectMap,
} from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import {
  pointQueryResourceDescriptor,
  windowQueryResourceDescriptor,
} from "../../core/internal/window-descriptor";

const rowsT = pgTable("rows", {
  id: text("id").primaryKey(),
  n: integer("n").notNull(),
});

const rowSchema = z.object({ id: z.string(), n: z.number() });

// A live in-memory "rows" table + a fake db that answers each rendered query
// from it: the pk-only windowed query (windowIdsOf), the `IN (...)` scoped
// refill, and the windowed FULL loader. Total order: n asc, id asc — matching
// the compiled ORDER BY.
function liveDb() {
  const table = new Map<string, { n: number }>();
  const members = () =>
    [...table.entries()]
      .map(([id, c]) => ({ id, n: c.n }))
      .sort((a, b) => a.n - b.n || (a.id < b.id ? -1 : 1));

  const dialect = new PgDialect();
  const qb = new QueryBuilder();
  const wrap = (q: any): any => ({
    where: (p: SQL) => wrap(q.where(p)),
    orderBy: (...o: SQL[]) => wrap(q.orderBy(...o)),
    limit: (nn: number) => wrap(q.limit(nn)),
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const { sql, params } = dialect.sqlToQuery(q.getSQL());
      let rows: unknown[];
      if (sql.includes(" in (") || sql.includes(" = ANY(")) {
        // Scoped refill (`in ($1, …)`) / point read (`= ANY($1::text[])`, the
        // id list as one array param): the params are the requested ids.
        rows = (params.flat() as string[])
          .filter((id) => table.has(id))
          .map((id) => ({ id, n: table.get(id)!.n }));
      } else {
        // Windowed read (FULL loader or windowIdsOf): last param is the limit.
        const limit = params[params.length - 1] as number;
        const window = members().slice(0, limit);
        rows = sql.startsWith(`select "id" from`)
          ? window.map((r) => ({ id: r.id }))
          : window;
      }
      return Promise.resolve(rows).then(resolve, reject);
    },
  });
  const makeFrom = (builder: any) => ({
    from: (t: any) => wrap(builder.from(t)),
  });
  const db = {
    select: (fields?: SelectMap) =>
      makeFrom(fields ? qb.select(fields) : qb.select()),
    selectDistinct: (fields: SelectMap) => makeFrom(qb.selectDistinct(fields)),
  } as unknown as QueryDb;
  return { db, table };
}

// Two sortable columns (`n`, `m`) for the per-params order suite: the fake reads
// the ORDER BY column off the rendered SQL, so each tuple's windowed reads sort
// by the order its own params resolved.
const sortT = pgTable("sorted", {
  id: text("id").primaryKey(),
  n: integer("n").notNull(),
  m: integer("m").notNull(),
});
const sortSchema = z.object({ id: z.string(), n: z.number(), m: z.number() });

function sortDb() {
  const table = new Map<string, { n: number; m: number }>();
  const dialect = new PgDialect();
  const qb = new QueryBuilder();
  const wrap = (q: any): any => ({
    where: (p: SQL) => wrap(q.where(p)),
    orderBy: (...o: SQL[]) => wrap(q.orderBy(...o)),
    limit: (nn: number) => wrap(q.limit(nn)),
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const { sql, params } = dialect.sqlToQuery(q.getSQL());
      const all = [...table.entries()].map(([id, c]) => ({ id, ...c }));
      let rows: unknown[];
      if (sql.includes(" in (") || sql.includes(" = ANY(")) {
        const ids = params.flat() as string[];
        rows = all.filter((r) => ids.includes(r.id));
      } else {
        const col = sql.includes(`order by "sorted"."m"`) ? "m" : "n";
        const limit = params[params.length - 1] as number;
        const window = all
          .sort((a, b) => a[col] - b[col] || (a.id < b.id ? -1 : 1))
          .slice(0, limit);
        rows = sql.startsWith(`select "id" from`)
          ? window.map((r) => ({ id: r.id }))
          : window;
      }
      return Promise.resolve(rows).then(resolve, reject);
    },
  });
  const makeFrom = (builder: any) => ({
    from: (t: any) => wrap(builder.from(t)),
  });
  const db = {
    select: (fields?: SelectMap) =>
      makeFrom(fields ? qb.select(fields) : qb.select()),
    selectDistinct: (fields: SelectMap) => makeFrom(qb.selectDistinct(fields)),
  } as unknown as QueryDb;
  return { db, table };
}

interface SentFrame {
  key: string;
  params?: ResourceParams;
  kind: string;
  value?: unknown;
  upserts?: [string, unknown][];
  deletes?: string[];
  order?: string[];
}

function harness(table = "rows") {
  const runtime = createResourceRuntime({ readSet: () => [table] });
  const frames: SentFrame[] = [];
  const ws = {
    send(raw: string) {
      const msg = JSON.parse(raw) as SentFrame & { kind: string };
      if (msg.kind === "ping") return;
      frames.push(msg);
    },
  };
  const handler = runtime.notificationsWsHandler as any;
  handler.open(ws);
  return {
    runtime,
    frames,
    async subscribe(key: string, params: ResourceParams = {}) {
      handler.message(ws, JSON.stringify({ op: "sub", key, params }));
      await new Promise((r) => setTimeout(r, 0));
    },
    deltas(key: string) {
      return frames.filter((f) => f.key === key && f.kind === "delta");
    },
    // One base-table change as the change feed delivers it (`routeChange`): to
    // BOTH routers — the compiled resources are routed, so `routeTableChange`
    // serves them and the legacy `applyLegacyFullChange` must skip them (a double
    // delivery would show as a second delta).
    feed(changed: string, op: "I" | "U" | "D", ids: string[]) {
      runtime.routeTableChange({
        source: "feed",
        table: changed,
        op,
        ids,
        keys: null,
        unchanged: null,
      });
      runtime.applyLegacyFullChange({
        source: "feed",
        table: changed,
      });
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
let seq = 0;

describe("compiled window resource — end-to-end", () => {
  test("sub-ack is the bounded window; an entrant ships one delta with the bounded order; squeeze-out drops the tail", async () => {
    const { db, table } = liveDb();
    const key = `test.cwr.win-${seq++}`;
    const descriptor = windowQueryResourceDescriptor(key, rowSchema, "id", {
      defaultLimit: 2,
    });
    const { serverOpts } = compileWindowQuery(descriptor, {
      from: rowsT,
      select: { id: rowsT.id, n: rowsT.n },
      orderBy: { col: rowsT.n },
      window: { maxLimit: 10 },
      db,
    });
    const h = harness();
    h.runtime.defineResource(descriptor, serverOpts);

    table.set("b", { n: 2 });
    table.set("c", { n: 3 });
    table.set("d", { n: 4 }); // beyond the limit-2 window
    await h.subscribe(key, descriptor.defaultParams);

    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toEqual([
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ]); // bounded, never d

    table.set("a", { n: 1 }); // sorts first → enters, c squeezed out
    h.feed("rows", "I", ["a"]);
    await tick();

    const ds = h.deltas(key);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.upserts).toEqual([["a", { id: "a", n: 1 }]]);
    expect(ds[0]!.order).toEqual(["a", "b"]); // the bounded window order, c gone via order
  });

  test("a member DELETE backfills the new tail through windowIdsOf + the scoped refill", async () => {
    const { db, table } = liveDb();
    const key = `test.cwr.win-${seq++}`;
    const descriptor = windowQueryResourceDescriptor(key, rowSchema, "id", {
      defaultLimit: 2,
    });
    const { serverOpts } = compileWindowQuery(descriptor, {
      from: rowsT,
      select: { id: rowsT.id, n: rowsT.n },
      orderBy: { col: rowsT.n },
      window: { maxLimit: 10 },
      db,
    });
    const h = harness();
    h.runtime.defineResource(descriptor, serverOpts);

    table.set("a", { n: 1 });
    table.set("b", { n: 2 });
    table.set("d", { n: 4 });
    await h.subscribe(key, descriptor.defaultParams); // window [a,b]

    table.delete("b");
    h.feed("rows", "D", ["b"]);
    await tick();

    const ds = h.deltas(key);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.deletes).toEqual(["b"]);
    expect(ds[0]!.upserts).toEqual([["d", { id: "d", n: 4 }]]); // the pulled-in tail
    expect(ds[0]!.order).toEqual(["a", "d"]);
  });

  test("an order-column UPDATE re-derives the window via the compiler-derived orderSignatureOf (resurface flow)", async () => {
    const { db, table } = liveDb();
    const key = `test.cwr.win-${seq++}`;
    const descriptor = windowQueryResourceDescriptor(key, rowSchema, "id", {
      defaultLimit: 2,
    });
    const { serverOpts } = compileWindowQuery(descriptor, {
      from: rowsT,
      select: { id: rowsT.id, n: rowsT.n },
      orderBy: { col: rowsT.n },
      window: { maxLimit: 10 },
      db,
    });
    const h = harness();
    h.runtime.defineResource(descriptor, serverOpts);

    table.set("a", { n: 1 });
    table.set("b", { n: 2 });
    table.set("d", { n: 4 }); // beyond the limit-2 window
    await h.subscribe(key, descriptor.defaultParams); // window [a,b]

    // The notifications resurface shape: the order column moves on an in-place
    // UPDATE (membership `where` untouched). b sorts past d → leaves the window
    // via the fresh order; d is pulled in as the new tail.
    table.set("b", { n: 9 });
    h.feed("rows", "U", ["b"]);
    await tick();

    const ds = h.deltas(key);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.deletes).toEqual([]); // not an exit — it left via `order`
    expect(ds[0]!.order).toEqual(["a", "d"]);
    expect(ds[0]!.upserts).toEqual([["d", { id: "d", n: 4 }]]);
  });
});

describe("compiled window resource — per-params orderBy, end-to-end", () => {
  // A richer window codec: `order` is an additive params key. Static-typed as
  // the contract generic so the compile below pins that such a descriptor
  // type-checks against `compileWindowQuery` / `WindowQueryResourceSpec<P>`.
  type SortParams = { limit: string; order?: string };

  test("two tuples sort differently over one table; a signature-column UPDATE reorders only the tuple sorted by it", async () => {
    const { db, table } = sortDb();
    const key = `test.cwr.sort-${seq++}`;
    const base = windowQueryResourceDescriptor(key, sortSchema, "id", {
      defaultLimit: 2,
    });
    const descriptor: WindowQueryResourceContract<
      z.infer<typeof sortSchema>,
      SortParams
    > = { ...base, window: { ...base.window, maxLimit: 10 } };
    const { serverOpts } = compileWindowQuery(descriptor, {
      from: sortT,
      orderBy: (p: SortParams) => [
        { col: p.order === "m" ? sortT.m : sortT.n },
      ],
      signatureColumns: [sortT.n, sortT.m],
      window: {}, // maxLimit comes from the descriptor
      db,
    });
    const h = harness("sorted");
    h.runtime.defineResource(descriptor, serverOpts);

    table.set("a", { n: 1, m: 3 });
    table.set("b", { n: 2, m: 2 });
    table.set("c", { n: 3, m: 1 });
    const byN: SortParams = { limit: "2" };
    const byM: SortParams = { limit: "2", order: "m" };
    await h.subscribe(key, byN);
    await h.subscribe(key, byM);

    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(
      acks.map((f) => (f.value as { id: string }[]).map((r) => r.id)),
    ).toEqual([
      ["a", "b"],
      ["c", "b"],
    ]);

    // c's `m` moves: the byM tuple (c a member, signature moved) re-derives
    // its window — c sorts last and leaves via `order`, a is pulled in. The byN
    // tuple does not sort by m and c is not its member: nothing ships there.
    table.set("c", { n: 3, m: 9 });
    h.feed("sorted", "U", ["c"]);
    await tick();

    const ds = h.deltas(key);
    const forM = ds.filter((f) => f.params?.order === "m");
    expect(forM).toHaveLength(1);
    expect(forM[0]!.order).toEqual(["b", "a"]);
    expect(forM[0]!.upserts).toEqual([["a", { id: "a", n: 1, m: 3 }]]);
    const forN = ds.filter((f) => f.params?.order === undefined);
    for (const f of forN) expect(f.order ?? ["a", "b"]).toEqual(["a", "b"]);
  });
});

describe("compiled point resource — end-to-end", () => {
  test("a change routes only to intersecting tuples; foreign ids ship nothing", async () => {
    const { db, table } = liveDb();
    const key = `test.cwr.pt-${seq++}`;
    const descriptor = pointQueryResourceDescriptor(key, rowSchema, "id");
    const { serverOpts } = compileWindowQuery(descriptor, {
      from: rowsT,
      point: { by: rowsT.id },
      db,
    });
    const h = harness();
    h.runtime.defineResource(descriptor, serverOpts);

    table.set("a", { n: 1 });
    table.set("z", { n: 9 });
    await h.subscribe(key, descriptor.point.encode(["a", "b"]));

    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toEqual([{ id: "a", n: 1 }]); // b has no row yet — z never read

    // In-set update → one scoped upsert.
    table.set("a", { n: 5 });
    h.feed("rows", "U", ["a"]);
    await tick();
    expect(h.deltas(key)).toHaveLength(1);
    expect(h.deltas(key)[0]!.upserts).toEqual([["a", { id: "a", n: 5 }]]);

    // Foreign-id update → no frame at all.
    table.set("z", { n: 10 });
    h.feed("rows", "U", ["z"]);
    await tick();
    expect(h.deltas(key)).toHaveLength(1); // unchanged

    // The missing subscribed id appearing → entrant append.
    table.set("b", { n: 7 });
    h.feed("rows", "I", ["b"]);
    await tick();
    const ds = h.deltas(key);
    expect(ds).toHaveLength(2);
    expect(ds[1]!.upserts).toEqual([["b", { id: "b", n: 7 }]]);
    expect(ds[1]!.order).toEqual(["a", "b"]);
  });
});
