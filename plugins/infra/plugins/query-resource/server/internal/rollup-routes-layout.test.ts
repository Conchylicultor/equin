/**
 * C14 of research/2026-10-06-global-scoped-change-routing-p8-v3.md (A36,
 * dropped: A3 already covers it): a rollup's SOURCE route — `attempt_id` on
 * conversations, carried for an `attempt_conv_agg` join on attempts — is a
 * route like any other. It reaches `routedTableRequirements()`, the change
 * feed installs a trigger carrying it, and A3 (`assertRouteLayoutsInstalled`)
 * refuses a trigger that does not carry it. The rollup table itself is in no
 * requirement (A1): it is feed-exempt, reached through its source.
 *
 * Requires a running Postgres cluster (started by ./equin build);
 * createTestDb() throws loudly when it is unreachable.
 * Run: `./equin test plugins/infra/plugins/query-resource`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  assertRouteLayoutsInstalled,
  rebuildTriggers,
} from "@plugins/database/plugins/change-feed/server/testing";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { defineRollup } from "@plugins/database/plugins/derived-tables/core";
import { ATTEMPT_CONV_AGG_TABLE } from "@plugins/database/plugins/derived-views/core";
import {
  createResourceRuntime,
  type ResourceParams,
  type TableLayoutRequirement,
} from "@plugins/framework/plugins/resource-runtime/core";
import { BASE_RELATION } from "@plugins/infra/plugins/query-resource/core";
import { recordingQueryDb } from "../testing/recording-db";
import { routedReads } from "./arm-plan";
import { compileAllJoins } from "./joins";
import { compiledRoutePlan } from "./routes";

const attempts = pgTable("attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
});
const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull(),
  status: text("status").notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  waitingFor: text("waiting_for"),
});
const aggT = pgTable(ATTEMPT_CONV_AGG_TABLE, {
  attemptId: text("attempt_id").primaryKey(),
  hasConv: boolean("has_conv").notNull(),
  maxEndedAt: timestamp("max_ended_at", { withTimezone: true }),
});
const convAgg = defineRollup({
  table: aggT,
  key: aggT.attemptId,
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

const EXCLUSIONS = {
  // A rollup is feed-exempt (derived-tables' `feedExemptTables()`).
  feedExempt: new Set([ATTEMPT_CONV_AGG_TABLE]),
  optedOut: new Set<string>(),
  produced: new Set<string>(),
};

let t: TestDb;
let requirements: TableLayoutRequirement[];

beforeAll(async () => {
  t = await createTestDb({ prefix: "qr_rollup_layout" });
  await t.db.execute(
    sql.raw(`
      CREATE TABLE attempts (id text PRIMARY KEY, task_id text NOT NULL);
      CREATE TABLE conversations (
        id text PRIMARY KEY, attempt_id text NOT NULL, status text NOT NULL,
        ended_at timestamptz, waiting_for text);
      CREATE TABLE ${ATTEMPT_CONV_AGG_TABLE} (
        attempt_id text PRIMARY KEY, has_conv boolean NOT NULL,
        max_ended_at timestamptz);
    `),
  );

  // An `attempts` read joining the rollup, routed as the `all` compiler will
  // route it, registered in a runtime of its own.
  const base = { table: attempts, name: "attempts" };
  const plan = compileAllJoins(
    base,
    [
      {
        kind: "rollup",
        alias: "conv",
        rollup: convAgg,
        on: { from: BASE_RELATION, col: attempts.id },
      },
    ],
    attempts.id,
    "c14",
  );
  const reads = routedReads<ResourceParams>({
    label: "c14",
    base,
    joins: plan,
    projection: {
      id: attempts.id,
      hasConv: plan.render({ from: "conv", col: aggT.hasConv }),
    },
    pk: attempts.id,
    keyField: "id",
    where: undefined,
    whereReads: undefined,
    orderColumns: [],
    orderOf: () => [],
    db: recordingQueryDb().db,
  });
  const runtime = createResourceRuntime();
  runtime.defineResource(
    {
      key: "c14-attempts",
      schema: z.array(z.object({ id: z.string(), hasConv: z.boolean() })),
      keyed: { keyOf: (r) => (r as { id: string }).id },
      validateParams: () => {},
    },
    {
      routes: compiledRoutePlan(
        reads.routes,
        (params) => reads.tuple(params).uses,
        reads.derivedReads,
      ),
      membership: { kind: "point", idsOf: (p) => [p.id ?? ""] },
      loader: () => [],
    },
  );
  requirements = runtime.routedTableRequirements();
});

afterAll(async () => {
  await t.drop();
});

describe("C14 — a rollup's source route is laid out and checked like any route (A3)", () => {
  test("routedTableRequirements: conversations carries attempt_id; the rollup table is in none (A1)", () => {
    expect(requirements).toEqual([
      { table: "attempts", carry: [], reads: [["id"]] },
      {
        table: "conversations",
        carry: ["attempt_id"],
        reads: [["attempt_id", "ended_at", "id", "status"]],
      },
    ]);
  });

  test("the installed triggers carry it, and A3 passes", async () => {
    await rebuildTriggers(t.db, EXCLUSIONS, requirements);
    await assertRouteLayoutsInstalled(t.db, requirements);
  });

  test("a conversations trigger that does not carry attempt_id is refused by A3", async () => {
    // Install the layout without the rollup's carry (a trigger compiled from
    // routes that lost it), then check the real requirement against it.
    await rebuildTriggers(
      t.db,
      EXCLUSIONS,
      requirements.map((r) =>
        r.table === "conversations" ? { ...r, carry: [] } : r,
      ),
    );
    let error: unknown;
    try {
      await assertRouteLayoutsInstalled(t.db, requirements);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      `"conversations" (live_state_conversations_i) does not carry "attempt_id"`,
    );
    expect((error as Error).message).toContain("(A3)");
    // Restored by the next rebuild from the real routes.
    await rebuildTriggers(t.db, EXCLUSIONS, requirements);
    await assertRouteLayoutsInstalled(t.db, requirements);
  });
});
