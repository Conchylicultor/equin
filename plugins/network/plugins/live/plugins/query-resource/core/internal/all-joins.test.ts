/**
 * The `all`-only join kinds and their aggregates (P8 v3 §4.1, C9; A33):
 * builders, the aggregate brand, and the types — a children or closure join
 * exposes only its aggregates (`AllJoinRefs`), a non-null aggregate states
 * `ifNone`, and `JoinSpec` (every non-`all` compile) does not admit them.
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Rollup } from "@plugins/database/plugins/derived-tables/core";
import {
  aggregate,
  childrenJoin,
  closureJoin,
  isAggregate,
  jsonAgg,
  type AggregateRef,
  type AggregateValue,
  type AllJoinRefs,
  type AllJoinSpec,
} from "./all-joins";
import type { JoinSpec } from "./joins";

const tasks = pgTable("t_tasks", {
  id: text("id").primaryKey(),
  droppedAt: timestamp("dropped_at", { withTimezone: true }),
});
const attempts = pgTable("t_attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  note: text("note"),
});
const convAgg = pgTable("t_attempt_conv_agg", {
  attemptId: text("attempt_id").primaryKey(),
  hasConv: boolean("has_conv").notNull(),
});
const deps = pgTable("t_deps", {
  taskId: text("task_id").notNull(),
  dependsOn: text("depends_on").notNull(),
});
// Only its `handle` is read here (the refs' types); the compiler reads its
// sources (16b.4). A real one is minted by `defineRollup`.
const convRollup = { handle: convAgg } as unknown as Rollup<typeof convAgg>;

const att = childrenJoin({
  alias: "att",
  table: attempts,
  fk: attempts.taskId,
  rollups: [
    {
      kind: "rollup",
      alias: "conv",
      rollup: convRollup,
      on: attempts.id,
    },
  ],
  where: (c) => sql`${c.att.status} <> 'system'`,
  aggregates: (c) => ({
    hasCompleted: aggregate(sql`bool_or(${c.att.status} = 'completed')`, {
      decoder: Boolean,
      sqlType: "boolean",
      notNull: true,
      ifNone: sql`false`,
    }),
    anyConv: aggregate(sql`bool_or(${c.conv.hasConv})`, {
      decoder: Boolean,
      sqlType: "boolean",
    }),
    list: jsonAgg(
      { id: c.att.id, createdAt: c.att.createdAt, note: c.att.note },
      { orderBy: [[c.att.createdAt, "asc"]] },
    ),
  }),
});

const blocking = closureJoin({
  alias: "blocking",
  edges: deps,
  child: deps.taskId,
  parent: deps.dependsOn,
  nodes: tasks,
  ancestorJoins: [att],
  aggregates: (c) => ({
    hasBlocking: aggregate(
      sql`bool_or(${c.anc.droppedAt} IS NULL AND NOT ${c.att.hasCompleted})`,
      {
        decoder: Boolean,
        sqlType: "boolean",
        notNull: true,
        ifNone: sql`false`,
      },
    ),
  }),
});

describe("children and closure builders", () => {
  test("a children join keeps its declaration as data; the callbacks are the compiler's to run", () => {
    expect(att.kind).toBe("children");
    expect(att.alias).toBe("att");
    expect(att.rollups.map((r) => r.alias)).toEqual(["conv"]);
    expect(typeof att.where).toBe("function");
    expect(typeof att.aggregates).toBe("function");
    expect(Object.isFrozen(att)).toBe(true);
    const bare = childrenJoin({
      alias: "bare",
      table: attempts,
      fk: attempts.taskId,
      aggregates: () => ({}),
    });
    expect(bare.rollups).toEqual([]);
    expect(bare.where).toBeUndefined();
  });

  test("a closure join keeps its edge, nodes and ancestor joins", () => {
    expect(blocking.kind).toBe("closure");
    expect(blocking.child).toBe(deps.taskId);
    expect(blocking.parent).toBe(deps.dependsOn);
    expect(blocking.nodes).toBe(tasks);
    expect(blocking.ancestorJoins).toEqual([att]);
  });

  test("refuses an empty alias, a repeated or reserved nested alias, and child = parent", () => {
    expect(() =>
      childrenJoin({
        alias: "",
        table: attempts,
        fk: attempts.taskId,
        aggregates: () => ({}),
      }),
    ).toThrow(/an empty alias/);
    const rollup = (alias: string) =>
      ({
        kind: "rollup",
        alias,
        rollup: convRollup,
        on: attempts.id,
      }) as const;
    expect(() =>
      childrenJoin({
        alias: "att",
        table: attempts,
        fk: attempts.taskId,
        rollups: [rollup("conv"), rollup("conv")],
        aggregates: () => ({}),
      }),
    ).toThrow(/nested alias "conv" repeats another/);
    expect(() =>
      childrenJoin({
        alias: "att",
        table: attempts,
        fk: attempts.taskId,
        rollups: [rollup("att")],
        aggregates: () => ({}),
      }),
    ).toThrow(/nested alias "att" repeats a reserved name/);
    expect(() =>
      closureJoin({
        alias: "b",
        edges: deps,
        child: deps.taskId,
        parent: deps.taskId,
        nodes: tasks,
        aggregates: () => ({}),
      }),
    ).toThrow(/`child` and `parent` are the same column/);
    expect(() =>
      closureJoin({
        alias: "b",
        edges: deps,
        child: deps.taskId,
        parent: deps.dependsOn,
        nodes: tasks,
        ancestorJoins: [
          {
            kind: "rollup",
            alias: "anc",
            rollup: convRollup,
            on: tasks.id,
          },
        ],
        aggregates: () => ({}),
      }),
    ).toThrow(/nested alias "anc" repeats a reserved name/);
  });

  test("refuses a declared column that is not the named table's own", () => {
    expect(() =>
      childrenJoin({
        alias: "att",
        table: attempts,
        fk: deps.taskId,
        aggregates: () => ({}),
      }),
    ).toThrow(/`fk` \(column "task_id"\) is not a column of `table`/);
    expect(() =>
      childrenJoin({
        alias: "att",
        table: attempts,
        fk: attempts.taskId,
        rollups: [
          { kind: "rollup", alias: "conv", rollup: convRollup, on: tasks.id },
        ],
        aggregates: () => ({}),
      }),
    ).toThrow(
      /`rollups\["conv"\]\.on` \(column "id"\) is not a column of `table`/,
    );
    expect(() =>
      closureJoin({
        alias: "b",
        edges: deps,
        child: attempts.taskId,
        parent: deps.dependsOn,
        nodes: tasks,
        aggregates: () => ({}),
      }),
    ).toThrow(/`child` \(column "task_id"\) is not a column of `edges`/);
    expect(() =>
      closureJoin({
        alias: "b",
        edges: deps,
        child: deps.taskId,
        parent: tasks.id,
        nodes: tasks,
        aggregates: () => ({}),
      }),
    ).toThrow(/`parent` \(column "id"\) is not a column of `edges`/);
    expect(() =>
      closureJoin({
        alias: "b",
        edges: deps,
        child: deps.taskId,
        parent: deps.dependsOn,
        nodes: tasks,
        ancestorJoins: [
          {
            kind: "rollup",
            alias: "conv",
            rollup: convRollup,
            on: attempts.id,
          },
        ],
        aggregates: () => ({}),
      }),
    ).toThrow(
      /`ancestorJoins\["conv"\]\.on` \(column "id"\) is not a column of `nodes`/,
    );
  });
});

describe("aggregates", () => {
  test("aggregate: an expression with its ifNone; notNull without ifNone is refused (A33)", () => {
    const a = aggregate(sql`count(*)`, {
      decoder: Number,
      sqlType: "integer",
      notNull: true,
      ifNone: sql`0`,
    });
    expect(isAggregate(a)).toBe(true);
    expect(a.notNull).toBe(true);
    expect(a.shape.kind).toBe("expr");
    const n = aggregate(sql`max(x)`, { decoder: String, sqlType: "text" });
    expect(n.notNull).toBe(false);
    expect(n.shape).toMatchObject({ kind: "expr", ifNone: null });
    expect(() =>
      aggregate(sql`count(*)`, {
        decoder: Number,
        sqlType: "integer",
        notNull: true,
      } as never),
    ).toThrow(/`notNull: true` needs `ifNone`/);
    expect(() =>
      aggregate(sql`count(*)`, { decoder: Number, sqlType: "int; drop" }),
    ).toThrow(/is not a Postgres type name/);
  });

  test("jsonAgg: never NULL (a host with no rows reads []), ordered by declaration", () => {
    const refs = {
      id: { from: "att", col: attempts.id },
      createdAt: { from: "att", col: attempts.createdAt },
    } as const;
    const j = jsonAgg(refs, { orderBy: [[refs.createdAt, "desc"]] });
    expect(isAggregate(j)).toBe(true);
    expect(j.notNull).toBe(true);
    expect(j.sqlType).toBe("json");
    expect(j.shape.kind).toBe("json");
    expect(() => jsonAgg({}, { orderBy: [[refs.id, "asc"]] })).toThrow(
      /no columns/,
    );
    expect(() => jsonAgg(refs, { orderBy: [] })).toThrow(/an empty `orderBy`/);
  });

  test("the brand, not the shape, makes an aggregate", () => {
    expect(isAggregate({ kind: "aggregate", shape: {} })).toBe(false);
  });
});

describe("types (T13, A33, C9)", () => {
  test("a children / closure join exposes only aggregates; JoinSpec does not admit them", () => {
    // Never called — the assertions are the types and the `@ts-expect-error`s.
    const _typesOnly = (
      j: AllJoinRefs<
        (typeof tasks)["_"]["columns"],
        [typeof att, typeof blocking]
      >,
    ) => {
      const completed: AggregateRef<"att", "hasCompleted", boolean> =
        j.att.hasCompleted;
      const anyConv: AggregateRef<"att", "anyConv", boolean | null> =
        j.att.anyConv;
      const list: AggregateRef<
        "att",
        "list",
        { id: string; createdAt: string; note: string | null }[]
      > = j.att.list;
      const blocked: AggregateRef<"blocking", "hasBlocking", boolean> =
        j.blocking.hasBlocking;
      // @ts-expect-error — a raw child column is not a value of the host
      void j.att.status;
      // @ts-expect-error — nor an undeclared aggregate
      void j.blocking.nope;
      void j.base.id;
      void [completed, anyConv, list, blocked];

      const noIfNone = {
        decoder: Number,
        sqlType: "integer",
        notNull: true,
      } as const;
      // @ts-expect-error — a non-null aggregate states what an empty group reads (A33)
      aggregate(sql`count(*)`, noIfNone);

      const all: AllJoinSpec = att;
      // @ts-expect-error — every non-`all` compile takes `JoinSpec`, which has no children join (C9)
      const windowJoin: JoinSpec = att;
      // @ts-expect-error — nor a closure
      const windowJoin2: JoinSpec = blocking;
      void [all, windowJoin, windowJoin2];

      childrenJoin({
        alias: "x",
        table: attempts,
        fk: attempts.taskId,
        aggregates: (c) => {
          // @ts-expect-error — the child relation is the join's own alias
          void c.att;
          // @ts-expect-error — and offers only its table's columns
          void c.x.nope;
          return {};
        },
      });

      // A rollup is LEFT-joined: its NOT NULL columns still read NULL for a
      // host with no rollup row, so a jsonAgg element over one is `| null`.
      // The refs come from the rollup's own handle (no `table` to declare).
      const nested = childrenJoin({
        alias: "a2",
        table: attempts,
        fk: attempts.taskId,
        rollups: [
          {
            kind: "rollup",
            alias: "conv",
            rollup: convRollup,
            on: attempts.id,
          },
        ],
        aggregates: (c) => ({
          items: jsonAgg(
            { id: c.a2.id, hasConv: c.conv.hasConv },
            { orderBy: [[c.a2.id, "asc"]] },
          ),
        }),
      });
      const items: AggregateRef<
        "a2",
        "items",
        { id: string; hasConv: boolean | null }[]
      > = null as unknown as AllJoinRefs<
        (typeof tasks)["_"]["columns"],
        [typeof nested]
      >["a2"]["items"];
      type NestedElement = AggregateValue<
        ReturnType<(typeof nested)["aggregates"]>["items"]
      >[number];
      // @ts-expect-error — a rollup column is never non-null inside the aggregate
      const strict: { id: string; hasConv: boolean } = {} as NestedElement;
      void [items, strict];
    };
    void _typesOnly;
  });
});
