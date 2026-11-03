/**
 * A rollup join's routes (P8 v3 step 16b.4 — C8, C9, D24, A1, A22): the
 * generalized routed half (`joinRoutes` / `JoinPlan.routeIdsOf`, `routedReads`'
 * fan-out and `derivedReads`), and the refusal of every `all`-only join kind
 * outside the `all` compiler.
 *
 * A rollup is never routed itself (A1: it has no change-feed trigger): each of
 * its SOURCES gets a route `<alias>[<source>]`, gated by what the rollup's
 * maintain function diffs (pk, carry, reads) — an `alias` on `carry` when the
 * carried values are host ids, else a `reverse` probe after commit. A tuple
 * reading the rollup names every source route, in the role it reads the
 * rollup in; the rollup's table is a derived read the plan mints (A22). A
 * source's `via` hop table must be a source of its own (A35).
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { defineRollup } from "@plugins/database/plugins/derived-tables/core";
import {
  ATTEMPT_CONV_AGG_TABLE,
  ATTEMPT_PUSH_AGG_TABLE,
  TASK_LATEST_CONVERSATION_TABLE,
} from "@plugins/database/plugins/derived-views/core";
import type {
  HostMap,
  ResourceParams,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core";
import {
  aggregate,
  BASE_RELATION,
  childrenJoin,
  closureJoin,
  type JoinSpec,
  type RollupJoin,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { recordingQueryDb } from "../testing/recording-db";
import { routedReads } from "./arm-plan";
import { compileGroupsQuery } from "./compile-groups";
import { compileAllJoins, compileJoins, type PlannedJoin } from "./joins";
import { compiledRoutePlan } from "./routes";
import type { WindowOrderKey } from "./spec";

const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const attempts = pgTable("attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  n: integer("n"),
});
const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  status: text("status").notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  waitingFor: text("waiting_for"),
});
const pushes = pgTable("pushes", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
const launches = pgTable("agent_launches", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  n: integer("n"),
  attemptId: text("attempt_id"),
});

const convAggT = pgTable(ATTEMPT_CONV_AGG_TABLE, {
  attemptId: text("attempt_id").primaryKey(),
  hasConv: boolean("has_conv").notNull(),
  maxEndedAt: timestamp("max_ended_at", { withTimezone: true }),
});
const pushAggT = pgTable(ATTEMPT_PUSH_AGG_TABLE, {
  attemptId: text("attempt_id").primaryKey(),
  minPushAt: timestamp("min_push_at", { withTimezone: true }).notNull(),
});
const latestT = pgTable(TASK_LATEST_CONVERSATION_TABLE, {
  taskId: text("task_id").primaryKey(),
  status: text("status"),
});

// attempt_id → its conversations' aggregate (no hop: the carry IS the key).
const convAgg = defineRollup({
  table: convAggT,
  key: convAggT.attemptId,
  select: (scope) =>
    `SELECT c.attempt_id, true AS has_conv, max(c.ended_at) AS max_ended_at
       FROM conversations c WHERE ${scope("c.attempt_id")} GROUP BY c.attempt_id`,
  sources: [
    {
      table: conversations,
      carry: conversations.attemptId,
      reads: [conversations.status, conversations.endedAt],
    },
  ],
});
// task_id → its latest conversation, through the attempts hop — with no
// attempts source, which a JoinPlan refuses (A35).
const latest = defineRollup({
  table: latestT,
  key: latestT.taskId,
  select: (scope) =>
    `SELECT DISTINCT ON (a.task_id) a.task_id, c.status
       FROM conversations c JOIN attempts a ON a.id = c.attempt_id
      WHERE ${scope("a.task_id")} ORDER BY a.task_id, c.id DESC`,
  sources: [
    {
      table: conversations,
      carry: conversations.attemptId,
      via: { table: attempts, match: attempts.id, key: attempts.taskId },
      reads: [conversations.status],
    },
  ],
});
// Two sources: the hop table is a source of its own (carry = the key).
const latestTwo = defineRollup({
  table: latestT,
  key: latestT.taskId,
  select: (scope) =>
    `SELECT DISTINCT ON (a.task_id) a.task_id, c.status
       FROM conversations c JOIN attempts a ON a.id = c.attempt_id
      WHERE ${scope("a.task_id")} ORDER BY a.task_id, c.id DESC`,
  sources: [
    { table: attempts, carry: attempts.taskId, reads: [] },
    {
      table: conversations,
      carry: conversations.attemptId,
      via: { table: attempts, match: attempts.id, key: attempts.taskId },
      reads: [conversations.status],
    },
  ],
});
// A hop source that misses part of A35, one fixture per gap.
type SourceSpec = Parameters<typeof defineRollup>[0]["sources"][number];
const latestOver = (hop: SourceSpec, via: NonNullable<SourceSpec["via"]>) =>
  defineRollup({
    table: latestT,
    key: latestT.taskId,
    select: (scope) =>
      `SELECT DISTINCT ON (a.task_id) a.task_id, c.status
         FROM conversations c JOIN attempts a ON a.id = c.attempt_id
        WHERE ${scope("a.task_id")} ORDER BY a.task_id, c.id DESC`,
    sources: [
      hop,
      {
        table: conversations,
        carry: conversations.attemptId,
        via,
        reads: [conversations.status],
      },
    ],
  });
const attemptsHop = {
  table: attempts,
  match: attempts.id,
  key: attempts.taskId,
};
// The hop source carries another column than the hop key.
const latestWrongCarry = latestOver(
  { table: attempts, carry: attempts.id, reads: [] },
  attemptsHop,
);
// The hop source fires on no delete (an RI cascade re-keys unseen).
const latestNoDelete = latestOver(
  {
    table: attempts,
    carry: attempts.taskId,
    reads: [],
    ops: ["insert", "update"],
  },
  attemptsHop,
);
// The hop matches on a column its source neither keys on nor reads.
const launchesHop = {
  table: launches,
  match: launches.attemptId,
  key: launches.taskId,
};
const latestMatchUnread = latestOver(
  { table: launches, carry: launches.taskId, reads: [] },
  launchesHop,
);
// …and the same hop with the match read is accepted.
const latestMatchRead = latestOver(
  { table: launches, carry: launches.taskId, reads: [launches.attemptId] },
  launchesHop,
);
// The carry is the source's own pk.
const pushAgg = defineRollup({
  table: pushAggT,
  key: pushAggT.attemptId,
  select: (scope) =>
    `SELECT a.id AS attempt_id, min(p.created_at) AS min_push_at
       FROM attempts a JOIN pushes p ON p.attempt_id = a.id
      WHERE ${scope("a.id")} GROUP BY a.id`,
  sources: [
    { table: attempts, carry: attempts.id, reads: [] },
    { table: pushes, carry: pushes.attemptId, reads: [pushes.createdAt] },
  ],
});

type Base =
  | typeof tasks
  | typeof attempts
  | typeof launches
  | typeof conversations
  | typeof pushes;

const baseOf = (table: Base, name: string) => ({ table, name });

/** The routed half of a keyed `all`-style read over `base` + `joins`. */
function plan(
  table: Base,
  name: string,
  joins: readonly PlannedJoin[],
  project: (
    p: ReturnType<typeof compileAllJoins>,
  ) => Record<string, ReturnType<ReturnType<typeof compileAllJoins>["render"]>>,
  order?: (p: ReturnType<typeof compileAllJoins>) => WindowOrderKey[],
) {
  const rec = recordingQueryDb();
  const base = baseOf(table, name);
  const joinPlan = compileAllJoins(base, joins, table.id, `all("${name}")`);
  const projection = { id: table.id, ...project(joinPlan) };
  const orderKeys = order?.(joinPlan) ?? [];
  const reads = routedReads<ResourceParams>({
    label: `all("${name}")`,
    base,
    joins: joinPlan,
    projection,
    pk: table.id,
    keyField: "id",
    where: undefined,
    whereReads: undefined,
    orderColumns: orderKeys.map((k) => k.col),
    orderOf: () => orderKeys,
    db: rec.db,
  });
  return { ...reads, joinPlan, rec };
}

type Reverse = Extract<HostMap, { kind: "reverse" }>;
const reverseOf = (map: unknown): Reverse => {
  const m = map as HostMap;
  if (m.kind !== "reverse") throw new Error(`not a reverse map: ${m.kind}`);
  return m;
};

const rollupJoin = (
  alias: string,
  rollup: RollupJoin["rollup"],
  on: RollupJoin["on"],
): RollupJoin => ({ kind: "rollup", alias, rollup, on });

describe("rollup routes — one per source, never the rollup table (A1)", () => {
  test("`on` the host pk, no hop: an alias on the carry, gated by pk ∪ carry ∪ reads", () => {
    const r = plan(
      attempts,
      "attempts",
      [rollupJoin("conv", convAgg, { from: BASE_RELATION, col: attempts.id })],
      (p) => ({ hasConv: p.render({ from: "conv", col: convAggT.hasConv }) }),
    );
    expect(r.routes.map((x) => [x.id, x.table])).toEqual([
      ["base", "attempts"],
      ["conv[conversations]", "conversations"],
    ]);
    const route = r.routes[1]!;
    expect(route.map).toEqual({ kind: "alias", column: "attempt_id" });
    // What the maintain function diffs — never `waiting_for`, which the
    // rollup ignores: a write to it reaches no reader either.
    expect(route.columns).toEqual(["attempt_id", "ended_at", "id", "status"]);
    expect(r.routes.some((x) => x.table === ATTEMPT_CONV_AGG_TABLE)).toBe(
      false,
    );
    expect(r.derivedReads).toEqual([
      { table: ATTEMPT_CONV_AGG_TABLE, sources: ["conversations"] },
    ]);
    expect(r.joinPlan.routeIdsOf("conv")).toEqual(["conv[conversations]"]);
  });

  test("a carry that is the source's own pk reads `change.ids` (no column)", () => {
    const r = plan(
      attempts,
      "attempts",
      [rollupJoin("push", pushAgg, { from: BASE_RELATION, col: attempts.id })],
      (p) => ({
        minPushAt: p.render({ from: "push", col: pushAggT.minPushAt }),
      }),
    );
    expect(r.routes.slice(1).map((x) => [x.id, x.map, x.columns])).toEqual([
      ["push[attempts]", { kind: "alias" }, ["id"]],
      [
        "push[pushes]",
        { kind: "alias", column: "attempt_id" },
        ["attempt_id", "created_at", "id"],
      ],
    ]);
    expect(r.derivedReads).toEqual([
      { table: ATTEMPT_PUSH_AGG_TABLE, sources: ["attempts", "pushes"] },
    ]);
  });

  test("through a hop: a reverse probe resolving the carried values via the hop, `within` cast as absent", async () => {
    const r = plan(
      tasks,
      "tasks",
      [rollupJoin("latest", latestTwo, { from: BASE_RELATION, col: tasks.id })],
      (p) => ({ status: p.render({ from: "latest", col: latestT.status }) }),
    );
    // The hop table's own source: its carry is the key, `on` the host pk.
    expect(r.routes[1]).toMatchObject({
      id: "latest[attempts]",
      map: { kind: "alias", column: "task_id" },
      columns: ["id", "task_id"],
    });
    const route = r.routes[2]!;
    expect([route.id, route.table, route.columns]).toEqual([
      "latest[conversations]",
      "conversations",
      ["attempt_id", "id", "status"],
    ]);
    const map = reverseOf(route.map);
    expect(map.column).toBe("attempt_id");
    expect(await map.resolve([], null, 500)).toEqual([]);
    expect(await map.resolve(["a1"], new Set(), 500)).toEqual([]);
    expect(r.rec.calls).toEqual([]);
    await map.resolve(["a1", "a2"], new Set(["t1"]), 500);
    expect(r.rec.calls).toEqual([
      {
        sql: 'select distinct "id" from "tasks" where ("tasks"."id" IN (SELECT "task_id" FROM "attempts" WHERE "id" = ANY($1::text[])) and "tasks"."id" = ANY($2::text[])) limit $3',
        params: [["a1", "a2"], ["t1"], 501],
      },
    ]);
  });

  test("the probe answers the hosts, and over-cap past the cap", async () => {
    const rec = recordingQueryDb(() => [{ id: "t1" }, { id: "t2" }]);
    const base = baseOf(tasks, "tasks");
    const joinPlan = compileAllJoins(
      base,
      [rollupJoin("latest", latestTwo, { from: BASE_RELATION, col: tasks.id })],
      tasks.id,
      "t",
    );
    const reads = routedReads<ResourceParams>({
      label: "t",
      base,
      joins: joinPlan,
      projection: { id: tasks.id },
      pk: tasks.id,
      keyField: "id",
      where: undefined,
      whereReads: undefined,
      orderColumns: [],
      orderOf: () => [],
      db: rec.db,
    });
    const map = reverseOf(
      reads.routes.find((x) => x.id === "latest[conversations]")!.map,
    );
    expect(await map.resolve(["a1"], null, 5)).toEqual(["t1", "t2"]);
    expect(await map.resolve(["a1"], null, 1)).toBe("over-cap");
  });

  test("`on` a non-pk base column: a reverse probe over it, no hop", async () => {
    const r = plan(
      launches,
      "agent_launches",
      [
        rollupJoin("latest", latestTwo, {
          from: BASE_RELATION,
          col: launches.taskId,
        }),
      ],
      (p) => ({ status: p.render({ from: "latest", col: latestT.status }) }),
    );
    expect(r.routes.slice(1).map((x) => [x.id, x.table])).toEqual([
      ["latest[attempts]", "attempts"],
      ["latest[conversations]", "conversations"],
    ]);
    const viaAttempts = reverseOf(r.routes[1]!.map);
    expect(viaAttempts.column).toBe("task_id");
    await viaAttempts.resolve(["t1"], null, 500);
    expect(r.rec.calls.at(-1)).toEqual({
      sql: 'select distinct "id" from "agent_launches" where "agent_launches"."task_id" = ANY($1::text[]) limit $2',
      params: [["t1"], 501],
    });
    // A uuid-free text pk: `within` as absent renders the plain comparison.
    await viaAttempts.resolve(["t1"], new Set(["l1"]), 500);
    expect(r.rec.calls.at(-1)!.sql).toContain(
      '"agent_launches"."id" = ANY($2::text[])',
    );
    expect(r.derivedReads).toEqual([
      {
        table: TASK_LATEST_CONVERSATION_TABLE,
        sources: ["attempts", "conversations"],
      },
    ]);
  });

  test("`on` an earlier join's column: the probe joins the chain", async () => {
    const att: JoinSpec = {
      kind: "lookup",
      alias: "att",
      table: attempts,
      pk: attempts.id,
      on: { from: BASE_RELATION, col: conversations.attemptId },
      required: false,
    };
    const rec = recordingQueryDb();
    const base = baseOf(conversations, "conversations");
    const joinPlan = compileAllJoins(
      base,
      [
        att,
        rollupJoin("latest", latestTwo, { from: "att", col: attempts.taskId }),
      ],
      conversations.id,
      "t",
    );
    const reads = routedReads<ResourceParams>({
      label: "t",
      base,
      joins: joinPlan,
      projection: {
        id: conversations.id,
        status: joinPlan.render({ from: "latest", col: latestT.status }),
      },
      pk: conversations.id,
      keyField: "id",
      where: undefined,
      whereReads: undefined,
      orderColumns: [],
      orderOf: () => [],
      db: rec.db,
    });
    // The changed source is `conversations` — the base, which is host-side
    // (A10 allows it); the chain join `att` and the hop are over `attempts`,
    // so the route probes.
    const route = reads.routes.find((x) => x.id === "latest[conversations]")!;
    const map = reverseOf(route.map);
    await map.resolve(["a1"], null, 500);
    expect(rec.calls.at(-1)!.sql).toBe(
      'select distinct "conversations"."id" from "conversations" left join "attempts" "att" on "att"."id" = "conversations"."attempt_id" where "att"."task_id" IN (SELECT "task_id" FROM "attempts" WHERE "id" = ANY($1::text[])) limit $2',
    );
  });

  test("a chain join over the CHANGED source table needs its pre-image: full, with the reason (A10)", () => {
    const att: JoinSpec = {
      kind: "lookup",
      alias: "att",
      table: attempts,
      pk: attempts.id,
      on: { from: BASE_RELATION, col: pushes.attemptId },
      required: false,
    };
    const base = baseOf(pushes, "pushes");
    const joinPlan = compileAllJoins(
      base,
      [
        att,
        rollupJoin("latest", latestTwo, { from: "att", col: attempts.taskId }),
      ],
      pushes.id,
      "t",
    );
    const reads = routedReads<ResourceParams>({
      label: "t",
      base,
      joins: joinPlan,
      projection: {
        id: pushes.id,
        status: joinPlan.render({ from: "latest", col: latestT.status }),
      },
      pk: pushes.id,
      keyField: "id",
      where: undefined,
      whereReads: undefined,
      orderColumns: [],
      orderOf: () => [],
      db: recordingQueryDb().db,
    });
    const viaAttempts = reads.routes.find((x) => x.id === "latest[attempts]")!;
    expect(viaAttempts.map.kind).toBe("full");
    expect((viaAttempts.map as { reason: string }).reason).toMatch(
      /^pre-image needed: rollup "latest"'s source "attempts" is resolved through the join "att"/,
    );
    // The other source still probes.
    expect(
      reads.routes.find((x) => x.id === "latest[conversations]")!.map.kind,
    ).toBe("reverse");
  });

  test("`on` of another type than the key is refused at compile (A4)", () => {
    expect(() =>
      compileAllJoins(
        baseOf(attempts, "attempts"),
        [rollupJoin("conv", convAgg, { from: BASE_RELATION, col: attempts.n })],
        attempts.id,
        "t",
      ),
    ).toThrow(
      /its `on` "n" is integer, but rollup "attempt_conv_agg"'s key "attempt_id" is text/,
    );
  });

  test("`on` naming a join declared after it is refused (A4)", () => {
    expect(() =>
      compileAllJoins(
        baseOf(attempts, "attempts"),
        [rollupJoin("conv", convAgg, { from: "later", col: attempts.id })],
        attempts.id,
        "t",
      ),
    ).toThrow(/rollup join "conv": its `on` names "later"/);
  });

  test("a hop table that is not a source of the rollup is refused at compile (A35)", () => {
    // `UPDATE attempts SET task_id = 'T2'` re-keys T1's rollup row: with no
    // attempts source, neither the maintain function nor any route reaches T1.
    expect(() =>
      compileAllJoins(
        baseOf(tasks, "tasks"),
        [rollupJoin("latest", latest, { from: BASE_RELATION, col: tasks.id })],
        tasks.id,
        "t",
      ),
    ).toThrow(
      /t: rollup join "latest": rollup "task_latest_conversation"'s source "conversations" is resolved through the hop table "attempts", which is not a source of the rollup .* Add "attempts" as a source with `carry: attempts.task_id` \(A35\)/,
    );
    // A hop source that misses part of the cover is refused, naming the gap.
    const head =
      /t: rollup join "latest": rollup "task_latest_conversation"'s source "conversations" is resolved through the hop table "(attempts|agent_launches)", /;
    const refusals: [typeof latest, RegExp][] = [
      [
        latestWrongCarry,
        /whose source does not carry the hop key "task_id" directly .* Set its `carry: attempts.task_id` with no `via` \(A35\)/,
      ],
      [
        latestNoDelete,
        /whose source fires on no "delete" .* Add "delete" to its `ops` \(or drop `ops` for all three\) \(A35\)/,
      ],
      [
        latestMatchUnread,
        /whose source neither keys on nor reads the hop match "attempt_id" .* Add "agent_launches.attempt_id" to its `reads` \(A35\)/,
      ],
    ];
    for (const [rollup, gap] of refusals) {
      const compile = () =>
        compileAllJoins(
          baseOf(tasks, "tasks"),
          [
            rollupJoin("latest", rollup, {
              from: BASE_RELATION,
              col: tasks.id,
            }),
          ],
          tasks.id,
          "t",
        );
      expect(compile).toThrow(head);
      expect(compile).toThrow(gap);
    }
    // The hop table as a source of its own, carrying the key, seeing every
    // re-key, is accepted.
    for (const rollup of [latestTwo, latestMatchRead]) {
      expect(() =>
        compileAllJoins(
          baseOf(tasks, "tasks"),
          [
            rollupJoin("latest", rollup, {
              from: BASE_RELATION,
              col: tasks.id,
            }),
          ],
          tasks.id,
          "t",
        ),
      ).not.toThrow();
    }
  });

  test("routeIdsOf: a window join is its alias; an undeclared alias throws", () => {
    const att: JoinSpec = {
      kind: "lookup",
      alias: "att",
      table: attempts,
      pk: attempts.id,
      on: { from: BASE_RELATION, col: conversations.attemptId },
      required: true,
    };
    const p = compileJoins(
      baseOf(conversations, "conversations"),
      [att],
      conversations.id,
      "t",
    );
    expect(p.routeIdsOf("att")).toEqual(["att"]);
    expect(p.derivedReads).toEqual([]);
    expect(() => p.routeIdsOf("nope")).toThrow(
      /no declared join has the alias "nope"/,
    );
  });
});

describe("routedReads' fan-out: a tuple reading a rollup names every source route", () => {
  test("projected only → every source route in the value role", () => {
    const r = plan(
      tasks,
      "tasks",
      [rollupJoin("latest", latestTwo, { from: BASE_RELATION, col: tasks.id })],
      (p) => ({ status: p.render({ from: "latest", col: latestT.status }) }),
    );
    expect([...r.tuple({}).uses]).toEqual([
      ["base", { role: "membership", moves: [] }],
      ["latest[attempts]", { role: "value" }],
      ["latest[conversations]", { role: "value" }],
    ]);
  });

  test("ordered by a rollup column → membership on every source route, with no `moves` (every column)", () => {
    const r = plan(
      tasks,
      "tasks",
      [rollupJoin("latest", latestTwo, { from: BASE_RELATION, col: tasks.id })],
      (p) => ({ status: p.render({ from: "latest", col: latestT.status }) }),
      (p) => [{ col: p.render({ from: "latest", col: latestT.status }) }],
    );
    expect([...r.tuple({}).uses]).toEqual([
      // The base's `moves`: the join condition's base column.
      ["base", { role: "membership", moves: ["id"] }],
      ["latest[attempts]", { role: "membership" }],
      ["latest[conversations]", { role: "membership" }],
    ]);
  });

  test("an unread rollup is not joined, and no source route is named", () => {
    const r = plan(
      tasks,
      "tasks",
      [rollupJoin("latest", latestTwo, { from: BASE_RELATION, col: tasks.id })],
      () => ({ title: tasks.title }),
    );
    expect([...r.tuple({}).uses.keys()]).toEqual(["base"]);
    // Still routes and a derived read: the declaration reads it.
    expect(r.routes.map((x) => x.id)).toEqual([
      "base",
      "latest[attempts]",
      "latest[conversations]",
    ]);
  });

  test("the minted plan carries the derived reads; a plan with none carries no field", () => {
    const r = plan(
      attempts,
      "attempts",
      [rollupJoin("conv", convAgg, { from: BASE_RELATION, col: attempts.id })],
      (p) => ({ hasConv: p.render({ from: "conv", col: convAggT.hasConv }) }),
    );
    const minted = compiledRoutePlan(
      r.routes,
      (params) => r.tuple(params).uses,
      r.derivedReads,
    );
    expect(minted.derivedReads).toEqual([
      { table: ATTEMPT_CONV_AGG_TABLE, sources: ["conversations"] },
    ]);
    const bare = compiledRoutePlan(r.routes.slice(0, 1), () => new Map());
    expect("derivedReads" in bare).toBe(false);
  });

  test("two joins of one rollup are one derived read", () => {
    const r = plan(
      attempts,
      "attempts",
      [
        rollupJoin("c1", convAgg, { from: BASE_RELATION, col: attempts.id }),
        rollupJoin("c2", convAgg, { from: BASE_RELATION, col: attempts.id }),
      ],
      (p) => ({
        a: p.render({ from: "c1", col: convAggT.hasConv }),
        b: p.render({ from: "c2", col: convAggT.hasConv }),
      }),
    );
    expect(r.derivedReads).toEqual([
      { table: ATTEMPT_CONV_AGG_TABLE, sources: ["conversations"] },
    ]);
    expect(r.routes.map((x) => x.id)).toEqual([
      "base",
      "c1[conversations]",
      "c2[conversations]",
    ]);
  });
});

describe("C9 / D24 — an `all`-only join outside the `all` compiler is refused at module eval", () => {
  const rollup = rollupJoin("conv", convAgg, {
    from: BASE_RELATION,
    col: attempts.id,
  });
  const children = childrenJoin({
    alias: "convs",
    table: conversations,
    fk: conversations.attemptId,
    aggregates: (c) => ({
      n: aggregate(sql`count(${c.convs.id})`, {
        decoder: Number,
        sqlType: "integer",
      }),
    }),
  });
  const closure = closureJoin({
    alias: "up",
    edges: attempts,
    child: attempts.id,
    parent: attempts.taskId,
    nodes: attempts,
    aggregates: (c) => ({
      n: aggregate(sql`count(${c.anc.id})`, {
        decoder: Number,
        sqlType: "integer",
      }),
    }),
  });

  for (const [kind, join] of [
    ["rollup", rollup],
    ["children", children],
    ["closure", closure],
  ] as const) {
    test(`a ${kind} join in a grouping (:groups)`, () => {
      expect(() =>
        compileGroupsQuery("k", {
          from: attempts,
          // A cast: `GroupsQuerySpec.joins` is `JoinSpec[]` (tsc refuses it).
          joins: [join as unknown as JoinSpec],
          query: () => ({
            column: attempts.taskId,
            where: undefined,
            limit: 10,
            check: () => {},
          }),
          db: recordingQueryDb().db,
        }),
      ).toThrow(
        new RegExp(
          `groupsQuery\\("k"\\): join "${join.alias}" is a ${kind} join, which only a collection declared \`all\` reads`,
        ),
      );
    });

    test(`a ${kind} join in a window / point / union arm (compileJoins)`, () => {
      expect(() =>
        compileJoins(
          baseOf(attempts, "attempts"),
          [join as unknown as JoinSpec],
          attempts.id,
          "w",
        ),
      ).toThrow(/only a collection declared `all` reads/);
    });
  }

  for (const [kind, join] of [
    ["children", children],
    ["closure", closure],
  ] as const) {
    test(`a ${kind} join is not joined row-wise by the \`all\` plan either`, () => {
      expect(() =>
        compileAllJoins(
          baseOf(attempts, "attempts"),
          [join as unknown as PlannedJoin],
          attempts.id,
          "a",
        ),
      ).toThrow(
        new RegExp(
          `a: join "${join.alias}" is a ${kind} join, which a JoinPlan does not join row-wise — a children or closure join is rendered as a grouped CTE by the \`all\` compiler`,
        ),
      );
    });
  }

  test("the types refuse them too", () => {
    // @ts-expect-error — a rollup join is not a `JoinSpec`.
    const _w: JoinSpec = rollup;
    void _w;
    expect(() =>
      compileGroupsQuery("t", {
        from: attempts,
        // @ts-expect-error — `GroupsQuerySpec.joins` is `JoinSpec[]`.
        joins: [rollup],
        query: () => ({
          column: attempts.id,
          where: undefined,
          limit: 1,
          check: () => {},
        }),
        db: recordingQueryDb().db,
      }),
    ).toThrow(/only a collection declared `all` reads/);
  });
});
