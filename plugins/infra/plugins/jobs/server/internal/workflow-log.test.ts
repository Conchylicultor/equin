/**
 * The two halves of "a dead workflow takes its step/wait log with it".
 *
 * Why this matters beyond tidiness: a keyed dedup's `workflowRunId` is NOT
 * unique per run. It is `${jobName}:${key}` (one run per key), so a log left
 * behind by a failed run is read by the NEXT enqueue with that key — `ctx.step`
 * returns a cached result for work nobody did, and `ctx.waitFor` finds a
 * `resolved` row and never suspends. (Every other row is its own run,
 * `${jobName}:job:${jobId}` — see `run-identity.ts` — so there a left-behind log
 * only leaks.) The deletion must therefore happen on every terminal path, and
 * never one attempt early.
 *
 * The DB arm runs against a throwaway database (`db-test-fixture`) with the
 * real migration chain applied, so the deletes run as real SQL against the real
 * `job_steps` / `job_waits` tables.
 *
 * Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { NonRetryableError } from "./non-retryable";
import { _jobSteps, _jobWaits } from "./tables";
import {
  classifyFailure,
  deleteWorkflowLog,
  deleteWorkflowLogs,
} from "./workflow-log";

describe("classifyFailure", () => {
  const plain = new Error("boom");

  test("a retryable failure mid-budget keeps the log", () => {
    expect(
      classifyFailure({
        err: plain,
        deadlineAborted: false,
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({ collapseBudget: false, workflowDead: false });
  });

  test("a plain error on the LAST attempt kills the workflow", () => {
    // The case no in-process branch used to name: graphile dead-letters this
    // row on its own, so nothing collapsed the budget — but the workflow is
    // just as dead, and its log just as poisonous to the next singleton run.
    expect(
      classifyFailure({
        err: plain,
        deadlineAborted: false,
        attempt: 3,
        maxAttempts: 3,
      }),
    ).toEqual({ collapseBudget: false, workflowDead: true });
  });

  test("a NonRetryableError kills the workflow on the first attempt", () => {
    expect(
      classifyFailure({
        err: new NonRetryableError("schema drift"),
        deadlineAborted: false,
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({ collapseBudget: true, workflowDead: true });
  });

  test("a deadline abort spends its retry first, then dead-letters", () => {
    const first = classifyFailure({
      err: plain,
      deadlineAborted: true,
      attempt: 1,
      maxAttempts: 3,
    });
    expect(first).toEqual({ collapseBudget: false, workflowDead: false });

    const second = classifyFailure({
      err: plain,
      deadlineAborted: true,
      attempt: 2,
      maxAttempts: 3,
    });
    expect(second).toEqual({ collapseBudget: true, workflowDead: true });
  });

  test("a collapsed budget always implies a dead workflow", () => {
    // The invariant the two callers rely on: whenever the retry budget is
    // collapsed the log teardown also fires, so there is no permanently-failed
    // shape that leaves the log behind.
    for (const err of [plain, new NonRetryableError("drift")]) {
      for (const deadlineAborted of [false, true]) {
        for (let attempt = 1; attempt <= 4; attempt++) {
          for (const maxAttempts of [1, 3]) {
            const f = classifyFailure({
              err,
              deadlineAborted,
              attempt,
              maxAttempts,
            });
            if (f.collapseBudget) expect(f.workflowDead).toBe(true);
          }
        }
      }
    }
  });

  test("a single-attempt job is dead the first time it fails", () => {
    // `maxAttempts: 1` is what supervised work will use — one failure IS the
    // end of the workflow.
    expect(
      classifyFailure({
        err: plain,
        deadlineAborted: false,
        attempt: 1,
        maxAttempts: 1,
      }),
    ).toEqual({ collapseBudget: false, workflowDead: true });
  });
});

describe("deleteWorkflowLog", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb({ prefix: "workflow_log_test" });
    await runMigrations(t.db);
  });

  afterAll(async () => {
    await t.drop();
  });

  test("drops one run's steps and waits, and only that run's", async () => {
    const dead = "jobs.example:key-a";
    const other = "jobs.example:keep";

    await t.db.insert(_jobSteps).values([
      { workflowRunId: dead, stepName: "spawn", resultJson: { v: 7 } },
      { workflowRunId: dead, stepName: "notify", resultJson: { v: null } },
      { workflowRunId: other, stepName: "spawn", resultJson: { v: 1 } },
    ]);
    await t.db.insert(_jobWaits).values([
      {
        workflowRunId: dead,
        waitName: "wait:run.ended:0",
        status: "resolved",
        payloadJson: { runId: "abc" },
      },
      { workflowRunId: other, waitName: "wait:run.ended:0", status: "pending" },
    ]);

    await deleteWorkflowLog(t.db, dead);

    const deadSteps = await t.db
      .select()
      .from(_jobSteps)
      .where(eq(_jobSteps.workflowRunId, dead));
    const deadWaits = await t.db
      .select()
      .from(_jobWaits)
      .where(eq(_jobWaits.workflowRunId, dead));
    expect(deadSteps).toHaveLength(0);
    expect(deadWaits).toHaveLength(0);

    const keptSteps = await t.db
      .select()
      .from(_jobSteps)
      .where(eq(_jobSteps.workflowRunId, other));
    const keptWaits = await t.db
      .select()
      .from(_jobWaits)
      .where(eq(_jobWaits.workflowRunId, other));
    expect(keptSteps).toHaveLength(1);
    expect(keptWaits).toHaveLength(1);
  });

  test("the set form drops every listed run's log and nothing else", async () => {
    const runs = ["jobs.example:job:1", "jobs.example:job:2"];
    const other = "jobs.example:job:3";
    await t.db.insert(_jobSteps).values([
      ...runs.map((workflowRunId) => ({
        workflowRunId,
        stepName: "spawn",
        resultJson: { v: 1 },
      })),
      { workflowRunId: other, stepName: "spawn", resultJson: { v: 1 } },
    ]);
    await t.db.insert(_jobWaits).values(
      runs.map((workflowRunId) => ({
        workflowRunId,
        waitName: "wait:run.ended:0",
        status: "pending" as const,
      })),
    );

    await deleteWorkflowLogs(t.db, runs);
    await deleteWorkflowLogs(t.db, []);

    const steps = await t.db.select().from(_jobSteps);
    const waits = await t.db.select().from(_jobWaits);
    expect(steps.map((r) => r.workflowRunId)).not.toContain(runs[0]);
    expect(steps.map((r) => r.workflowRunId)).not.toContain(runs[1]);
    expect(steps.map((r) => r.workflowRunId)).toContain(other);
    expect(waits.map((r) => r.workflowRunId)).not.toContain(runs[0]);
    expect(waits.map((r) => r.workflowRunId)).not.toContain(runs[1]);
  });

  test("is idempotent on a run that has no log", async () => {
    // The permanently-failed path calls this for every dead workflow, most of
    // which never used a step or a wait at all.
    await deleteWorkflowLog(t.db, "jobs.example:never-ran");
  });
});
