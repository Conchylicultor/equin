/**
 * A launch whose spawn job dead-letters leaves `starting` with its failure
 * shown — end to end, through the real job, queue, hook and reconciler.
 *
 * The hang this pins (2026-11-05): once the 30 s "stuck starting" timer was
 * gone, a `starting` row was decided only by whether its spawn was still in
 * flight. That is a fact, but nothing turned the spawn's terminal failure INTO
 * the row's state: a spawn parked on its checkout wait whose wake-up died
 * stayed "in flight" forever, and a dead-lettered spawn left its row to
 * whoever looked next. Now the job's death is announced (`onDead`), the
 * launch is recorded as failed, and the reconcile it asks for moves the row.
 *
 * The suite runs the REAL `conversations.spawn` handler on the in-process
 * queue, over a throwaway database standing in for the app's `db` (its
 * `DatabaseDriver`). The handler fails at its first step — no workspace kind
 * is registered here, so the scratch spec's kind is unknown — on every
 * attempt; `settleJobQueue` fast-forwards the retries until the row is dead.
 * No runtime is registered, so the reconcile sees no live session. No report
 * kind is registered either: the reports the path files are logged as failed
 * to record (`[conversations.status] recordReport failed`), and the user's
 * notification — what this asserts — is written regardless.
 *
 * Requires the running embedded cluster — `./equin build` first.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  DatabaseDriver,
  type DatabaseDriverImpl,
  type Db,
} from "@plugins/database/server";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { withHostServices } from "@plugins/framework/plugins/server-core/core/testing";
import { JobQueue } from "@plugins/infra/plugins/jobs/server";
import { settleJobQueue } from "@plugins/infra/plugins/jobs/plugins/in-process/server";
import { createInProcessQueue } from "@plugins/infra/plugins/jobs/plugins/in-process/server/testing";
import { installTaskDerivedSchema } from "@plugins/tasks/plugins/tasks-core/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  asNamespace,
  MAIN_WORKTREE_NAME,
} from "@plugins/infra/plugins/namespace/core";
import {
  declareRuntimeNamespace,
  runtimeNamespace,
} from "@plugins/infra/plugins/runtime-identity/core";
import { resetRuntimeNamespaceForTest } from "@plugins/infra/plugins/runtime-identity/core/testing";
import { spawnConversationJob } from "./spawn-job";
import { startStatusReconciler } from "./status-reconciler";

let t: TestDb;

/**
 * Reconcile as MAIN's backend: conversation rows are main's to settle (a
 * worktree's reconciler leaves its fork's copies alone —
 * `decideMissingProcessAction`), so the reconcile runs under main's name,
 * and the preload's own declaration is put back right after.
 */
async function reconcileAsMain(): Promise<void> {
  const own = runtimeNamespace();
  resetRuntimeNamespaceForTest();
  declareRuntimeNamespace(asNamespace(MAIN_WORKTREE_NAME));
  try {
    await startStatusReconciler();
  } finally {
    resetRuntimeNamespaceForTest();
    declareRuntimeNamespace(own);
  }
}

// Provisioning a throwaway DB and running the full migration chain overruns
// bun's 5s default.
setDefaultTimeout(120_000);

/** The throwaway as the app's database: `db` forwards every call to it. */
function throwawayDriver(database: Db): DatabaseDriverImpl {
  const unused = (what: string) => () => {
    throw new Error(`[spawn-dead-letter test] ${what} is not used here`);
  };
  return {
    db: () => database,
    ready: async () => {},
    bootDdl: unused("bootDdl"),
    listen: unused("listen"),
    holdSchemaGeneration: unused("holdSchemaGeneration"),
    awaitGenerationsGone: unused("awaitGenerationsGone"),
  };
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "spawn_dead_letter_test" });
  await runMigrations(t.db);
  await installTaskDerivedSchema(t.db);
  await spawnConversationJob.register();
});

afterAll(async () => {
  await t.drop();
});

const TASK = "task-spawn-dead-letter";
const ATTEMPT = "att-spawn-dead-letter";
const CONV = "conv-spawn-dead-letter";

test("a spawn job that dead-letters takes its conversation out of starting, its failure shown", async () => {
  await t.db.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, rank, mandate_ref)
    VALUES (${TASK}, ${TASK}, 'dead-letter launch', 'a0', 'interactive')
  `);
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${ATTEMPT}, ${TASK}, ${`/tmp/${ATTEMPT}`})
  `);
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, spawned_by)
    VALUES (${CONV}, ${ATTEMPT}, 'starting', 'sdk', ${FALLBACK_MODEL}, 'test')
  `);

  const queue = createInProcessQueue();
  await withHostServices(
    [
      DatabaseDriver.provide(throwawayDriver(t.db as unknown as Db)),
      JobQueue.provide(queue),
    ],
    async () => {
      await queue.start();
      try {
        await spawnConversationJob.enqueue({
          conversationId: CONV,
          attemptId: ATTEMPT,
          worktreePath: `/tmp/${ATTEMPT}`,
          workspace: { kind: "scratch", profile: "none", input: {} },
          runtimeId: "sdk",
          create: { model: FALLBACK_MODEL, forkSession: false },
        });
        // Every attempt fails; the last one dead-letters the row.
        const settled = settleJobQueue();
        expect(settled).rejects.toThrow("conversations.spawn");

        // Dead: no longer in flight, and the death recorded the launch as
        // failed with its error before any reconcile ran.
        expect(await spawnConversationJob.inFlight([CONV])).toEqual(new Set());
        const failure = await t.db.execute(sql`
          SELECT step, message FROM conversations_ext_spawn_failure
           WHERE parent_id = ${CONV}
        `);
        expect(failure.rows).toEqual([
          { step: "worktree", message: 'Unknown workspace kind "scratch"' },
        ]);

        // One reconcile — what the death's request, the sweep or a boot runs.
        await reconcileAsMain();
        const row = await t.db.execute(
          sql`SELECT status FROM conversations WHERE id = ${CONV}`,
        );
        expect(row.rows).toEqual([{ status: "gone" }]);
        const shown = await t.db.execute(sql`
          SELECT title, detail FROM notifications
           WHERE dedup_key = ${`conversation-start-failed:${CONV}`}
        `);
        expect(shown.rows).toEqual([
          {
            title: "Couldn't start conversation",
            detail:
              'Preparing the workspace failed: Unknown workspace kind "scratch"',
          },
        ]);
      } finally {
        // The death's own reconcile request drains after the boot reconcile;
        // a second pass waits behind it on the reconcile gate, so nothing
        // still reads the throwaway once it is dropped.
        await reconcileAsMain();
        await queue.stop();
      }
    },
  );
});
