/**
 * Real-DB suite for the atomic auto-launch (`launchArmedTask`): the auto-start
 * marker and the launch — attempt, conversation, fork + spawn jobs — commit
 * together or not at all, and two runners racing for one armed task launch it
 * exactly once.
 *
 * Why a `createTestDb` throwaway and not `worktreeDbScenario`: the race case
 * needs two transactions that genuinely block on each other and COMMIT, which a
 * single always-rolled-back scenario cannot hold. And a throwaway has no worker
 * attached, so a committed `conversations.spawn` row is just a row — nothing
 * checks out a worktree or starts an agent. Every statement the code under
 * test runs goes through the transaction handed to it, so pointing that
 * transaction at the throwaway is enough; the view + rollup DDL the launch reads
 * is installed by tasks-core's `installTaskDerivedSchema`.
 *
 * `prepareConversation` is not exercised: it is the read-only half (runtime
 * registry, worktree root, attachment and preprompt lookups against the real
 * pool). The suite hands `launchArmedTask` a prepared launch directly.
 *
 * Requires the running embedded cluster — `./singularity build` first.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  setDefaultTimeout,
} from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { installQueueSchema } from "@plugins/infra/plugins/jobs/server/testing";
import type { DbExecutor } from "@plugins/tasks/plugins/tasks-core/server";
import {
  installTaskDerivedSchema,
  runStatusBatchOn,
} from "@plugins/tasks/plugins/tasks-core/server/testing";
import {
  DEFAULT_MODEL_CHOICE,
  FALLBACK_MODEL,
} from "@plugins/conversations/plugins/model-provider/core";
import { installWorkspaceImpl } from "@plugins/conversations/plugins/workspace/server/testing";
import { worktreeWorkspace } from "@plugins/conversations/plugins/workspace/plugins/worktree/server/testing";

const MODEL = FALLBACK_MODEL;
import { launchArmedTask, type IfAlreadyStarted } from "./auto-start-jobs";
import type { PreparedConversation } from "./lifecycle";

let t: TestDb;
// `createTestDb`'s own pool holds ONE connection, so two runners on it would
// queue for the connection rather than race for the marker row lock. The
// runners (and the lock observer) get a pool of their own on the throwaway.
let racePool: Pool;
let raceDb: NodePgDatabase;

// Provisioning a throwaway DB and running the full migration chain overruns
// bun's 5s default.
setDefaultTimeout(120_000);

beforeAll(async () => {
  // The commit enqueues the workspace's own job (a worktree's DB fork) through
  // the registry, which no register phase fills here.
  installWorkspaceImpl(worktreeWorkspace);
  t = await createTestDb({ prefix: "autolaunch_test" });
  await runMigrations(t.db);
  await installQueueSchema(t.connectionString);
  await installTaskDerivedSchema(t.db);
  racePool = new Pool({ connectionString: t.connectionString, max: 4 });
  raceDb = drizzle(racePool);
});

afterAll(async () => {
  await racePool.end();
  await t.drop();
});

// ── seeding (raw SQL: no jobs, no emits) ─────────────────────────────────────

let seq = 0;
const nextId = (kind: string): string => `${kind}-${++seq}-${Date.now()}`;

async function seedArmedTask(): Promise<string> {
  const id = nextId("task");
  await t.db.execute(sql`
    INSERT INTO tasks (id, title, rank) VALUES (${id}, ${`title ${id}`}, ${`a${seq}`})
  `);
  await t.db.execute(sql`
    INSERT INTO tasks_ext_auto_start (parent_id, auto_start_at, auto_start_model)
    VALUES (${id}, now(), ${DEFAULT_MODEL_CHOICE})
  `);
  return id;
}

async function seedAttemptWithConversation(
  taskId: string,
  conversationId = nextId("conv"),
): Promise<string> {
  const attemptId = nextId("att");
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attemptId}, ${taskId}, ${`/tmp/${attemptId}`})
  `);
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, spawned_by)
    VALUES (${conversationId}, ${attemptId}, 'working', 'sdk', ${MODEL}, 'test')
  `);
  return attemptId;
}

function prepared(taskId: string): PreparedConversation {
  const attemptId = nextId("att");
  return {
    runtimeId: "sdk",
    conversationId: nextId("conv"),
    model: MODEL,
    spawnedBy: "test",
    kind: "user",
    rawPrompt: "do the thing",
    launchTurn: { text: "do the thing", typedText: "do the thing" },
    prepromptId: undefined,
    workspace: {
      attemptId,
      path: `/tmp/${attemptId}`,
      spec: { kind: "worktree" },
    },
    target: { kind: "new", attemptId, taskId },
    create: {
      model: MODEL,
      forkSession: false,
    },
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const { rows } = await t.db.execute(query);
  return Number((rows[0] as { n: string | number }).n);
}

const markerCount = (taskId: string) =>
  count(
    sql`SELECT count(*) AS n FROM tasks_ext_auto_start WHERE parent_id = ${taskId}`,
  );
const attemptCount = (taskId: string) =>
  count(sql`SELECT count(*) AS n FROM attempts WHERE task_id = ${taskId}`);
const conversationCount = (taskId: string) =>
  count(sql`
    SELECT count(*) AS n FROM conversations c
    JOIN attempts a ON a.id = c.attempt_id WHERE a.task_id = ${taskId}
  `);
// Every launch job (fork + spawn) carries the attempt id in its payload. The
// public `graphile_worker.jobs` view does not expose `payload`.
const launchJobCount = (attemptId: string) =>
  count(sql`
    SELECT count(*) AS n FROM graphile_worker._private_jobs
    WHERE payload::text LIKE ${`%${attemptId}%`}
  `);

// ── the launch, on its own transaction ──────────────────────────────────────

/**
 * One runner: open a transaction on the throwaway, run the launch as a status
 * batch, then (optionally) hold the transaction open on `beforeCommit` so a
 * concurrent runner can be observed blocking on it. Runs as the queue does
 * (`skip`) unless a case says otherwise.
 */
function launch(
  taskId: string,
  p: PreparedConversation,
  beforeCommit?: () => Promise<void>,
  ifAlreadyStarted: IfAlreadyStarted = "skip",
): Promise<boolean> {
  return raceDb.transaction(async (tx) => {
    // The throwaway's drizzle handle is schema-less; at runtime it is the same
    // node-postgres transaction every mutation takes.
    const exec = tx as unknown as DbExecutor;
    const launched = await runStatusBatchOn(exec, (batchTx) =>
      launchArmedTask(batchTx, taskId, p, { ifAlreadyStarted }),
    );
    if (beforeCommit) await beforeCommit();
    return launched;
  });
}

class InjectedRollback extends Error {}

/** Resolves once some session in the throwaway is waiting on a row lock. */
async function untilSomeoneWaitsOnALock(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await raceDb.execute(sql`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `);
    const waiting = Number((rows[0] as { n: string | number }).n);
    if (waiting > 0) return;
    if (Date.now() > deadline) {
      throw new Error("no session ever blocked on the marker row lock");
    }
    await Bun.sleep(20);
  }
}

describe("launchArmedTask", () => {
  test("a launch that throws after createAttempt rolls back and leaves the task armed", async () => {
    const taskId = await seedArmedTask();
    const p = prepared(taskId);
    // Make the conversation INSERT fail — after the attempt row and the fork
    // job were already written on the transaction — by taking its id first.
    const otherTask = await seedArmedTask();
    await seedAttemptWithConversation(otherTask, p.conversationId);

    // The injected failure, and only it: a unique violation on the
    // conversation id.
    const [result] = await Promise.allSettled([launch(taskId, p)]);
    expect(result.status).toBe("rejected");
    expect(
      result.status === "rejected" && (result.reason as { code?: string }).code,
    ).toBe("23505");

    expect(await markerCount(taskId)).toBe(1);
    expect(await attemptCount(taskId)).toBe(0);
    expect(await conversationCount(taskId)).toBe(0);
    expect(await launchJobCount(p.target.attemptId)).toBe(0);
  });

  test("a successful launch consumes the marker and commits every launch row", async () => {
    const taskId = await seedArmedTask();
    const p = prepared(taskId);

    expect(await launch(taskId, p)).toBe(true);

    expect(await markerCount(taskId)).toBe(0);
    expect(await attemptCount(taskId)).toBe(1);
    expect(await conversationCount(taskId)).toBe(1);
    // database.fork + conversations.spawn.
    expect(await launchJobCount(p.target.attemptId)).toBe(2);
  });

  test("two racing runners: the first commits, the blocked second launches nothing", async () => {
    const taskId = await seedArmedTask();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    const first = launch(taskId, prepared(taskId), () => held);
    // Let the first claim the marker before the second starts.
    await Bun.sleep(200);
    const second = launch(taskId, prepared(taskId));
    await untilSomeoneWaitsOnALock();
    release();

    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(await attemptCount(taskId)).toBe(1);
    expect(await conversationCount(taskId)).toBe(1);
    expect(await markerCount(taskId)).toBe(0);
  });

  test("two racing runners: the first rolls back, the blocked second launches once", async () => {
    const taskId = await seedArmedTask();
    const firstPrepared = prepared(taskId);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    const first = launch(taskId, firstPrepared, async () => {
      await held;
      throw new InjectedRollback();
    });
    await Bun.sleep(200);
    const second = launch(taskId, prepared(taskId));
    await untilSomeoneWaitsOnALock();
    release();

    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second,
    ]);
    expect(firstResult.status).toBe("rejected");
    expect(secondResult).toEqual({ status: "fulfilled", value: true });
    expect(await attemptCount(taskId)).toBe(1);
    expect(await conversationCount(taskId)).toBe(1);
    expect(await markerCount(taskId)).toBe(0);
    expect(await launchJobCount(firstPrepared.target.attemptId)).toBe(0);
  });

  test("a task that already has an attempt gets no new rows", async () => {
    const taskId = await seedArmedTask();
    await seedAttemptWithConversation(taskId);
    const p = prepared(taskId);

    expect(await launch(taskId, p)).toBe(false);

    expect(await attemptCount(taskId)).toBe(1);
    expect(await conversationCount(taskId)).toBe(1);
    expect(await launchJobCount(p.target.attemptId)).toBe(0);
  });

  test("an explicit launch of a task that already has an attempt starts another run", async () => {
    // A second "Fix this crash" on one report reuses the report's live task:
    // the user is asking for another run, so an attempt is no reason to refuse.
    const taskId = await seedArmedTask();
    await seedAttemptWithConversation(taskId);
    const p = prepared(taskId);

    expect(await launch(taskId, p, undefined, "launch")).toBe(true);

    expect(await markerCount(taskId)).toBe(0);
    expect(await attemptCount(taskId)).toBe(2);
    expect(await conversationCount(taskId)).toBe(2);
    expect(await launchJobCount(p.target.attemptId)).toBe(2);
  });

  test("an explicit launch still claims the arm exactly once", async () => {
    // `launch` relaxes only the attempt check — with the marker already
    // claimed, there is nothing to launch.
    const taskId = await seedArmedTask();
    expect(await launch(taskId, prepared(taskId), undefined, "launch")).toBe(
      true,
    );

    const p = prepared(taskId);
    expect(await launch(taskId, p, undefined, "launch")).toBe(false);
    expect(await attemptCount(taskId)).toBe(1);
    expect(await launchJobCount(p.target.attemptId)).toBe(0);
  });
});
