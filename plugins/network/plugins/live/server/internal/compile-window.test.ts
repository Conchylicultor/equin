/**
 * `compileWindowQuery` / `windowQueryResource` — SQL shapes, params-driven
 * limits, and the module-eval misuse guards for the bounded (window / point)
 * compiler. Fake `db` renders SQL via `PgDialect` (same harness as
 * `compile.test.ts`); no live DB.
 * Lives beside `serveCollection` because the window / point descriptors it
 * compiles are minted only by `network/live`'s own factories
 * (`core/internal/window-descriptor.ts`, internal to `liveCollection`).
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  integer,
  pgTable,
  pgView,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { WindowQueryResourceContract } from "@plugins/infra/plugins/query-resource/core";
import { parsedJson } from "@plugins/database/plugins/sql-column/server";
import {
  compileJoins,
  windowQueryResource,
  type WindowQueryResourceSpec,
} from "@plugins/infra/plugins/query-resource/server";
import type { ExtensionJoin } from "@plugins/infra/plugins/query-resource/core";
import {
  compileWindowQuery,
  recordingQueryDb,
} from "@plugins/infra/plugins/query-resource/server/testing";
import {
  pointQueryResourceDescriptor,
  windowQueryResourceDescriptor,
} from "../../core/internal/window-descriptor";
import type {
  WindowParams,
  PointParams,
} from "@plugins/primitives/plugins/live-state/core";
import { liveCollection, LIVE_ROW_KEY } from "../../core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { compileCollection } from "./serve-collection";

const rows = pgTable("rows", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  n: integer("n").notNull(),
  dismissed: integer("dismissed").notNull(),
  icon: parsedJson("icon", z.object({ color: z.string() })),
});

const rowSchema = z.object({ id: z.string(), n: z.number() });

// Unique-key descriptor factories (descriptors self-register globally by key).
let seq = 0;
const winDescriptor = (
  opts: { defaultLimit: number } = { defaultLimit: 100 },
) =>
  windowQueryResourceDescriptor(`test.cw.win-${seq++}`, rowSchema, "id", opts);
// A richer window codec (extra `order` key, descriptor-carried maxLimit) —
// the shape a client-sortable collection declares.
type SortParams = { limit: string; order?: string };
const sortDescriptor = (
  maxLimit?: number,
): WindowQueryResourceContract<z.infer<typeof rowSchema>, SortParams> => {
  const base = winDescriptor({ defaultLimit: 10 });
  return { ...base, window: { ...base.window, maxLimit } };
};
const byOrder = (p: SortParams) => [
  p.order === "parent"
    ? { col: rows.parentId, nullable: true }
    : { col: rows.n, dir: "desc" as const },
];
const ptDescriptor = () =>
  pointQueryResourceDescriptor(`test.cw.pt-${seq++}`, rowSchema, "id");

// ── Fake db: records rendered SQL, returns scripted rows ──
const fakeDb = recordingQueryDb;

describe("compileWindowQuery — window SQL", () => {
  test("FULL loader: where + declared order + pk tiebreaker (NULLS LAST) + params-decoded limit", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts, keyField } = compileWindowQuery(winDescriptor(), {
      from: rows,
      select: { id: rows.id, n: rows.n },
      where: eq(rows.dismissed, 0),
      orderBy: { col: rows.n, dir: "desc" },
      window: { maxLimit: 500 },
      db,
    });
    expect(keyField).toBe("id");
    // Routed: the base table is its identity route.
    expect(serverOpts.routes.routes.map((r) => [r.table, r.map])).toEqual([
      ["rows", { kind: "identity" }],
    ]);
    await serverOpts.loader({ limit: "100" });
    expect(calls[0]!.sql).toBe(
      `select "id", "n" from "rows" where "rows"."dismissed" = $1 ` +
        `order by "rows"."n" DESC NULLS LAST, "rows"."id" ASC NULLS LAST limit $2`,
    );
    expect(calls[0]!.params).toEqual([0, 100]);
  });

  test("the limit comes from the subscription params and clamps to maxLimit", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(
      winDescriptor({ defaultLimit: 10 }),
      {
        from: rows,
        select: { id: rows.id, n: rows.n },
        orderBy: { col: rows.n },
        window: { maxLimit: 50 },
        db,
      },
    );
    await serverOpts.loader({ limit: "25" });
    expect(calls[0]!.params).toEqual([25]);
    await serverOpts.loader({ limit: "9999" }); // over the cap → clamped, never trusted
    expect(calls[1]!.params).toEqual([50]);
  });

  test("malformed params throw loudly instead of loading an unbounded window", () => {
    const { db } = fakeDb();
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      select: { id: rows.id, n: rows.n },
      orderBy: { col: rows.n },
      window: { maxLimit: 500 },
      db,
    });
    expect(() => serverOpts.loader({} as WindowParams)).toThrow(
      /params\.limit/,
    );
    expect(() => serverOpts.loader({ limit: "1e9" })).toThrow(/params\.limit/);
  });

  test("scoped refill: where ∧ pk IN (...), NO order/limit", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      select: { id: rows.id, n: rows.n },
      where: eq(rows.dismissed, 0),
      orderBy: { col: rows.n, dir: "desc" },
      window: { maxLimit: 500 },
      db,
    });
    await serverOpts.loader({ limit: "100" }, { affectedIds: ["a", "b"] });
    expect(calls[0]!.sql).toBe(
      `select "id", "n" from "rows" where ("rows"."dismissed" = $1 and "rows"."id" in ($2, $3))`,
    );
    expect(calls[0]!.params).toEqual([0, "a", "b"]);
  });

  test("windowIdsOf: pk-only projection, SAME where/order/limit as the loader", async () => {
    const { db, calls } = fakeDb(() => [{ id: "a" }, { id: "b" }]);
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      select: { id: rows.id, n: rows.n },
      where: eq(rows.dismissed, 0),
      orderBy: { col: rows.n, dir: "desc" },
      window: { maxLimit: 500 },
      db,
    });
    const membership = serverOpts.membership!;
    expect(membership.kind).toBe("window");
    if (membership.kind !== "window") throw new Error("unreachable");
    const ids = await membership.windowIdsOf({ limit: "42" });
    expect(calls[0]!.sql).toBe(
      `select "id" from "rows" where "rows"."dismissed" = $1 ` +
        `order by "rows"."n" DESC NULLS LAST, "rows"."id" ASC NULLS LAST limit $2`,
    );
    expect(calls[0]!.params).toEqual([0, 42]);
    expect(ids).toEqual(["a", "b"]);
  });

  test("orderSignatureOf: derived from the declared order columns; the pk tiebreaker is excluded", () => {
    const { db } = fakeDb();
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      select: { id: rows.id, n: rows.n },
      orderBy: { col: rows.n, dir: "desc" },
      window: { maxLimit: 500 },
      db,
    });
    const membership = serverOpts.membership!;
    if (membership.kind !== "window") throw new Error("unreachable");
    const params = { limit: "10" };
    const sig = (row: unknown) => membership.orderSignatureOf!(row, params);
    // Same order value, different pk → same signature (the tiebreaker is
    // immutable and excluded); different order value → different signature.
    expect(sig({ id: "a", n: 1 })).toBe(sig({ id: "b", n: 1 }));
    expect(sig({ id: "a", n: 1 })).not.toBe(sig({ id: "a", n: 2 }));
  });

  test("orderSignatureOf: multi-key windows join every declared column, read off projection aliases", () => {
    const { db } = fakeDb();
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      select: { id: rows.id, count: rows.n, parent: rows.parentId },
      orderBy: [
        { col: rows.n, dir: "desc" },
        { col: rows.parentId, nullable: true },
      ],
      window: { maxLimit: 500 },
      db,
    });
    const membership = serverOpts.membership!;
    if (membership.kind !== "window") throw new Error("unreachable");
    const params = { limit: "10" };
    const sig = (row: unknown) => membership.orderSignatureOf!(row, params);
    // Reads the ALIASED wire fields (`count`, `parent`), not the DB names.
    expect(sig({ id: "a", count: 1, parent: "p" })).toBe(
      sig({ id: "z", count: 1, parent: "p" }),
    );
    expect(sig({ id: "a", count: 1, parent: "p" })).not.toBe(
      sig({ id: "a", count: 1, parent: "q" }),
    );
    // Adjacent values never collide across the field boundary (JSON-quoted).
    expect(sig({ id: "a", count: 1, parent: null })).not.toBe(
      sig({ id: "a", count: 1, parent: "null" }),
    );
  });

  test("an unprojected order column throws at module eval", () => {
    const { db } = fakeDb();
    expect(() =>
      compileWindowQuery(winDescriptor(), {
        from: rows,
        select: { id: rows.id }, // n is the order column but is not projected
        orderBy: { col: rows.n },
        window: { maxLimit: 500 },
        db,
      }),
    ).toThrow(/order column "n" is not projected/);
  });

  test("an orderBy already targeting the pk gets no duplicate tiebreaker", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      select: { id: rows.id, n: rows.n },
      orderBy: { col: rows.id, dir: "desc" },
      window: { maxLimit: 500 },
      db,
    });
    await serverOpts.loader({ limit: "10" });
    expect(calls[0]!.sql).toBe(
      `select "id", "n" from "rows" order by "rows"."id" DESC NULLS LAST limit $1`,
    );
  });
});

describe("compileWindowQuery — routes", () => {
  test("a window emits ONE identity route on its base table, read by every tuple as membership", () => {
    const { db } = fakeDb();
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      where: (p: WindowParams) => (p.limit === "1" ? eq(rows.n, 1) : undefined),
      orderBy: { col: rows.n },
      window: { maxLimit: 500 },
      db,
    });
    const plan = serverOpts.routes!;
    expect(plan.routes).toEqual([
      {
        id: "base",
        table: "rows",
        map: { kind: "identity" },
        // A function `where` with no `whereReads`: every column, the safe
        // over-approximation of what the SQL may reference.
        columns: ["id", "parent_id", "n", "dismissed", "icon"],
      },
    ]);
    // Each tuple moves on what its where / order read — `n` for both.
    for (const params of [{ limit: "1" }, { limit: "5" }]) {
      expect([...plan.usesOf(params)]).toEqual([
        ["base", { role: "membership", moves: ["n"] }],
      ]);
    }
  });

  test("a point set keyed by the table's pk routes the change feed's ids as they stand", () => {
    const { db } = fakeDb();
    const { serverOpts } = compileWindowQuery(ptDescriptor(), {
      from: rows,
      point: { by: rows.id },
      db,
    });
    expect(serverOpts.routes!.routes[0]!.map).toEqual({ kind: "identity" });
  });

  test("a pk that is NOT the table's primary key routes by that column's value", () => {
    const { db } = fakeDb();
    const { serverOpts } = compileWindowQuery(ptDescriptor(), {
      from: rows,
      identity: { pk: rows.parentId },
      select: { conversationId: rows.parentId, n: rows.n },
      point: { by: rows.parentId },
      db,
    });
    expect(serverOpts.routes!.routes[0]!.map).toEqual({
      kind: "identity",
      column: "parent_id",
    });
  });

  test("A1: a view `from` throws — a routed resource reads base tables", () => {
    const view = pgView("rows_v").as((qb) =>
      qb.select({ id: rows.id, n: rows.n }).from(rows),
    );
    expect(() =>
      compileWindowQuery(ptDescriptor(), {
        // An untyped caller: `from` is typed `PgTable | EntitySource`.
        from: view as unknown as typeof rows,
        point: { by: rows.id },
        db: fakeDb().db,
      }),
    ).toThrow(/a routed compile reads a base table, never a view/);
  });
});

describe("compileWindowQuery — point", () => {
  test("FULL loader reads the params-decoded id set; membership.idsOf IS the descriptor decode", async () => {
    const { db, calls } = fakeDb();
    const descriptor = ptDescriptor();
    const { serverOpts, keyField } = compileWindowQuery(descriptor, {
      from: rows,
      identity: { pk: rows.parentId },
      select: { conversationId: rows.parentId, n: rows.n },
      point: { by: rows.parentId },
      db,
    });
    expect(keyField).toBe("conversationId");
    await serverOpts.loader({ ids: "c1,c2" });
    expect(calls[0]!.sql).toBe(
      `select "parent_id", "n" from "rows" where "rows"."parent_id" = ANY($1::text[])`,
    );
    expect(calls[0]!.params).toEqual([["c1", "c2"]]);

    const membership = serverOpts.membership!;
    expect(membership.kind).toBe("point");
    if (membership.kind !== "point") throw new Error("unreachable");
    expect(membership.idsOf({ ids: "b,a" })).toEqual(["b", "a"]);
  });

  test("scoped load reads ctx.affectedIds, not the params set", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(ptDescriptor(), {
      from: rows,
      point: { by: rows.id },
      db,
    });
    await serverOpts.loader({ ids: "a,b,c" }, { affectedIds: ["b"] });
    expect(calls[0]!.params).toEqual([["b"]]);
  });

  test("an id the pk cannot hold is absent, never a cast error", async () => {
    // The point set is client-supplied (`:rows` params — a stale or hand-typed
    // URL): against a uuid pk each id is checked with pg_input_is_valid, so
    // "not-a-uuid" reads as an unknown id rather than failing the whole load.
    const uuidRows = pgTable("uuid_rows", {
      id: uuid("id").primaryKey(),
      n: integer("n").notNull(),
    });
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(ptDescriptor(), {
      from: uuidRows,
      point: { by: uuidRows.id },
      db,
    });
    await serverOpts.loader({ ids: "not-a-uuid" });
    expect(calls[0]!.sql).toBe(
      `select "id", "n" from "uuid_rows" where "uuid_rows"."id" = ANY(ARRAY(SELECT x::uuid FROM unnest($1::text[]) AS x WHERE pg_input_is_valid(x, $2)))`,
    );
    expect(calls[0]!.params).toEqual([["not-a-uuid"], "uuid"]);
  });

  test("an empty id set short-circuits to [] with NO query", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(ptDescriptor(), {
      from: rows,
      point: { by: rows.id },
      db,
    });
    expect(await serverOpts.loader({ ids: "" })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("a static where composes with the id set", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(ptDescriptor(), {
      from: rows,
      where: eq(rows.dismissed, 0),
      point: { by: rows.id },
      db,
    });
    await serverOpts.loader({ ids: "a" });
    expect(calls[0]!.sql).toBe(
      `select "id", "parent_id", "n", "dismissed", "icon" from "rows" ` +
        `where ("rows"."dismissed" = $1 and "rows"."id" = ANY($2::text[]))`,
    );
  });

  test("a jsonb column projected with an aliased pk compiles; keyField targets the alias", async () => {
    const { db, calls } = fakeDb();
    const descriptor = ptDescriptor();
    // Mirrors conversation-preprompt: the parent-FK pk is projected under the
    // wire ALIAS `conversationId`, and a jsonb `icon` (AvatarSpec) rides along
    // as a plain projected column — no special handling, no keyField drift.
    const { serverOpts, keyField } = compileWindowQuery(descriptor, {
      from: rows,
      identity: { pk: rows.parentId },
      select: { conversationId: rows.parentId, icon: rows.icon, n: rows.n },
      point: { by: rows.parentId },
      db,
    });
    expect(keyField).toBe("conversationId");
    await serverOpts.loader({ ids: "c1,c2" });
    expect(calls[0]!.sql).toBe(
      `select "parent_id", "icon", "n" from "rows" where "rows"."parent_id" = ANY($1::text[])`,
    );
    expect(calls[0]!.params).toEqual([["c1", "c2"]]);
  });
});

describe("compileWindowQuery — per-params orderBy", () => {
  test("each tuple's loader AND windowIdsOf read the order its params resolve", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(sortDescriptor(50), {
      from: rows,
      select: { id: rows.id, n: rows.n, parentId: rows.parentId },
      orderBy: byOrder,
      signatureColumns: [rows.n, rows.parentId],
      window: {},
      db,
    });
    await serverOpts.loader({ limit: "5" });
    await serverOpts.loader({ limit: "5", order: "parent" });
    const membership = serverOpts.membership!;
    if (membership.kind !== "window") throw new Error("unreachable");
    await membership.windowIdsOf({ limit: "5", order: "parent" });
    await serverOpts.loader({ limit: "9999" }); // clamped to the descriptor's maxLimit
    expect(calls.map((c) => c.sql)).toEqual([
      `select "id", "n", "parent_id" from "rows" order by "rows"."n" DESC NULLS LAST, "rows"."id" ASC NULLS LAST limit $1`,
      `select "id", "n", "parent_id" from "rows" order by "rows"."parent_id" ASC NULLS LAST, "rows"."id" ASC NULLS LAST limit $1`,
      `select "id" from "rows" order by "rows"."parent_id" ASC NULLS LAST, "rows"."id" ASC NULLS LAST limit $1`,
      `select "id", "n", "parent_id" from "rows" order by "rows"."n" DESC NULLS LAST, "rows"."id" ASC NULLS LAST limit $1`,
    ]);
    expect(calls[3]!.params).toEqual([50]);
  });

  test("orderSignatureOf covers the columns the TUPLE orders by, not every signature column", () => {
    const { db } = fakeDb();
    const { serverOpts } = compileWindowQuery(sortDescriptor(50), {
      from: rows,
      select: { id: rows.id, n: rows.n, parent: rows.parentId },
      orderBy: byOrder,
      signatureColumns: [rows.n, rows.parentId],
      window: {},
      db,
    });
    const membership = serverOpts.membership!;
    if (membership.kind !== "window") throw new Error("unreachable");
    // The default tuple sorts by `n`: a `parent` write does not move it — a
    // write to a column only another tuple sorts by costs it no ids query.
    const byN = { limit: "5" };
    const byParent = { limit: "5", order: "parent" };
    const sig = membership.orderSignatureOf!;
    expect(sig({ id: "a", n: 1, parent: "p" }, byN)).toBe(
      sig({ id: "b", n: 1, parent: "p" }, byN),
    );
    expect(sig({ id: "a", n: 1, parent: "p" }, byN)).not.toBe(
      sig({ id: "a", n: 2, parent: "p" }, byN),
    );
    expect(sig({ id: "a", n: 1, parent: "p" }, byN)).toBe(
      sig({ id: "a", n: 1, parent: "q" }, byN),
    );
    // The tuple sorting by `parent` is the mirror image.
    expect(sig({ id: "a", n: 1, parent: "p" }, byParent)).not.toBe(
      sig({ id: "a", n: 1, parent: "q" }, byParent),
    );
    expect(sig({ id: "a", n: 1, parent: "p" }, byParent)).toBe(
      sig({ id: "a", n: 2, parent: "p" }, byParent),
    );
  });

  test("a static orderBy with signatureColumns: the SQL and the signature follow the order alone", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      select: { id: rows.id, n: rows.n, parentId: rows.parentId },
      orderBy: { col: rows.n },
      signatureColumns: [rows.n, rows.parentId],
      window: { maxLimit: 500 },
      db,
    });
    await serverOpts.loader({ limit: "3" });
    expect(calls[0]!.sql).toBe(
      `select "id", "n", "parent_id" from "rows" order by "rows"."n" ASC NULLS LAST, "rows"."id" ASC NULLS LAST limit $1`,
    );
    const membership = serverOpts.membership!;
    if (membership.kind !== "window") throw new Error("unreachable");
    // `signatureColumns` is the universe a tuple's order is checked against;
    // the signature is the tuple's own order columns (`n`).
    const params = { limit: "3" };
    const sig = (row: unknown) => membership.orderSignatureOf!(row, params);
    expect(sig({ id: "a", n: 1, parentId: "p" })).toBe(
      sig({ id: "a", n: 1, parentId: "q" }),
    );
    expect(sig({ id: "a", n: 1, parentId: "p" })).not.toBe(
      sig({ id: "a", n: 2, parentId: "p" }),
    );
  });

  test("a resolved order column outside signatureColumns throws on first use", async () => {
    const { db } = fakeDb();
    const { serverOpts } = compileWindowQuery(sortDescriptor(50), {
      from: rows,
      select: { id: rows.id, n: rows.n, parentId: rows.parentId },
      orderBy: byOrder,
      signatureColumns: [rows.n],
      window: {},
      db,
    });
    await serverOpts.loader({ limit: "5" }); // n: covered
    expect(() => serverOpts.loader({ limit: "5", order: "parent" })).toThrow(
      /order column "parent_id" is not in `signatureColumns`/,
    );
  });
});

describe("compileWindowQuery — misuse guards (module-eval throws)", () => {
  const { db } = fakeDb();
  const base = { from: rows, select: { id: rows.id, n: rows.n }, db };

  test("window and point are mutually exclusive", () => {
    expect(() =>
      compileWindowQuery(winDescriptor(), {
        ...base,
        orderBy: { col: rows.n },
        window: { maxLimit: 10 },
        point: { by: rows.id },
      } as WindowQueryResourceSpec<WindowParams>),
    ).toThrow(/mutually exclusive/);
  });

  test("neither window nor point → declare the collection with `all`", () => {
    expect(() =>
      compileWindowQuery(winDescriptor(), {
        ...base,
      } as WindowQueryResourceSpec<WindowParams>),
    ).toThrow(
      /declare the collection with `all` \(`liveCollection\(key, \{ all \}\)`\)/,
    );
  });

  test("window without orderBy", () => {
    expect(() =>
      compileWindowQuery(winDescriptor(), {
        ...base,
        window: { maxLimit: 10 },
      }),
    ).toThrow(/REQUIRES `orderBy`/);
  });

  test("defaultLimit > maxLimit", () => {
    expect(() =>
      compileWindowQuery(winDescriptor({ defaultLimit: 100 }), {
        ...base,
        orderBy: { col: rows.n },
        window: { maxLimit: 50 },
      }),
    ).toThrow(/defaultLimit \(100\) exceeds window\.maxLimit \(50\)/);
  });

  test("non-integer maxLimit", () => {
    expect(() =>
      compileWindowQuery(winDescriptor({ defaultLimit: 1 }), {
        ...base,
        orderBy: { col: rows.n },
        window: { maxLimit: 2.5 },
      }),
    ).toThrow(/maxLimit must be a positive integer/);
  });

  test("function orderBy without signatureColumns", () => {
    expect(() =>
      compileWindowQuery(sortDescriptor(50), {
        ...base,
        orderBy: byOrder,
        window: {},
      }),
    ).toThrow(/function `orderBy` REQUIRES a non-empty `signatureColumns`/);
  });

  test("an unprojected signature column", () => {
    expect(() =>
      compileWindowQuery(sortDescriptor(50), {
        ...base, // projects id, n — not parent_id
        orderBy: byOrder,
        signatureColumns: [rows.n, rows.parentId],
        window: {},
      }),
    ).toThrow(/order column "parent_id" is not projected/);
  });

  test("a static order column outside signatureColumns", () => {
    expect(() =>
      compileWindowQuery(winDescriptor(), {
        ...base,
        orderBy: { col: rows.n },
        signatureColumns: [rows.parentId],
        window: { maxLimit: 500 },
      }),
    ).toThrow(/order column "n" is not in `signatureColumns`/);
  });

  test("spec and descriptor maxLimit disagree", () => {
    expect(() =>
      compileWindowQuery(sortDescriptor(50), {
        ...base,
        orderBy: { col: rows.n },
        window: { maxLimit: 60 },
      }),
    ).toThrow(
      /window\.maxLimit \(60\) disagrees with the descriptor's maxLimit \(50\)/,
    );
  });

  test("spec and descriptor maxLimit agreeing compiles", () => {
    expect(() =>
      compileWindowQuery(sortDescriptor(50), {
        ...base,
        orderBy: { col: rows.n },
        window: { maxLimit: 50 },
      }),
    ).not.toThrow();
  });

  test("no maxLimit anywhere", () => {
    expect(() =>
      compileWindowQuery(sortDescriptor(), {
        ...base,
        orderBy: { col: rows.n },
        window: {},
      }),
    ).toThrow(/declare `window\.maxLimit`/);
  });

  test("point with signatureColumns", () => {
    expect(() =>
      compileWindowQuery(ptDescriptor(), {
        ...base,
        signatureColumns: [rows.n],
        point: { by: rows.id },
      }),
    ).toThrow(/point sets are unordered/);
  });

  test("point with orderBy (point sets are unordered)", () => {
    expect(() =>
      compileWindowQuery(ptDescriptor(), {
        ...base,
        orderBy: { col: rows.n },
        point: { by: rows.id },
      } as WindowQueryResourceSpec<PointParams>),
    ).toThrow(/point sets are unordered/);
  });

  test("point.by must BE the identity pk when both are declared", () => {
    expect(() =>
      compileWindowQuery(ptDescriptor(), {
        ...base,
        identity: { pk: rows.id },
        point: { by: rows.parentId },
      }),
    ).toThrow(/`point\.by` must BE the identity pk/);
  });

  test("descriptor/spec kind drift: a point descriptor with a window spec", () => {
    expect(() =>
      compileWindowQuery(ptDescriptor(), {
        ...base,
        orderBy: { col: rows.n },
        window: { maxLimit: 10 },
      } as WindowQueryResourceSpec<PointParams>),
    ).toThrow(/no window codec/);
  });

  test("descriptor/spec kind drift: a window descriptor with a point spec", () => {
    expect(() =>
      compileWindowQuery(winDescriptor(), {
        ...base,
        point: { by: rows.id },
      } as WindowQueryResourceSpec<WindowParams>),
    ).toThrow(/no point codec/);
  });
});

describe("windowQueryResource — descriptor/keyField assertion", () => {
  test("throws loudly when queryPk disagrees with the derived keyField", () => {
    const { db } = fakeDb();
    // keyField derives to "id"; the descriptor keys on "n" → throw BEFORE any
    // real defineResource registration.
    const descriptor = windowQueryResourceDescriptor(
      "test.cw.mismatch",
      rowSchema,
      "n",
      { defaultLimit: 10 },
    );
    expect(() =>
      windowQueryResource(descriptor, {
        from: rows,
        select: { id: rows.id, n: rows.n },
        orderBy: { col: rows.n },
        window: { maxLimit: 100 },
        db,
      }),
    ).toThrow(/does not match the keyField "id"/);
  });
});

describe("compileWindowQuery — joins", () => {
  const rowsExt = pgTable("rows_ext", {
    parentId: text("parent_id").primaryKey(),
    id: text("id"),
    score: integer("score"),
  });
  const x: ExtensionJoin<"x", typeof rowsExt> = {
    kind: "extension",
    alias: "x",
    table: rowsExt,
    key: rowsExt.parentId,
    parentKey: rows.id,
  };
  const plan = compileJoins({ table: rows, name: "rows" }, [x], rows.id, "t");
  const score = plan.render({ from: "x", col: rowsExt.score });

  test("a spec with joins needs an explicit select", () => {
    expect(() =>
      compileWindowQuery(winDescriptor(), {
        from: rows,
        joins: [x],
        orderBy: { col: rows.n },
        window: { maxLimit: 500 },
        db: fakeDb().db,
      }),
    ).toThrow(/needs an explicit `select`/);
  });

  test("the key field must project the base identity, never a joined column", () => {
    expect(() =>
      compileWindowQuery(winDescriptor(), {
        from: rows,
        joins: [x],
        select: { id: plan.render({ from: "x", col: rowsExt.id }), n: rows.n },
        orderBy: { col: rows.n },
        window: { maxLimit: 500 },
        db: fakeDb().db,
      }),
    ).toThrow(/projects a joined column/);
  });

  test("a per-params where reading outside its declared whereReads fails its load", async () => {
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      joins: [x],
      select: { id: rows.id, n: rows.n, score },
      where: (p: WindowParams) =>
        p.limit === "1" ? eq(rows.dismissed, 0) : eq(rows.n, 1),
      whereReads: [rows.n],
      orderBy: { col: rows.n },
      window: { maxLimit: 500 },
      db: fakeDb().db,
    });
    await serverOpts.loader({ limit: "5" });
    const failure = await Promise.resolve()
      .then(() => serverOpts.loader({ limit: "1" }))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(String(failure)).toMatch(
      /reads "base"\."dismissed", which is not in `whereReads`/,
    );
    // …and its read-set answer throws the same, so the runtime FULLs the tuple.
    expect(() => serverOpts.routes!.usesOf({ limit: "1" })).toThrow(
      /whereReads/,
    );
  });

  test("with whereReads, the route columns are exactly what the SQL may read", () => {
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      joins: [x],
      select: { id: rows.id, n: rows.n, score },
      where: () => eq(rows.dismissed, 0),
      whereReads: [rows.dismissed],
      orderBy: { col: rows.n },
      window: { maxLimit: 500 },
      db: fakeDb().db,
    });
    expect(
      serverOpts.routes!.routes.map((r) => [r.id, r.map, r.columns]),
    ).toEqual([
      ["base", { kind: "identity" }, ["id", "n", "dismissed"]],
      ["x", { kind: "alias" }, ["parent_id", "score"]],
    ]);
  });

  test("with no select, the route columns are the whole projection a select-all reads", async () => {
    const { db, calls } = fakeDb();
    const { serverOpts } = compileWindowQuery(winDescriptor(), {
      from: rows,
      where: eq(rows.dismissed, 0),
      orderBy: { col: rows.n },
      window: { maxLimit: 500 },
      db,
    });
    // An update that changes only `icon` or `parent_id` changes a member row
    // the loader returns, so the `unchanged` gate must let it through.
    expect(serverOpts.routes!.routes[0]!.columns).toEqual([
      "id",
      "parent_id",
      "n",
      "dismissed",
      "icon",
    ]);
    await serverOpts.loader({ limit: "5" });
    expect(calls[0]!.sql).toStartWith(
      `select "id", "parent_id", "n", "dismissed", "icon" from "rows"`,
    );
  });
});

// ── A scroll collection's window: page cuts and the `$key` row key ─────────

describe("compileWindowQuery — scroll pages (serveCollection over a scroll collection)", () => {
  const tracks = pgTable("tracks", {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    playedAt: timestamp("played_at", { withTimezone: true }),
    durationSec: integer("duration_sec").notNull(),
    owner: text("owner").notNull(),
  });
  const TrackRow = z.object({
    id: z.string(),
    title: z.string(),
    playedAt: z.date().nullable(),
    durationSec: z.number(),
    owner: z.string(),
  });
  let n = 0;
  const scrollCollection = () =>
    liveCollection(`test.cw.scroll-${n++}`, {
      row: TrackRow,
      id: "id",
      filterable: { title: liveText(), owner: liveText() },
      // durationSec is sortable but NOT filterable.
      sortable: ["title", "playedAt", "durationSec"],
      default: { orderBy: [["playedAt", "desc"]], limit: 10 },
      maxLimit: 30,
      scroll: true,
    });

  function compileScroll(
    script?: (q: { sql: string; params: unknown[] }) => unknown[],
  ) {
    const c = scrollCollection();
    const recording = fakeDb(script);
    const specs = compileCollection(c, {
      from: tracks,
      where: eq(tracks.owner, "me"),
      db: recording.db,
    });
    return {
      c,
      window: compileWindowQuery(c.window, specs.window).serverOpts,
      ...recording,
    };
  }

  const AFTER = JSON.stringify(["2026-09-30 10:00:00.123456+00", "t1"]);
  const UNTIL = JSON.stringify(["2026-09-29 08:00:00.5+00", "t9"]);

  test("a cut-free tuple renders exactly as before; each row gets its $key", async () => {
    const { c, window, calls } = compileScroll(() => [
      {
        id: "t1",
        title: "a",
        playedAt: new Date(0),
        durationSec: 1,
        owner: "me",
        __row_key_0: "1970-01-01 00:00:00+00",
        __row_key_1: "t1",
      },
    ]);
    const rows = (await window.loader(c.window.window.encode())) as Record<
      string,
      unknown
    >[];
    expect(calls[0]!.sql).toBe(
      `select "id", "title", "played_at", "duration_sec", "owner", ` +
        `"played_at"::text as "__row_key_0", "id"::text as "__row_key_1" ` +
        `from "tracks" where "tracks"."owner" = $1 ` +
        `order by "tracks"."played_at" DESC NULLS LAST, "tracks"."id" ASC NULLS LAST limit $2`,
    );
    expect(rows[0]![LIVE_ROW_KEY]).toBe('["1970-01-01 00:00:00+00","t1"]');
    expect(Object.keys(rows[0]!).some((k) => k.startsWith("__row_key"))).toBe(
      false,
    );
  });

  test("cuts compile on the order side, operands cast back to each key's column type, in full / scoped / ids", async () => {
    const { c, window, calls } = compileScroll();
    const params = c.window.window.encode(
      { limit: 20 },
      { after: AFTER, until: UNTIL },
    );
    await window.loader(params);
    await window.loader(params, { affectedIds: ["t3"] });
    await (
      window.membership as { windowIdsOf(p: unknown): Promise<string[]> }
    ).windowIdsOf(params);
    const cut =
      `(("tracks"."played_at" < $2::timestamp with time zone OR "tracks"."played_at" IS NULL) ` +
      `or ("tracks"."played_at" = $3::timestamp with time zone and "tracks"."id" > $4::text)) ` +
      `and ("tracks"."played_at" > $5::timestamp with time zone ` +
      `or ("tracks"."played_at" = $6::timestamp with time zone and "tracks"."id" < $7::text) ` +
      `or ("tracks"."played_at" = $8::timestamp with time zone and "tracks"."id" = $9::text))`;
    for (const call of calls) expect(call.sql).toContain(cut);
    expect(calls[0]!.params.slice(0, 9)).toEqual([
      "me",
      "2026-09-30 10:00:00.123456+00",
      "2026-09-30 10:00:00.123456+00",
      "t1",
      "2026-09-29 08:00:00.5+00",
      "2026-09-29 08:00:00.5+00",
      "t9",
      "2026-09-29 08:00:00.5+00",
      "t9",
    ]);
    // Only the full and scoped loads project the row key.
    expect(calls[0]!.sql).toContain(`::text as "__row_key_0"`);
    expect(calls[1]!.sql).toContain(`::text as "__row_key_0"`);
    expect(calls[2]!.sql).not.toContain("__row_key");
  });

  test("a NULL order key in a cut compiles as the trailing NULL region", async () => {
    const { c, window, calls } = compileScroll();
    await window.loader(
      c.window.window.encode(undefined, {
        after: JSON.stringify([null, "t4"]),
      }),
    );
    expect(calls[0]!.sql).toContain(
      `where ("tracks"."owner" = $1 and ("tracks"."played_at" IS NULL and "tracks"."id" > $2::text))`,
    );
  });

  test("a sortable-but-not-filterable order key takes cuts without tripping the whereReads universe", async () => {
    const { c, window, calls } = compileScroll();
    const params = c.window.window.encode(
      { orderBy: [["durationSec", "asc"]], where: { title: "x" } },
      { after: JSON.stringify(["90", "t2"]) },
    );
    await window.loader(params);
    expect(calls[0]!.sql).toContain(
      `("tracks"."duration_sec" > $3::integer or ("tracks"."duration_sec" = $4::integer and "tracks"."id" > $5::text))`,
    );
    // The routes and roles are those of the same tuple without the cut.
    expect([...window.routes!.usesOf(params)]).toEqual([
      ...window.routes!.usesOf(
        c.window.window.encode({
          orderBy: [["durationSec", "asc"]],
          where: { title: "x" },
        }),
      ),
    ]);
  });

  test("a $key over 1 KiB (a long text sort key) is projected as null", async () => {
    const long = "x".repeat(1100);
    const { c, window } = compileScroll(() => [
      {
        id: "t1",
        title: long,
        playedAt: null,
        durationSec: 1,
        owner: "me",
        __row_key_0: long,
        __row_key_1: "t1",
      },
      {
        id: "t2",
        title: "short",
        playedAt: null,
        durationSec: 1,
        owner: "me",
        __row_key_0: "short",
        __row_key_1: "t2",
      },
    ]);
    const rows = (await window.loader(
      c.window.window.encode({ orderBy: [["title", "asc"]] }),
    )) as Record<string, unknown>[];
    expect(rows.map((r) => r[LIVE_ROW_KEY])).toEqual([null, '["short","t2"]']);
  });
});
