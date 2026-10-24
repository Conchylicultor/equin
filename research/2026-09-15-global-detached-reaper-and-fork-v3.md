# One way to run detached work (v3)

Status: plan, awaiting final approval. Supersedes v2
(`2026-09-15-global-detached-reaper-and-fork-v2.md`) and v1.

Decisions the user took on v2:

- **Deploy:** one path. Only `defineSupervisedJob` can start a detached child,
  and deploy moves onto it.
- **Long in-process jobs:** declare it. `hold: "minutes"` requires an explicit
  `inProcess` reason.
- **Framework:** yes, change `./equin build`'s wait for a new worktree's
  database.

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

The underlying problem is that there are three ways to do long work, and the
safe one is the easiest to miss:

1. **`defineSupervisedJob`.** Build, release and backup use it. Each still
   hand-writes a ledger. Backup also needs a separate task registration and a
   separate cron job.
2. **The low-level `startSupervisedRun` / `defineSupervisedRunKind`.** It is
   exported, and deploy calls it directly with about 150 lines of its own
   spawn-and-wait code.
3. **An ordinary `defineJob({ hold: "minutes" })`** whose subprocess runs inside
   the backend. This is how the reaper and the fork were written.

Goal: path 1 is the only way to start a detached child, path 2 has no public
name, and path 3 cannot be written without stating why dying mid-run is fine.
The reaper and the fork move to path 1.

**Out of scope, per the user:** a time limit on a detached run. Also out of
scope: long-lived processes with their own supervisors (worktree backends,
zero-cache, conversation tmux sessions, release previews). They are not jobs.

---

## 1. Job framework: a run is a queue row, not the dedup key

Verified against graphile 0.16.6 (`sql/000018.sql:150-173`).

- **Keyed dedup** keeps one run per key (`${name}:${key}`).
  `exit-clean-finalize-job.ts` relies on a second enqueue coalescing into its
  suspended workflow.
- **Everything else** (singleton, none, cron ticks) runs as `${name}:job:${jobId}`,
  derived by the worker at dispatch through one `workflowRunIdFor(payload, jobId)`.
  - The row id survives a retry, a sweeper reclaim, and a later enqueue or tick
    collapsing onto the pending row (which replaces the payload).
  - Resume rows keep their explicit run id.
  - This replaces cron's `${name}:${_cron.ts}` and the `legacy:` fallback.
- Enqueue and cron share one `singletonJobKey(name)`. Today they agree only
  because the run id and the key are the same string.
- Dead-job GC and the sweeper's superseded DELETE discard the row's step log.
- It fixes two current bugs:
  - A losing claim no longer wipes a live singleton workflow's saved progress.
  - A run killed on its last attempt no longer poisons the next run's replay.
- **Behaviour change:** "singleton" now means at most one *pending* row, not at
  most one live workflow. None of the 36 singleton jobs use steps or waits, so
  nothing current changes.
- Files: `jobs/server/internal/{registry,worker,dead-job-gc,stuck-lock-sweeper}.ts`,
  plus the comments and docs stating the old rule:
  - `JobCtx.workflowRunId`;
  - `worker.ts` ≈159-166, 212-218, 519-522, 687-697;
  - the `workflow-log.test.ts` header;
  - `jobs/CLAUDE.md`.

## 2. Long in-process jobs must say why (`inProcess`)

`DefineJobSpec` becomes a union on `hold`:

- **`"instant"` / `"seconds"`:** unchanged.
- **`"minutes"`:** also requires `inProcess: string`. This is a sentence saying
  why dying mid-run and re-running from scratch is acceptable. The field's
  doc comment says: long work that must survive a restart, or must not hold a
  worker slot, belongs in `defineSupervisedJob`.

So a new long job fails `tsc` until its author has chosen. The four jobs that
stay in process get their reason written in:

| Job | File | Reason, in short |
|---|---|---|
| `conversations.spawn` | `plugins/conversations/server/internal/spawn-job.ts` | worktree add and tmux create are both idempotent; a rerun no-ops what is done |
| `prototypes.render-thumbnail` | `apps/prototypes/plugins/thumbnails/server/internal/jobs.ts` | a lost render is re-rendered; runs too often to pay a child boot each time |
| `prototypes.checkpoint-turn` | `apps/prototypes/plugins/checkpoints/server/internal/job.ts` | idempotent per message; runs every turn |
| `events.refresh-source` | `apps/events/plugins/refresh/server/internal/jobs.ts` | re-marks its source row each run; a rerun refetches |

Test fixtures that build `hold: "minutes"` slot or row objects (not
`defineJob` specs) are unaffected.

This is enforcement at the type level (rung 2). It is also the reason the
reaper and the fork would not be written that way again: their honest reason
would now read "kills a sweep mid-reap" and "restarts a 2 GB dump", which is
the prompt to detach.

## 3. The one factory: `defineSupervisedJob`

### 3a. One plugin, one public way to start a child

Fold `jobs/plugins/supervised-run` and `jobs/plugins/supervised-task` into
`jobs/plugins/supervised-job` as internal files:

- `server/internal/run/*` — today's supervisor, registry, tail and reconciler.
- `server/internal/task/*` — today's task registry.
- `cli/` — the `supervised-exec` command, still `detachable: true`.
- `core/` — today's supervised-run and supervised-task core.

The plugin's `onReady` registers the one reconciler.

**Public server barrel after the fold:**

- `defineSupervisedJob`, `cancelSupervisedJob`, and the types a ledger
  implements (`UnfinishedRun`, `RunTerminal`).
- `runEnded` stays public for release's `awaitRelease`, which is a durable wait,
  not a spawn.
- **No longer exported:** `startSupervisedRun`, `defineSupervisedRunKind`,
  `killSupervisedRun`, `reconcileSupervisedRuns`, `defineSupervisedTask`.

**Public core:** read-only helpers such as `readRunTerminal`, `isPidAlive`,
`HARD_KILL_EXIT_CODE` and `TRANSCRIPT_CEILING_BYTES`. Build, release, backup and
deploy's ledgers use these, and none of them can start a process.

This is rung 1. Starting a detached child has no spelling outside the factory.

Moves:

- Update every importer: build, release, backup and deploy run-state, and
  `build-logs`.
- Delete the two plugin folders and their `CLAUDE.md` files.
- Merge that prose into supervised-job's `CLAUDE.md`, which becomes the single
  guide to detached work.
- The registries regenerate on build.

### 3b. The declaration

```ts
defineSupervisedJob({
  name, input,
  // WHAT runs — exactly one of:
  argv:  (input, runId) => ({ argv, cwd?, envOverrides? }),   // one child, a command line
  run:   async (input, { runId, log }) => { … },              // one child, in-process code
  steps: async (input, { runId, step, ctx }) => { … },        // several children, sequenced in the backend
  // WHERE runs are recorded:
  ledger?: { kindId, claim, listUnfinished, setPid, closeRow, beginStep?, onReattach? },
  lock?:   (input) => string,       // built-in ledger only
  channel,
  schedule?, runAttempts?, onEnded?,
  hold?: "instant" | "seconds",     // `steps` only: what bounds the backend code between steps
});
```

One `register: [job]` token mounts the queue job, the run kind and, for `run`,
the child task registered under the job name.

The type forbids these combinations:

- both or none of `argv` / `run` / `steps`;
- `lock` together with `ledger`;
- `steps` without `ledger`: the built-in ledger closes a run when its one child
  ends;
- `runAttempts` with `steps`: a sequence decides its own retries;
- `hold: "minutes"` anywhere.

### 3c. Bodies

- **`argv`:** unchanged from today.
- **`run`:** the child is `./equin supervised-exec <name>` with payload
  `{ runId, attempt, input }`, booted in exec mode.
  - `log` writes to stdout/stderr. That output becomes the transcript, which the
    parent tails into `channel`, so one process writes each log file.
  - On a throw, the child records `error_message` and
    `retryable = !isNonRetryableError(err)` on its built-in ledger row, then
    exits 1. Export `isNonRetryableError` from the jobs barrel.
- **`steps`:** the body is a durable workflow in the backend. It suspends
  between steps and holds no slot while a child runs.
  - `step(name, { argv } | { run })` spawns child `${runId}.${name}` inside a
    memoized step, then waits for its end with the shared observe-then-wait
    loop, and returns its `RunTerminal`.
  - Before spawning, it calls `ledger.beginStep?.(runId, name)`. That records
    which child a restarted backend should look for, and returns false if the
    run was closed meanwhile. The body then gets `{ state: "run-closed" }` and
    spawns nothing.
  - `ctx` is the job context, for waits the body needs between steps (deploy's
    `awaitRelease`).
  - The wrapper still calls `abortDurableRun` on the way out.
- **Child ids:** a single-child job keeps child id = run id. Build, release and
  backup ids are unchanged, so their in-flight runs re-attach across the deploy
  that ships this. A step keeps deploy's existing `<runId>.<leg>` form.

### 3d. Ledgers

- **Own ledger:** the kind verbs plus `claim`, grouped, with an explicit
  `kindId`.
  - Needed by build (its CLI writes `build_runs` rows, including runs started by
    hand in a shell), release (closing reads `RELEASE.json` and writes five
    domain columns in one UPDATE), backup and deploy.
  - This keeps the Runs plugin's recorded "federation, not a shared table"
    decision.
  - `claim` may adopt a row the caller already inserted. Deploy claims in its
    endpoint so a busy server answers 409 on the click.
  - A failed run is data in your table and UI. That is today's rule.
- **Built-in ledger** `supervised_job_runs`:
  - Columns: `id, job_name, lock_key, pid, attempt, workflow_run_id, started_at,
    finished_at, exit_code, signal_code, error_message, retryable`.
  - `UNIQUE (job_name, lock_key) WHERE finished_at IS NULL` is the lock;
    `claim` is an INSERT against it.
  - `closeRow` stamps the exit marker's outcome. It is the only writer of the
    outcome.
  - Excluded from DB forks (`ExcludeFromFork`), so no namespace column.
  - Kept 30 days after `finished_at` (`defineRetention`).
  - Kind id derived from the name (`databasefork`, `worktreecleanupreapstale`).
    A collision throws at register.
  - **The dead-letter is its failure surface**, since there is no UI:
    - exit 0 → done;
    - failed and (not retryable, or last attempt) → throw `NonRetryableError`
      with the child's recorded message, or "killed before recording an error,
      see the transcript";
    - failed otherwise → retry.
    - A hard kill or a reboot's TERM carries no flag, so it stays retryable.

### 3e. Scheduling and retries

- **`schedule`:** present means `dedup: "singleton"` plus the cron. Absent stays
  `"none"`, because a pending singleton row takes the latest payload, which would
  change build, release and deploy. The cron payload is `input.parse({})`, which
  `defineJob` already asserts.
- **Retry ladder:**
  - Close the previous attempt's row (`closeRow`, idempotent) before the next
    claim. Today, after a restart, the next claim can lose to the previous
    attempt's still-open row; the loss is cached and the retry silently never
    happens. Backup is exposed to this now.
  - `not-claimed` on attempt 2 or later throws.
  - A durable backoff (about 3, 7, 20 and 55 s) between attempts, holding no
    slot.

## 4. Consumers

- **build** (`plugins/build/server/internal/run-build.ts`), **release**
  (`plugins/release/server/internal/release-job.ts`):
  - Declaration shape only: `kind` + `claim` → `ledger`.
  - `build.run.debounced` stays; it is a debounce, not a schedule workaround.
- **backup** (`plugins/backup/server/internal/{backup-job,backup-task,backup-schedule}.ts`):
  - The body moves into `run` and the schedule onto the job.
  - Delete `backup-schedule.ts` and the task token.
  - A `backup.run.schedule` row pending at the instant of deploy would
    dead-letter as an unknown job. That row lives for milliseconds around the
    nightly tick, so accept the risk.
- **deploy** (`plugins/apps/plugins/deploy/plugins/deployments/server/internal/`):
  - `deploy.run` becomes `defineSupervisedJob({ steps, ledger, hold: "seconds" })`.
    `hold` stays `seconds` because of the `compareToHead` git read between legs.
  - `runUpdate` becomes converge step → decide build → `awaitRelease(ctx, …)` →
    ship step.
  - Single verbs become one step.
  - `spawnLeg`, `awaitLeg` and `observeLeg` are deleted.
  - The ledger adapter:
    - `deployVerbKind`'s verbs become the ledger (`listUnfinished`, `setPid`,
      `closeRow` = `closeDeployRow`, `onReattach` = `reattachRun`).
    - `beginStep` = `beginLeg`. The bundle pin that `beginLeg` writes today
      moves into the memoized step just before the ship step.
    - `claim` adopts the endpoint-claimed row, and returns `null` when it is
      closed. That replaces `loadOpenRun`'s null.
    - `claimRun` in the endpoint, the in-memory live view, and
      `reconcileDeployLiveView` stay as they are.
  - **Behaviour to keep:** a thrown error still stamps the run via `failRun`
    and rethrows. The wrapper must pass the suspend signal through untouched,
    as `runDeploy` does today.
  - **Wait-rule change:** a leg's end is now detected like every other child —
    exit marker, else dead pid → hard kill — instead of "marker, or row closed".
    Both are correct: in deploy's `closeRow` a hard-killed leg closes the row,
    and the body then sees a failed terminal and stops.
- **reaper** (`plugins/debug/plugins/worktree-cleanup/server`):
  - `run` body with the built-in ledger, the hourly schedule, and
    `runAttempts: 1` (the next tick is the retry).
  - `channel` is its existing `worktree-cleanup` sink, so
    `logs/worktree-cleanup.jsonl` stays where it is. `log.publish` becomes
    `ctx.log`.
  - `hold`, `serial` and the deadline plumbing go away.
  - The `onReady` boot enqueue stays; while a run is in flight its claim loses.
- **fork** (`plugins/database/plugins/fork/server`):
  - `run` body with the built-in ledger, `lock: target`, `runAttempts: 5` with
    backoff, and a new `database-fork` channel.
  - `ForkPlanError` → `NonRetryableError`.
  - Notifications are written from the child.
  - `createConversation` is unchanged.

## 5. `./equin build`'s wait for a new worktree's DB (approved framework edit)

`plugins/framework/plugins/cli/plugins/build/cli/run.ts:336-374`:

- Raise the no-temp-DB grace from 20 s to 60 s. The detached fork spends an exec
  boot before its temp DB appears.
- Both error messages point at Debug → Queue for a dead `database.fork` and at
  `logs/database-fork.jsonl`. "Check /api/jobs" finds nothing while the workflow
  is suspended.

## Residuals

- **A time limit on detached runs**, excluded by request. The reaper loses the
  deadline that used to release the host-wide `worktree-mutate` flock; the
  per-call git timeouts remain.
- **Bell notifications from a child can be lost at exit.** `recordReport` fires
  its bell without awaiting it, and exec mode exits right after the body.
  Report rows are safe. File a task: flush pending notifications in exec shutdown.
- **Built-in-ledger runs don't appear on the Runs surface.** A follow-up could
  add one run arm covering all of them.
- **The close rule is still written twice**, in the observe loop and in the
  reconciler. Both now sit inside one plugin, which makes the planned single
  shared rule a local refactor.

## Implementation order

Each step leaves the tree building and checks passing.

1. §1 job framework, with tests.
2. §2 `inProcess`, with the four reasons.
3. §3a fold: move the files and update importers. No behaviour change.
4. §3b–e factory: `run`, `steps`, `ledger`, the built-in ledger, `schedule`, the
   ladder fixes, with tests.
5. Build, release, backup to the new shape.
6. Deploy onto `steps`.
7. Reaper, then fork.
8. §5 build wait.
9. Docs: supervised-job guide, `jobs`, `backup`, `fork`, `worktree-cleanup`,
   deploy `CLAUDE.md` (drop "deliberately not defineSupervisedJob").

## Verification

- **Unit tests** (`./equin test <plugin>`):
  - run-id derivation and the shared singleton key;
  - log discard on GC and supersede;
  - loop: close-before-reclaim, attempt-2 `not-claimed` throwing, backoff
    replay;
  - `steps`: memoized spawn per step, `beginStep` refusal → `run-closed`, replay
    after a resume spawns nothing twice;
  - built-in ledger: claim lock, the failure-policy table, kind-id derivation;
  - existing `loop` / `observe` / `finish` / `spawn-claimed` / supervisor / shim /
    tail tests, which move with the fold;
  - deploy's `verb-outcome.test.ts`.
- **Type-level:** `hold: "minutes"` without `inProcess` fails; the forbidden
  combinations in §3b fail.
- **`./equin check`:** plugin-boundaries (no remaining import of the
  removed exports), type-check, migrations-in-sync, docs in sync.
- **Existing harnesses** on the worktree deploy: `POST /api/events-test/{cron-dedup,
  superseded,crash-recovery,serial-queue}`.
- **Survives a restart** (worktree deploy):
  1. Add an `events-test` job with a `run` body that sleeps about 90 s, and a
     two-step `steps` job, and start both.
  2. Run `./equin build` mid-run.
  3. With `query_db`, confirm: the children stayed alive, rows close with exit
     0, the second step spawned after the restart, no dead job, and a second
     start during the run loses its claim.
  4. Repeat with `kill -9` on a `run` child: expect a retry, then a dead-letter
     naming the kill.
- **Moved consumers** (worktree deploy):
  - a Build-button build: the row closes and the bell fires;
  - a Studio release: the domain columns are written;
  - a manual backup: the row closes;
  - the nightly schedule appears as `cron:backup.run.supervised`.
- **Deploy:** needs a configured server. Check main's `deploy_deployments` via
  `query_db`. If one exists, run converge and then update from the worktree app,
  including a backend restart during the release wait. If none exists, say so;
  deploy is then covered by unit tests plus the `steps` harness only, and must
  be tried on a real server before relying on it.
- **Fork:** create a conversation from the worktree app and confirm the DB
  appears. Repeat with a restart mid-restore.
- **Reaper:** not run from a worktree, since it would remove real worktrees on
  this machine. After push, check main's next hourly tick: its
  `supervised_job_runs` row, the lines in `logs/worktree-cleanup.jsonl`, and no
  slot-hog report.
