/**
 * The union compiler (`compileUnionCollection`, step 12a of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md) against a
 * recording `db`: the SQL each shape renders, pruning, static nullability, the
 * zero-arm scaffold, the routes and their gates, the row decode — and the A14
 * bind-time throws. The DB oracle (real triggers, real rows) is network/live's
 * `serve-union-oracle.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import { recordingQueryDb, type RecordedQuery } from "../testing";
import {
  compileUnionCollection,
  type UnionArmSpec,
  type UnionCollectionSpec,
} from "./compile-union-window";

const aRuns = pgTable("cu_a_runs", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  code: integer("code"),
  pid: integer("pid"),
});
const bRuns = pgTable("cu_b_runs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  size: integer("size").notNull(),
});

const TS = "timestamp with time zone";

/** The fake tuple's params: `order`, `kinds` (kept arms), `after` (a cut). */
type P = ResourceParams;

const armA = (): UnionArmSpec => ({
  kind: "a",
  from: aRuns,
  id: aRuns.id,
  reads: {
    label: aRuns.label,
    startedAt: aRuns.startedAt,
    "a.code": aRuns.code,
  },
  whereReads: [aRuns.label],
});
const armB = (): UnionArmSpec => ({
  kind: "b",
  from: bRuns,
  id: bRuns.id,
  reads: {
    label: bRuns.title,
    startedAt: bRuns.startedAt,
    "b.size": bRuns.size,
  },
  whereReads: [bRuns.title],
});

function spec(
  arms: UnionArmSpec[],
  script?: (q: RecordedQuery) => unknown[],
  over: Partial<UnionCollectionSpec<P, P, P>> = {},
) {
  const { db, calls } = recordingQueryDb(script);
  const s: UnionCollectionSpec<P, P, P> = {
    key: "test.union",
    keyField: "runKey",
    discriminator: "kind",
    columns: [
      { name: "label", sqlType: "text" },
      { name: "startedAt", sqlType: TS },
      { name: "a.code", sqlType: "integer" },
      { name: "b.size", sqlType: "integer" },
    ],
    arms,
    sortable: ["kind", "label", "startedAt", "a.code", "b.size"],
    window: {
      armsOf: (p) => new Set(p.kinds ? p.kinds.split(",") : ["a", "b"]),
      whereOf: () => undefined,
      orderOf: (p) => [{ name: p.order ?? "startedAt", dir: "desc" }],
      limitOf: () => 10,
      cutsOf: (p) => (p.after ? { after: JSON.parse(p.after) } : {}),
      familyOf: (p) => JSON.stringify([p.kinds ?? null, p.order ?? null]),
    },
    rowKey: { keyField: "$key", maxKeyBytes: 1024 },
    point: { idsOf: (p) => (p.kinds ?? "").split(",").filter(Boolean) },
    groups: {
      query: (p) => ({
        groupBy: p.order ?? "label",
        arms: new Set(p.kinds ? p.kinds.split(",") : ["a", "b"]),
        whereOf: () => undefined,
        limit: 5,
        check: () => {},
      }),
    },
    readField: (row, name) => row[name],
    db,
    ...over,
  };
  return {
    compiled: compileUnionCollection<Record<string, unknown>, P, P, P>(s),
    calls,
  };
}

describe("compileUnionCollection — the shapes", () => {
  test("full: one ordered, limited subselect per arm, a typed NULL for a column the arm lacks, the row key as tiebreaker", async () => {
    const { compiled, calls } = spec([armA(), armB()]);
    await compiled.window.loader({});
    const q = calls[0]!.sql;
    expect(q).toContain(`'a'::text AS "__kind"`);
    expect(q).toContain(`('a:' || "cu_a_runs"."id"::text) AS "__key"`);
    // b has no `a.code`: a typed NULL keeps the UNION aligned.
    expect(q).toContain(`NULL::integer AS "__c2"`);
    expect(q).toContain(" UNION ALL ");
    expect(q).toMatch(
      /ORDER BY u\."__c1" DESC NULLS LAST, u\."__key" ASC NULLS LAST LIMIT/,
    );
    // The row key's parts, projected outside as Postgres text.
    expect(q).toContain(`(u."__c1")::text AS "__p0"`);
  });

  test("a pruned arm leaves no SQL — but its NULL still makes the column nullable (static, over every arm)", async () => {
    const { compiled, calls } = spec([armA(), armB()]);
    await compiled.window.loader({
      kinds: "b",
      order: "b.size",
      after: JSON.stringify(["3", "b:x"]),
    });
    const q = calls[0]!.sql;
    expect(q).not.toContain("cu_a_runs");
    // `b.size` is NOT NULL in b, yet nullable in the union (a projects none):
    // the seek's after-term keeps NULL rows behind a non-null cut.
    expect(q).toContain(`"cu_b_runs"."size" IS NULL`);
  });

  test("zero arms: the typed WHERE false scaffold, one code path", async () => {
    const { compiled, calls } = spec([]);
    expect(await compiled.window.loader({})).toEqual([]);
    expect(calls[0]!.sql).toContain("WHERE false");
    // Every arm pruned is the same answer.
    const two = spec([armA()]);
    await two.compiled.window.loader({ kinds: "none" });
    expect(two.calls[0]!.sql).toContain("WHERE false");
  });

  test("scoped refill: keys decoded per arm, an unknown kind or another arm's key dropped, no order", async () => {
    const { compiled, calls } = spec([armA(), armB()]);
    expect(
      await compiled.window.loader({}, { affectedIds: ["z:1", "nope"] }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
    await compiled.window.loader({}, { affectedIds: ["a:1", "a:x:y"] });
    const q = calls[0]!;
    expect(q.sql).not.toContain("cu_b_runs");
    expect(q.sql).not.toContain("LIMIT");
    // A raw id may itself contain `:` — the prefix is stripped once.
    expect(q.params).toContainEqual(["1", "x:y"]);
  });

  test("point: grouped by kind over every arm; nothing to read is no query", async () => {
    const { compiled, calls } = spec([armA(), armB()]);
    expect(await compiled.rows.loader({ kinds: "q:1" })).toEqual([]);
    expect(calls).toHaveLength(0);
    await compiled.rows.loader({ kinds: "a:1,b:2" });
    expect(calls[0]!.sql).toContain("cu_a_runs");
    expect(calls[0]!.sql).toContain("cu_b_runs");
  });

  test("a raw id that is not valid input for a non-text pk is dropped in SQL, never cast", async () => {
    const nRuns = pgTable("cu_n_runs", {
      id: integer("id").primaryKey(),
      label: text("label").notNull(),
      startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    });
    const armN: UnionArmSpec = {
      kind: "n",
      from: nRuns,
      id: nRuns.id,
      reads: { label: nRuns.label, startedAt: nRuns.startedAt },
      whereReads: [],
    };
    const { compiled, calls } = spec([armA(), armN]);
    await compiled.rows.loader({ kinds: "a:x,n:1,n:abc" });
    const q = calls[0]!.sql;
    // The text pk compares the text array directly (its index serves it)…
    expect(q).toContain(`"cu_a_runs"."id" = ANY($`);
    // …the integer pk only the ids Postgres says are valid integers.
    expect(q).toMatch(
      /"cu_n_runs"\."id" = ANY\(ARRAY\(SELECT x::integer FROM unnest\(\$\d+::text\[\]\) AS x WHERE pg_input_is_valid\(x, \$\d+\)\)\)/,
    );
    expect(calls[0]!.params).toContainEqual(["1", "abc"]);
  });

  test("rows decode per arm, name back to fields, and carry the row key", async () => {
    const { compiled } = spec([armA(), armB()], () => [
      {
        __kind: "b",
        __key: "b:1",
        __c0: "hello",
        __c1: "2026-10-01 10:00:00+00",
        __c2: null,
        __c3: 4,
        __p0: "2026-10-01 10:00:00+00",
        __p1: "b:1",
      },
    ]);
    const rows = await compiled.window.loader({});
    expect(rows).toEqual([
      {
        kind: "b",
        runKey: "b:1",
        label: "hello",
        startedAt: new Date("2026-10-01T10:00:00Z"),
        "a.code": null,
        "b.size": 4,
        $key: JSON.stringify(["2026-10-01 10:00:00+00", "b:1"]),
      },
    ]);
  });

  test("a row of an arm that declares the column NOT NULL may not read NULL there (decoded per arm)", async () => {
    const { compiled } = spec([armA(), armB()], () => [
      {
        __kind: "b",
        __key: "b:1",
        __c0: "x",
        __c1: "2026-10-01 10:00:00+00",
        __c2: null,
        __c3: null,
        __p0: "x",
        __p1: "b:1",
      },
    ]);
    // `expect(p).rejects` is typed `void` under bun:test: assert by hand.
    let failure: unknown;
    try {
      await compiled.window.loader({});
    } catch (err) {
      failure = err;
    }
    expect(String(failure)).toMatch(/__c3/);
  });

  test("groups: per-arm GROUP BY, summed outside; a constant arm groups as one value", async () => {
    const { compiled, calls } = spec([armA(), armB()]);
    await Promise.resolve(compiled.groups.loader({ order: "a.code" }));
    const q = calls[0]!.sql;
    expect(q).toContain(`SELECT "cu_a_runs"."code" AS "value"`);
    expect(q).toContain(`SELECT NULL::integer AS "value"`);
    expect(q).toContain(`sum(g."count")`);
  });
});

describe("compileUnionCollection — routes", () => {
  test("each arm's routes are prefixed by its kind; a column no shape reads is not in a gate", () => {
    const { compiled } = spec([armA(), armB()]);
    const routes = compiled.window.routes!.routes;
    expect(routes.map((r) => r.id)).toEqual(["a", "b"]);
    const a = routes.find((r) => r.id === "a")!;
    expect(a.columns).not.toContain("pid");
    expect([...a.columns].sort()).toEqual([
      "code",
      "id",
      "label",
      "started_at",
    ]);
  });

  test("usesOf drops a pruned arm's routes", () => {
    const { compiled } = spec([armA(), armB()]);
    const uses = compiled.window.routes!.usesOf({ kinds: "a" });
    expect([...uses.keys()]).toEqual(["a"]);
  });
});

describe("compileUnionCollection — A14", () => {
  test("throws on a duplicate kind, a non-pk id, a bad sqlType, a type disagreement, a reserved column", () => {
    expect(() => spec([armA(), armA()])).toThrow(/two arms are of kind "a"/);
    expect(() => spec([{ ...armA(), id: aRuns.label }])).toThrow(
      /not the single-column primary key/,
    );
    expect(() =>
      spec([armA()], undefined, {
        columns: [{ name: "label", sqlType: "text; drop" }],
      }),
    ).toThrow(/not a Postgres type name/);
    expect(() =>
      spec([{ ...armA(), reads: { label: aRuns.code } }], undefined, {
        columns: [{ name: "label", sqlType: "text" }],
        sortable: [],
      }),
    ).toThrow(/every arm must produce one type/);
    expect(() =>
      spec([armA()], undefined, {
        columns: [{ name: "kind", sqlType: "text" }],
      }),
    ).toThrow(/the compiler projects those itself/);
    expect(() => spec([{ ...armA(), kind: "a.b" }])).toThrow();
  });
});
