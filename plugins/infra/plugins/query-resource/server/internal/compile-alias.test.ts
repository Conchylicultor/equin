/**
 * The `all` compiler (P8 v3 step 16b.5 — §4.1, C2/C3/C5/C7/C18, A29, A32,
 * A35, A37, A38, A39, A40): `compileAllCollection` over a tasks-shaped
 * declaration — a required (INNER) lookup, a top-level rollup, two children
 * joins (one with a nested rollup and a `jsonAgg`), and a closure whose
 * ancestors carry a children join — compiled against the recording `QueryDb`.
 *
 * Pinned here: the shapes' SQL (the CTE set, unquoted CTE names, the scoped
 * planner fences, the orderIds joins), the relations each shape reads, the
 * routes and their gates, the uses, the loaders' decoding, the dependents
 * probe, the definition's stability and sensitivity, and every bind-time
 * refusal. The DB-backed oracles are `compile-alias-closure.test.ts` (A23)
 * and tasks-core's `all-parity.test.ts`.
 *
 * Run: `./equin test plugins/infra/plugins/query-resource`.
 */

import { describe, expect, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { quotedRelationsIn } from "@plugins/database/server";
import { defineRollup } from "@plugins/database/plugins/derived-tables/core";
import {
  ATTEMPT_CONV_AGG_TABLE,
  TASK_LATEST_CONVERSATION_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import {
  parsedText,
  withWire,
} from "@plugins/database/plugins/sql-column/server";
import {
  nullable,
  parsed,
} from "@plugins/database/plugins/sql-projection/server";
import {
  aggregate,
  BASE_RELATION,
  childrenJoin,
  closureJoin,
  expr,
  jsonAgg,
  type AllJoinSpec,
  type AllQueryResourceContract,
  type LookupJoin,
  type PointQueryResourceContract,
} from "@plugins/infra/plugins/query-resource/core";
import { recordingQueryDb, type RecordedQuery } from "../testing/recording-db";
import { compileAllCollection, type AllCollectionSpec } from "./compile-alias";
import { CTE_NAME_RE, WITHIN_IN_SQL_MAX } from "./grouped";

// ── The schema ───────────────────────────────────────────────────────────────

const owners = pgTable("a_owners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const tasks = pgTable("a_tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: text("owner_id").notNull(),
  heldAt: timestamp("held_at", { withTimezone: true }),
  droppedAt: timestamp("dropped_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  secret: text("secret"),
});
const attempts = pgTable(
  "a_attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    cost: numeric("cost"),
  },
  (t) => [index("a_attempts_task_id_idx").on(t.taskId)],
);
const deps = pgTable(
  "a_deps",
  {
    taskId: text("task_id").notNull(),
    dependsOn: text("depends_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOn] }),
    index("a_deps_depends_on_idx").on(t.dependsOn),
  ],
);
const conversations = pgTable(
  "a_conversations",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
    status: text("status").notNull(),
    waitingFor: text("waiting_for"),
  },
  (t) => [index("a_conversations_attempt_id_idx").on(t.attemptId)],
);
const convAggT = pgTable(ATTEMPT_CONV_AGG_TABLE, {
  attemptId: text("attempt_id").primaryKey(),
  hasConv: boolean("has_conv").notNull(),
  hasLive: boolean("has_live"),
});
const convAgg = defineRollup({
  table: convAggT,
  key: convAggT.attemptId,
  select: (scope) =>
    `SELECT c.attempt_id, true AS has_conv, bool_or(c.status <> 'done') AS has_live
       FROM a_conversations c WHERE ${scope("c.attempt_id")} GROUP BY c.attempt_id`,
  sources: [
    {
      table: conversations,
      carry: conversations.attemptId,
      reads: [conversations.status],
    },
  ],
});

// ── A10 / A35 fixtures: rollups under a children join and a closure ─────────

const latestT = pgTable(TASK_LATEST_CONVERSATION_TABLE, {
  taskId: text("task_id").primaryKey(),
  status: text("status"),
});
type SourceSpec = Parameters<typeof defineRollup>[0]["sources"][number];
/** attempt_id → its conversations, with `extra` sources beside them. */
const convAggWith = (extra: readonly SourceSpec[]) =>
  defineRollup({
    table: convAggT,
    key: convAggT.attemptId,
    select: (scope) =>
      `SELECT c.attempt_id, true AS has_conv, bool_or(c.status <> 'done') AS has_live
         FROM a_conversations c JOIN a_attempts a ON a.id = c.attempt_id
        WHERE ${scope("c.attempt_id")} GROUP BY c.attempt_id`,
    sources: [
      ...extra,
      {
        table: conversations,
        carry: conversations.attemptId,
        reads: [conversations.status],
      },
    ],
  });
/** task_id → its latest conversation, through the attempts hop, with `sources` before it. */
const latestWith = (sources: readonly SourceSpec[]) =>
  defineRollup({
    table: latestT,
    key: latestT.taskId,
    select: (scope) =>
      `SELECT DISTINCT ON (a.task_id) a.task_id, c.status
         FROM a_conversations c JOIN a_attempts a ON a.id = c.attempt_id
        WHERE ${scope("a.task_id")} ORDER BY a.task_id, c.id DESC`,
    sources: [
      ...sources,
      {
        table: conversations,
        carry: conversations.attemptId,
        via: { table: attempts, match: attempts.id, key: attempts.taskId },
        reads: [conversations.status],
      },
    ],
  });
/** `bool_or(<the rollup's `col`> IS NOT NULL)`, whichever rollup `refs` is. */
const anyNotNull = (refs: unknown, col: string) =>
  aggregate(sql`bool_or(${(refs as Record<string, SQL>)[col]!} IS NOT NULL)`, {
    decoder: Boolean,
    sqlType: "boolean",
  });
/** A children join over attempts whose one nested rollup is `rollup`, keyed by `on`. */
const attOver = (
  rollup: ReturnType<typeof defineRollup>,
  on: typeof attempts.id | typeof attempts.taskId,
  col: string,
) =>
  childrenJoin({
    alias: "att",
    table: attempts,
    fk: attempts.taskId,
    rollups: [{ kind: "rollup", alias: "r", rollup, on }],
    aggregates: (c) => ({ any: anyNotNull(c.r, col) }),
  });
/** A closure whose ancestors carry `rollup` (keyed by the task id). */
const blockingOver = (rollup: ReturnType<typeof defineRollup>) =>
  closureJoin({
    alias: "blocking",
    edges: deps,
    child: deps.taskId,
    parent: deps.dependsOn,
    nodes: tasks,
    ancestorJoins: [{ kind: "rollup", alias: "r", rollup, on: tasks.id }],
    aggregates: (c) => ({ any: anyNotNull(c.r, "status") }),
  });
/** A one-join declaration reading `alias`'s `any` aggregate. */
const oneJoin = (
  join: AllJoinSpec,
  alias: string,
): AllCollectionSpec<typeof tasks, readonly AllJoinSpec[]> => ({
  from: tasks,
  joins: [join],
  select: ({ j, render, aggregate: agg }) => ({
    id: render(j.base.id),
    createdAt: render(j.base.createdAt),
    any: agg((j as unknown as Record<string, { any: never }>)[alias]!.any),
  }),
});
const routeMaps = (key: string, s: ReturnType<typeof oneJoin>) =>
  Object.fromEntries(
    compileAllCollection(contracts(key), {
      ...s,
      db: recordingQueryDb(script).db,
    }).all.routes!.routes.map((r) => [
      r.id,
      r.map.kind === "full" ? `full: ${r.map.reason}` : r.map.kind,
    ]),
  );

// ── The declaration ──────────────────────────────────────────────────────────

const owner: LookupJoin<"owner", typeof owners> = {
  kind: "lookup",
  alias: "owner",
  table: owners,
  pk: owners.id,
  on: { from: BASE_RELATION, col: tasks.ownerId },
  required: true,
};
const att = childrenJoin({
  alias: "att",
  table: attempts,
  fk: attempts.taskId,
  rollups: [
    { kind: "rollup", alias: "conv", rollup: convAgg, on: attempts.id },
  ],
  where: (c) => sql`${c.att.status} <> 'system'`,
  aggregates: (c) => ({
    hasCompleted: aggregate(sql`bool_or(${c.att.status} = 'completed')`, {
      decoder: Boolean,
      sqlType: "boolean",
      notNull: true,
      ifNone: sql`false`,
    }),
    anyLive: aggregate(sql`bool_or(${c.conv.hasLive})`, {
      decoder: Boolean,
      sqlType: "boolean",
    }),
    list: jsonAgg(
      { id: c.att.id, createdAt: c.att.createdAt, live: c.conv.hasLive },
      { orderBy: [[c.att.createdAt, "asc"]] },
    ),
  }),
});
const depList = childrenJoin({
  alias: "deps",
  table: deps,
  fk: deps.taskId,
  aggregates: (c) => ({
    ids: aggregate(
      sql`array_agg(${c.deps.dependsOn} ORDER BY ${c.deps.createdAt})`,
      {
        decoder: parsed(z.array(z.string()), "deps.ids"),
        sqlType: "text[]",
        notNull: true,
        ifNone: sql`ARRAY[]::text[]`,
      },
    ),
  }),
});
const ancAtt = childrenJoin({
  alias: "att",
  table: attempts,
  fk: attempts.taskId,
  aggregates: (c) => ({
    done: aggregate(sql`bool_or(${c.att.status} = 'completed')`, {
      decoder: Boolean,
      sqlType: "boolean",
      notNull: true,
      ifNone: sql`false`,
    }),
  }),
});
const blocking = closureJoin({
  alias: "blocking",
  edges: deps,
  child: deps.taskId,
  parent: deps.dependsOn,
  nodes: tasks,
  ancestorJoins: [ancAtt],
  aggregates: (c) => ({
    blocked: aggregate(
      sql`bool_or(${c.anc.droppedAt} IS NULL AND NOT ${c.att.done})`,
      {
        decoder: Boolean,
        sqlType: "boolean",
        notNull: true,
        ifNone: sql`false`,
      },
    ),
  }),
});

interface Row {
  id: string;
}

function contracts(
  key: string,
  orderBy: readonly (readonly [string, "asc" | "desc"])[] = [
    ["createdAt", "desc"],
  ],
  bound: { max: number } | { unbounded: { reason: string } } = {
    unbounded: { reason: "a test set" },
  },
) {
  const all = {
    key,
    schema: z.array(z.object({ id: z.string() }).passthrough()),
    keyed: { keyOf: (r: unknown) => (r as Row).id },
    all: { orderBy, ...bound },
    queryPk: "id",
  } as unknown as AllQueryResourceContract<Row>;
  const rows = {
    key: `${key}:rows`,
    queryPk: "id",
    point: {
      decode: (p: Record<string, string>) =>
        p.ids === "" || p.ids === undefined ? [] : p.ids!.split(","),
      encode: (ids: readonly string[]) => ({ ids: [...ids].sort().join(",") }),
    },
  } as unknown as PointQueryResourceContract<Row>;
  return { all, rows };
}

const JOINS = [owner, att, depList, blocking] as const;

function spec(
  overrides: Partial<AllCollectionSpec<typeof tasks, typeof JOINS>> = {},
): AllCollectionSpec<typeof tasks, typeof JOINS> {
  return {
    from: tasks,
    joins: JOINS,
    select: ({ j, render, aggregate: agg, expr: ex }) => ({
      id: render(j.base.id),
      title: render(j.base.title),
      createdAt: render(j.base.createdAt),
      ownerName: render(j.owner.name),
      hasCompleted: agg(j.att.hasCompleted),
      anyLive: agg(j.att.anyLive),
      attempts: agg(j.att.list),
      dependencies: agg(j.deps.ids),
      blocked: agg(j.blocking.blocked),
      status: ex(
        expr(
          sql`CASE WHEN ${j.base.heldAt} IS NOT NULL THEN 'held' WHEN ${j.att.hasCompleted} THEN 'done' WHEN ${j.blocking.blocked} THEN 'blocked' ELSE 'new' END`,
          { decoder: String, sqlType: "text", notNull: true },
        ),
        "status",
      ),
    }),
    where: sql`${tasks.droppedAt} IS NULL`,
    ...overrides,
  };
}

// The same declaration as `spec()`, its `att` join's `hasCompleted` decoder
// and nested rollup swappable — every other byte of SQL identical.
const attWith = (o: {
  decoder?: (v: unknown) => boolean;
  rollup?: typeof convAgg;
}) =>
  childrenJoin({
    alias: "att",
    table: attempts,
    fk: attempts.taskId,
    rollups: [
      {
        kind: "rollup",
        alias: "conv",
        rollup: o.rollup ?? convAgg,
        on: attempts.id,
      },
    ],
    where: (c) => sql`${c.att.status} <> 'system'`,
    aggregates: (c) => ({
      hasCompleted: aggregate(sql`bool_or(${c.att.status} = 'completed')`, {
        decoder: o.decoder ?? Boolean,
        sqlType: "boolean",
        notNull: true,
        ifNone: sql`false`,
      }),
      anyLive: aggregate(sql`bool_or(${c.conv.hasLive})`, {
        decoder: Boolean,
        sqlType: "boolean",
      }),
      list: jsonAgg(
        { id: c.att.id, createdAt: c.att.createdAt, live: c.conv.hasLive },
        { orderBy: [[c.att.createdAt, "asc"]] },
      ),
    }),
  });
const withAtt = (o: Parameters<typeof attWith>[0]) =>
  spec({ joins: [owner, attWith(o), depList, blocking] as never });

const ROW = {
  id: "t1",
  title: "T",
  createdAt: "2026-10-06 10:00:00+00",
  ownerName: "o",
  hasCompleted: false,
  anyLive: null,
  attempts: [],
  dependencies: [],
  blocked: false,
  status: "new",
};

/** `ROW` decoded: the timestamptz column's driver string read as a `Date`. */
const DECODED = { ...ROW, createdAt: new Date("2026-10-06T10:00:00Z") };

function script(q: RecordedQuery): unknown[] {
  if (/^SELECT \S+ AS __id /.test(q.sql))
    return [{ __id: "t2" }, { __id: "t1" }];
  if (q.sql.startsWith("SELECT DISTINCT")) return [{ __h: "t1" }];
  if (q.sql.startsWith("WITH RECURSIVE __d_")) {
    return [{ __n: "t3" }, { __n: "t4" }];
  }
  return [ROW];
}

function compile(key: string, s = spec()) {
  const rec = recordingQueryDb(script);
  const out = compileAllCollection(contracts(key), { ...s, db: rec.db });
  return { ...out, calls: rec.calls };
}

const last = (calls: RecordedQuery[]): RecordedQuery => calls.at(-1)!;

/** Await `p` and return the Error it rejected with; throw if it resolved. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("the shapes", () => {
  test("Full: the CTE set, the row-wise joins, the grouped joins, the order", async () => {
    const c = compile("a-full");
    const rows = await c.all.loader({});
    const q = last(c.calls).sql;
    expect(q.startsWith("WITH RECURSIVE __c_att AS (")).toBe(true);
    // Every CTE, in dependency order, named unquoted (A38).
    const ctes = [
      ...q.matchAll(/(?:WITH RECURSIVE |, )(__[a-z0-9_]+) AS \(/g),
    ].map((m) => m[1]!);
    expect(ctes).toEqual([
      "__c_att",
      "__c_deps",
      "__x_blocking",
      "__c_blocking__anc__att",
      "__g_blocking",
    ]);
    for (const name of ctes) expect(CTE_NAME_RE.test(name)).toBe(true);
    expect(q).toContain(
      `INNER JOIN "a_owners" "owner" ON "owner"."id" = "a_tasks"."owner_id"`,
    );
    expect(q).toContain(`LEFT JOIN __c_att ON __c_att.__k = "a_tasks"."id"`);
    expect(q).toContain(
      `LEFT JOIN __g_blocking ON __g_blocking.__k = "a_tasks"."id"`,
    );
    // The children CTE: its where, its nested rollup, grouped by the fk.
    expect(q).toContain(
      `LEFT JOIN "attempt_conv_agg" "att__conv" ON "att__conv"."attempt_id" = "att"."id"`,
    );
    expect(q).toContain(`GROUP BY "att"."task_id"`);
    // jsonAgg: a timestamptz as its ISO text, ordered with the pk tiebreaker.
    expect(q).toContain(
      `json_agg(json_build_object('id', "att"."id", 'createdAt', to_char("att"."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'live', "att__conv"."has_live") ORDER BY "att"."created_at" ASC NULLS LAST, "att"."id" ASC)`,
    );
    // The full closure is one recursive UNION over the edges.
    expect(q).toContain(
      `__x_blocking AS (SELECT "blocking"."task_id" AS __n, "blocking"."depends_on" AS __a FROM "a_deps" "blocking" UNION SELECT __x_blocking.__n, "blocking"."depends_on" FROM __x_blocking JOIN "a_deps" "blocking" ON "blocking"."task_id" = __x_blocking.__a)`,
    );
    expect(q).toContain(
      `(COALESCE(__c_att."hasCompleted", false)) AS "hasCompleted"`,
    );
    expect(q).toContain(`(COALESCE(__c_att."list", '[]'::json)) AS "attempts"`);
    expect(q).toContain(`(__c_att."anyLive") AS "anyLive"`);
    expect(q).toContain(`WHERE "a_tasks"."dropped_at" IS NULL ORDER BY`);
    expect(q).toMatch(
      /ORDER BY "a_tasks"\."created_at" DESC NULLS LAST, "a_tasks"\."id" ASC NULLS LAST$/,
    );
    // The relations it reads are exactly the routed ones and the rollup.
    expect(new Set(quotedRelationsIn(q))).toEqual(
      new Set([
        "a_attempts",
        "attempt_conv_agg",
        "a_deps",
        "a_tasks",
        "a_owners",
      ]),
    );
    expect(rows).toEqual([DECODED as never]);
  });

  test("Scoped: the same CTEs for the hosts asked, the planner fences pinned (A32), no ORDER BY", async () => {
    const c = compile("a-scoped");
    await c.all.loader({}, { affectedIds: ["t1", "t2"] });
    const q = last(c.calls);
    expect(q.sql).not.toContain('ORDER BY "a_tasks"');
    expect(q.sql).toContain(`__c_att AS (SELECT "att"."task_id" AS __k`);
    expect(q.sql).toContain(
      `WHERE ("att"."status" <> 'system' and "att"."task_id" = ANY($`,
    );
    // A32: the walk is a fenced lateral, the ancestors' groups an InitPlan,
    // the ancestor row a pk lateral.
    expect(q.sql).toContain(
      `UNION SELECT __x_blocking.__n, __y.__a FROM __x_blocking CROSS JOIN LATERAL (SELECT "blocking"."depends_on" AS __a FROM "a_deps" "blocking" WHERE "blocking"."task_id" = __x_blocking.__a OFFSET 0) __y`,
    );
    expect(q.sql).toContain(
      `"blocking__anc__att"."task_id" = ANY(ARRAY(SELECT DISTINCT __x_blocking.__a FROM __x_blocking))`,
    );
    expect(q.sql).toContain(
      `CROSS JOIN LATERAL (SELECT * FROM "a_tasks" "blocking__anc" WHERE "blocking__anc"."id" = __x_blocking.__a OFFSET 0) "blocking__anc"`,
    );
    expect(q.sql).toMatch(
      /WHERE \("a_tasks"\."dropped_at" IS NULL and "a_tasks"\."id" = ANY\(\$\d+::text\[\]\)\)$/,
    );
    expect(q.params.filter((p) => Array.isArray(p))).toEqual([
      ["t1", "t2"],
      ["t1", "t2"],
      ["t1", "t2"],
      ["t1", "t2"],
    ]);
  });

  test("orderIds: the base, the INNER lookup and the where's joins only (A29), ordered with the pk", async () => {
    const c = compile("a-order");
    const policy = c.all as unknown as {
      scopedMembership: {
        orderOf(p: object): Promise<string[]>;
        orderSignatureOf(row: unknown, p: object): string;
      };
    };
    expect(await policy.scopedMembership.orderOf({})).toEqual(["t2", "t1"]);
    expect(last(c.calls).sql).toBe(
      `SELECT "a_tasks"."id" AS __id FROM "a_tasks" INNER JOIN "a_owners" "owner" ON "owner"."id" = "a_tasks"."owner_id" WHERE "a_tasks"."dropped_at" IS NULL ORDER BY "a_tasks"."created_at" DESC NULLS LAST, "a_tasks"."id" ASC NULLS LAST`,
    );
    expect(
      policy.scopedMembership.orderSignatureOf(
        { id: "t1", createdAt: "x" },
        {},
      ),
    ).toBe(`"x"`);
  });

  test(":rows reads the subscribed ids (absent policy), nothing for none", async () => {
    const c = compile("a-rows");
    expect(await c.rows.loader({ ids: "" })).toEqual([]);
    const before = c.calls.length;
    expect(await c.rows.loader({ ids: "t1" })).toEqual([DECODED as never]);
    expect(c.calls.length).toBe(before + 1);
    expect(last(c.calls).sql).toContain(`"a_tasks"."id" = ANY($`);
    const m = c.rows as unknown as {
      membership: { kind: string; idsOf(p: object): readonly string[] };
    };
    expect(m.membership.kind).toBe("point");
    expect(m.membership.idsOf({ ids: "a,b" })).toEqual(["a", "b"]);
  });

  test("a capped set (`all: { max }`): the full and orderIds shapes read one row past the cap, and a set that outgrew it fails loudly", async () => {
    let n = 2;
    const rec = recordingQueryDb((q) =>
      /^SELECT \S+ AS __id /.test(q.sql)
        ? Array.from({ length: n }, (_, i) => ({ __id: `t${i}` }))
        : Array.from({ length: n }, (_, i) => ({ ...ROW, id: `t${i}` })),
    );
    const c = compileAllCollection(contracts("a-max", undefined, { max: 2 }), {
      ...spec(),
      db: rec.db,
    });
    const policy = c.all as unknown as {
      scopedMembership: { orderOf(p: object): Promise<string[]> };
    };
    expect(await c.all.loader({})).toHaveLength(2);
    expect(last(rec.calls).sql).toMatch(/ NULLS LAST LIMIT 3$/);
    expect(await policy.scopedMembership.orderOf({})).toEqual(["t0", "t1"]);
    expect(last(rec.calls).sql).toMatch(/ NULLS LAST LIMIT 3$/);
    // The scoped refill names its hosts: no LIMIT.
    await c.all.loader({}, { affectedIds: ["t0"] });
    expect(last(rec.calls).sql).not.toContain("LIMIT");
    n = 3;
    expect(
      (await rejection(Promise.resolve(c.all.loader({})))).message,
    ).toMatch(/allCollection\("a-max"\): the full shape read more than 2 rows/);
    expect(
      (await rejection(policy.scopedMembership.orderOf({}))).message,
    ).toMatch(/the orderIds shape read more than 2 rows/);
    // An unbounded set's SQL has no LIMIT (its definition is unchanged).
    const whole = compile("a-max-whole");
    await whole.all.loader({});
    expect(last(whole.calls).sql).not.toContain("LIMIT");
  });

  test("debounceMs passes through to the whole set only (C18)", () => {
    const c = compile("a-debounce", spec({ debounceMs: 250 }));
    expect((c.all as { debounceMs?: number }).debounceMs).toBe(250);
    expect((c.rows as { debounceMs?: number }).debounceMs).toBeUndefined();
    expect(
      (compile("a-nodebounce").all as { debounceMs?: number }).debounceMs,
    ).toBeUndefined();
  });
});

describe("routes and uses", () => {
  test("every grouped join is routed through its own tables, gated by what it reads", () => {
    const c = compile("a-routes");
    const routes = c.all.routes!.routes.map((r) => ({
      id: r.id,
      table: r.table,
      columns: r.columns,
      map: r.map.kind,
      column: "column" in r.map ? r.map.column : undefined,
    }));
    expect(routes).toEqual([
      {
        id: "base",
        table: "a_tasks",
        columns: [
          "id",
          "title",
          "owner_id",
          "held_at",
          "dropped_at",
          "created_at",
        ],
        map: "identity",
        column: undefined,
      },
      {
        id: "owner",
        table: "a_owners",
        columns: ["id", "name"],
        map: "reverse",
        column: undefined,
      },
      {
        id: "att",
        table: "a_attempts",
        columns: ["id", "task_id", "status", "created_at"],
        map: "alias",
        column: "task_id",
      },
      {
        id: "att__conv[a_conversations]",
        table: "a_conversations",
        columns: ["attempt_id", "id", "status"],
        map: "reverse",
        column: "attempt_id",
      },
      {
        id: "deps",
        table: "a_deps",
        columns: ["task_id", "depends_on", "created_at"],
        map: "alias",
        column: "task_id",
      },
      {
        id: "blocking",
        table: "a_deps",
        columns: ["task_id", "depends_on"],
        map: "alias",
        column: "task_id",
      },
      {
        id: "blocking:closure",
        table: "a_deps",
        columns: ["task_id", "depends_on"],
        map: "reverse",
        column: "task_id",
      },
      {
        id: "blocking__anc:closure",
        table: "a_tasks",
        columns: ["id", "dropped_at"],
        map: "reverse",
        column: undefined,
      },
      {
        id: "blocking__anc__att:closure",
        table: "a_attempts",
        columns: ["id", "task_id", "status"],
        map: "reverse",
        column: "task_id",
      },
    ]);
    expect(c.all.routes!.derivedReads).toEqual([
      { table: ATTEMPT_CONV_AGG_TABLE, sources: ["a_conversations"] },
    ]);
  });

  test("uses: the base and the INNER lookup as membership, every grouped route as value", () => {
    const c = compile("a-uses");
    const uses = Object.fromEntries(c.all.routes!.usesOf({}));
    expect(uses).toEqual({
      base: {
        role: "membership",
        moves: ["created_at", "dropped_at", "owner_id"],
      },
      owner: { role: "membership", moves: ["id"] },
      att: { role: "value" },
      "att__conv[a_conversations]": { role: "value" },
      deps: { role: "value" },
      blocking: { role: "value" },
      "blocking:closure": { role: "value" },
      "blocking__anc:closure": { role: "value" },
      "blocking__anc__att:closure": { role: "value" },
    });
    // `:rows` reads the same relations.
    expect(Object.fromEntries(c.rows.routes!.usesOf({ ids: "t1" }))).toEqual(
      uses,
    );
  });

  test("a nested rollup's source resolves through the child rows to their hosts", async () => {
    const c = compile("a-nested");
    const route = c.all.routes!.routes.find(
      (r) => r.id === "att__conv[a_conversations]",
    )!;
    if (route.map.kind !== "reverse") throw new Error("not a reverse route");
    expect(await route.map.resolve(["a1"], new Set(["t1", "t9"]), 10)).toEqual([
      "t1",
    ]);
    expect(last(c.calls).sql).toBe(
      `SELECT DISTINCT "att"."task_id" AS __h FROM "a_attempts" "att" WHERE ("att"."id" = ANY($1::text[]) and "att"."task_id" = ANY($2::text[])) LIMIT $3`,
    );
    expect(await route.map.resolve([], null, 10)).toEqual([]);
    expect(await route.map.resolve(["a1"], new Set(), 10)).toEqual([]);
  });

  test("the dependents probe walks DOWN the edges by a fenced lateral; `within` in SQL up to its bound, else in JS", async () => {
    const c = compile("a-deps");
    const route = c.all.routes!.routes.find(
      (r) => r.id === "blocking:closure",
    )!;
    if (route.map.kind !== "reverse") throw new Error("not a reverse route");
    expect(await route.map.resolve(["t1"], null, 10)).toEqual(["t3", "t4"]);
    expect(last(c.calls).sql).toBe(
      `WITH RECURSIVE __d_blocking AS (SELECT "blocking"."task_id" AS __n FROM "a_deps" "blocking" WHERE "blocking"."depends_on" = ANY($1::text[]) UNION SELECT __y.__n FROM __d_blocking CROSS JOIN LATERAL (SELECT "blocking"."task_id" AS __n FROM "a_deps" "blocking" WHERE "blocking"."depends_on" = __d_blocking.__n OFFSET 0) __y) SELECT __d_blocking.__n AS __n FROM __d_blocking LIMIT $2`,
    );
    await route.map.resolve(["t1"], new Set(["t3"]), 10);
    expect(last(c.calls).sql).toContain(
      `FROM __d_blocking WHERE __d_blocking.__n = ANY($2::text[]) LIMIT $3`,
    );
    const many = new Set(
      Array.from({ length: WITHIN_IN_SQL_MAX + 1 }, (_, i) => `x${i}`),
    );
    many.add("t4");
    expect(await route.map.resolve(["t1"], many, 10)).toEqual(["t4"]);
    expect(last(c.calls).sql).toContain(`FROM __d_blocking LIMIT $2`);
    expect(await route.map.resolve(["t1"], null, 1)).toBe("over-cap");
    // An ancestor's own write and its children's expand the same way.
    const anc = c.all.routes!.routes.find(
      (r) => r.id === "blocking__anc__att:closure",
    )!;
    if (anc.map.kind !== "reverse") throw new Error("not a reverse route");
    expect(await anc.map.resolve(["t1"], null, 10)).toEqual(["t3", "t4"]);
  });
  test("A10: a nested or ancestor rollup source on a table the hosts are resolved through is full, pre-image needed", () => {
    const preImage = (src: string, route: string) =>
      `full: pre-image needed: rollup source "${src}" (route "${route}") is resolved through "${src}" itself, which the hosts are resolved through — read after commit, the probe would see the rows that changed, not the ones they were (A10)`;
    // Under a children join over attempts: a source on the child table itself.
    const children = routeMaps(
      "a-a10-children",
      oneJoin(
        attOver(
          convAggWith([
            { table: attempts, carry: attempts.id, reads: [attempts.status] },
          ]),
          attempts.id,
          "hasLive",
        ),
        "att",
      ),
    );
    expect(children["att__r[a_attempts]"]).toBe(
      preImage("a_attempts", "att__r[a_attempts]"),
    );
    expect(children["att__r[a_conversations]"]).toBe("reverse");
    // Under a closure's ancestors: sources on the base and on the edges are
    // full; the hop source and the source read through it stay reverse.
    const closure = routeMaps(
      "a-a10-closure",
      oneJoin(
        blockingOver(
          latestWith([
            { table: tasks, carry: tasks.id, reads: [tasks.title] },
            { table: deps, carry: deps.taskId, reads: [] },
            { table: attempts, carry: attempts.taskId, reads: [] },
          ]),
        ),
        "blocking",
      ),
    );
    expect(closure["blocking__anc__r[a_tasks]:closure"]).toBe(
      preImage("a_tasks", "blocking__anc__r[a_tasks]:closure"),
    );
    expect(closure["blocking__anc__r[a_deps]:closure"]).toBe(
      preImage("a_deps", "blocking__anc__r[a_deps]:closure"),
    );
    expect(closure["blocking__anc__r[a_attempts]:closure"]).toBe("reverse");
    expect(closure["blocking__anc__r[a_conversations]:closure"]).toBe(
      "reverse",
    );
  });
});

describe("the definition (A18 / A40)", () => {
  test("is a sha256, equal for two compiles of one declaration", () => {
    const a = compile("a-def-1");
    const b = compile("a-def-1");
    expect(a.definition).toMatch(/^[0-9a-f]{64}$/);
    expect(b.definition).toBe(a.definition);
    expect(a.all.routes!.definition).toBe(a.definition);
    expect(a.rows.routes!.definition).toBeUndefined();
  });

  test("moves with the SQL, the order and the wire ids", () => {
    const base = compile("a-def-2").definition;
    expect(
      compile("a-def-2", spec({ where: sql`${tasks.heldAt} IS NULL` }))
        .definition,
    ).not.toBe(base);
    expect(
      compileAllCollection(contracts("a-def-2", [["title", "asc"]]), {
        ...spec(),
        db: recordingQueryDb(script).db,
      }).definition,
    ).not.toBe(base);
    const wire = (id: string) =>
      spec({ wire: { encodeRow: (row) => row, ids: { title: id } } });
    const withWireA = compile("a-def-2", wire("codec:a")).definition;
    expect(withWireA).not.toBe(base);
    expect(compile("a-def-2", wire("codec:b")).definition).not.toBe(withWireA);
  });

  test("moves with an aggregate's decoder alone, the SQL unchanged", async () => {
    const a = compile("a-def-4", withAtt({}));
    expect(a.definition).toBe(compile("a-def-4").definition);
    const b = compile(
      "a-def-4",
      withAtt({ decoder: parsed(z.boolean(), "att.hasCompleted") }),
    );
    expect(b.definition).not.toBe(a.definition);
    // A parsed decoder's schema is part of it, not only its label.
    const c = compile(
      "a-def-4",
      withAtt({
        decoder: parsed(
          z.literal(true).or(z.literal(false)),
          "att.hasCompleted",
        ),
      }),
    );
    expect(c.definition).not.toBe(b.definition);
    // The rendered SQL is the same for all three.
    await a.all.loader({});
    await b.all.loader({});
    expect(last(b.calls).sql).toBe(last(a.calls).sql);
  });

  test("moves with an expression's decoder alone, through nullable", () => {
    const status = (decoder: (v: unknown) => unknown) =>
      spec({
        select: ({ j, render, aggregate: agg, expr: ex }) => ({
          id: render(j.base.id),
          createdAt: render(j.base.createdAt),
          hasCompleted: agg(j.att.hasCompleted),
          anyLive: agg(j.att.anyLive),
          attempts: agg(j.att.list),
          dependencies: agg(j.deps.ids),
          blocked: agg(j.blocking.blocked),
          ownerName: render(j.owner.name),
          status: ex(
            expr(sql`CASE WHEN ${j.base.heldAt} IS NULL THEN 'new' END`, {
              decoder,
              sqlType: "text",
            }),
            "status",
          ),
        }),
      });
    const plain = compile("a-def-5", status(String)).definition;
    const wrapped = compile("a-def-5", status(nullable(String))).definition;
    const enumd = compile(
      "a-def-5",
      status(nullable(parsed(z.enum(["new"]), "status"))),
    ).definition;
    expect(new Set([plain, wrapped, enumd]).size).toBe(3);
  });

  test("moves with the row schema alone", () => {
    const base = compile("a-def-6").definition;
    const c = contracts("a-def-6");
    const narrowed = {
      ...c,
      all: {
        ...c.all,
        schema: z.array(z.object({ id: z.string().min(1) }).passthrough()),
      },
    } as typeof c;
    expect(
      compileAllCollection(narrowed, {
        ...spec(),
        db: recordingQueryDb(script).db,
      }).definition,
    ).not.toBe(base);
  });

  test("moves with a rollup's DDL alone", () => {
    const base = compile("a-def-7", withAtt({})).definition;
    const otherAgg = defineRollup({
      table: convAggT,
      key: convAggT.attemptId,
      select: (scope) =>
        `SELECT c.attempt_id, true AS has_conv, bool_or(c.status NOT IN ('done', 'failed')) AS has_live
           FROM a_conversations c WHERE ${scope("c.attempt_id")} GROUP BY c.attempt_id`,
      sources: [
        {
          table: conversations,
          carry: conversations.attemptId,
          reads: [conversations.status],
        },
      ],
    });
    expect(
      compile("a-def-7", withAtt({ rollup: otherAgg })).definition,
    ).not.toBe(base);
  });

  test("moves with a parsed decoder's literal default alone", () => {
    const withDefault = (d: boolean) =>
      compile(
        "a-def-8",
        withAtt({
          decoder: parsed(z.boolean().default(d), "att.hasCompleted"),
        }),
      ).definition;
    expect(withDefault(false)).not.toBe(withDefault(true));
    expect(withDefault(false)).toBe(withDefault(false));
  });

  test("moves with a parsedText column's schema alone", () => {
    const onStatus = (schema: z.ZodType<string, z.ZodTypeDef, string>) => {
      const t = pgTable("a_flat", {
        id: text("id").primaryKey(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
        status: parsedText("status", schema).notNull(),
      });
      return compileAllCollection(contracts("a-def-9"), {
        from: t,
        joins: [],
        select: ({ j, render }) => ({
          id: render(j.base.id),
          createdAt: render(j.base.createdAt),
          status: render(j.base.status),
        }),
        db: recordingQueryDb(script).db,
      }).definition;
    };
    const ab = onStatus(z.enum(["a", "b"]));
    expect(onStatus(z.enum(["a", "b"]))).toBe(ab);
    expect(onStatus(z.enum(["a", "b", "c"]))).not.toBe(ab);
    expect(onStatus(z.string())).not.toBe(ab);
  });

  test("refuses a non-literal param (A40)", () => {
    expect(() =>
      compile(
        "a-def-3",
        spec({ where: sql`${tasks.createdAt} > ${new Date(0)}` }),
      ),
    ).toThrow(/is \[object Date\], not a literal .*\(A40\)/);
  });
});

describe("bind-time refusals", () => {
  const refuses = (
    s: AllCollectionSpec<typeof tasks, readonly AllJoinSpec[]>,
    pattern: RegExp,
    orderBy?: readonly (readonly [string, "asc" | "desc"])[],
  ) =>
    expect(() =>
      compileAllCollection(contracts("a-bad", orderBy), {
        ...s,
        db: recordingQueryDb(script).db,
      }),
    ).toThrow(pattern);

  test("A29: an order field that reads no base column", () => {
    refuses(
      spec() as never,
      /the order field "ownerName" reads no base column .*\(A29\)/,
      [["ownerName", "asc"]],
    );
    refuses(spec() as never, /the order field "status" reads no base column/, [
      ["status", "asc"],
    ]);
  });

  test("a where reading an aggregate", () => {
    refuses(
      spec({
        where: ({ aggregate: agg, j }) => sql`NOT ${agg(j.blocking.blocked)}`,
      }) as never,
      /the `where` reads "blocking__anc"\."dropped_at", a grouped join's/,
    );
  });

  test("C7: a field that reads no relation column", () => {
    refuses(
      spec({
        select: ({ j, render, expr: ex }) => ({
          id: render(j.base.id),
          createdAt: render(j.base.createdAt),
          one: ex(
            expr(sql`1 + 1`, {
              decoder: Number,
              sqlType: "integer",
              notNull: true,
            }),
            "one",
          ),
        }),
        joins: [] as never,
      }) as never,
      /field "one" reads no relation column .*\(C7\)/,
    );
  });

  test("an unread grouped join", () => {
    refuses(
      spec({
        select: ({ j, render }) => ({
          id: render(j.base.id),
          createdAt: render(j.base.createdAt),
          ownerName: render(j.owner.name),
        }),
      }) as never,
      /the grouped join "att" is declared but no field reads an aggregate of it/,
    );
  });

  test("the key field must read the base primary key", () => {
    refuses(
      spec({
        select: ({ j, render }) => ({
          id: render(j.base.title),
          createdAt: render(j.base.createdAt),
        }),
        joins: [] as never,
      }) as never,
      /the key field "id" does not read the base table's primary key/,
    );
  });

  test("A38: a grouped alias that is not lower-snake", () => {
    const bad = childrenJoin({
      alias: "Att",
      table: attempts,
      fk: attempts.taskId,
      aggregates: (c) => ({
        n: aggregate(sql`count(${c.Att.id})`, {
          decoder: Number,
          sqlType: "integer",
        }),
      }),
    });
    refuses(
      { from: tasks, joins: [bad], select: () => ({}) },
      /alias "Att" is not lower-snake .*\(A38\)/,
    );
  });

  test("A37: an fk leading no index", () => {
    const bad = childrenJoin({
      alias: "convs",
      table: conversations,
      fk: conversations.waitingFor,
      aggregates: (c) => ({
        n: aggregate(sql`count(${c.convs.id})`, {
          decoder: Number,
          sqlType: "integer",
        }),
      }),
    });
    refuses(
      { from: tasks, joins: [bad], select: () => ({}) },
      /"a_conversations"\."waiting_for" leads no index .*\(A37\)/,
    );
  });

  test("A39: a jsonAgg column of another type", () => {
    const bad = childrenJoin({
      alias: "att",
      table: attempts,
      fk: attempts.taskId,
      aggregates: (c) => ({
        list: jsonAgg({ cost: c.att.cost }, { orderBy: [[c.att.id, "asc"]] }),
      }),
    });
    refuses(
      { from: tasks, joins: [bad], select: () => ({}) },
      /jsonAgg field "cost" is a numeric column .*\(A39\)/,
    );
  });

  test("a closure over another table than the base", () => {
    const bad = closureJoin({
      alias: "up",
      edges: deps,
      child: deps.taskId,
      parent: deps.dependsOn,
      nodes: owners,
      aggregates: (c) => ({
        n: aggregate(sql`count(${c.anc.id})`, {
          decoder: Number,
          sqlType: "integer",
        }),
      }),
    });
    refuses(
      { from: tasks, joins: [bad], select: () => ({}) },
      /its `nodes` is "a_owners", not the base table "a_tasks"/,
    );
  });

  test("A18: a decoder with no readable identity", () => {
    const anonymous = (v: unknown) => v === "t";
    refuses(
      withAtt({ decoder: anonymous }) as never,
      /field "hasCompleted"'s decoder is a function with no readable identity .*\(A18\)/,
    );
    function namedButOpaque(v: unknown): string {
      return String(v);
    }
    refuses(
      spec({
        select: ({ j, render, aggregate: agg, expr: ex }) => ({
          id: render(j.base.id),
          createdAt: render(j.base.createdAt),
          hasCompleted: agg(j.att.hasCompleted),
          attempts: agg(j.att.list),
          dependencies: agg(j.deps.ids),
          blocked: agg(j.blocking.blocked),
          ownerName: render(j.owner.name),
          status: ex(
            expr(sql`upper(${j.base.title})`, {
              decoder: namedButOpaque,
              sqlType: "text",
            }),
            "status",
          ),
        }),
      }) as never,
      /field "status"'s decoder is a function with no readable identity/,
    );
  });

  test("A18: a parsed schema whose output depends on a function body", () => {
    let n = 0;
    for (const [schema, part] of [
      [z.unknown().transform((v) => v === "t"), "a transform effect"],
      [z.preprocess((v) => v === "t", z.boolean()), "a preprocess effect"],
      [z.boolean().catch(false), "a catch value"],
      [
        z.boolean().default(() => n++ % 2 === 0),
        "a default that is not one JSON value",
      ],
      [z.promise(z.boolean()), "an unhandled ZodPromise"],
    ] as const) {
      refuses(
        withAtt({
          decoder: parsed(schema as never, "att.hasCompleted"),
        }) as never,
        new RegExp(
          `field "hasCompleted"'s decoder is \\\`parsed\\(…, "att\\.hasCompleted"\\)\\\` over a schema whose output depends on a function body \\(.*${part}.*\\) .*\\(A18\\)`,
        ),
      );
    }
  });

  test("A18: wire codecs with no id", () => {
    refuses(
      spec({ wire: { encodeRow: (row) => row, ids: {} } }) as never,
      /`wire\.ids` is empty/,
    );
  });

  test("a nested rollup no aggregate or where reads", () => {
    const bad = childrenJoin({
      alias: "att",
      table: attempts,
      fk: attempts.taskId,
      rollups: [
        { kind: "rollup", alias: "conv", rollup: convAgg, on: attempts.id },
      ],
      aggregates: (c) => ({
        n: aggregate(sql`count(${c.att.id})`, {
          decoder: Number,
          sqlType: "integer",
        }),
      }),
    });
    refuses(
      { from: tasks, joins: [bad], select: () => ({}) },
      /children join "att": rollup "conv" is declared but neither its where nor any aggregate reads it/,
    );
  });

  test("an ancestor join no closure aggregate reads", () => {
    const unreadChildren = closureJoin({
      alias: "blocking",
      edges: deps,
      child: deps.taskId,
      parent: deps.dependsOn,
      nodes: tasks,
      ancestorJoins: [ancAtt],
      aggregates: (c) => ({
        blocked: aggregate(sql`bool_or(${c.anc.droppedAt} IS NULL)`, {
          decoder: Boolean,
          sqlType: "boolean",
        }),
      }),
    });
    refuses(
      { from: tasks, joins: [unreadChildren], select: () => ({}) },
      /closure join "blocking": ancestor children join "att" is declared but neither its where nor any aggregate reads it/,
    );
    const unreadRollup = closureJoin({
      alias: "blocking",
      edges: deps,
      child: deps.taskId,
      parent: deps.dependsOn,
      nodes: tasks,
      ancestorJoins: [
        { kind: "rollup", alias: "conv", rollup: convAgg, on: tasks.id },
      ],
      aggregates: (c) => ({
        blocked: aggregate(sql`bool_or(${c.anc.droppedAt} IS NULL)`, {
          decoder: Boolean,
          sqlType: "boolean",
        }),
      }),
    });
    refuses(
      { from: tasks, joins: [unreadRollup], select: () => ({}) },
      /closure join "blocking": ancestor rollup "conv" is declared but neither its where nor any aggregate reads it/,
    );
  });

  test("A35: a nested or ancestor rollup's hop not covered by a source of its own", () => {
    const gaps = [
      [
        [],
        /which is not a source of the rollup .* Add "a_attempts" as a source with `carry: a_attempts\.task_id`/,
      ],
      [
        [{ table: attempts, carry: attempts.id, reads: [] }],
        /whose source does not carry the hop key "task_id" directly/,
      ],
      [
        [
          {
            table: attempts,
            carry: attempts.taskId,
            reads: [],
            ops: ["insert", "update"],
          },
        ],
        /whose source fires on no "delete"/,
      ],
    ] as const;
    for (const [sources, gap] of gaps) {
      const rollup = latestWith(sources as readonly SourceSpec[]);
      for (const [join, alias, where] of [
        [
          attOver(rollup, attempts.taskId, "status"),
          "att",
          `children join "att"`,
        ],
        [blockingOver(rollup), "blocking", `closure join "blocking"`],
      ] as const) {
        expect(() =>
          compileAllCollection(contracts("a-a35"), {
            ...oneJoin(join, alias),
            db: recordingQueryDb(script).db,
          }),
        ).toThrow(
          new RegExp(
            `${where}.*rollup "r": rollup "task_latest_conversation"'s source "a_conversations" is resolved through the hop table "a_attempts", ${gap.source}.*\\(A35\\)`,
          ),
        );
      }
    }
  });

  test("A39: a jsonAgg column with a wire codec", () => {
    const notes = pgTable(
      "a_notes",
      {
        id: text("id").primaryKey(),
        taskId: text("task_id").notNull(),
        body: withWire(text("body").notNull(), {
          schema: z.string(),
          encode: (v: string) => v.toUpperCase(),
        }),
      },
      (t) => [index("a_notes_task_id_idx").on(t.taskId)],
    );
    const bad = childrenJoin({
      alias: "notes",
      table: notes,
      fk: notes.taskId,
      aggregates: (c) => ({
        list: jsonAgg(
          { body: c.notes.body },
          { orderBy: [[c.notes.id, "asc"]] },
        ),
      }),
    });
    refuses(
      { from: tasks, joins: [bad], select: () => ({}) },
      /jsonAgg field "body" is a wire-encoded column \(`withWire`\) .*\(A39\)/,
    );
  });

  test("an aggregate reading outside its join", () => {
    const bad = childrenJoin({
      alias: "att",
      table: attempts,
      fk: attempts.taskId,
      aggregates: () => ({
        n: aggregate(sql`count(${tasks.id})`, {
          decoder: Number,
          sqlType: "integer",
        }),
      }),
    });
    refuses(
      { from: tasks, joins: [bad], select: () => ({}) },
      /aggregate "n" reads "base"\."id", outside the join/,
    );
  });
});
