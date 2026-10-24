# Atomic auto-launch: a failed launch leaves the task armed, never stranded

## Context

On 2026-09-15 the task "Letter-spacing cannot be themed per app" became unblocked. The
`tasks.maybe-launch` job deleted its auto-start marker, then called `createConversation`.
That call wrote the attempt row and hung. What the user saw:

- For 2.5 hours the task read "In progress". An attempt with no conversation counts as active.
- Main restarted. The boot sweep deleted the orphaned attempt and the task went back to "New".
- The marker was already gone, so the boot reconcile never re-launched it. Nothing reported it.

Why it can happen: a launch is several separate writes, each committed on its own.

1. `claimAutoStart` deletes the marker (`plugins/tasks/plugins/auto-start/server/internal/mutations.ts:47`).
2. `createConversation` inserts the attempt, enqueues the DB fork, rewrites attachment refs,
   inserts the conversation, emits `conversationCreated`, enqueues the spawn
   (`plugins/conversations/server/internal/lifecycle.ts:59`).

A crash or hang anywhere after step 1 loses the launch for good. Its try/catch cleanup and the
boot `sweepOrphanedAttempts` only undo the stuck status. Neither gives the marker back.

Goal: a failed or interrupted auto-launch neither strands the task silently nor spawns twice.

## Approach: one launch = one transaction

Make "the marker is gone" and "the attempt + conversation + spawn jobs exist" the same commit.
Then only two states are possible:

- **Committed**: the marker is gone, the rows exist, and the fork and spawn jobs are durable.
  A spawn failure after that shows up as a failed conversation, which is already visible.
- **Rolled back** (a throw, a crash, a killed connection): the marker is still there, and there is
  no attempt and no "In progress". The job's own retry, or the boot reconcile, launches it again.

No double spawn: the claim is a `DELETE … RETURNING` on the marker row *inside* the transaction.
A second runner blocks on that row lock. It then finds the row deleted (the first committed) or
wins it (the first rolled back). Either way, exactly one launch commits.

Every primitive this needs already exists:

- `withTaskStatusBatch(fn)` (`tasks-core/server/internal/status-batch.ts:41`) opens one tx and
  emits the net `taskStatusChanged` on that tx.
- `job.enqueue(input, { tx })` (`infra/jobs/server/internal/registry.ts:176`) and
  `event.emit(payload, { tx })` (`infra/events/server/internal/event.ts:73`) both commit with the tx.
- `insertConversationRow(exec, …)` already takes an executor.

### 1. Split `createConversation` into prepare + commit

In `plugins/conversations/server/internal/lifecycle.ts`:

- **`prepareConversation(opts)`: reads only, no writes.** It handles fork-source lookup, model
  normalisation, `spawnedBy`, the new ids, `worktreePathFor`, `resolveAttachmentRefs`, preprompt
  and effort resolution, and building the `create` spawn payload. All the slow or non-DB work
  happens here, *before* any transaction is open. So a hang here holds no lock and has written
  nothing.
- **`commitConversation(tx, prepared)`: writes only, on `tx`.** It runs `createTask` +
  `setTaskCategory` when there is no task, then `createAttempt`, `databaseForkJob.enqueue({tx})`,
  `insertConversation`, `conversationCreated.emit({tx})` and `spawnConversationJob.enqueue({tx})`
  (or the attempt-reuse inline spawn, which stays after commit, as it is today).
- **`createConversation(opts)`** becomes `prepare`, then `withTaskStatusBatch(tx => commit(tx, p))`,
  then the post-commit side effects (`forkConfig`, and the inline spawn on the reuse branch).
  The three other callers (`handle-create`, `agents/handle-launch`, `summary/handle-generate`)
  keep their signature unchanged. They also get atomicity for free.
- Delete the try/catch that cleans up orphaned attempts. A rollback now does that job.
- `forkConfig` moves after commit. Today it is fired before the attempt exists and never awaited.
  After commit, a rolled-back launch leaves no config dir behind.

### 2. Thread an executor through the tasks-core mutations it calls

Add an optional `exec: DbExecutor = db` parameter to `createAttempt` and `insertConversation`
(`tasks-core/server/internal/mutations/{attempts,conversations}.ts`), and to `createTask` /
`setTaskCategory` if they are on the no-task path. Pass it to `withTaskStatusChange(…, exec, …)`.
That function already asserts the executor matches the open batch, so writing on the wrong
connection fails loudly instead of quietly leaving the transaction.

### 3. Claim on the transaction

`claimAutoStart(id, exec)` in `auto-start/server/internal/mutations.ts` runs the same
`DELETE … RETURNING` on `exec`.

### 4. Rewrite `tasks.maybe-launch`

In `plugins/conversations/server/internal/auto-start-jobs.ts`:

```ts
// …main-only, task lookup, dropped/held, marker read, hasBlockingDep — unchanged
const prepared = await prepareConversation({ taskId, model, prompt: buildTaskPrompt(t), spawnedBy: cause });
await withTaskStatusBatch(async (tx) => {
  await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
  if (!(await claimAutoStart(taskId, tx))) return;          // another runner owns it
  if (await hasAttempts(taskId, tx)) return;                // manual start won (marker stays consumed, as today)
  await commitConversation(tx, prepared);
});
```

- **The Postgres timeout for an idle transaction is the backstop for a hang like this incident.**
  If the job stalls between statements, Postgres kills the session and the transaction rolls back
  on its own. The marker comes back without waiting for a restart. The deadline audit already
  files `job-deadline-exceeded` / `job-zombie` reports, so the hang is still visible.
- **A throw rolls back and graphile retries (5 attempts, with backoff).** If every attempt fails,
  the row is dead-lettered. The queue-health watchdog reports dead letters, and the task stays
  armed, so the next boot's reconcile tries again. It is never silent, and it is never lost.
- The dedup on `taskId` and the `isMain()` gate stay as they are.
- The job's `hold: "instant"` stays honest: the transaction holds only indexed writes and inserts.
- Replace the old comment ("A stuck-on-failure task is better than a runaway spawn") with the new
  rule: *the marker and the launch commit together*.
- If the lint rule `database/no-pool-await-in-transaction` flags awaits inside
  `withTaskStatusBatch`, fix the pool reads it names (for example, `hasAttempts` must read on `tx`).

### 5. Turn the orphan sweep into an invariant alarm

A transactional create can no longer leave an orphan, so `sweepOrphanedAttempts`
(`tasks-core/server/internal/sweep-orphaned-attempts.ts`) now only catches a genuine bug.
Keep the delete, and replace the `console.error` with a `recordReport` (kind `crash`), so the bell
shows it rather than a log line. Do not make it re-arm the task. That would guess the intent of a
write we can no longer explain.

## Critical files

- `plugins/conversations/server/internal/lifecycle.ts`: prepare/commit split
- `plugins/conversations/server/internal/auto-start-jobs.ts`: transactional claim + launch
- `plugins/tasks/plugins/auto-start/server/internal/mutations.ts`: `claimAutoStart(id, exec)`
- `plugins/tasks/plugins/tasks-core/server/internal/mutations/{attempts,conversations}.ts`: `exec` param
- `plugins/tasks/plugins/tasks-core/server/internal/sweep-orphaned-attempts.ts`: report instead of log

## Out of scope (noted)

- **The root cause of this incident's hang.** The reports from that window don't pin it down.
  After this change, the hang can no longer strand a task, and the deadline audit will name the
  hanging job if it happens again.
- **The stranded task itself.** It needs re-arming by hand once, after this ships.

## Verification

1. **DB-backed test** in `plugins/conversations/server/internal/` using the `db-test-fixture` harness:
   - When `commitConversation` throws after `createAttempt`, the marker still exists, and there
     are no attempt rows, no conversation rows and no `graphile_worker.jobs` rows for the spawn.
   - Two concurrent `maybeLaunch` runs for one armed task produce exactly one attempt.
   - A run that finds an existing attempt leaves no new rows.
2. `./equin test plugins/conversations plugins/tasks/plugins/tasks-core`
3. `./equin check` (type-check, eslint including `no-pool-await-in-transaction`, boundaries).
4. `./equin build`, then in the worktree app: arm a task with a blocking dependency, then
   complete the dependency. The task launches once, reads "In progress", and the conversation starts.
   Use `query_db` to confirm one attempt and no `tasks_ext_auto_start` row.
