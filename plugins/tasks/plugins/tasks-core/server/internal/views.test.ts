/**
 * Real-DB semantics suite for the derived task views (`views.ts`) — the pure-SQL
 * rules that are otherwise unguarded. Two families:
 *
 * 1. STATUS PRECEDENCE in `tasks_v` / `task_blocking_v` (the "Hold & close" bug,
 *    below).
 * 2. I6 in `attempts_v` — every status arm names a fact the row PROVES, and a
 *    `pushes` row may only promote an attempt to a landed claim, never select one
 *    by its absence. The last describe block is that truth table.
 *
 * The bug this pins down: "Hold & close" wrote `held_at`, closed the last live
 * conversation, which flipped the attempt `pushed` → `completed`, which made
 * `tasks_v` resolve the task to `done` — discarding the hold and emitting
 * taskStatusChanged{status:'done'}, which unblocks everything downstream. The
 * next task launched itself ~40s after the user held this one.
 *
 * Held now outranks a completed attempt in BOTH derived views, and the two must
 * stay in agreement (`task_blocking_v` re-derives "settled" from the raw columns
 * because it cannot read `tasks_v.status` without a cycle) — so both are asserted
 * here off one seeded graph.
 *
 * Headless: no server boot, no plugin registry. The view + rollup DDL is installed
 * straight from the exported declarations, so the SQL under test is byte-identical
 * to what `rebuildDerivedViews` / `rebuildDerivedTables` install at boot.
 *
 * Run: `bun test plugins/tasks/plugins/tasks-core/server/internal/views.test.ts`
 * (requires the running embedded cluster — `./singularity build` first).
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
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { compileCreateView } from "@plugins/database/plugins/derived-views/core";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import { attemptConvAgg, attemptPushAgg } from "./rollup-spec";
import { eq } from "drizzle-orm";
import { attempts, taskBlocking, tasks } from "./views";

let t: TestDb;

// Provisioning a throwaway DB and running the full migration chain overruns
// bun's 5s default, which surfaces as an unrelated "pool already ended" error.
setDefaultTimeout(120_000);

beforeAll(async () => {
  t = await createTestDb({ prefix: "tv_test" });
  // The real migration chain — the real base tables, FKs and cascades.
  await runMigrations(t.db);

  // The migration chain still contains the historical CREATE VIEW statements
  // from before plain views became derived code, so drop whatever it left
  // behind before installing the current definitions (CASCADE: tasks_v reads
  // attempts_v). Mirrors rebuildDerivedViews' drop-in-reverse-dependency-order.
  for (const name of [
    "tasks_v",
    "task_blocking_v",
    "conversations_v",
    "attempts_v",
  ]) {
    await t.db.execute(
      sql.raw(`DROP VIEW IF EXISTS "public"."${name}" CASCADE`),
    );
  }

  // attempts_v LEFT JOINs the two trigger-maintained rollups; without them the
  // view compiles but every attempt reads as 'pending'.
  await installRollups(t.db, [attemptConvAgg, attemptPushAgg]);

  // Dependency order: attempts_v → task_blocking_v → tasks_v.
  for (const [name, view] of [
    ["attempts_v", attempts],
    ["task_blocking_v", taskBlocking],
    ["tasks_v", tasks],
  ] as const) {
    await t.db.execute(
      sql.raw(compileCreateView({ name, view, dependsOn: [] })),
    );
  }
});

afterAll(async () => {
  await t.drop();
});

// ── seeding ──────────────────────────────────────────────────────────────────
// Raw INSERTs: the rank/status columns are branded value objects on the drizzle
// side, and this suite is about the SQL the views run, not the TS mapping.

let seq = 0;
const nextId = (kind: string): string => `${kind}-${++seq}`;

async function seedTask(
  opts: { held?: boolean; dropped?: boolean } = {},
): Promise<string> {
  const id = nextId("task");
  await t.db.execute(sql`
    INSERT INTO tasks (id, title, rank, held_at, dropped_at)
    VALUES (${id}, ${`title ${id}`}, ${`a${seq}`},
            ${opts.held ? sql`now()` : sql`NULL`},
            ${opts.dropped ? sql`now()` : sql`NULL`})
  `);
  return id;
}

async function seedAttempt(taskId: string): Promise<string> {
  const id = nextId("att");
  await t.db.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path) VALUES (${id}, ${taskId}, ${`/tmp/${id}`})
  `);
  return id;
}

/** `status: 'done'` is a closed conversation; anything else counts as live. */
async function seedConversation(
  attemptId: string,
  status: string,
): Promise<string> {
  const id = nextId("conv");
  await t.db.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, model, ended_at)
    VALUES (${id}, ${attemptId}, ${status}, ${FALLBACK_MODEL},
            ${status === "done" ? sql`now()` : sql`NULL`})
  `);
  return id;
}

async function seedPush(attemptId: string): Promise<void> {
  const id = nextId("push");
  await t.db.execute(sql`
    INSERT INTO pushes (id, attempt_id, sha, push_id, message)
    VALUES (${id}, ${attemptId}, ${`sha-${id}`}, ${`pid-${id}`}, ${"msg"})
  `);
}

async function seedDependency(
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  await t.db.execute(sql`
    INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (${taskId}, ${dependsOnTaskId})
  `);
}

/** The exact shape of the reported bug: an attempt that pushed, then closed. */
async function seedPushedAndClosed(taskId: string): Promise<void> {
  const attemptId = await seedAttempt(taskId);
  await seedConversation(attemptId, "done");
  await seedPush(attemptId);
}

async function taskStatus(
  id: string,
): Promise<{ status: string; finishedAt: Date | null }> {
  const { rows } = await t.db.execute(
    sql`SELECT status, finished_at FROM tasks_v WHERE id = ${id}`,
  );
  const row = rows[0] as
    { status: string; finished_at: Date | null } | undefined;
  if (!row) throw new Error(`no tasks_v row for ${id}`);
  return { status: row.status, finishedAt: row.finished_at };
}

async function attemptRow(id: string): Promise<{
  status: string;
  active: boolean;
  retained: boolean;
  finishedAt: Date | null;
}> {
  const { rows } = await t.db.execute(
    sql`SELECT status, active, retained, finished_at FROM attempts_v WHERE id = ${id}`,
  );
  const row = rows[0] as
    | {
        status: string;
        active: boolean;
        retained: boolean;
        finished_at: Date | null;
      }
    | undefined;
  if (!row) throw new Error(`no attempts_v row for ${id}`);
  return {
    status: row.status,
    active: row.active,
    retained: row.retained,
    finishedAt: row.finished_at,
  };
}

/**
 * One attempt per truth-table cell: the conversation shape it holds, and whether
 * a ledger row exists for it.
 *
 * `convStatus: null` seeds no conversation at all. `"working"` is live-and-open,
 * `"gone"` is open-but-not-live (the process vanished — usually hibernation),
 * `"done"` is neither (explicitly closed).
 */
async function seedCell(opts: {
  convStatus: string | null;
  push: boolean;
}): Promise<string> {
  const attemptId = await seedAttempt(await seedTask());
  if (opts.convStatus !== null) {
    await seedConversation(attemptId, opts.convStatus);
  }
  if (opts.push) await seedPush(attemptId);
  return attemptId;
}

async function isBlocked(id: string): Promise<boolean> {
  const { rows } = await t.db.execute(
    sql`SELECT has_blocking_dep FROM task_blocking_v WHERE task_id = ${id}`,
  );
  const row = rows[0] as { has_blocking_dep: boolean } | undefined;
  // No row ⇒ no dependency edges ⇒ not blocked (consumers COALESCE the absence).
  return row?.has_blocking_dep ?? false;
}

// ── status precedence ────────────────────────────────────────────────────────

describe("tasks_v status — hold vs a completed attempt", () => {
  test("baseline: an attempt that pushed and closed makes the task done", async () => {
    const taskId = await seedTask();
    await seedPushedAndClosed(taskId);

    const { status, finishedAt } = await taskStatus(taskId);
    expect(status).toBe("done");
    expect(finishedAt).not.toBeNull();
  });

  test("held wins over that completed attempt (the Hold & close bug)", async () => {
    const taskId = await seedTask({ held: true });
    await seedPushedAndClosed(taskId);

    const { status, finishedAt } = await taskStatus(taskId);
    expect(status).toBe("held");
    // A held task is not finished — status and finished_at must not contradict.
    expect(finishedAt).toBeNull();
  });

  test("held with no attempt at all is still held", async () => {
    const taskId = await seedTask({ held: true });
    expect((await taskStatus(taskId)).status).toBe("held");
  });

  test("a live conversation still outranks the hold, mirroring dropped", async () => {
    const heldTask = await seedTask({ held: true });
    const heldAttempt = await seedAttempt(heldTask);
    await seedConversation(heldAttempt, "running");

    const droppedTask = await seedTask({ dropped: true });
    const droppedAttempt = await seedAttempt(droppedTask);
    await seedConversation(droppedAttempt, "running");

    expect((await taskStatus(heldTask)).status).toBe("in_progress");
    expect((await taskStatus(droppedTask)).status).toBe("in_progress");
  });

  test("dropped still loses to a completed attempt (unchanged)", async () => {
    const taskId = await seedTask({ dropped: true });
    await seedPushedAndClosed(taskId);

    expect((await taskStatus(taskId)).status).toBe("done");
  });
});

// ── blocking, which is what actually launched the next agent ─────────────────

describe("task_blocking_v — a held dependency keeps blocking", () => {
  test("baseline: a done dependency stops blocking its dependent", async () => {
    const dep = await seedTask();
    await seedPushedAndClosed(dep);
    const dependent = await seedTask();
    await seedDependency(dependent, dep);

    expect(await isBlocked(dependent)).toBe(false);
  });

  test("holding that same dependency re-blocks the dependent", async () => {
    const dep = await seedTask({ held: true });
    await seedPushedAndClosed(dep);
    const dependent = await seedTask();
    await seedDependency(dependent, dep);

    expect(await isBlocked(dependent)).toBe(true);
    // And the dependent reports it, so the UI agrees with the auto-start gate.
    expect((await taskStatus(dependent)).status).toBe("blocked");
  });

  test("a dropped dependency still stops blocking (unchanged)", async () => {
    const dep = await seedTask({ dropped: true });
    const dependent = await seedTask();
    await seedDependency(dependent, dep);

    expect(await isBlocked(dependent)).toBe(false);
  });

  test("blocking walks transitively through a held ancestor", async () => {
    const ancestor = await seedTask({ held: true });
    await seedPushedAndClosed(ancestor);
    const middle = await seedTask();
    await seedPushedAndClosed(middle);
    const dependent = await seedTask();
    await seedDependency(middle, ancestor);
    await seedDependency(dependent, middle);

    expect(await isBlocked(dependent)).toBe(true);
  });
});

// ── the two blocked statuses ─────────────────────────────────────────────────

describe("tasks_v — a running agent on a blocked task reports in_progress_blocked", () => {
  test("at rest, a blocked task is `blocked`", async () => {
    const dep = await seedTask();
    const dependent = await seedTask();
    await seedDependency(dependent, dep);

    expect((await taskStatus(dependent)).status).toBe("blocked");
  });

  test("with a live conversation it is `in_progress_blocked`, not `blocked`", async () => {
    const dep = await seedTask();
    const dependent = await seedTask();
    await seedDependency(dependent, dep);
    const attemptId = await seedAttempt(dependent);
    await seedConversation(attemptId, "working");

    // Still blocked (the prerequisite is unresolved) — but the live attempt is
    // no longer hidden behind the plain `blocked` badge.
    expect(await isBlocked(dependent)).toBe(true);
    expect((await taskStatus(dependent)).status).toBe("in_progress_blocked");
  });

  test("blocking still outranks need_action, so a waiting agent reads as blocked", async () => {
    const dep = await seedTask();
    const dependent = await seedTask();
    await seedDependency(dependent, dep);
    const attemptId = await seedAttempt(dependent);
    await seedConversation(attemptId, "waiting");

    expect((await taskStatus(dependent)).status).toBe("in_progress_blocked");
  });

  test("an unblocked task with a waiting agent is `need_action`, and back to `in_progress` once it works again", async () => {
    // `need_action` is read off the rollup's `has_waiting_conv`, not
    // `conversations.status` directly: the INSERT arm of the rollup trigger
    // sets it, and the UPDATE arm must clear it.
    const task = await seedTask();
    const attemptId = await seedAttempt(task);
    const convId = await seedConversation(attemptId, "waiting");

    expect((await taskStatus(task)).status).toBe("need_action");

    await t.db.execute(
      sql`UPDATE conversations SET status = 'working' WHERE id = ${convId}`,
    );
    expect((await taskStatus(task)).status).toBe("in_progress");
  });

  test("resolving the prerequisite hands the running task back to in_progress", async () => {
    const dep = await seedTask();
    await seedPushedAndClosed(dep);
    const dependent = await seedTask();
    await seedDependency(dependent, dep);
    const attemptId = await seedAttempt(dependent);
    await seedConversation(attemptId, "working");

    expect((await taskStatus(dependent)).status).toBe("in_progress");
  });
});

// ── I6: every attempt status names a fact the row proves ─────────────────────
//
// The CASE used to end in `ELSE 'abandoned'` — the one verdict in the whole
// derivation reached from MISSING evidence. `has_push IS NULL` means at least
// four different things (never pushed / finished with nothing to push / landed on
// an untrailered commit / the ledger has not caught up), and it also caught every
// hibernated attempt, because `gone` is not live. The table below is the pin:
// every cell's status is selected by a column that is TRUE, and the two coherence
// assertions below it are I6 itself, stated so a future edit has to break a test
// rather than a comment.

type Cell = {
  name: string;
  convStatus: string | null;
  push: boolean;
  status: string;
  /** A landed claim — the only kind a `pushes` row may produce. */
  landedClaim: boolean;
  finished: boolean;
};

const STATUS_TRUTH_TABLE: Cell[] = [
  // No conversation yet: nothing has run, whatever the ledger says.
  {
    name: "no conversation",
    convStatus: null,
    push: false,
    status: "pending",
    landedClaim: false,
    finished: false,
  },
  {
    name: "no conversation, ledger row",
    convStatus: null,
    push: true,
    status: "pending",
    landedClaim: false,
    finished: false,
  },
  // Live conversation: the push only decides in_progress vs pushed.
  {
    name: "live conversation",
    convStatus: "working",
    push: false,
    status: "in_progress",
    landedClaim: false,
    finished: false,
  },
  {
    name: "live conversation + ledger row",
    convStatus: "working",
    push: true,
    status: "pushed",
    landedClaim: true,
    finished: false,
  },
  // Open but not live (`gone`): the process vanished, the attempt is resumable.
  {
    name: "gone conversation",
    convStatus: "gone",
    push: false,
    status: "dormant",
    landedClaim: false,
    finished: false,
  },
  {
    name: "gone conversation + ledger row",
    convStatus: "gone",
    push: true,
    status: "completed",
    landedClaim: true,
    finished: true,
  },
  // Explicitly closed.
  {
    name: "closed conversation",
    convStatus: "done",
    push: false,
    status: "closed",
    landedClaim: false,
    finished: true,
  },
  {
    name: "closed conversation + ledger row",
    convStatus: "done",
    push: true,
    status: "completed",
    landedClaim: true,
    finished: true,
  },
];

describe("attempts_v status — I6, a claim only where a fact proves it", () => {
  for (const cell of STATUS_TRUTH_TABLE) {
    test(`${cell.name} reads ${cell.status}`, async () => {
      const attemptId = await seedCell(cell);
      const row = await attemptRow(attemptId);

      expect(row.status).toBe(cell.status);
      // A status that is over carries a finish instant; one that is still
      // resumable or has not started must not.
      expect(row.finishedAt !== null).toBe(cell.finished);
    });
  }

  test("finished_at is set for exactly the two statuses that are over", async () => {
    // The equivalence, stated over the whole table rather than arm by arm:
    // `completed` and `closed` are finished, and NOTHING else may carry an
    // instant — not `dormant` (resumable) and not `pending` (never ran).
    const OVER = new Set(["completed", "closed"]);
    for (const cell of STATUS_TRUTH_TABLE) {
      const row = await attemptRow(await seedCell(cell));
      expect(row.finishedAt !== null).toBe(OVER.has(row.status));
    }
  });

  test("no status is `abandoned` — the verdict has no spelling", async () => {
    for (const cell of STATUS_TRUTH_TABLE) {
      const row = await attemptRow(await seedCell(cell));
      expect(row.status).not.toBe("abandoned");
    }
  });

  test("only a ledger row can produce a landed claim", async () => {
    for (const cell of STATUS_TRUTH_TABLE) {
      const row = await attemptRow(await seedCell(cell));
      const claimsLanded =
        row.status === "pushed" || row.status === "completed";
      expect(claimsLanded).toBe(cell.landedClaim);
      // The whole of I6 in one line: a landed claim implies the evidence.
      if (claimsLanded) expect(cell.push).toBe(true);
    }
  });

  test("adding the ledger row only ever moves a cell UP, never sideways", async () => {
    // The negative arms must be functions of the conversation rollup alone, so
    // that a lagging or untrailered push can downgrade the badge but can never
    // change WHICH non-landed story it tells.
    for (const convStatus of [null, "working", "gone", "done"]) {
      const without = await attemptRow(
        await seedCell({ convStatus, push: false }),
      );
      const withPush = await attemptRow(
        await seedCell({ convStatus, push: true }),
      );
      const landed = (s: string) => s === "pushed" || s === "completed";
      if (!landed(withPush.status)) {
        expect(withPush.status).toBe(without.status);
      }
    }
  });

  test("a hibernated attempt is dormant and retained, not finished", async () => {
    // The regression that had nothing to do with push lag: hibernation parks an
    // idle pane as `gone`, which is not live but IS open — and `gone` is exactly
    // the status `resumeConversation` requires. It used to read `abandoned`.
    const attemptId = await seedCell({ convStatus: "gone", push: false });
    const row = await attemptRow(attemptId);

    expect(row.status).toBe("dormant");
    expect(row.active).toBe(false); // no agent is running
    expect(row.retained).toBe(true); // but the worktree is still the user's
    expect(row.finishedAt).toBeNull();
  });

  test("tasks_v still resolves `done` from a landed attempt only", async () => {
    // tasks_v is deliberately untouched by the split: `hasCompleted` compares
    // against 'completed', which the new arms cannot reach.
    const closedTask = await seedTask();
    const closedAttempt = await seedAttempt(closedTask);
    await seedConversation(closedAttempt, "done");

    const doneTask = await seedTask();
    await seedPushedAndClosed(doneTask);

    expect((await taskStatus(closedTask)).status).toBe("attempted");
    expect((await taskStatus(doneTask)).status).toBe("done");
  });
});

// ── the projections' decoders ────────────────────────────────────────────────

describe("the view's computed columns decode to what they claim", () => {
  // These read THROUGH the view objects (`db.select().from(tasks)`), which is
  // the only path that exercises the decoders: a decoder lives on the JS `SQL`
  // object, not in Postgres, so the raw `db.execute(sql`SELECT …`)` every other
  // helper here uses bypasses it by construction.
  //
  // The columns below used to be `sql<Date | null>` / `sql<TaskStatus>` — types
  // written by hand over drizzle's no-op decoder. `finished_at` in particular
  // held a raw pg STRING for its whole life, because drizzle's pg driver returns
  // timestamps unparsed and the `Date` mapping lives on the column type a raw
  // projection does not have. Nothing typed could catch that; this can.

  test("tasks_v.finished_at is a real Date, and status is one of the enum arms", async () => {
    const taskId = await seedTask();
    await seedPushedAndClosed(taskId);

    const [row] = await t.db
      .select({ status: tasks.status, finishedAt: tasks.finishedAt })
      .from(tasks)
      .where(eq(tasks.id, taskId));

    expect(row?.status).toBe("done");
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  test("attempts_v.finished_at is a real Date, and the flags are real booleans", async () => {
    const attemptId = await seedCell({ convStatus: "done", push: true });

    const [row] = await t.db
      .select({
        status: attempts.status,
        active: attempts.active,
        retained: attempts.retained,
        finishedAt: attempts.finishedAt,
      })
      .from(attempts)
      .where(eq(attempts.id, attemptId));

    expect(row?.status).toBe("completed");
    expect(typeof row?.active).toBe("boolean");
    expect(typeof row?.retained).toBe("boolean");
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  test("a task with no finish instant decodes to null, not to an Invalid Date", async () => {
    // The decoder is never called for a NULL — drizzle short-circuits — so this
    // pins the half a decoder structurally cannot police.
    const taskId = await seedTask();

    const [row] = await t.db
      .select({ finishedAt: tasks.finishedAt })
      .from(tasks)
      .where(eq(tasks.id, taskId));

    expect(row?.finishedAt).toBeNull();
  });

  test("tasks_v.dependencies is a real array, empty when there are no edges", async () => {
    // `array_agg` is the shape that produced the sql-rows incident: over a
    // column pg has no array decoder for, the WHOLE array arrives as one raw
    // literal string. `parsed` is what turns that into a throw.
    const depTask = await seedTask();
    const taskId = await seedTask();
    await seedDependency(taskId, depTask);

    const [withDeps] = await t.db
      .select({ dependencies: tasks.dependencies })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    expect(withDeps?.dependencies).toEqual([depTask]);

    const [withNone] = await t.db
      .select({ dependencies: tasks.dependencies })
      .from(tasks)
      .where(eq(tasks.id, depTask));
    expect(withNone?.dependencies).toEqual([]);
  });
});

// ── a scratch attempt's delivery is its landed fact ─────────────────────────
// A scratch workspace never pushes; its recorded delivery (`attempt_deliveries`)
// is what the landed rollup reads in a push's place.

async function seedDelivery(attemptId: string, conversationId: string) {
  await t.db.execute(sql`
    INSERT INTO attempt_deliveries (attempt_id, conversation_id, summary)
    VALUES (${attemptId}, ${conversationId}, ${"delivered"})
  `);
}

describe("attempt_deliveries — a delivery lands like a push", () => {
  test("without a delivery, a closed scratch attempt is `closed` and its task not done", async () => {
    const taskId = await seedTask();
    const attemptId = await seedAttempt(taskId);
    await seedConversation(attemptId, "done");
    expect((await attemptRow(attemptId)).status).toBe("closed");
    expect((await taskStatus(taskId)).status).not.toBe("done");
  });

  test("delivered while live: `pushed`, then `completed` once closed, and the task `done`", async () => {
    const taskId = await seedTask();
    const attemptId = await seedAttempt(taskId);
    const conv = await seedConversation(attemptId, "working");
    await seedDelivery(attemptId, conv);
    expect((await attemptRow(attemptId)).status).toBe("pushed");

    await t.db.execute(sql`
      UPDATE conversations SET status = 'done', ended_at = now() WHERE id = ${conv}
    `);
    const attempt = await attemptRow(attemptId);
    expect(attempt.status).toBe("completed");
    expect(attempt.finishedAt).not.toBeNull();
    const task = await taskStatus(taskId);
    expect(task.status).toBe("done");
    expect(task.finishedAt).not.toBeNull();
  });

  test("a held task stays held over a delivered attempt", async () => {
    const taskId = await seedTask({ held: true });
    const attemptId = await seedAttempt(taskId);
    const conv = await seedConversation(attemptId, "done");
    await seedDelivery(attemptId, conv);
    expect((await taskStatus(taskId)).status).toBe("held");
  });
});
