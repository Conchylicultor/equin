# Worktree checkouts run in supervised children

## Context

2026-10-28 12:45: main's hot restart SIGTERMed the old backend's process group one
second after `conversations.spawn` started. The job's `git worktree move` died
(exit 143), `claimSpare` misread that as "another claimer won" and started a cold
`git worktree add` in the dying process, and the SIGKILL 5 s later cut the add
half-way (20 731 files never written, git's `initializing` lock left on). The
re-queued job adopted the half-written dir as "already set up" and failed every
retry on `<wt>/equin install`.

The job was durable — the row was reclaimed and retried. What was not was the
work: `conversations.spawn` and `worktree.spare-refill` are in-process
`hold: "minutes"` jobs whose `inProcess` claims ("a kill re-runs and skips what
landed") were false for a checkout. The jobs doc already says long work that must
survive a restart is a `defineSupervisedJob` — a detached child a restart does not
kill (backup, build, release, `database.fork`, the reaper all run that way).

Already landed in this branch (backstops, kept): `isUnfinishedCheckout` treats
git's `initializing` lock as an unfinished add (discard + redo), the discard
releases that lock, the spare reaper reclaims killed adds, and the reclaim report
quotes a `minutes` job's `inProcess` claim and points at `defineSupervisedJob`.

Outcome wanted: a deploy or restart never interrupts a checkout; the spawn
resumes in whichever backend is alive when the checkout ends.

## Constraint that shapes the design

A supervised `run` child boots the plugin graph: ≥ 2 s (`deps.install`'s no-op
run, 3-day min). Spawn today is 7.6 s p50 / 24 s p90. So only work that *needs*
the child goes there: making a checkout. A resume (checkout already complete)
stays in process and as fast as today.

## Design

### 1. `worktree.prepare` — supervised `run` job

In `plugins/conversations/plugins/workspace/plugins/worktree/server/internal/prepare-job.ts`
(where `prepare` and the composition-manifest read already live).

- `defineSupervisedJob({ name: "worktree.prepare", input: { attemptId, path }, lock: (i) => i.attemptId, channel: <new log sink "worktree-prepare">, run, onEnded })`, built-in ledger, `runAttempts` default 1 (the spawn owns the ladder, §3).
- `run` (child): `setupWorktree(attemptId, path, compositionIds)` exactly as `prepare` calls it today — spare claim or cold add, `convergeExistingCheckout`'s discard of a cut-off one, then `installCheckout(frozen)`. No `signal` (the child is bounded by git's `ADD_TIMEOUT_MS` and install's 20 min; nothing else holds it).
- `onEnded` (backend): on exit 0, `spareRefillJob.enqueue({})` — moved out of `prepare` so the child never enqueues.
- A failed run dead-letters (built-in-ledger policy) — the loud surface, alongside the spawn's own `conversation-spawn-failed` report.

### 2. `infra/worktree`: a read-only checkout state

`checkoutState(repoRoot, wtPath): Promise<"complete" | "absent" | "unfinished">`
in `server/internal/worktree.ts`, exported from the barrel — `absent` (no dir),
`unfinished` (`isUnfinishedCheckout`), else `complete`. Never discards: only the
child converges. `setupWorktree` keeps its current behaviour (the child and the
CLI call it).

### 3. The worktree workspace's `prepare` becomes a durable wait

`WorkspaceImpl.prepare(at, signal)` → `prepare(at, ctx: WorkspacePrepareCtx)`
where `WorkspacePrepareCtx = Pick<JobCtx, "signal" | "step" | "waitFor">`
(`plugins/conversations/plugins/workspace/server/internal/registry.ts`). Scratch
ignores the new members (`ctx.signal` where it used `signal`).

Worktree `prepare`, observe-before-wait (the shape of `release`'s `awaitRelease`,
`plugins/release/server/internal/await-release.ts`):

```
for i = 0..:
  state = checkoutState(path)
  complete  → ensureWorktreeLocked + installCheckout(frozen:false)   // today's "existing" path, in process
              return
  run = latestSupervisedRun(prepareJob, { attemptId, path })          // §4
  run open  → waitFor(runEnded, { kindId, runId: run.id }, 30 s, name `prepare:wait:${i}`); continue
  run closed after OUR last request, still not complete
            → requests < 3 ? request again : throw NonRetryableError(run.errorMessage ?? "killed …")
  no run / run older than our last request
            → request = ctx.step(`prepare:request:${n}`, enqueue + return requestedAt)
              waitFor(runEnded, { kindId }, 30 s, name `prepare:wait:${i}`)
```

- The **checkout on disk is the authority**; `runEnded` is only a wake-up (the same rule supervised-job applies to its marker). A lost wake costs one 30 s re-look, never the spawn.
- "Closed after our last request": `requestedAt` is memoized by the step, compared with the row's `started_at`. The spawn's run id is keyed (`conversations.spawn:<conversationId>`), so its steps replay across graphile retries — which is why the retry ladder over prepare runs lives in this loop (new step name per request), not in graphile's retry: a thrown failure would replay the same memoized request forever.
- After 3 failed runs: `NonRetryableError` with the last run's recorded error — the spawn records it (`recordSpawnFailure`, `conversation-spawn-failed`) and dead-letters.

### 4. supervised-job: read a built-in-ledger run by lock

`latestSupervisedRun(job, input): Promise<SupervisedRunRow | null>` in
`plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/builtin-ledger.ts`,
exported: the newest `supervised_job_runs` row for `(job.name, lock(input))` —
`{ id, startedAt, open, exitCode, errorMessage }`. Throws for a job without the
built-in ledger + `lock` (reuse `builtinLockedJobOf`, as `cancelSupervisedJobByLock`
does). The kind id for the `runEnded` filter comes from `job.kind`.

### 5. The spawn job

`plugins/conversations/server/internal/spawn-job.ts`:
- pass `ctx` (not `signal`) to `workspace.prepare`;
- the catch-all rethrows `isSuspendSignal(err)` first (today it would report a suspend as a spawn failure);
- `hold` stays `minutes` (in-process `installCheckout` on an existing checkout, `runtime.create`); `inProcess` rewritten to the true claim: the checkout runs in `worktree.prepare`; what stays here is safe under a kill (`./equin install`'s own lock + stamp; `runtime.create` no-ops once live).
- Header comment and the `step` labels ("worktree" / "runtime") unchanged.

### 6. `worktree.spare-refill` → supervised

`plugins/infra/plugins/worktree/plugins/spare-pool/server/internal/refill-job.ts`:
`defineSupervisedJob({ name: "worktree.spare-refill", input: z.object({}), schedule: <same cron>, channel: <log sink>, run })`
— built-in ledger, no `lock` (one job-wide run: an enqueue while one runs loses
its claim and returns, and the running loop tops up to `SPARE_TARGET` anyway).
`run` = today's body without `signal`. Callers' `spareRefillJob.enqueue({})`
unchanged (boot warm-up, `onEnded` of §1).

## Files

- `plugins/conversations/plugins/workspace/plugins/worktree/server/internal/{prepare-job.ts (new), worktree-workspace.ts}` + its `server/index.ts` `register`
- `plugins/conversations/plugins/workspace/server/internal/registry.ts` (+ scratch impl and tests)
- `plugins/conversations/server/internal/spawn-job.ts`
- `plugins/infra/plugins/worktree/server/{index.ts, internal/worktree.ts}` (`checkoutState`)
- `plugins/infra/plugins/jobs/plugins/supervised-job/server/{index.ts, internal/builtin-ledger.ts}` (`latestSupervisedRun`)
- `plugins/infra/plugins/worktree/plugins/spare-pool/server/internal/refill-job.ts`
- Docs: the touched plugins' `CLAUDE.md` (spawn path, spare pool), supervised-job's consumer list.

## Verification

1. `./equin test` on `infra/worktree`, `supervised-job`, `conversations/workspace` — new tests: `checkoutState` for each state (incl. the `initializing` one); `latestSupervisedRun` against the built-in ledger; the worktree `prepare` loop with a fake `ctx` (complete → no enqueue; absent → one request then wait; failed run → re-request, 3rd failure → `NonRetryableError`).
2. `./equin build`, `./equin check`.
3. Live on this worktree's deploy: launch a conversation → a `worktree.prepare` row in `supervised_job_runs` (`query_db`), the agent starts. Resume it → no new prepare row.
4. Kill test: launch, and while the prepare child runs, restart this worktree's backend (`./equin build` again). The child keeps running (its pid survives), the new backend's spawn wakes on `runEnded`, the agent starts; `git worktree list` shows no `initializing` lock.
