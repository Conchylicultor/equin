# One way to declare detached work (v2)

Status: plan, awaiting approval. Supersedes v1
(`2026-09-15-global-detached-reaper-and-fork.md`), which added a second factory
(`defineDetachedJob`) beside `defineSupervisedJob`. After review the user asked:
what about build, release and the other detached jobs — can there be a single
way to set up detached work? This version answers that.

## Context

Two long jobs still run their body inside the backend, so a deploy or restart
kills them mid-run:

- `worktree-cleanup.reap-stale`, the hourly stale-worktree sweep.
- `database.fork`, which copies main's database for a new worktree.

On main on 2026-09-12 at 17:00:30 UTC, a deploy restarted the backend 30 s into
the hourly reap. The old process died after 3 targets, and graphile retired its
row, which then showed up as a dead job. The reaper also held one of the four
long-job worker slots for up to an hour (the 09-06 to 09-11 slot-hog, deadline
and slot-blocked reports).

Setting up detached work today takes a different amount of hand-written code
per consumer. There is no single way to do it.

## What exists today

| Layer | Who uses it | Hand-written per consumer |
|---|---|---|
| `supervised-run`: detach, pid, transcript, exit marker, boot reconcile | everything below | — |
| `defineSupervisedJob`: claim → spawn → suspend → wake → record | build, release, backup | the ledger table + 4 ledger functions |
| `defineSupervisedTask`: body is in-process code, not a command line | backup only | a second `register:` token |
| a separate cron job whose body is `enqueue()` | backup only | a whole second job (`backup-schedule.ts`) |
| deploy's `update`: a workflow of 2–3 detached legs under one row | deploy | its own spawn/wait loop on `supervised-run` |
| not detached at all | reaper, fork | — |

Things that also detach but are **not jobs** stay out of this plan. They are
long-lived processes with their own supervisor:

- worktree backends and zero-cache, supervised by the gateway;
- conversation tmux sessions;
- release previews, deliberately reaped rather than re-attached on restart.

The layer at the bottom is already shared: every detached job, deploy's legs
included, runs through `supervised-run`. The inconsistency is in the layer
above it.

## Decision: one factory, `defineSupervisedJob`

Extend the existing factory rather than adding a sibling. After this change a
detached job is always one declaration:

```ts
defineSupervisedJob({
  name, input,
  // WHAT runs in the detached child — exactly one of:
  argv:  (input, runId) => ({ argv, cwd?, envOverrides? }),   // a command line (build, release)
  run:   async (input, { runId, log }) => { … },               // in-process code (backup, reaper, fork)
  // WHERE the run is recorded — optional:
  ledger?: { kindId, claim, listUnfinished, setPid, closeRow, onReattach? }, // your own table
  lock?:   (input) => string,   // only with the built-in ledger; default: one in flight per job
  channel,                       // where the child's output lands
  schedule?, runAttempts?, onEnded?,
});
```

One `register: [job]` token mounts everything: the queue job, the run kind and,
for `run`, the child task.

What each consumer writes after the change:

| Job | Body | Ledger | Schedule | Change |
|---|---|---|---|---|
| build | `argv` | own (`build_runs`) | — | the kind/claim fields move under `ledger` |
| release | `argv` | own (`release_runs`) | — | same |
| backup | `run` | own (`backup_runs`) | nightly, on the job | task token and `backup-schedule.ts` deleted |
| reaper | `run` | built-in | hourly, on the job | moves out of process |
| fork | `run` | built-in (`lock: target`) | — | moves out of process |

### Why the ledger is pluggable, not one shared table

The Runs plugin records a deliberate decision to keep each domain's own ledger:
"read-time federation, not a shared table" (`plugins/runs/CLAUDE.md`). The
survey confirms that each own ledger is doing real work:

- **build:** `./equin build` run by hand in a shell inserts its own
  `build_runs` row and closes it about 100 s before the process exits. It does
  this with raw SQL, so it survives the schema change the build itself is
  applying. A primitive-owned table would need a second writer from that CLI.
- **release:** closing a row reads `RELEASE.json` from disk and writes five
  domain columns in the same first-writer-wins UPDATE. Splitting that into a
  shared-table close plus a domain write would let readers see a half-written
  row. A release run from the shell deliberately records nothing in the DB.
- **backup:** the manifest and per-target results are written by the child
  itself.

So the one factory takes a ledger. **Omit it** and you get the built-in one: a
table the primitive owns, which suits jobs with no domain data such as the
reaper and the fork. **Pass it** and you keep your own table, as build, release
and backup do. The declaration has the same shape either way.

### Who owns the failure surface

This follows from the ledger choice, and the type makes it explicit:

- **Own ledger:** a failed run is data in your table, shown by your UI and the
  Runs surface. This is today's rule for build, release and backup, unchanged.
- **Built-in ledger:** there is no UI, so a run that fails its last attempt, or
  fails with `NonRetryableError`, dead-letters the job. Queue-health's
  existing dead-job report then reaches Debug → Reports and the bell. That
  matches what a failed reap or fork produces today.

### Deploy stays a workflow over the same legs

Deploy's `update` is not one detached job. It is a sequence:

1. converge on the server;
2. maybe wait for a release, which is a run of *another* kind;
3. ship.

All of it sits under one deploy row, with a close rule that depends on which leg
ended. Putting that into the factory would make every one-shot job carry
multi-leg machinery it never uses. Deploy already uses the shared bottom layer
(`supervised-run`) for each leg, so its legs are detached the same way as
everything else. What differs is only the orchestration above them. Leave it
as is.

The obvious "shared leg helper" does not work cleanly. Deploy decides a leg
ended from its exit marker *or* its row being closed. Build cannot use that
rule, because its CLI closes its row about 100 s before the child exits.

---

## 1. Job framework: a run is a queue row, not the dedup key

Unchanged from v1 and verified against graphile 0.16.6 (`sql/000018.sql:150-173`).

- **Keyed dedup** keeps one run per key (`${name}:${key}`).
  `exit-clean-finalize-job.ts` relies on a second enqueue coalescing into the
  suspended workflow.
- **Everything else** (singleton, none, cron ticks) runs as `${name}:job:${jobId}`,
  derived by the worker at dispatch. The row id survives a retry, a sweeper
  reclaim, and a later enqueue or tick collapsing onto the pending row (which
  replaces its payload). Resume rows keep their explicit run id.
  - This replaces cron's `${name}:${_cron.ts}` and the `legacy:` fallback with
    one rule, `workflowRunIdFor(payload, jobId)`.
  - Enqueue and cron share `singletonJobKey(name)`.
- It fixes two current bugs. A losing claim no longer wipes a live singleton
  workflow's log. A run killed on its last attempt no longer poisons the next
  run's replay.
- Dead-job GC and the sweeper's superseded DELETE also discard the row's step
  log.
- **Behaviour change:** "singleton" now means at most one *pending* row, not at
  most one live workflow. None of the 36 singleton jobs use steps or waits, so
  nothing current changes.
- Files: `jobs/server/internal/{registry,worker,dead-job-gc,stuck-lock-sweeper}.ts`,
  plus the comments and docs that state the old rule (listed in v1 §1).

## 2. The one factory

All changes are in `plugins/infra/plugins/jobs/plugins/supervised-job`.

- **`run` body.** The factory registers a supervised task under the job name,
  with payload `{ runId, attempt, input }`, and spawns
  `./equin supervised-exec <name>`. The child calls
  `run(input, { runId, log })`:
  - `log` writes to stdout/stderr, which becomes the transcript, which the
    parent tails into `channel`. So one process writes each log file.
  - On a throw, the child records `error_message` and
    `retryable = !isNonRetryableError(err)` on its built-in ledger row, then
    exits 1. Export `isNonRetryableError` from the jobs barrel.
  - The `task` arm is removed, since backup was its only user.
  - `defineSupervisedTask` becomes an internal building block that consumers no
    longer call.
- **`ledger`, optional.** It is today's `kind` verbs plus `claim`, grouped. It
  carries an explicit `kindId`, so build, release and backup keep their ids and
  in-flight runs re-attach across the deploy that ships this.
- **Built-in ledger** `supervised_job_runs`:
  - Columns: `id, job_name, lock_key, pid, attempt, workflow_run_id, started_at,
    finished_at, exit_code, signal_code, error_message, retryable`.
  - `UNIQUE (job_name, lock_key) WHERE finished_at IS NULL` is the lock;
    `claim` is an INSERT against it.
  - `closeRow` stamps the exit marker's outcome. It is the only writer of the
    outcome.
  - Excluded from DB forks (`ExcludeFromFork`), so it needs no namespace column.
  - Retained for 30 days after `finished_at` (`defineRetention`).
  - The kind id is derived from the name (`databasefork`,
    `worktreecleanupreapstale`). A collision throws at register.
- **`schedule`.** Present means `dedup: "singleton"` plus the cron. Absent stays
  `"none"`, since singleton would change which payload build, release and deploy
  run with. The input must be fully defaultable, which `defineJob` already
  asserts at start.
- **Retry ladder** (`loop.ts`):
  - Close the previous attempt's row before the next claim. Today, after a
    restart, the next claim can lose to the previous attempt's still-open row;
    the loss is cached and the retry silently never happens. Backup is exposed
    to this now.
  - Make `not-claimed` on attempt 2 or later throw.
  - Sleep durably between attempts: about 3, 7, 20 and 55 s, graphile's own
    spacing. The sleep holds no worker slot.
- **Built-in-ledger failure policy** in the wrapper's `onEnded`:
  - exit 0 → done.
  - failed and (not retryable, or last attempt) → throw `NonRetryableError`
    with the child's recorded message, or "killed before recording an error, see
    the transcript".
  - failed otherwise → retry.
  - A hard kill or a reboot's TERM carries no flag, so it stays retryable.
- Docs: rewrite supervised-job `CLAUDE.md` into the one guide to detached work.
  It covers the declaration, choosing a ledger, the failure surface, and why a
  scheduled job no longer needs two jobs. It also points deploy-shaped workflows
  at `supervised-run`. `supervised-task/CLAUDE.md` says it is internal.

## 3. Consumers

- **build** (`plugins/build/server/internal/run-build.ts`) and **release**
  (`plugins/release/server/internal/release-job.ts`): the declaration shape
  changes, `kind` + `claim` → `ledger`. Behaviour is unchanged.
  `build.run.debounced` stays: it is a debounce, not a schedule workaround.
- **backup** (`plugins/backup/server/internal/{backup-job,backup-task,backup-schedule}.ts`):
  - The body moves from `backupTask` into `run`, and the schedule moves onto the
    job.
  - Delete `backup-schedule.ts` and the task token.
  - A `backup.run.schedule` row pending at the instant of deploy would
    dead-letter as an unknown job. That row lives for milliseconds around the
    nightly tick, so accept the risk.
- **reaper** (`plugins/debug/plugins/worktree-cleanup/server`):
  - `run` body with the built-in ledger, the hourly schedule, and
    `runAttempts: 1` (the next tick is the retry).
  - `channel` is its existing `worktree-cleanup` sink, so
    `logs/worktree-cleanup.jsonl` stays where it is. `log.publish` becomes
    `ctx.log`.
  - `hold: "minutes"` and `serial` go away: the handler holds a slot for
    milliseconds, and the claim allows one child.
  - The deadline plumbing goes away, since nothing aborts the child except a
    group signal that kills it.
  - The `onReady` boot enqueue stays; while a run is in flight its claim loses.
- **fork** (`plugins/database/plugins/fork/server`):
  - `run` body with the built-in ledger, `lock: target`, `runAttempts: 5` with
    the backoff, and a new `database-fork` channel.
  - `ForkPlanError` → `NonRetryableError`, so there is one attempt.
  - Its notifications stay in the body, and are now written from the child.
  - `createConversation` is unchanged.

## 4. `./equin build`'s wait for a new worktree's DB (needs your approval: under `plugins/framework/`)

The detached fork spends an exec boot before its temp DB appears, and that eats
into build's 20 s grace. Once the workflow suspends, there is also no job row
for "check /api/jobs" to find. Proposed:

- raise the grace to 60 s;
- point the message at Debug → Queue and `logs/database-fork.jsonl`
  (`plugins/framework/plugins/cli/plugins/build/cli/run.ts:336-374`).

Skip this step if you'd rather not touch framework code. The only cost is a
misleading hint in a rare failure.

## Out of scope / residuals

- **Deploy's orchestration** (see above) and **the non-job processes**
  (backends, zero-cache, tmux, previews).
- **Other `hold: "minutes"` jobs:** `conversations.spawn`, prototype thumbnails
  and checkpoints, and events refresh. They self-heal today by retrying
  idempotently. With the one factory, moving any of them later is a single
  declaration change.
- **A time limit on detached runs**, excluded by request. The reaper loses the
  deadline that used to release the host-wide `worktree-mutate` flock; the
  per-call git timeouts remain.
- **Bell notifications from a child can be lost at exit.** `recordReport`
  fires its bell without awaiting it, and exec mode exits right after the body.
  File a task: flush pending notifications in exec shutdown.
- **Built-in-ledger runs don't appear on the Runs surface.** A follow-up could
  add one run arm that covers every such job at once.

## Implementation order

1. §1 job framework, with tests.
2. §2 factory: the `run` body, the `ledger` option, the built-in ledger,
   `schedule`, and the ladder fixes, with tests.
3. Move build, release and backup to the new shape, and delete backup's two
   extra tokens.
4. Reaper, then fork.
5. §4, if approved.
6. Docs.

## Verification

- **Unit tests** (`./equin test <plugin>`):
  - run-id derivation and the shared singleton key;
  - log discard on GC and supersede;
  - loop: close-before-reclaim, `not-claimed` on attempt 2 throwing, backoff
    replay;
  - built-in ledger: claim lock, the failure-policy table, kind-id derivation;
  - type-level: exactly one of `argv` / `run`, and `lock` only without `ledger`.
- **Existing harnesses** on the worktree deploy: `POST /api/events-test/{cron-dedup,
  superseded,crash-recovery,serial-queue}`.
- **Survives a restart** (worktree deploy):
  1. Add an `events-test` job with a `run` body that sleeps about 90 s, and
     start it.
  2. Run `./equin build` mid-run.
  3. With `query_db`, confirm: the child stayed alive, its row closes with exit
     0, the workflow completes with no dead job, and a second start during the
     run loses its claim.
  4. Repeat with `kill -9` on the child: expect a retry, then a dead-letter
     whose message says it was killed.
- **Regression on the moved consumers** (worktree deploy):
  - a Build-button build: the row closes and the bell fires;
  - a Studio release: the row gets its domain columns;
  - a manual backup: the row closes;
  - the nightly backup schedule appears as `cron:backup.run.supervised`.
- **Fork:** create a conversation from the worktree app and confirm the DB
  appears. Repeat with a backend restart mid-restore.
- **Reaper:** not run from a worktree, since it would remove real worktrees on
  this machine. After push, check main's next hourly tick: its
  `supervised_job_runs` row, the lines in `logs/worktree-cleanup.jsonl`, and no
  slot-hog report.
- `./equin check`.
