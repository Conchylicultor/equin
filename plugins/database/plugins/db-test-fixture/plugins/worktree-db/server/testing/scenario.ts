import { db } from "@plugins/database/server";
import { connectionString } from "@plugins/database/plugins/admin/server";
import { installQueueSchema } from "@plugins/infra/plugins/jobs/server/testing";

/**
 * db-or-tx executor — the SAME union every mutation in this repo takes (see
 * tasks-core's `status-batch.ts`, rank's `RankExecutor`), declared here rather
 * than imported: a test fixture may not depend on a domain plugin, and the
 * union is a property of drizzle's own `transaction` signature, not of tasks.
 *
 * It is deliberately the wide union and not the narrow `db.transaction`
 * callback arm. A batch (`runStatusBatchOn`) hands its own callback the union,
 * so a scenario body typed to the narrow arm cannot be handed the batch's
 * executor — which is exactly how the two copied-by-hand harnesses this one
 * replaces drifted apart (`clusters.test.ts` typed it narrowly,
 * `status-closure.test.ts` widely).
 */
export type DbExecutor =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Private sentinel: the only exception that means "roll back, as planned". */
class Rollback extends Error {}

/**
 * Once-per-process gate for the queue-schema install. `null` while nothing has
 * been attempted, the in-flight/settled promise afterwards.
 */
let installed: Promise<void> | null = null;

/**
 * Put the `graphile_worker` schema in this worktree's database before the first
 * scenario opens a transaction.
 *
 * WHY a test harness has to care about the job queue at all: the `opts.tx`
 * enqueue transport — the one every status-change emit takes — writes on the
 * CALLER's connection and so ASSUMES the schema rather than installing it. A
 * database that has never hosted a booted backend has none, and the failure is
 * a bare Postgres `3F000` that names nothing in this repo. That is precisely
 * how four tasks-core tests were failing.
 *
 * A worktree database no longer arrives in that state — the fork keeps
 * graphile's migration watermark (`ExcludeSchemaDataFromFork({ schema:
 * "graphile_worker", keep: ["migrations"] })` in jobs' server barrel), so it is
 * born queue-capable. This gate stays because it is cheap (one connect, one
 * SELECT) and because it is the harness's job to state its own precondition
 * rather than inherit one from how the database happened to be provisioned —
 * a hand-made database, a graphile version bump, or a future provisioning path
 * all land here.
 *
 * A rejection is deliberately NOT cached: the usual cause is a cluster that is
 * not up yet, and a second run in the same process should get a real attempt
 * rather than a replayed corpse of the first one.
 */
function ensureQueueSchema(): Promise<void> {
  if (installed) return installed;
  const pending = connectionString()
    .then((connString) => installQueueSchema(connString))
    .catch((err: unknown) => {
      installed = null;
      throw err;
    });
  installed = pending;
  return pending;
}

/**
 * Run one scenario against the REAL worktree database inside a transaction that
 * is always rolled back, returning whatever the body read just before the
 * rollback. Nothing is ever committed: no seeded rows, no emissions, no
 * enqueued jobs survive.
 *
 * This is the sanctioned harness for the suites that genuinely cannot use a
 * `createTestDb` throwaway — the ones reading the derived VIEW layer
 * (`tasks_v` / `task_blocking_v`), which is rebuilt from source on every boot
 * and is not migration schema, so a migrations-only throwaway cannot reproduce
 * it.
 *
 * **CONSTRAINT — a scenario may only contain failures that are JS-level
 * `throw`s.** The body keeps reading from the same `tx` after an asserted
 * rejection, and that is sound only while no statement raises a *Postgres*
 * error: a PG error puts the transaction in the aborted state and every later
 * statement fails with "current transaction is aborted" instead of doing what
 * the test asked. So a case whose failure mode is a constraint violation or a
 * bad cast needs its own savepoint — do not simply add it to a scenario.
 */
export async function worktreeDbScenario<T>(
  body: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  await ensureQueueSchema();

  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await body(tx);
      throw new Rollback();
    });
  } catch (err) {
    // Only the sentinel is ours. Anything else is the scenario failing for
    // real and must reach the test runner untouched.
    if (!(err instanceof Rollback)) throw err;
  }
  return result!;
}
