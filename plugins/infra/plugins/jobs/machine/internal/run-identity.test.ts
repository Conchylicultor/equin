/**
 * Run identity vs queue identity (`run-identity.ts`): **a keyed dedup is one
 * run per key; every other row is its own run**, and the singleton queue key is
 * one derivation shared by `enqueue()` and the cron item.
 *
 * The pure arm pins the derivations. The DB arm runs against a throwaway
 * database (`db-test-fixture`) with the queue schema and the app's migration
 * chain installed, and checks the three places the rule is load-bearing: what
 * `enqueue()` writes into a row, and that dead-job GC and the stuck-lock
 * sweeper's superseded DELETE take a removed row's own step/wait log with it —
 * while leaving a keyed run's log, which the next row under that key shares.
 *
 * graphile's runtime row writes (fetch, fail) are reproduced as the UPDATE
 * shapes it issues, as in `superseded-trigger.test.ts`, because no worker runs
 * in this process.
 *
 * Run: `./singularity test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./singularity build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { reconcileDeadJobs } from "./dead-job-gc";
import { installQueueSchema } from "../../server/internal/queue-schema";
import { defineJob } from "../../server/internal/registry";
import {
  ownedWorkflowRunIds,
  singletonJobKey,
  workflowRunIdFor,
} from "../../server/internal/run-identity";
import { sweepOnce } from "./stuck-lock-sweeper";
import { _jobSteps } from "../../server/internal/tables";
import { buildCronItems } from "./worker";

function neverRun(): never {
  throw new Error(
    "[jobs] run-identity-test job was dispatched; this suite starts no worker",
  );
}

describe("workflowRunIdFor", () => {
  test("a row without a baked run id is its own run", () => {
    expect(workflowRunIdFor({ jobName: "jobs.example" }, "42")).toBe(
      "jobs.example:job:42",
    );
  });

  test("a baked run id (keyed dedup, resume row, pre-rule row) wins", () => {
    expect(
      workflowRunIdFor(
        { jobName: "jobs.example", workflowRunId: "jobs.example:k" },
        "42",
      ),
    ).toBe("jobs.example:k");
  });
});

describe("ownedWorkflowRunIds", () => {
  test("only rows without a baked run id own their log", () => {
    expect(
      ownedWorkflowRunIds([
        { id: "1", job_name: "jobs.a", baked_run_id: null },
        { id: "2", job_name: "jobs.b", baked_run_id: "jobs.b:key" },
      ]),
    ).toEqual(["jobs.a:job:1"]);
  });
});

describe("hold: minutes requires inProcess", () => {
  const base = {
    description: "Test job.",
    input: z.object({}),
    event: z.never(),
    dedup: "none" as const,
    run: neverRun,
  };

  test("an empty reason is refused at define time", () => {
    expect(() =>
      defineJob({
        ...base,
        name: "jobs.run-identity-test.empty-reason",
        hold: "minutes",
        inProcess: "  ",
      }),
    ).toThrow(/inProcess/);
  });

  test("the type demands a reason for minutes and forbids one otherwise", () => {
    // Type-level arms: each `@ts-expect-error` fails type-check if the
    // combination ever becomes spellable. The calls themselves are not made.
    const typeOnly = () => {
      // @ts-expect-error — `minutes` without `inProcess`
      defineJob({ ...base, name: "jobs.t1", hold: "minutes" });
      // @ts-expect-error — `inProcess` on a shorter class
      defineJob({ ...base, name: "jobs.t2", hold: "seconds", inProcess: "x" });
      defineJob({ ...base, name: "jobs.t3", hold: "minutes", inProcess: "x" });
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("the cron item", () => {
  test("uses the singleton job key and bakes no run id", async () => {
    const name = "jobs.run-identity-test.cron";
    await defineJob({
      name,
      description: "Test job.",
      hold: "instant",
      input: z.object({}),
      event: z.never(),
      dedup: "singleton",
      // perWorktree, so the item is built whichever checkout runs the suite.
      schedule: { cron: "0 * * * *", perWorktree: true },
      run: neverRun,
    }).register();

    const item = buildCronItems().find((i) => i.identifier === `cron:${name}`);
    expect(item?.options.jobKey).toBe(singletonJobKey(name));
    expect(item?.payload).not.toHaveProperty("workflowRunId");
  });
});

describe("against a real queue", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb({ prefix: "run_identity_test" });
    await runMigrations(t.db);
    await installQueueSchema(t.connectionString);
  });

  afterAll(async () => {
    await t.drop();
  });

  const SINGLETON = "jobs.run-identity-test.singleton";
  const NONE = "jobs.run-identity-test.none";
  const KEYED = "jobs.run-identity-test.keyed";

  const singletonJob = defineJob({
    name: SINGLETON,
    description: "Test job.",
    hold: "instant",
    input: z.object({}),
    event: z.never(),
    dedup: "singleton",
    run: neverRun,
  });
  const noneJob = defineJob({
    name: NONE,
    description: "Test job.",
    hold: "instant",
    input: z.object({}),
    event: z.never(),
    dedup: "none",
    run: neverRun,
  });
  const keyedJob = defineJob({
    name: KEYED,
    description: "Test job.",
    hold: "instant",
    input: z.object({ key: z.string() }),
    event: z.never(),
    dedup: { key: (input) => input.key },
    run: neverRun,
  });

  const RowSchema = z.object({
    key: z.string().nullable(),
    job_name: z.string(),
    baked_run_id: z.string().nullable(),
  });

  async function readRow(id: string): Promise<z.infer<typeof RowSchema>> {
    return executeOne(t.db, {
      label: "run-identity-test: row",
      row: RowSchema,
      query: sql`
        SELECT key,
               payload->>'jobName'       AS job_name,
               payload->>'workflowRunId' AS baked_run_id
          FROM graphile_worker._private_jobs
         WHERE id = ${id}::bigint
      `,
    });
  }

  async function rowExists(id: string): Promise<boolean> {
    const res = await t.db.execute(
      sql`SELECT 1 FROM graphile_worker._private_jobs WHERE id = ${id}::bigint`,
    );
    return res.rows.length > 0;
  }

  /** graphile's fetch: stamp the lock, count the attempt. */
  async function fetchRow(id: string): Promise<void> {
    await t.db.execute(sql`
      UPDATE graphile_worker._private_jobs
         SET locked_at = now(),
             locked_by = 'run-identity-test-worker',
             attempts = attempts + 1
       WHERE id = ${id}::bigint
    `);
  }

  /** graphile's fail path: record the error and let go of the row. */
  async function failRow(id: string): Promise<void> {
    await t.db.execute(sql`
      UPDATE graphile_worker._private_jobs
         SET last_error = 'run-identity-test failure',
             locked_by = NULL,
             locked_at = NULL
       WHERE id = ${id}::bigint
    `);
  }

  /** Dead the way graphile leaves an exhausted row. */
  async function killRow(id: string): Promise<void> {
    await fetchRow(id);
    await failRow(id);
    await t.db.execute(sql`
      UPDATE graphile_worker._private_jobs
         SET attempts = max_attempts
       WHERE id = ${id}::bigint
    `);
  }

  async function seedLog(workflowRunId: string): Promise<void> {
    await t.db
      .insert(_jobSteps)
      .values({ workflowRunId, stepName: "spawn", resultJson: { v: 1 } });
  }

  async function hasLog(workflowRunId: string): Promise<boolean> {
    const rows = await t.db
      .select()
      .from(_jobSteps)
      .where(eq(_jobSteps.workflowRunId, workflowRunId));
    return rows.length > 0;
  }

  test("enqueue: a singleton keys on singletonJobKey and bakes no run id", async () => {
    const { jobId } = await t.db.transaction((tx) =>
      singletonJob.enqueue({}, { tx }),
    );
    const row = await readRow(jobId);
    expect(row.key).toBe(singletonJobKey(SINGLETON));
    expect(row.baked_run_id).toBeNull();
    await t.db.execute(
      sql`DELETE FROM graphile_worker._private_jobs WHERE id = ${jobId}::bigint`,
    );
  });

  test("enqueue: dedup none has no key and bakes no run id", async () => {
    const { jobId } = await t.db.transaction((tx) =>
      noneJob.enqueue({}, { tx }),
    );
    const row = await readRow(jobId);
    expect(row.key).toBeNull();
    expect(row.baked_run_id).toBeNull();
  });

  test("enqueue: a keyed dedup bakes its key as the run id", async () => {
    const { jobId } = await t.db.transaction((tx) =>
      keyedJob.enqueue({ key: "k" }, { tx }),
    );
    const row = await readRow(jobId);
    expect(row.key).toBe(`${KEYED}:k`);
    expect(row.baked_run_id).toBe(`${KEYED}:k`);
  });

  test("dead-job GC drops a row-owned run's log and keeps a keyed run's", async () => {
    const { jobId: owned } = await t.db.transaction((tx) =>
      noneJob.enqueue({}, { tx }),
    );
    const { jobId: keyed } = await t.db.transaction((tx) =>
      keyedJob.enqueue({ key: "gc" }, { tx }),
    );
    const ownedRun = workflowRunIdFor({ jobName: NONE }, owned);
    const keyedRun = `${KEYED}:gc`;
    await seedLog(ownedRun);
    await seedLog(keyedRun);
    await killRow(owned);
    await killRow(keyed);

    await reconcileDeadJobs(t.db);

    expect(await rowExists(owned)).toBe(false);
    expect(await rowExists(keyed)).toBe(false);
    expect(await hasLog(ownedRun)).toBe(false);
    // A keyed run id is shared with the next row under that key.
    expect(await hasLog(keyedRun)).toBe(true);
  });

  test("the superseded DELETE drops the retired row's log, not its successor's", async () => {
    const { jobId: running } = await t.db.transaction((tx) =>
      singletonJob.enqueue({}, { tx }),
    );
    await fetchRow(running);
    // Re-queueing the singleton key while it runs retires (supersedes) it.
    const { jobId: successor } = await t.db.transaction((tx) =>
      singletonJob.enqueue({}, { tx }),
    );
    expect(successor).not.toBe(running);
    await failRow(running);

    const retiredRun = workflowRunIdFor({ jobName: SINGLETON }, running);
    const successorRun = workflowRunIdFor({ jobName: SINGLETON }, successor);
    await seedLog(retiredRun);
    await seedLog(successorRun);

    await sweepOnce(t.db);

    expect(await rowExists(running)).toBe(false);
    expect(await hasLog(retiredRun)).toBe(false);
    expect(await rowExists(successor)).toBe(true);
    expect(await hasLog(successorRun)).toBe(true);
  });
});
