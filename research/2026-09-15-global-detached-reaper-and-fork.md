# Detached jobs: the worktree reaper and the DB fork survive a restart

Status: plan, awaiting approval.

## Context

Two long jobs still run their body inside the backend process. A deploy or a
restart kills them mid-run:

- `worktree-cleanup.reap-stale` — the hourly stale-worktree sweep
  (`plugins/debug/plugins/worktree-cleanup/server/internal/reap-job.ts`).
- `database.fork` — copies main's database for a new worktree
  (`plugins/database/plugins/fork/server/internal/fork-job.ts`).

On main on 2026-09-12 at 17:00:30 UTC, a deploy restarted the backend 30 s into
the hourly reap. The old process died after 3 targets, and graphile retired its
row, which then showed up as a dead job. The reaper also held one of the four
long-job worker slots for up to an hour at a time (the 09-06 to 09-11
queue-slot-hog, job-deadline-exceeded and queue-slot-blocked reports).

Builds, deploys, releases and backups already survive restarts. Their work runs
in a detached child, tracked in a ledger row and re-attached at boot
(`supervised-run` / `supervised-job` / `supervised-task` under
`plugins/infra/plugins/jobs/plugins/`). Backup is the closest precedent,
because its body is in-process code, not a command line.

Two frictions make copying backup unattractive:

1. **A supervised job cannot carry a cron schedule.** Backup needs a second job
   (`plugins/backup/server/internal/backup-schedule.ts`) whose only purpose is
   to enqueue the supervised one. The cause is inside the job framework:
   `dedup` decides both the queue row key and the run id (the key the step log
   is stored under). For `"singleton"` the run id is the constant `${name}:_`,
   so every run of the job shares one step log.
2. **Each backup-style consumer hand-writes a ledger:** a table with a partial
   unique "in flight" index, plus claim / list-unfinished / set-pid / close-row
   functions, plus a task, plus a job. That is about 150 lines and a migration
   per job, and neither the reaper nor the fork has any domain columns to put
   in it.

Intended outcome: the reaper and the fork run in detached children and survive
restarts. Declaring a scheduled detached job takes one declaration, the way
`defineJob({ schedule })` does today. Backup loses its second job.

**Out of scope, per the user:** a time limit on a detached run.

## Design at a glance

Four layers, each usable on its own:

| # | Layer | What changes |
|---|---|---|
| 1 | `infra/jobs` | A run is a queue row. `dedup` decides only the queue key. Keyed jobs keep one run per key. |
| 2 | `jobs/supervised-job` | Accepts `schedule`. The retry ladder closes the previous row before re-claiming, and backs off between attempts. |
| 3 | `jobs/detached-job` (new) | `defineDetachedJob`: one declaration → queue job + run kind + task + one shared generic ledger. |
| 4 | consumers | Reaper and fork move to `defineDetachedJob`. Backup folds its schedule into its supervised job. |

---

## 1. Job framework: run identity is the queue row, not the dedup key

### Rule

- **Keyed dedup** (`{ key }`): the run id stays `${name}:${key}`, one run per
  key. `exit-clean-finalize-job.ts` relies on this: a second `exit_clean` for a
  conversation coalesces into the suspended workflow instead of starting another.
- **Every other job** (`"singleton"`, `"none"`, cron ticks): the run id is the
  **graphile row**, `${name}:job:${jobId}`. The worker derives it at dispatch.
  `enqueue()` no longer puts a `workflowRunId` in the payload for these.

Why the row id, and not a uuid minted at enqueue (verified against graphile
0.16.6 `sql/000018.sql:150-173`):

- A retry of a row, and a stuck-lock reclaim, keep the same row id. Cached steps
  still replay on retry, which is intended.
- A later enqueue or cron tick that collapses onto a pending row updates it in
  place and **replaces its payload**. A uuid in the payload would change mid-life
  and orphan the failed attempt's log. The row id does not change.
- Cron has no enqueue call, so a uuid would still need a second rule for it.
  Today cron derives `${name}:${_cron.ts}`, which flips whenever a manual
  enqueue and a tick collapse onto each other. Switch cron to the row id too:
  one rule.
- Resume rows already carry `__resume_workflowRunId` explicitly, so they are
  unaffected. `abortDurableRun` still matches, because a resume row's key is its
  run id.
- Forked databases cannot collide on row ids: graphile's sequences carry main's
  high-water mark into the fork.

### What this fixes beyond enabling `schedule`

Two hazards the constant `${name}:_` carries today (found in review):

- **A losing claim wipes a live workflow's log.** A second run of a singleton
  supervised job whose claim loses returns normally. The worker then calls
  `discardWorkflowLog("name:_")`, which deletes the *live* workflow's waits, so
  that workflow never wakes and its `onEnded` never runs.
- **A run killed on its last attempt poisons the next run.** The sweeper
  releases the killed row, it becomes dead without `dispatch` discarding its
  log, the dead-job GC archives it, and the next `name:_` run replays the stale
  log.

With per-row ids, both shrink to a bounded leak, and the leak is closed below.

### Changes

- `registry.ts`: export `singletonJobKey(name)`. Use it in `enqueue()` and in
  `buildCronItems` (`worker.ts`), which today match only because the run id and
  the key are the same string. Keyed jobs keep baking `workflowRunId`; singleton
  and none stop.
- `worker.ts`: one exported `workflowRunIdFor(payload, jobId)` =
  `payload.workflowRunId ?? \`${jobName}:job:${jobId}\``. This replaces both the
  `_cron` branch and the `legacy:` branch. Rows already queued with an old baked
  id keep working.
- `dead-job-gc.ts` and the superseded DELETE in `stuck-lock-sweeper.ts` call
  `discardWorkflowLog(workflowRunIdFor(...))`, so a row that dies without a
  dispatch no longer leaks its log.
- Update the docs that state the old rule: `JobCtx.workflowRunId`
  (`registry.ts:41-47`), `worker.ts` comments (≈159-166, 212-218, 519-522,
  687-697), `workflow-log.test.ts` header, `jobs/CLAUDE.md`.

**Behaviour change to document:** a suspended singleton no longer holds
`name:_`. A tick while it is suspended starts a separate workflow, so
`"singleton"` now means "at most one *pending* row". None of the 36 singleton
jobs use `ctx.step`, `waitFor` or `sleep` today (checked), so nothing current
changes. For supervised jobs the ledger claim is the lock anyway.

## 2. `defineSupervisedJob` takes `schedule`; the ladder gets two fixes

- **`schedule?: ScheduleSpec`** on the spec. When it is present the job is
  `dedup: "singleton"` with that schedule. When absent it stays `"none"`, since
  a singleton pending row takes the last payload, which would change build,
  release and deploy. The input must be fully defaultable. `defineJob` already
  asserts that at worker start (`inputSchema.parse({})`).
- **Close before re-claim** (`loop.ts` / `define-supervised-job.ts`). Attempt
  N+1's claim needs attempt N's row closed, and today only the reconciler's
  `finish → closeRow` closes it. After a restart, a due resume can dispatch
  before the boot reconcile has run. The claim then loses, the `null` is cached
  in step `spawn:N+1`, and the workflow ends silently: no retry, no dead-letter.
  Backup (`runAttempts: 2`) is exposed today. Fix: call
  `kind.closeRow(prevRunId, terminal)` (idempotent, first-writer-wins) before the
  next claim, and make `not-claimed` on attempt ≥ 2 throw.
- **Backoff between attempts.** Add `sleep` to `LoopCtx` and `ctx.sleep` a
  graphile-shaped exponential delay (e^attempt seconds: ~3 s, 7 s, 20 s, 55 s)
  before each re-spawn. The sleep suspends, so no slot is held. The fork keeps
  the retry spacing it has today.
- Rewrite supervised-job `CLAUDE.md` "`dedup: "none"`…" and "A scheduled
  supervised job is TWO jobs" sections, and `define-supervised-job.ts:275-282`.

**Backup:** move `schedule` into `backupRunJob` and delete
`backup-schedule.ts`. Its input already defaults `trigger` to `"periodic"`.
Deploy transition: a `backup.run.schedule` row pending at the instant of the
deploy would hit "unknown job" and dead-letter. That row lives for milliseconds
around the nightly tick, so accept the risk and don't keep a tombstone. The
`cron:backup.run.schedule` entry left in graphile's known-crontabs table is inert.

## 3. New sub-plugin `plugins/infra/plugins/jobs/plugins/detached-job`

A job whose body is ordinary async code, run in a detached
`./equin supervised-exec <name>` child. It is declared in one place:

```ts
export const worktreeReapJob = defineDetachedJob({
  name: "worktree-cleanup.reap-stale",
  input: z.object({}),
  schedule: { cron: "0 * * * *" },
  channel: worktreeCleanupLog,            // the child's output lands here
  run: async (_input, { log }) => { … },  // runs in the child
});

export const databaseForkJob = defineDetachedJob({
  name: "database.fork",
  input: z.object({ source: z.string(), target: z.string() }),
  lock: (input) => input.target,          // default: one in flight per job
  runAttempts: 5,
  channel: databaseForkLog,
  run: async ({ source, target }, { log }) => { … },
});
```

One `register: [job]` token mounts the queue job, the supervised-run kind and
the supervised task.

### What it composes

- `defineSupervisedTask({ id: name, payload: { runId, attempt, input }, run })`.
  The task id is the job name, which already passes `TASK_ID_RE`. The child
  wrapper calls the body. If the body throws, the wrapper writes `error_message`
  and `retryable = !isNonRetryableError(err)` onto the run's ledger row, then
  rethrows so the process exits 1. Export `isNonRetryableError` from the jobs
  barrel for this.
- `defineSupervisedJob({ name, input, schedule, runAttempts, kind, claim, task, onEnded })`:
  - **Kind id** derived from the name with non-alphanumerics stripped:
    `databasefork`, `worktreecleanupreapstale`. Both match `/^[a-z][a-z0-9]*$/`
    and keep their artifact prune families separate. A derived collision throws
    at register.
  - **`claim`**: INSERT a ledger row. The partial unique index is the lock; a
    unique violation means `null`.
  - **`listUnfinished` / `setPid`**: generic, filtered by `job_name`.
  - **`closeRow`**: stamp `finished_at`, `exit_code` and `signal_code` from the
    exit marker, `WHERE finished_at IS NULL`. It is the **only** writer of the
    outcome, so there is one closer, from the marker.
  - **`onEnded`** is the failure policy, deterministic on replay:
    - exit 0 → return.
    - failed, and (`retryable = false` or this is the last attempt) → throw
      `NonRetryableError` carrying the child's recorded message, or "killed or
      crashed before recording an error, see the transcript" when there is none.
      The workflow dead-letters, and queue-health's existing dead-job report
      reaches Debug → Reports and the bell.
    - otherwise → return, and the ladder backs off and re-spawns.
    - A boot failure, a hard kill (`-1`) or a reboot's `143 TERM` records no
      flag, so it stays retryable.

  This is a deliberate exception to supervised-job's rule that "a non-zero exit
  is data". Build, deploy and backup have a runs UI where a failed run shows up.
  A detached job has none, so the dead-letter is its failure surface. That is
  also what a failed reap or fork is today. Detached-job's `CLAUDE.md` states this.

### Shared ledger table `detached_job_runs`

| column | notes |
|---|---|
| `id` text pk | run id |
| `job_name` text | which detached job |
| `lock_key` text | from `lock(input)`, default `"_"` |
| `pid` int | seeded with the backend's pid at claim, then the child's |
| `attempt` int, `workflow_run_id` text | attribution |
| `started_at`, `finished_at` timestamptz | |
| `exit_code` int, `signal_code` text | from the marker, via `closeRow` |
| `error_message` text, `retryable` bool | written by the child on a throw |

- `UNIQUE (job_name, lock_key) WHERE finished_at IS NULL`. This is the lock.
- `INDEX (job_name, started_at DESC)`.
- **Excluded from DB forks** (`ExcludeFromFork` contribution) instead of a
  namespace column. A worktree DB then holds only its own rows, so
  `listUnfinished` needs no scoping. The fork runs themselves live in main's DB.
- **Growth bound:** `defineRetention` on `finished_at` (30 days,
  `perWorktree: true`). Open rows are never swept.

### Output

`channel` is required, as it already is on every supervised-run kind. The
supervisor tails the child's transcript into it. The body writes through
`ctx.log(line, stream?)`, which goes to stdout/stderr, so **one process writes
each log file**. That matters: a child publishing to the parent's log sink
would append to the same jsonl from a second process, with a separate rotation
counter, and never reach the parent's live view. The reaper passes its existing
`worktree-cleanup` sink, so `logs/worktree-cleanup.jsonl` stays where it is. The
fork gets a new `database-fork` sink.

### Dependencies

`detached-job` → `supervised-job`, `supervised-task/server`, `infra/jobs`,
`database`, `database/admin` (for `ExcludeFromFork`), `retention`,
`log-channels`. There is no cycle: `infra/jobs` already imports
`database/admin`, and none of these import the consumers.

## 4. Consumers

### Reaper (`plugins/debug/plugins/worktree-cleanup/server`)

- `reap-job.ts` → `defineDetachedJob` with the hourly schedule. The handler is
  then `instant`, so no slot is held, and `hold: "minutes"` and `serial: true`
  go away. `serial` only existed because a locked row released its key and
  hourly ticks piled into slots; the claim now allows one child.
- The body is today's handler body, minus the deadline plumbing. Nothing aborts
  the child except a process-group signal, which kills it outright, so the
  `signal.aborted` branches and `throwIfAborted` go. `log.publish` becomes
  `ctx.log`.
- Report-path failures still fail the run. The child exits 1 with a recorded
  message, the run is retryable, and on the last attempt it dead-letters. Use
  `runAttempts: 1`, since the next hourly tick is the retry, as it is today.
- Keep the `onReady` boot enqueue in `server/index.ts`. While a detached run is
  in flight, its claim loses and it returns. Update the comment.
- The manual Debug → Worktree Cleanup delete endpoints keep calling
  `reapAttempt` inside the request. They are out of scope.

### Fork (`plugins/database/plugins/fork/server`)

- `fork-job.ts` → `defineDetachedJob` with `lock: target` and `runAttempts: 5`
  (keeps today's `maxAttempts: 5`, now with the backoff from §2).
- The body is today's handler run in the child: `forkDatabase(source, target,
  forkExclusions())`, where exclusions are present because exec mode collects
  contributions. The "DB fork failed" notification and the
  undeclared-schema warnings stay in the body (plain awaited inserts).
  `ForkPlanError` → throw `NonRetryableError`, so the child records
  `retryable = false` and the ladder stops after one attempt.
- The only enqueuer, `createConversation` (`conversations/.../lifecycle.ts:162`),
  is unchanged. It always mints a fresh target, so the old "replace if not
  running, per target" key and the new ledger lock behave the same.
- Rewrite `database/plugins/fork/CLAUDE.md`: a restart no longer interrupts a
  fork, and the in-flight lock is the ledger, not the queue key.

### `./equin build`'s wait for the worktree DB (needs your approval: it's under `plugins/framework/`)

Build waits for the fork by polling Postgres
(`plugins/framework/plugins/cli/plugins/build/cli/run.ts:336-374`):

- If a `__forking` temp DB exists, it waits up to 120 s.
- If not, it grace-waits 20 s.

Two small consequences of the change:

- The detached child adds an exec boot before the temp DB appears. That boot
  runs `onReadyBlocking`, and it eats into the 20 s grace. In practice an agent
  builds minutes after its worktree is created, so this rarely bites.
- The error text "the database.fork job may be dead — check /api/jobs" is
  wrong once the workflow suspends, because there is no job row to find.

Proposed: raise the grace to 60 s, and point the message at Debug → Queue for
a dead `database.fork` and at `logs/database-fork.jsonl`. If you'd rather not
touch framework, skip this step. The only cost is a misleading message in a
rare failure path.

## Residuals (stated, not fixed here)

- **No deadline on the reaper any more.** Today its deadline aborted the sweep
  and released the host-wide `worktree-mutate` flock. The per-call git timeouts
  remain. A time limit on detached runs is out of scope by request.
- **A report's bell can be lost at child exit.** `recordReport` awaits the
  report row, but fires its bell notification without awaiting it
  (`record-report.ts:355`), and `runExec` exits straight after the body. The
  reaper's per-target report rows are safe; the last bell can be lost. File as a
  task: flush pending notifications in exec shutdown.
- **One skipped boot reap after a hard kill.** A stale open row makes the
  `onReady` claim lose until the boot reconcile closes it. The next hourly tick
  covers it.
- **Detached runs don't appear in the Runs surface.** A follow-up could add one
  `defineRunKind` arm over `detached_job_runs`, which would cover every future
  detached job at once.
- **Future candidates:** `conversations.spawn`, prototype thumbnails and
  checkpoints, events refresh (the remaining `hold: "minutes"` jobs) could each
  become a `defineDetachedJob`. Not in this change.

## Implementation order

1. §1 job framework (run id per row, shared key helper, log cleanup on GC and
   supersede) + tests.
2. §2 supervised-job `schedule`, close-before-reclaim, backoff; backup folds its
   tick + tests.
3. §3 `detached-job` plugin + tests.
4. §4 reaper, then fork.
5. (If approved) build wait message and grace.
6. Docs: `jobs`, `supervised-job`, `supervised-task` (link to detached-job),
   `detached-job`, `backup`, `fork`, `worktree-cleanup` CLAUDE.md files.

## Critical files

- `plugins/infra/plugins/jobs/server/internal/{registry,worker,dead-job-gc,stuck-lock-sweeper}.ts`
- `plugins/infra/plugins/jobs/server/index.ts` (export `isNonRetryableError`)
- `plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/{define-supervised-job,loop}.ts`
- `plugins/infra/plugins/jobs/plugins/detached-job/**` (new)
- `plugins/backup/server/internal/{backup-job,backup-schedule}.ts`, `plugins/backup/server/index.ts`
- `plugins/debug/plugins/worktree-cleanup/server/{index.ts,internal/reap-job.ts}`
- `plugins/database/plugins/fork/server/{index.ts,internal/fork-job.ts}`

Reuse, don't rewrite: `defineSupervisedJob`, `defineSupervisedTask`,
`superviseRuns` / `awaitSupervisedRun`, `NonRetryableError`, `defineRetention`,
`ExcludeFromFork`, `defineLogSink`, `abortDurableRun`.

## Verification

- **Unit tests** (`./equin test <plugin>`):
  - jobs: `workflowRunIdFor` (keyed vs row), `singletonJobKey` shared by
    enqueue and cron, dead-GC and supersede discard the right log.
  - supervised-job `loop.test.ts`: close-before-reclaim, `not-claimed` on
    attempt 2 throws, backoff sleeps between attempts and replays
    deterministically.
  - detached-job: the failure policy table (0 / retryable / non-retryable / last
    attempt / hard kill), kind-id derivation, claim lock.
- **Existing harnesses** on the worktree deploy: `POST /api/events-test/cron-dedup`,
  `/superseded`, `/crash-recovery`, `/serial-queue` still pass.
- **Survives a restart (manual, worktree deploy).** Add a harmless
  `events-test.detached-sleep` detached job (sleeps ~90 s, then logs), started
  by an events-test endpoint. Start it, run `./equin build` mid-run to
  restart the backend, then confirm with `query_db`:
  - the child pid stayed alive;
  - its `detached_job_runs` row closes with exit 0;
  - the workflow completes, with no dead job;
  - a second start during the run is `not-claimed`.
  Repeat with the child killed (`kill -9`) to see the retry and then the
  dead-letter with the "killed" message.
- **Fork end to end (worktree deploy):** create a conversation from the worktree
  app. Watch its `detached_job_runs` row and `logs/database-fork.jsonl`, and
  confirm the target DB appears. Repeat with a backend restart mid-restore.
- **Reaper:** not run from a worktree, because it would remove real host
  worktrees. After push, check main's next hourly tick: a `detached_job_runs`
  row on `singularity` via `query_db`, the scan/tally lines in
  `logs/worktree-cleanup.jsonl`, and no queue-slot-hog report.
- `./equin check` (type-check, boundaries, migrations-in-sync, docs in sync).
