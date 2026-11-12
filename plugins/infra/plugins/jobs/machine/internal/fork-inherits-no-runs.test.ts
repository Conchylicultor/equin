/**
 * **A forked database inherits no run of its source.** The source holds a
 * `conversations.spawn`-shaped run suspended on its checkout wait — a step it
 * already performed, a pending wait, and the wait's timeout racer queued in
 * graphile — exactly what main held when a worktree's database was forked on
 * 2026-11-12 and the worktree's backend resumed it (a second agent of the same
 * conversation). Forked with what this plugin declares (both halves: graphile's
 * schema, the step and wait logs), the fork holds none of it: the run is not in
 * flight there, and the wait `jobs.resume` reads before resuming is absent — so
 * nothing in the fork can resume it. The source keeps all of it.
 *
 * Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  dropDatabase,
  forkDatabase,
  forkExclusionsFrom,
  openShortLivedClient,
} from "@plugins/database/plugins/admin/server";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { mintTestDbName } from "@plugins/database/plugins/db-test-fixture/core/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import { installQueueSchema } from "../../server/internal/queue-schema";
import { defineJob } from "../../server/internal/registry";
import { _jobSteps, _jobWaits } from "../../server/internal/tables";
import { jobsForkExclusions } from "./fork-exclusion";
import { keysInFlightOn } from "./graphile-queue";

const SPAWN = "jobs.fork-test-spawn";
const RACER = "jobs.fork-test-racer";
const noWorker = (): never => {
  throw new Error(
    "[jobs] fork test job was dispatched; this suite starts no worker",
  );
};
defineJob({
  name: SPAWN,
  description: "Test spawn.",
  hold: "instant",
  input: z.object({ key: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.key },
  run: noWorker,
});
const racer = defineJob({
  name: RACER,
  description: "Test timeout racer.",
  hold: "instant",
  input: z.object({ key: z.string() }),
  event: z.never(),
  dedup: { key: (input) => input.key },
  run: noWorker,
});

const runId = `${SPAWN}:conv-1`;
const racerKey = `${RACER}:conv-1`;

let source: TestDb;
const target = mintTestDbName("fork_runs_dst", process.pid, Date.now());
let targetPool: Awaited<ReturnType<typeof openShortLivedClient>> | undefined;

beforeAll(async () => {
  source = await createTestDb({ prefix: "fork_runs_src" });
  await runMigrations(source.db);
  await installQueueSchema(source.connectionString);
  // The suspended run: a performed step, its pending wait, its waker queued.
  await source.db.transaction((tx) => racer.enqueue({ key: "conv-1" }, { tx }));
  await source.db.insert(_jobSteps).values({
    workflowRunId: runId,
    stepName: "prepare:request:0",
    resultJson: { v: "requested" },
  });
  await source.db.insert(_jobWaits).values({
    workflowRunId: runId,
    waitName: "prepare:wait:0",
    status: "pending",
    wakerKey: racerKey,
  });
});

afterAll(async () => {
  await targetPool?.end();
  await dropDatabase({ unserved: target, reason: "a test database" });
  await source.drop();
});

const graphileJobs = async (exec: typeof source.db): Promise<number> =>
  (
    await executeOne(exec, {
      query: sql.raw(
        `SELECT count(*)::int AS n FROM graphile_worker._private_jobs`,
      ),
      row: z.object({ n: z.number() }),
      label: "fork test graphile jobs",
    })
  ).n;

/** What `jobs.resume` reads first: the wait it is to resolve, still pending. */
const pendingWaitOf = (exec: typeof source.db) =>
  exec
    .select()
    .from(_jobWaits)
    .where(
      and(
        eq(_jobWaits.workflowRunId, runId),
        eq(_jobWaits.waitName, "prepare:wait:0"),
        eq(_jobWaits.status, "pending"),
      ),
    );

describe("a fork inherits no run of its source", () => {
  test("the suspended run is in flight in the source and absent from its fork", async () => {
    expect(await keysInFlightOn(source.db, [runId])).toEqual(new Set([runId]));

    const outcome = await forkDatabase(
      source.name,
      target,
      forkExclusionsFrom([{ contributions: jobsForkExclusions }]),
    );
    expect(outcome.kind).toBe("forked");
    targetPool = await openShortLivedClient(target);
    const fork = drizzle(targetPool);

    // Nothing to resume, nothing to replay, nothing queued to wake it.
    expect(await pendingWaitOf(fork)).toEqual([]);
    expect(await fork.select().from(_jobSteps)).toEqual([]);
    expect(await graphileJobs(fork)).toBe(0);
    expect(await keysInFlightOn(fork, [runId])).toEqual(new Set());

    // The source still owns its run.
    expect(await pendingWaitOf(source.db)).toHaveLength(1);
    expect(await source.db.select().from(_jobSteps)).toHaveLength(1);
    expect(await graphileJobs(source.db)).toBe(1);
  });
});
