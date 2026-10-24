# The hold class becomes a deadline: aborting a run, forfeiting its slot, and making the abort reach the wait

**Date:** 2026-08-20 · **Category:** global (jobs, debug/queue-health, reports, server-core, host-admission, spawn) · **Status:** planned

Implements Phases 2, 3 and 4 of
[`research/2026-08-17-global-bounded-job-execution.md`](./2026-08-17-global-bounded-job-execution.md).
Read that doc for the incident, the crash-vs-quarantine evaluation, and the
reasoning this plan does not repeat.

## Context

On 2026-08-17 main's job queue stopped for 70 minutes: four handlers that would
never return held all four worker slots, 690 jobs froze behind them, and it was
found by hand.

Three commits have landed since, and they change what is left to do:

- **`e6592a8dd`** (Phases 0–1) — the alarm is no longer a job queued behind the
  wedge it detects; cron ticks no longer insert a row per tick; `serial` maps to
  graphile's `queue_name` so a wedged job costs one slot, not N. `ctx.signal`
  was added to `JobCtx` and left deliberately inert.
- **`2d09b074d`** (hold classes) — **this is the big one, and it supersedes the
  original Phase 2 and Phase 5 both.** Every job now declares
  `hold: "instant" | "seconds" | "minutes"`, and three graphile runners with
  nested task lists drain them (`floor` 2 slots / `mid` 2 / `wide` 4), so the
  reservation happens at fetch. `HOLD_SPECS[h].ceilingMs` already exists, and
  `jobs/CLAUDE.md` already commits to this next step: *"when Phase 2 lands, the
  same class ceiling becomes the deadline that aborts `ctx.signal`. A lane and a
  budget cannot disagree if there is only one thing to declare."*
- Both 2026-08-17 culprit sites are individually bounded now, and
  `spawnCaptured` gained full `AbortSignal` support (SIGTERM → grace → SIGKILL,
  then throws `signal.reason`).

**What is still missing is the whole enforcement half.** Nothing aborts
`ctx.signal`. A handler that never returns still holds a slot until the process
restarts. And the host-pool acquire — the thing the fourth wedged slot was
blocked inside, holding a *host-wide* flock — accepts no cancellation at all, so
even an abort that fires would not release what the handler was holding.

Intended outcome:

1. A run that overruns its class is aborted, and the abort is loud and named.
2. A handler that ignores the abort costs at most its own slot, and the ladder
   recovers rather than dying quietly.
3. The waits a handler blocks on actually accept the cancellation, so giving up
   on a handler releases the host resources it held.

**Explicitly not in scope:** a per-job budget field, and breaking the
`reports → jobs` dependency (see *Why not break the cycle*). The hold class is the one
declaration, and this plan derives the deadline from it.

---

## The mental model

**The worker gives up on the handler; it never takes the job away from it.**

A job already declares one thing:

```ts
defineJob({ name: "mail.delta", hold: "seconds", ... })
```

The unit bounded is **one dispatch**, not the workflow. `ctx.waitFor` /
`ctx.sleep` return from `run` and release the slot; the resume is a fresh row
with a fresh deadline. A workflow may span days while every one of its runs is
`instant`.

```
t = 0             handler starts, ctx.signal unaborted, a timer armed for the
                  class deadline.

t = deadline      · ctx.signal aborts, reason = JobDeadlineExceededError
                  · a `job-deadline-exceeded` report is filed immediately
                    (bell + Debug → Reports): job, class, deadline, elapsed
                  Nothing else. The wrapper does NOT return, the advisory lock is
                  NOT released, the job row is NOT touched.

t = deadline + ε  the handler notices — whatever it awaited that took the signal
                  throws — and unwinds. Ordinary job failure from here: lock
                  released, slot freed, reported, retried. The second attempt
                  dead-letters instead of burning all 5 retries.

t = deadline+30s  still not settled ⇒ zombie.
                  · the slot is FORFEITED (bookkeeping, not recovery): counted
                    as written off, shown as `forfeited` in Debug → Queue
                  · a `job-zombie` report is filed
                  · the row is STILL not touched. Its advisory lock is still held
                    by the live zombie, so the sweeper provably will not reclaim
                    it — no double-run, by the existing invariant, no new concept.

wide runner has   the only runner that can serve `minutes` can no longer do its
< 2 usable slots  job. Write the report SYNCHRONOUSLY to disk, then exit(1).
                  Postgres drops every advisory lock at teardown and the next
                  boot's sweeper reclaims cleanly. A latch suppresses a fourth
                  such crash within an hour.
```

Three properties this shape keeps, each of which is easy to lose:

- **There is no `Promise.race`.** Racing the handler against a deadline would let
  the wrapper return while the handler still runs, which releases the advisory
  lock, which lets the sweeper reclaim the row, which lets graphile re-dispatch a
  possibly non-idempotent handler alongside its own zombie — the exact corruption
  the advisory-lock design exists to prevent. The timer only aborts a signal. The
  slot frees when, and only when, the handler actually settles.
- **This is not the liveness inference the plugin bans.** The banned claim is
  third-person — "this row has been locked T, so its owner is dead, so I may
  re-dispatch it" — which cost ~25 stolen live jobs in 8 days. A deadline is
  first-person: *I* have been running this handler for T and *I* am giving up on
  it. The process making the claim holds the lock, so it cannot steal from
  itself, and it moves no row.
- **Forfeit is accounting, not recovery.** Nothing is reclaimed and nothing is
  retried. We record that a slot is gone for the life of the process, so the
  floor check can count what is left and Debug → Queue stops calling it running.

---

## Commit 1 — the deadline, derived from the hold class

### `jobs/core/hold.ts` gains `deadlineMs` beside `ceilingMs`

The class table's own comment promises the ceiling *becomes* the deadline. It
must not, and the same commit that wrote it also shipped the evidence:
**`ceilingMs` is a ceiling on WORK (`durationMs - waitMs`), while a deadline can
only ever be measured on wall-clock HOLD.** `queue-slot-blocked` exists precisely
because those differ — `jobs.dead-gc` was measured holding a slot for 77 seconds
to do 254 ms of work, all of it blocked on `background-tx-acquire`. Aborting on
hold at the work ceiling would kill conforming handlers for waiting on an
admission gate entered after dispatch.

So the class declares both, with the gap between them stated as what it is: how
much gate wait we are willing to believe before we stop believing the handler
will return.

| `hold` | `ceilingMs` (work) | slot-hog report | **`deadlineMs`** (hold) | zombie |
|---|---|---|---|---|
| `instant` | 10 s | 30 s | **60 s** | 90 s |
| `seconds` | 2 min | 5 min | **10 min** | 10 min 30 s |
| `minutes` | 30 min | 30 min | **60 min** | 60 min 30 s |

`ceilingMs` keeps its existing consumers untouched (`slow-ops`'s per-job
threshold, `queue-class-starved`'s per-class window).

### Warn-before-kill becomes structural, not coincidental

`queue-slot-hog` today reports at `ceilingMsFor(hold) × slotHogHoldFactor`
(config default 3 → 30 s / 6 min / 90 min). For `minutes` that lands *after* the
deadline: we would kill a job before ever warning about it, and an operator could
invert the order for the other two classes just by editing a config field.

Change the threshold to a **fraction of the deadline** —
`deadlineMsFor(hold) × slotHogDeadlineFraction`, default `0.5` — replacing
`slotHogHoldFactor`. Report-before-kill is then true by construction for every
class and every config value in range, and the knob stops meaning the awkward
thing it means today (a multiple of a *work* ceiling used as a *hold* threshold —
a tension `queue-health/CLAUDE.md` currently spends a paragraph apologising for).
The resulting thresholds are 30 s / 5 min / 30 min: identical for `instant`,
marginally earlier for `seconds`, and much earlier for `minutes`, where 30 min is
exactly its declared work ceiling — a better threshold than 90 min on its own
merits.

This edits code that landed yesterday, deliberately. The alternative considered
and rejected: keep `slotHogHoldFactor` and pick deadlines above today's
thresholds, which forces `minutes` to 2 h — long enough that three concurrent
wedges would take two hours to be recognised, when the incident this exists to
prevent lasted 70 minutes.

Files: `jobs/core/hold.ts` (+`deadlineMsFor`), `queue-health/core/config.ts`,
`queue-health/server/internal/watchdog.ts` (`checkSlotHogs`),
`queue-health/core/kinds.ts` payload doc, `queue-health/CLAUDE.md`.

### New: `jobs/server/internal/deadline.ts`

`armDeadline({ jobName, jobId, attempt, hold, runnerId, abort })` returns
`disarm()`. It owns both timers — the deadline, then the zombie grace — and calls
the signal sink and the forfeit registry. **No promise racing lives here.**

### `jobs/server/internal/worker.ts`

Arm it **inside** the `withJobLock` closure, wrapping the existing
`recordEntrySpan("job", …)` — inside, because the lock must be held for the
handler's real lifetime including its overrun:

```ts
async (): Promise<"completed" | "suspended"> => {
  const disarm = armDeadline({ ..., hold: job.hold, runnerId, abort });
  try {
    await recordEntrySpan("job", payload.jobName, () => job.run({ ... }));
    return "completed";
  } catch (err) { /* existing suspend / report / NonRetryable branches */ }
  finally { disarm(); }
}
```

Two additions to the existing catch:

- If `abort.signal.aborted` and `meta.attempt >= 2`, reuse the existing
  `markJobPermanentlyFailed(meta.jobId)` path so a deterministically-slow handler
  dead-letters after one retry rather than burning `maxAttempts × deadline` of
  slot time.
- If the handler **succeeds** after the abort, keep the success. It did the work;
  re-running it would be waste and, for a non-idempotent handler, harm. The
  overrun is still reported — that is the signal we need.

`handleJobTask` is currently one shared function across all three task lists, so
a dispatch cannot say which runner it is on. Make `startWorkers` build a
per-runner closure (`taskList[taskFor(hold)] = makeJobTaskHandler(spec.id)`) and
thread `runnerId` into `dispatch`. Forfeit accounting is per-runner, so this is
load-bearing, not cosmetic.

`ctx.signal`'s doc comment in `registry.ts` and the `AbortController` comment in
`dispatch` both lose their "nothing fires this yet" paragraphs.

**Nothing changes at any of the 63 `defineJob` call sites.** The hold class they
already declare is the deadline. That is the whole point of the one-declaration
rule, and it is why this commit is small.

### Reporting the cancellation — new sub-plugin `jobs/plugins/deadline-audit/`

A deadline that fires silently is worse than no deadline, so this ships in the
same commit.

`jobs` does not name the observability stack. That is a layering decision, not a
workaround for the cycle — see *Why not break the cycle* below. The repo already
has the primitive for it and an almost identical precedent for it:

- **The seam is `defineReportSink`**
  (`primitives/plugins/report-sink/core`), not a bespoke setter. A module-level
  soft-reporter slot whose `emit()` never throws — which matters, because these
  calls happen on the abort path. Twelve consumers already, two of them
  server-side. New `jobs/server/internal/deadline-seam.ts` declares
  `jobDeadlineSink = defineReportSink<JobDeadlineEvent, boolean>()`, with `phase:
  "exceeded" | "zombie" | "unforfeited"` discriminating the arms. `emit()`
  returning `undefined` means nobody is listening, and the caller falls back to
  the existing `reportServerError` — so the abort can never be silent, and the
  fallback is a branch rather than an assumption.
- **The consumer is a sub-plugin of `jobs`**, `jobs/plugins/deadline-audit/`,
  modelled on `infra/worktree/plugins/removal-audit/` — which declares the report
  kind, imports `@plugins/reports/server`, and registers a handler on its
  parent's sink in `onReady` (`registerRemovalChannel` /
  `worktreeRemovalSink.register(null)` on shutdown). The child importing the
  parent is not a cycle: the parent never imports the child.

  A sub-plugin rather than a `debug/` sibling because this is about jobs, and
  `removal-seam.ts` already states the general rule for exactly this shape: *"a
  CRUD primitive must not name the observability stack… the `removal-audit`
  sub-plugin registers a handler on this seam and owns the durable channel and
  the report kind."*

Three kinds, all `duressExempt: true` (Silencer 2 of the incident: a wedge and a
host duress episode are usually the same event, and shedding the report loses the
only evidence there was one — the argument `wedged-kind.ts` already makes):

Three kinds, all `duressExempt: true` (Silencer 2 of the incident: a wedge and a
host duress episode are usually the same event, and shedding the report loses the
only evidence there was one — the argument `wedged-kind.ts` already makes):

| kind | variant | fingerprint | filed |
|---|---|---|---|
| `job-deadline-exceeded` | `warning` | per `jobName` | at the deadline, from the dispatch path |
| `job-zombie` | `error` | per `jobName` | at deadline + 30 s, from the dispatch path |
| `job-slot-floor` | `error` | fixed per worktree | synchronously to disk, immediately before `exit(1)` |

Copy the shape of `queue-health/server/internal/wedged-kind.ts`, including its
rule that **no renderer restates a number from the class table** — every duration
comes from `HOLD_SPECS`. Each `renderTask` says in plain sentences which job, how
far over, what is now unavailable, and where to look next. `job-deadline-exceeded`
is the escalation of `queue-slot-hog` for the same jobName, and should say so.

### Why not break the cycle instead

Worth stating, because "use a seam" reads like a workaround for a build rule.

**It is breakable, and it would be worse.** `reports` reaches `jobs` by two
independent routes today: `record-report.ts:15` → `shell/notifications/server` →
`ttl-cleanup.ts:4` → `jobs`, and `reports/server/internal/retention.ts:2` →
`infra/retention/server` → `jobs`. (`report-kinds.ts:3` adds a third,
type-only — and type-only imports count as edges.) Each could be extracted into
a sub-plugin the way `removal-audit` was, and the graph would go acyclic.

But the cycle is a *symptom*, not the reason. `reports` depends on `jobs` because
reports is a **user** of durable background work — retention sweeps, notification
TTL cleanup, investigation-task filing. A primitive cannot import its own user.
Sever the two routes and the next thing reports needs from jobs recreates the
cycle; what you would actually be maintaining is a standing rule that "reports
must never use a background job", which is a far worse constraint than a sink.

And the direction of knowledge would be wrong regardless of the graph. `jobs` is
load-bearing infrastructure; `reports` owns interpretation — kinds, fingerprints,
duress shedding, the bell, task filing. `queue-health/CLAUDE.md` already states
this as the reason for its own placement ("it keeps queue interpretation out of
the load-bearing mechanism-only `jobs` plugin"), and `removal-seam.ts` states it
as a general rule. There is also a concrete cost: every composition containing
`jobs` would then have to contain `reports`, `shell/notifications` and `tasks` —
the opposite of what the composition/closure work exists to allow.

**`jobs` has already faced exactly this and answered it the same way.** It needs
`registerTrigger` from `events` for `ctx.waitFor`, and `events` already imports
`jobs` — the identical shape, one layer over. The answer was
`UNSAFE_installDurableHooks` (`step-ctx.ts:110`), installed by
`events/server/internal/install-jobs-hooks.ts`. A second seam here is consistency,
not a new concession.

Worth knowing before anyone reaches for a shortcut: **there is no cycle
exemption.** `boundary-config.ts`'s `exclude` skips whole files and is reserved
for composition roots; `runtimeExceptions` bypasses only the runtime-isolation
layer, and such an edge still enters `detectCycle`. The only way not to trip it is
not to create the edge.

So the seam is the design. The thing worth fixing was that the earlier draft
hand-rolled one; `defineReportSink` is the factored-out version, and this plan
uses it.

---

## Commit 2 — forfeit, the floor, the crash, the latch

### New: `jobs/server/internal/forfeit.ts`

- A module-level `Map<jobId, { jobName, hold, runnerId, since }>` plus
  `getForfeitedSlots()`. `disarm()` removes the entry, so a zombie that eventually
  wakes up un-forfeits itself.
- `usableSlots(runnerId) = spec.concurrency - forfeited on that runner`.
- **The crash condition is `usableSlots("wide") < 2`.** Under the ladder this is
  the sharp statement of the design's "the lane can no longer do its job":
  `wide` is the only runner serving `minutes`, so DB forks, conversation spawns,
  builds and backups have nowhere else to go. Numerically it is the original
  design's "3 of 4", now derived rather than asserted. The original "floor is 2,
  not 1, because one slot lets a long job block every monitor" no longer needs
  stating separately — monitors are `instant` and the `floor` runner already
  reserves two slots they alone can reach.
- A narrower runner losing all its slots is a **report, not a crash**: `instant`
  work still reaches `mid` and `wide`, so the pool is degraded, not dead.
- The anti-loop latch: three floor-crashes within an hour suppresses the fourth
  (report + stay up — an automatic restart that fixes nothing is worse than an
  honest wedge). It must survive the crash, so it is a small JSON file behind a
  new `jobs/data-dirs/index.ts` `defineDataDir({ kind: "state", … })`, one file
  per worktree, modelled on `reports/data-dirs`. **Its comment must say
  explicitly that it governs our own restart policy and makes no claim about
  whether any worker is alive** — a reviewer will otherwise pattern-match it onto
  the banned lease.
- Record in that comment: the gateway does **not** auto-respawn an exited backend
  (`gateway/worktree.go` `onBackendExit` sets `StateIdle`); the next proxied
  request lazily starts a fresh one. The crash loop is therefore slower than the
  design assumed, and an exit is still strictly better than holding on with the
  `wide` runner dead — the locks drop, the sweeper reclaims, the work re-runs.

### The synchronous fatal report

`recordReport` is async (Postgres) and cannot run on the way out. Mirror the
existing `setErrorReporter` hook in
`framework/plugins/server-core/core/error-reporter.ts` with a
`setFatalReporter` / `reportServerFatalSync({ kind, message, data })` pair, and
implement it in `reports` over the existing `appendReportSync` buffer, which is
already replayed on the next boot. That means generalising `buffer.ts`'s line
shape to carry an optional `kind` + `data` (defaulting to today's `crash`) and
`flushBufferedReports` to pass them through. No new persistence, no new flush
path. Verify once that contributions register before `reports`' `onReady` flush,
so the `job-slot-floor` kind resolves.

### Introspection

`RunningJobStat` gains `forfeited: boolean`, joined in `queryRunningJobs()` from
the in-process map (it is process state, not a DB column). `JobRowSchema` in
`jobs/core/resources.ts` gains it as **optional**, so a payload from an older
backend still parses. Debug → Queue renders a `forfeited` badge beside the
existing `no worker` one.

One consequence worth stating for the reviewer: a forfeited zombie keeps its
`job-lock` pg connection and its slot in `runnerPool` for the life of the
process. Both pools are sized from `TOTAL_JOB_SLOTS`, so this is correct and
needs no change — one connection per slot, forfeited slots included.

`queue-health`'s `checkWedge` needs no change either: a forfeited row is still
locked and still `alive`, so a fully-forfeited pool still trips `queue-wedged`.
The two signals are complements — `job-zombie` names the handler from the inside
at the moment we gave up; `queue-wedged` says the queue as a whole stopped.

---

## Commit 3 — make the abort actually reach the wait

The abort is the worker's only lever; whether a handler stops depends entirely on
whether what it is blocked on accepts a signal. `spawnCaptured` /
`spawnExpectOk` already do. `fetch` does natively.

**The host-pool acquire does not, and that is the gap that matters.** Until it
does, a forfeited `worktree-cleanup.reap-stale` keeps its *host-wide*
`worktree-mutate` flock and every backend on the box stays exposed; forfeit stays
accounting rather than containment. This is the same pathology `queue-slot-blocked`
was shipped to report — a slot held to wait on an admission gate entered after
dispatch — now on the enforcement side.

- `packages/plugins/host-semaphore/server/internal/host-semaphore.ts`:
  `AcquireHooks` gains `signal?: AbortSignal`, with two effects — abort a
  *pending* acquire, and release the share on abort even while `fn` is still
  pending. `HostShare.release()` is already explicitly idempotent (`let released`),
  which is what makes the second effect safe.
- `infra/plugins/host-admission/server/internal/pool.ts`: thread it through
  `HostPool.run` / `acquireShare`, and the `GrantHooks` mirror in
  `core/internal/grant.ts`.
- `infra/plugins/host-read-pool/server/internal/pool.ts`:
  `withHeavyReadSlot(fn, signal?)`, threaded into both tiers (the local
  `createSemaphore` gate and the host pool).
- `infra/plugins/worktree/server/internal/mutate-gate.ts`:
  `withWorktreeMutateSlot(fn, signal?)`, with `worktree.ts`'s two call sites
  (`setupWorktree`, `removeWorktreeUnlogged`) taking and forwarding it.
- Thread `ctx.signal` from the handlers that reach these: `worktree-cleanup.reap-stale`,
  `conversations.spawn`, `database.fork`, and the `spawnCaptured` calls inside them.

`createSemaphore`'s optional signal is deliberately **not** done: the design ranks
it low, its consumers are request-scoped leases, and the motivating case
(`renderGate`) was deleted in Phase 1.

---

## Commit 4 — a bound on `spawnCaptured` becomes mandatory

The "hard to write" half, landed last and alone so it stays reviewable.

`SpawnOptions` becomes a union, so omitting a bound has no spelling:

```ts
export type SpawnOptions = SpawnBaseOptions &
  ( { timeoutMs: number; signal?: AbortSignal }
  | { signal: AbortSignal; timeoutMs?: number }
  | { unbounded: string } );   // prose justification; greppable
```

`SpawnBound` already exists as its own interface precisely so this is a change to
one type rather than to every option list — its own comment says so. Scope: ~100
`spawnCaptured` / `spawnExpectOk` call sites across 51 files, roughly 80 of which
declare no bound today. The third arm is for the CLI, where a 10-minute
`./equin build` owns no deadline of its own.

Then drain `spawn/lint/index.ts`'s `no-raw-bun-spawn` ignore list: the 20-entry
**TEMPORARY** block is the Stage-2 backlog of mechanical `spawnCaptured`
conversions and is done when it is empty (one stale entry,
`tasks/…/push-watcher.ts`, names a file that no longer exists). The 10-entry
**PERMANENT** block stays — genuinely streaming or long-lived children where
after-exit temp-file capture is structurally impossible. Note in the commit that
**the gate has flipped**: `spawn/CLAUDE.md` sets the criterion as "the absence of
an observed field wedge", and one has now been observed twice.

---

## Docs

- `jobs/CLAUDE.md` — the `## Hold class` section's forward reference ("the same
  class ceiling becomes the deadline") becomes the real thing, and must say why
  it is a *sibling* number rather than the same one. Add what forfeit is and is
  not, and the no-race property.
- `queue-health/CLAUDE.md` — the hold-vs-work paragraph under `queue-slot-hog`
  gets shorter: the threshold is now a fraction of the deadline, and
  warn-before-kill is structural.
- `spawn/CLAUDE.md` — Stage 2 becomes done.
- New `plugins/infra/plugins/jobs/plugins/deadline-audit/CLAUDE.md`.

---

## Verification

`./equin build` after every commit — registries and plugin docs regenerate,
and `plugins-doc-in-sync` fails otherwise.

New `POST /api/events-test/job-deadline`, beside the four existing harnesses that
already assert both halves of the liveness contract, with three arms:

1. **Honours the signal.** An `instant` job awaiting an abortable sleep: fails
   cleanly, slot freed, exactly one `job-deadline-exceeded` report, retried once,
   then dead-lettered.
2. **Ignores the signal — the assertion that matters most.** An `instant` job
   awaiting a bare `new Promise(() => {})`: after deadline + 30 s it appears in
   `queryRunningJobs()` as `forfeited: true`, its row still has
   `locked_at IS NOT NULL` with `alive: true`, and a forced
   `UNSAFE_sweepStuckLocks()` does **not** reclaim it. This is the no-steal half.
3. **Succeeds after the abort.** The run is recorded as completed and the overrun
   is still reported.

Arms 1 and 2 use `instant` so the harness runs in ~90 s rather than an hour.

By hand, once:

- **Ordering.** `slotHogDeadlineFraction` is range-constrained to `(0, 1)` by its
  field definition, which is what makes warn-before-kill hold for every class at
  every settable value. Cover it with a unit test on the class table rather than
  leaving it to the field's `min`/`max` alone.
- **Floor + latch.** Force three concurrent zombies on the `wide` runner (arm 2,
  three `minutes` job names): the backend exits, `job-slot-floor` appears in
  Debug → Reports after the next boot, and a fourth crash within the hour is
  suppressed instead.
- **Duress.** Set the duress latch and re-run arm 1; the report must still land.
- **Host-pool cancellation.** `worktree-cleanup.reap-stale` against a held
  `worktree-mutate` slot releases the flock on abort — confirm via the pool's
  `depth()` that the host share is returned while the handler is still unwinding.

## Risks to watch after deploy

1. **A deadline that is too tight for a legitimately slow job** turns working work
   into a dead-letter. `minutes` at 60 min is the one to watch — `backup.run`,
   `database.fork`, `conversations.spawn`. `job-deadline-exceeded` and
   `queue-dead-job` are the signals; the fix is to re-examine the job, not to add
   a per-job override.
2. **There is deliberately no `unbounded` opt-out**, because there is deliberately
   no second field. The original design expected zero jobs to need one. If a real
   job turns out to need more than an hour of unbroken slot-hold, that is a
   finding about the job (it probably wants `ctx.waitFor`, or to re-enqueue in
   pages the way `mail.backfill` already does), not a gap in the type.
3. **`workflows.run` runs arbitrary step-executor code**, so its class is the
   least derivable of the 63. Most of its long-running-ness is spent suspended
   and therefore off-slot, but it is the job most likely to need revisiting.
4. **The deadline timers ride the same event loop as the handler.** A genuine spin
   loop starves them and nothing fires. Both observed wedges were promises
   awaiting something that never resolves, so the loop was live; a CPU-bound wedge
   remains the sentinel worker thread's territory, deliberately not built here.
5. **The crash's respawn is lazy**, not automatic. A worktree nobody is looking at
   stays down until the next request. Acceptable — its `wide` runner was dead —
   but the floor crash is not a self-healing restart, and the plan should not be
   read as if it were.
