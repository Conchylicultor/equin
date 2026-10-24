# Out-of-process work becomes ordinary jobs

**Status:** proposed
**Date:** 2026-09-02
**Follows:** [`2026-09-01-global-supervised-run-survives-restart.md`](./2026-09-01-global-supervised-run-survives-restart.md)
(the `supervised-run` primitive, landed) — this is the follow-on it filed as
`task-1788260211030-g47x1v`.

## Context

There are two systems for durable background work, split by nothing more
principled than whether the work must survive a backend restart.

`jobs` has dedup, retries, serial lanes, cron, dead-lettering, exact liveness and
a queue UI — and its handler dies with its process. `supervised-run` has detach,
pid, transcript, boot reconcile and re-attach — and no dedup, no retries, no
scheduling. Build, release and deploy live in the second half. Backup lives in
the first, so a restart kills it mid-`tar` and `reconcileBackups` marks the row
failed — a fourth hand-rolled reconciler.

**The blocker named in the prior doc is not the real one.** It said folding this
into `jobs` means changing dispatch, because `RegisteredJob.run` is an in-process
closure. It isn't, because `jobs` already has durable suspend and resume:
`ctx.waitFor` returns from `run` via a suspend sentinel, the worker slot is
released, the graphile row is deleted, and the workflow resumes later as a fresh
dispatch from `jobs.resume` (`server/internal/step-ctx.ts`,
`server/internal/resume-job.ts`). Its own docs say a workflow may span days while
every run of it is `instant`.

So a long-running job is short at both ends and empty in the middle: spawn and
suspend, then be woken by the child's exit marker and stamp the outcome. Nothing
in dispatch, the advisory lock or the hold classes changes.

**Intended outcome:** build, release, deploy and backup are all ordinary
`defineJob`s. The queue is the one place durable background work is requested,
observed and bounded. Backup survives a restart for the first time.

## Decisions taken

- **One ledger per consumer.** `build_runs`, `release_runs`, `deploy_runs` and
  `backup_runs` stay exactly as they are, each with its partial unique in-flight
  index. That index remains the authoritative lock — the claiming INSERT is what
  wins or loses. No schema unification; `plugins/runs` already merges them for
  display, and its four `defineRunKind` arms map 1:1 onto the four job kinds.
- **No auto-retry.** `runAttempts` defaults to 1, preserving today's behaviour
  exactly: a failed build/deploy/backup stays failed and visible. The wrapper
  supports a respawn loop; a kind must ask for it.
- **One session, agent-parallel.** Sequenced below as five workstreams, three of
  which are independent.

## Design

### A. A supervised run becomes a job

New plugin **`plugins/infra/plugins/jobs/plugins/supervised-job/`**, a sibling of
`supervised-run` under the `jobs` umbrella. It composes three existing things and
owns no new concept:

```ts
export const buildJob = defineSupervisedJob({
  name: "build.run.supervised",
  input: z.object({ trigger: z.enum(["manual", "auto"]), compositions: z.array(z.string()).optional() }),
  kind: { id: "build", channel: buildLog, listUnfinished, setPid, onReattach },
  // Mint the ledger row. The INSERT is the lock; returning null means we lost.
  claim: async (input) => claimBuildRun({ ... }),
  argv: (input, runId) => ({ argv: ["./equin", "build", "--allow-main", ...], cwd: REPO_ROOT, envOverrides: { ... } }),
  // Terminal work, on the resume. Everything that used to hang off `finish`.
  onEnded: async (runId, terminal) => { await stampBuildRow(runId, terminal); await notifyBuildFinished(runId); await reconcileDeployment(); },
});
```

The handler it builds is, in essence:

```
1. claim()                      → lost the race? return, nothing to do
2. startSupervisedRun(...)      → spawn detached, record pid
3. ctx.waitFor(runEnded, { where: { kindId, runId }, timeoutMs })
4. on wake: readRunTerminal(kindId, runId)
     marker present            → onEnded(), throw if the exit code is non-zero
     absent, pid alive         → wait again (next loop iteration)
     absent, pid dead          → hard-kill outcome, onEnded()
5. non-zero exit and runAttempts > 1 → next iteration spawns a fresh runId
```

Four rules make that correct, and each earns its place:

**The marker is the authority; the event is only a wake-up.** `supervisedRun.ended`
is a `defineTriggerEvent` filtered on `(kindId, runId)`. If the backend dies
between the child writing its exit marker and the emit landing, no event ever
fires — and for a kind whose own CLI stamped its ledger row early (build does,
~100s before its child exits) the supervised-run reconciler will not re-announce
it either. So the handler never trusts the event's payload. It re-reads the
marker file on every wake, and the wait is bounded so a lost event costs one
timeout rather than the run. That bounded re-wait is the same argument
`RECONCILE_MS` already makes in `supervisor.ts` — it exists only while a run is
live, and covers exactly the edge the filesystem cannot report.

**The claim is the lock, not `dedup`.** Each kind keeps its partial unique index
and the wrapper calls `claim()` before spawning. A lost race returns cleanly.
`dedup: "none"` on the generated job, deliberately — see the trap below.

**`hold` is set by the wrapper, never declared by a consumer.** A handler that
spawns detached and suspends returns in milliseconds, so it is `instant`. The
hold table's reviewer heuristic is literally "does it spawn?", which would say
`minutes` and burn one of only four wide slots for the length of a build. Fixing
it in the factory makes the wrong answer unspellable.

**`finish` shrinks to an announcement.** The supervised-run kind's `finish` now
only emits `runEnded`; every consumer's terminal work moves into `onEnded`, which
runs inside the job — retryable, observable in Debug → Queue, and with one owner
instead of two racing arms.

Boundary check: `supervised-job → events` is legal and closes no cycle. `events →
jobs` exists, `supervised-run`/`supervised-job` are their own zones (nesting under
`jobs` creates no edge), and nothing reachable from `events` points back at them.

`supervised-run` itself needs no change for this part.

### B. `defineSupervisedTask` — an out-of-process body that is not an argv

Build, release and deploy each have a CLI command to spawn. Backup does not: it
tars a staging dir, then calls `run(archive)` on ~2 contributed `BackupTarget`s
fed by ~11 contributed `BackupSource`s. There is nothing to type on a command
line, which is exactly why it is the one that still dies on restart.

New plugin **`plugins/infra/plugins/jobs/plugins/supervised-task/`**:

- `defineSupervisedTask({ id, payload: zodSchema, run })` — a `register:` token,
  same shape as `defineJob`/`defineSupervisedRunKind`.
- A CLI command `./equin supervised-exec <taskId> <payloadJson>`
  (`supervised-task/cli/index.ts` + `cli/run.ts`, per the `defineCliCommand`
  contract; `cli.generated.ts` is regenerated by `./equin build`).
- `defineSupervisedJob({ task })` as an alternative to `argv`: the wrapper spawns
  that command instead, and everything else — detach, transcript, marker,
  reconcile, resume — is unchanged.

**The headless boot is the real work here, and it must be one boot with two modes,
not a second copy.** `server-core/bin/index.ts` today is a linear script that
throws without `SOCKET_PATH`, binds a unix socket, and runs `onReady` — which
starts graphile runners, the git watcher, cron and the supervised-run reconciler.
A short-lived child must run none of that, and a forked copy of the boot sequence
would drift the way release's recovery path drifted.

So: extract the phase sequence into a shared runner over
`computeLoadWaves` / `topoSortPlugins` / `collectContributions`, parameterised by
mode.

| phase | `serve` | `exec` |
|---|---|---|
| load waves, `register`, `collectContributions` | yes | **yes** — contributions are how backup finds its sources and targets |
| `onReadyBlocking` | yes | **yes** — DB pool, migrations, config registry |
| socket bind, `onReady`, `onAllReady`, `drainWarmups` | yes | **no** |

The child inherits the backend's env (so `SINGULARITY_WORKTREE` resolves the right
DB) plus whatever `envOverrides` the kind adds, exactly as a build child does today.

Precedent to reuse, not to imitate: `plugin-meta/barrel-import` loads server
barrels outside the backend but only reads their static shape — it stubs the DB
and runs no phase. This is genuinely new, which is why it is scoped last and
verified on its own.

## Traps found while researching this — read before implementing

- **The step/wait log leaks on permanent failure, and a singleton workflow
  re-uses its id forever.** `worker.ts` deletes `_jobSteps` / `_jobWaits` only on
  the *completed* path; a throw exits before the cleanup. With
  `dedup: "singleton"` the `workflowRunId` is the constant `${jobName}:_`, so
  after one failed run the next enqueue replays stale cached steps and a
  `resolved` wait — it would skip the spawn entirely and never build. This is a
  pre-existing hazard in `jobs`, not something this change introduces.
  Two responses, both wanted: supervised jobs use `dedup: "none"` (a fresh uuid
  `workflowRunId` per enqueue, so no cross-run collision is possible), **and**
  `markJobPermanentlyFailed` also drops the workflow's step/wait rows. Ship the
  second as its own commit so it can be reverted independently.
- **Deploy's `update` awaits a release build in-process, for tens of minutes.**
  `runUpdate` is converge-leg → `await runRelease(...)` → ship-leg, and that
  middle await is why `driving`/`waiters` exist in `legs.ts` and why release has
  its own waiter map in `driving.ts`. It is also precisely the window the
  2026-08-28 incident died in. As a job the sequence becomes durable: the middle
  phase is `ctx.step` to enqueue the release job, then `ctx.waitFor(runEnded,
  { where: { kindId: "release", runId } })` — the same event the wrapper already
  publishes. Both waiter maps and `driving.ts` are then deleted, not generalised.
- **A leg is the supervised unit for deploy, not a run.** `<runId>.converge` /
  `<runId>.ship`; the wrapper must let one job own several sequential runs.
- **Cancellation is two halves.** `killSupervisedRun` signals the process group;
  `abortDurableRun(workflowRunId)` releases the pending wait. Wire both, or a
  cancelled run leaves a workflow suspended until its timeout.

## Work breakdown

Three of these are independent and can run in parallel; **4** depends on **1**,
and **5** depends on **1** and **3**.

**1. `supervised-job` (the wrapper).** New plugin: the `supervisedRun.ended`
trigger event + table, `defineSupervisedJob`, the spawn/wait/re-read loop, the
`runAttempts` respawn loop. Tests mirror
`supervised-run/server/internal/supervisor.test.ts` — a fake kind driven through
the real handler with real child processes.

**2. `jobs` hardening (independent).** Drop `_jobSteps`/`_jobWaits` for a
permanently-failed workflow in `server/internal/worker.ts`. One commit, one test.

**3. Headless boot mode (independent).** Extract the phase runner in
`plugins/framework/plugins/server-core/bin/`, add the `exec` mode, keep `serve`
byte-identical in behaviour. Verified by booting a worktree normally first.

**4. Migrate build, then release, then deploy.**
- `plugins/build/server/internal/run-build.ts` — `triggerBuild` becomes
  `buildJob.enqueue(...)`; `build.run.debounced` enqueues instead of calling it.
  `finishBuild`'s body moves to `onEnded`.
- `plugins/release/server/internal/run-release.ts`, `run-state.ts`,
  **delete `driving.ts`**.
- `plugins/apps/plugins/deploy/plugins/deployments/server/internal/run-deploy.ts`,
  `run-state.ts`, `legs.ts` — the three-phase durable sequence; delete both
  waiter maps. Largest piece; do it last and alone.

**5. Backup out of process.** `defineSupervisedTask("backup.run")` wrapping
today's `backupRunJob.run` body; `backup_runs` gains `pid` and a partial unique
in-flight index; `reconcileBackups` keeps only the staging/partial filesystem
sweep and loses its DB arm (the wrapper now owns that). The `google-drive` target
reaches secrets through the central runtime over the gateway, so it works
unchanged from a child process — verify it explicitly.

## Verification

1. **Unit** — `./equin test plugins/infra/plugins/jobs`. The wrapper's own
   suite covers: marker-present wake, lost-event wake (emit suppressed, timeout
   path still closes the run), hard-kill (no marker, dead pid), and a respawn
   loop with `runAttempts: 2`.
2. **The 2026-08-28 incident, reproduced** — start a deploy `update`, run
   `./equin build` while its release leg is running, assert the deploy still
   reaches `succeeded`. It fails 100% of the time today.
3. **Restart mid-build** — `./equin build`, kill the backend mid-run,
   confirm the job resumes, the transcript keeps streaming, the bell fires once
   and `reconcileDeployment` runs exactly once.
4. **Restart mid-backup** — trigger a backup, restart the backend during `tar`,
   confirm the archive completes and uploads. This is new behaviour and the
   headline of workstream 5.
5. **Ledgers** — `query_db` on `build_runs` / `release_runs` / `deploy_runs` /
   `backup_runs`: no row left unfinished with a dead pid, and `finished_at`
   reflects the child's real finish (the marker's mtime), not the reconcile
   instant.
6. **Queue** — Debug → Queue shows each run as one `instant` dispatch to spawn and
   one to finish, never a slot held for the length of the work.
7. `./equin check` and `./equin build`.

## Out of scope

- Merging the four ledgers into one table (decided against — see Decisions).
- A boot reaper for children that outlive their checkout or deployment row; still
  its own change, as the prior doc scoped it.
- Turning `serial` lanes on. The claiming INSERT already prevents overlap, and a
  lane would change today's drop-the-request semantics into queue-the-request
  semantics — a behaviour change worth making deliberately and separately.
