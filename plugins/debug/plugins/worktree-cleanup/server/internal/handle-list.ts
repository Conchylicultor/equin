import {
  listAttempts,
  listTasks,
} from "@plugins/tasks/plugins/tasks-core/server";
import { listDatabases } from "@plugins/database/plugins/admin/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { ndjsonResponse } from "@plugins/infra/plugins/ndjson-stream/server";
import { type WorktreeEntry } from "../../shared/endpoints";
import { dirExists } from "./reap";
import {
  canClassifyOrphans,
  dirAgeMs,
  readWorktreeDirs,
  type WorktreeDir,
} from "./dirs";
import { getGitHygiene, isTaskDeletable, isSafeToReap } from "./safety";

const CONCURRENCY = 50;

// Run `fn` over `items` with at most `limit` concurrent executions.
async function pMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

type Attempt = Awaited<ReturnType<typeof listAttempts>>[number];
type Task = Awaited<ReturnType<typeof listTasks>>[number];

async function buildEntry(
  attempt: Attempt,
  taskMap: Map<string, Task>,
  dbSet: Set<string>,
): Promise<WorktreeEntry> {
  const task = taskMap.get(attempt.taskId);
  const exists = await dirExists(attempt.worktreePath);
  const dbPresent = dbSet.has(attempt.id);

  const isDirty = exists
    ? (await getGitHygiene(attempt.worktreePath)).isDirty
    : false;

  const taskDeletable = isTaskDeletable(task?.status);
  // Passing `retained` here is what finally makes the badge and the reaper agree.
  // The reaper has always had a separate early-return for this (formerly on
  // `attempt.active`) that `isSafeToReap` knew nothing about, so the UI happily
  // showed "safe to delete" for attempts the reaper would never touch — the exact
  // drift the shared predicate exists to prevent.
  const isSafe = isSafeToReap({
    dirExists: exists,
    dbPresent,
    isDirty,
    taskDeletable,
    ageMs: Date.now() - attempt.createdAt.getTime(),
    retained: attempt.retained,
  });

  return {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    taskTitle: task?.title ?? "(unknown task)",
    taskStatus: task?.status ?? "unknown",
    attemptStatus: attempt.status,
    worktreePath: attempt.worktreePath,
    createdAt: attempt.createdAt.toISOString(),
    dirExists: exists,
    dbExists: dbPresent,
    isDirty,
    isSafe,
  };
}

// A canonical worktree dir on disk with NO attempt row to describe it. Listed
// so the pane shows every worktree that exists, not only the attempt-backed ones
// — these are precisely the dirs nothing else surfaces, and the reaper now
// reclaims them, so the UI must be able to show one before it disappears.
//
// `isSafe` is computed with the SAME `isSafeToReap` predicate as every other row
// (a missing task reads as deletable), so the badge keeps meaning "nothing to
// lose" everywhere. It deliberately does NOT mirror the reaper's 90-day floor for
// dir orphans — no row's `isSafe` has ever mirrored the hard floor, which exists
// to reap abandoned work, not to certify it as safe.
async function buildOrphanEntry(
  dir: WorktreeDir,
  dbSet: Set<string>,
): Promise<WorktreeEntry> {
  const now = Date.now();
  const ageMs = await dirAgeMs(dir.path, now);
  const dbPresent = dbSet.has(dir.name);
  const { isDirty } = await getGitHygiene(dir.path);

  return {
    attemptId: dir.name,
    taskId: "",
    taskTitle: "(no attempt row)",
    taskStatus: "orphan",
    attemptStatus: "orphan",
    worktreePath: dir.path,
    createdAt: new Date(now - ageMs).toISOString(),
    dirExists: true,
    dbExists: dbPresent,
    isDirty,
    isSafe: isSafeToReap({
      dirExists: true,
      dbPresent,
      isDirty,
      taskDeletable: true,
      ageMs,
      // No attempt row exists for a dir orphan, so there is no conversation that
      // could still be open — nothing to retain it on this axis. The hygiene
      // checks above are what protect it.
      retained: false,
    }),
  };
}

// Streamed NDJSON: each computed worktree row is emitted as it completes,
// followed by a terminal `{ end: true }` sentinel. Streaming keeps the socket
// alive past Bun's 10s idleTimeout (1257 worktrees × git status >> 10s) and lets
// rows render progressively. Errors inside the producer are framed as `{ error }`
// by ndjsonResponse, so no try/catch is needed here. No server-side sort — rows
// stream in completion order and the client sorts.
export function handleList(): Response {
  return ndjsonResponse(async (emit) => {
    const root = await ensureMainWorktreeRoot();

    // One catalog query for all DB names instead of an N+1 `databaseExists`
    // per attempt — with 2000+ attempts the per-row query was the dominant
    // cost that pushed the request past Bun's 10s idleTimeout.
    const [attempts, tasks, databases] = await Promise.all([
      listAttempts(),
      listTasks(),
      listDatabases(),
    ]);
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const dbSet = new Set(databases);

    await pMap(attempts, CONCURRENCY, async (attempt) => {
      emit({ item: await buildEntry(attempt, taskMap, dbSet) });
    });

    // Dir orphans last: everything above is attempt-anchored, so a dir with no
    // attempt row was invisible here (and to the reaper) until now. The attempt
    // ids already emitted are what makes a dir an orphan, hence the second pass.
    // Skipped entirely where the attempts table is a stale fork — see
    // canClassifyOrphans; the pane then lists exactly what it always did.
    if (canClassifyOrphans()) {
      const seen = new Set(attempts.map((a) => a.id));
      const orphanDirs = (await readWorktreeDirs(root)).filter(
        (d) => !seen.has(d.name),
      );
      await pMap(orphanDirs, CONCURRENCY, async (dir) => {
        emit({ item: await buildOrphanEntry(dir, dbSet) });
      });
    }

    emit({ end: true });
  });
}
