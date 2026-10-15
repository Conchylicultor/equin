# supervised-job

A build, a release, a deploy, a backup — work that runs for half an hour in a
process of its own — is an ordinary entry in the queue. `defineSupervisedJob` is
the whole of it: `defineJob` + a supervised-run kind + `ctx.waitFor`, composed
once so no consumer composes them again. **It is the one way to start a detached
child**; the supervisor underneath has no public spelling.

## The declaration

```ts
defineSupervisedJob({
  name, input, channel,
  // WHAT runs — exactly one of:
  argv:  (input, runId) => ({ argv, cwd?, envOverrides? }),  // one child, a command line
  run:   async (input, { runId, log, exec }) => { … },       // one child, in-process code
  steps: async (input, { runId, step, ctx }) => { … },       // several children, sequenced
  // WHERE runs are recorded:
  ledger?: { kindId, claim, listUnfinished, setPid, closeRow, beginStep?, onReattach? },
  lock?:   (input) => string,     // built-in ledger only
  schedule?, runAttempts?, onEnded?,   // runAttempts / onEnded: single-child only
  hold?: "instant" | "seconds",   // steps only
});
```

One `register: [job]` token mounts the queue job, the run kind and, for `run`,
the child task. The type forbids two or zero bodies, `lock` with `ledger`,
`steps` without `ledger`, `runAttempts` / `onEnded` with `steps`, and `hold`
anywhere but `steps` (never `minutes`) — `define-supervised-job.test.ts` holds
the `@ts-expect-error` for each.

### Bodies

- **`argv`** — the child is that command line (build, release).
- **`run`** — the child is `./singularity supervised-exec <job name>
  <{runId, attempt, input}>`, booted in `exec` mode, calling the function. The
  input is re-parsed against the job's schema in the child. `log(line, stream?)`
  writes stdout/stderr, which is the transcript the parent tails into `channel`
  — one process writes each log file. `exec` is an `ExecContext` (`core/`):
  proof the body runs off every backend's event loop, which a function doing
  long or heavy work demands (`infra/deps`' `ensureDep`). Only this run body
  and a CLI command (`cliExecContext`, exported from the `cli` barrel so no
  `server/` file can reach it) mint one. Both fill `exec.admit` — one
  background unit of `withHostGrant` — so host-only code below `server/` (the
  `infra/deps` engine) is admitted to the host without importing a `server`
  barrel. With the built-in ledger a throw records
  `error_message` and `retryable = !isNonRetryableError(err)` on the row, then
  exits 1; with an own ledger it just rethrows (the body writes its own row).
- **`steps`** — a durable workflow in the backend (deploy). `step(name, { argv, cwd?,
  envOverrides? })`, inside a memoized `ctx.step`, asks `ledger.beginStep?(runId,
  name)` (false ⇒ `{ state: "run-closed" }`, nothing spawned), spawns child
  `${runId}.${name}`, then waits with the observe-then-wait loop and returns `{
  state: "ended", runId, terminal }`. A spawn that failed before any child
  existed is memoized as a VALUE and answered `{ state: "not-started", runId,
  message }`, so the body records its own verdict in its own words (a thrown
  step would replay its error forever). **Once the body is done** — returned or
  thrown, never on a suspend — `runStepsBody` closes each such child's row with
  the hard-kill sentinel through `closeRow` (first-writer-wins, so a no-op after a
  body that stamped its run). That last-resort close is what makes "a child that
  never started cannot hold the lock" structural rather than each body's duty.
  A spawn that failed with a child possibly running throws and suppresses every
  close in that dispatch. The wrapper passes suspend signals through untouched
  and calls `abortDurableRun` when the body returns or throws a
  `NonRetryableError`. `claim` runs once, in a `claim` step; a `null` ends the workflow
  without running the body.
  - **Durable names: the memo is `spawn:<name>`, the waits `<name>:<i>`.** They
    are the names deploy's hand-written sequence recorded before it moved onto
    `steps`, kept byte-for-byte so a deploy suspended across that release
    re-attaches instead of spawning a leg twice (`steps.test.ts` asserts the
    literals). That sequence memoized `{ state: "spawned" }` with no pid, so a
    replay of that shape recovers the pid from `listUnfinished` (absent ⇒ the
    child's row was closed ⇒ `null`: marker, else the hard kill the reconciler
    already recorded). A body's own `ctx.step` / `ctx.waitFor` names must avoid
    both shapes.
  - **No `{ run }` step.** A child finds its body by id in a registry filled at
    module eval; a closure written inside a running `steps` body has no id. Work
    that needs one is its own `run`-body job the sequence waits on.

### Ledgers

- **Own ledger** (build, release, backup, deploy): the kind verbs plus `claim`,
  with an explicit `kindId`. A failed run is data in that table and UI; a
  non-zero exit is not an exception (see below). `claim` may adopt a row the
  caller already inserted, answering `null` when it is closed.
- **Built-in ledger** `supervised_job_runs` (omit `ledger`): for jobs with no
  domain of their own.
  - `UNIQUE (job_name, lock_key) WHERE finished_at IS NULL` is the lock; `claim`
    is an INSERT against it (a 23505 on that index answers `null`). No `lock` ⇒
    one job-wide key, so at most one run of the job at a time.
  - `closeRow` is the only writer of the outcome. Excluded from forks, so no
    namespace column; kept 30 days after `finished_at` (`defineRetention`, per
    worktree).
  - Kind id derived from the name (`database.fork` → `databasefork`), asserted
    `^[a-z][a-z0-9]*$`; a collision throws at register.
  - **The dead-letter is its failure surface**, applied after any `onEnded`:
    exit 0 → done; failed but cancelled (`cancelled_at` stamped by
    `cancelSupervisedJobByLock`) → done, no retry and no alert; failed and (not
    retryable, or the last attempt) → throw
    `NonRetryableError` naming the job, run, exit and the recorded error (or
    "killed or crashed before recording an error — see the transcript"); failed
    otherwise → retry. A hard kill or a reboot's TERM records no flag, so it stays
    retryable. Deterministic on replay: it re-runs for earlier attempts with the
    same row and attempt number, so it answers the same.

### The retry ladder (`runAttempts`)

Each attempt is a new run. Between two attempts the loop sleeps durably
(`e^attempt` s: ~3, 7, 20, 55, capped at 60 — no slot held), then calls
`closeRow` on the previous attempt's run (idempotent) before the next claim —
after a restart the next claim could otherwise lose to the previous attempt's
still-open row, and that memoized loss ended the ladder silently. A claim lost on
attempt ≥ 2 now throws.

## Long work, short runs

The handler is short at both ends and empty in the middle:

```
1. claim()               lost the race? return, there is nothing to do
2. startSupervisedRun()  spawn detached, record the pid
3. observe               marker on disk already? then skip to 5
4. ctx.waitFor(runEnded) SUSPEND — the run returns, the worker slot is freed
5. on wake: re-read the marker. still running → wait again. ended → onEnded()
   (the row itself was already closed by the reconciler's `finish`)
6. non-zero exit and runAttempts > 1 → step 1 again, as a NEW run
```

`ctx.waitFor` RETURNS from the handler through the jobs plugin's suspend
sentinel: the graphile row is deleted, the slot is released, and the workflow
comes back later as a fresh dispatch. So a workflow may span an hour while every
one of its runs is milliseconds — which is why a single-child job's `hold` is
**`instant`** and a consumer cannot set it (a `steps` body may say `seconds`, for
a timed read between steps). The hold table's reviewer heuristic is literally "does it
spawn? → `minutes`", and `minutes` is one of only four slots that can serve long
work; spending one for the length of a build is exactly the wedge those
reservations exist to prevent. A consumer whose `onEnded` really does exceed the
class ceiling gets a slot-hog report naming the real defect, which is the honest
outcome.

## The marker is the authority; the event is only a wake-up

`supervisedRun.ended` carries **only `(kindId, runId)`** — no exit code, no
signal, nothing to trust. That is not minimalism; it is the one rule this plugin
exists to enforce, made unspellable rather than documented:

- The event can be **lost**. If the backend dies between the shim writing the
  exit marker and the emit landing, nothing ever fires. And for a kind whose own
  CLI stamps its ledger row early (`./singularity build` does, ~100 s before its
  child exits) the `supervised-run` reconciler will not re-announce it either,
  because the row left `listUnfinished` long ago.
- The event can arrive **late, twice, or for a row already closed**. `finish` is
  called once per run per PROCESS, and a restart makes a second process.

So every wake re-reads the marker file and decides from scratch (`observeRun`,
exported from `core/`): present ⇒ ended; absent with a live process group ⇒ keep
waiting; absent with an empty group ⇒ hard kill, `exitCode: -1`, `signalCode: null`. **Never re-derive killed-ness from
`exitCode > 128`** — `kill -TERM` and a program calling `exit(143)` are the same
number, and guessing between them is what once recorded a deploy that never
exited as "Exited with code 143".

The wait is **bounded** (5 minutes) and loops, rather than `unbounded: true`.
That is the same argument `RECONCILE_MS` makes inside `supervised-run`: a bounded
re-look exists only while a run is live and covers exactly the edge nothing can
report. A lost event costs one interval, never the run.

**Observe before waiting, not after.** `startSupervisedRun` settles a run whose
marker is already on disk when the spawn returns, so the emit can fire while the
handler is still inside its spawn step, with no trigger armed to receive it. A
wait-first loop hangs until its timeout on a run that was over before it started.

### `awaitSupervisedRun` is internal, and stays that way

The observe-then-wait half is its own function, `awaitSupervisedRun(ctx, { kind,
runId, pid, name })`, which both `superviseRuns` and the `steps` runner call — so
the loop above is a thin ladder over it and the two cannot drift. It is **not
exported**: a workflow owning several sequential children is a `steps` body, not
a hand-written loop over the supervisor.

Its precondition, which is why it stays internal: **`pid` must be the pid of a
child YOU started for this run.** With no marker, a pid that is not alive IS the
hard-kill outcome — the close rule, correct for a row with no process behind it —
so `pid: null` returns the `-1` sentinel immediately. Right for a run you started,
wrong for a run whose id you merely know (deploy's wait on a RELEASE goes through
`release`'s own `awaitRelease` for exactly that reason). It takes the kind HANDLE
rather than an id and asserts registration on the way in, because a wait on a kind
nobody registered is a wait nothing will ever wake.

## `dedup`: `"none"`, or `"singleton"` with a `schedule`

Overlap is prevented by the **claim**: every ledger has a partial unique index
`WHERE finished_at IS NULL`, and the claiming INSERT wins or loses. `dedup` is not
a policy about overlap.

- **No `schedule` ⇒ `dedup: "none"`.** A pending singleton row takes the LATEST
  payload, so two different builds or releases enqueued back to back would merge
  into one. Every enqueue is its own row.
- **`schedule` ⇒ `dedup: "singleton"` plus the cron**, as `defineJob`'s union
  requires (graphile's cron path uses the singleton job key; a non-singleton
  would insert a row every tick). The cron payload is `input.parse({})`.

Either way the run's identity is its **queue row** — `ctx.workflowRunId` is
`${name}:job:${jobId}` (the jobs plugin's "Run identity"). So a failed run's
cached steps and resolved waits can never be replayed by a later run, which is
what once forced supervised jobs to `"none"` and a scheduled one to be split into
a separate tick job. That split is gone: `backup.run.supervised` carries its own
schedule. A tick that fires while a run is in flight claims nothing and returns.

The handler still cleans up after itself: on the way out (a recorded outcome, or a
dead-lettering failure) it calls `abortDurableRun(ctx.workflowRunId)`, releasing a
wait some iteration armed and then skipped (the marker appeared on a replay
before that wait was consulted). Without it, a stale resume re-dispatches the
handler minutes after the run is already recorded.

## `finish` closes the row; `onEnded` does the work

The split is by **what** each arm does, not by which one runs:

- **`finish`** (in the reconciler, in every backend) — close the ledger row if it
  is still open, then emit `runEnded`. A bare terminal write and an
  announcement; nothing else. The consumer supplies the write as
  `ledger.closeRow`.
- **`onEnded`** (in the job handler) — the terminal WORK: the notification, the
  convergence reconcile, any data beyond the outcome. Exactly-once, because only
  this arm has side effects.

**The close is a backstop and must not be the workflow's alone.** An earlier
draft had `finish` only announce, so the handler was the only thing that could
stamp a row. A workflow that dies — dead-lettered, or killed in the millisecond
between spawning its child and recording that it did — then left the row open
forever, and the kind's partial unique in-flight index refused every future run
of that kind, permanently, with no symptom at the call site. Closing in `finish`
costs a dead workflow its notification instead of costing the kind its future.

Closing happens **before** the announcement, so a failing emit still leaves a
closed row. Two consequences for a consumer:

- `closeRow` must be a bare, idempotent, first-writer-wins write
  (`WHERE finished_at IS NULL`). No notification, no enqueue, no reconcile: it
  runs in backends that know nothing about the workflow.
- By the time `onEnded` runs, the row is **already closed** in the ordinary case.
  Do not gate anything there on the row still being open, and read the row back
  rather than assuming who stamped it.

`onEnded` must also be **idempotent, because it is deliberately not memoized in a
step.** A step that throws is cached as a permanent failure and replays its error
forever — which would make the work most worth retrying the one piece that never
gets a second chance.

### The claim→spawn window closes itself

`claim` mints the row seeded with `process.pid` — this backend's own, alive — so
between the claim and a live child there is a window where the row exists and
nothing will ever finish it. A spawn that throws in that window (no
`./singularity` on PATH, `EAGAIN`, a DB write refusing) leaves a row the
reconciler reads as _running_ forever: no child exists to write a marker, and the
seeded pid does not die until the backend does. **That row is the kind's lock**,
so the kind then refuses every future run with no symptom at the call site.

So `spawnClaimedRun` closes the row with the hard-kill sentinel and rethrows the
original error — the job still fails loudly, the lock is released. It is here
rather than in each consumer's catch because it is the same three lines for
build, release and deploy; release carried them by hand as `failUnstartedRelease`.

**After the spawn, that same close is a worse bug than the wedge it repairs.** A
failure in the bookkeeping that follows `Bun.spawn` — the `setPid` write, the
watcher — leaves a child genuinely running, which will write its transcript and
its exit marker and be settled by the reconciler in the ordinary way. Stamping
`finished_at` there releases the in-flight lock **under a live child**, so the
next enqueue claims cleanly and spawns a second one: two `./singularity build`
runs against one checkout, two converges against one remote. That is exactly the
overlap the index exists to prevent, so doing nothing on that side is not a gap —
it is the correct action.

Which side a failure happened on is never inferred. `startSupervisedRun` reports
it as `SupervisedSpawnError.childStarted`, derived from whether the pid was
actually assigned rather than from a list of which call sites throw where, and
the guard compensates **only on positive proof that no child exists**. An
unrecognised error counts as "a child may be running": a wedged kind is loud and
a restart clears it, a duplicated build is neither.

## A non-zero exit code is DATA, not an exception (own ledger)

The handler claims, spawns, waits and records. A build that exits 1 means it did
all four: **that is a success of the job and a failure of the build**, and only
the second is news. So the handler records the outcome and returns normally.

Throwing would file a crash report and a dead-letter for every failed build —
which is not what a failed build is today — and would dangle graphile's row retry
as a way to "re-run" out-of-process work, which it cannot do: a retry replays the
memoized spawn step and re-derives the same outcome. The only retry that means
anything here is a **fresh child**, which is `runAttempts`.

The **built-in ledger** is the exception to this section: it has no UI, so its
failure policy throws `NonRetryableError` and the dead-letter is the surface (see
"Ledgers" above).

What DOES throw is the wrapper's own failure: `onEnded` throwing, a failing claim
or spawn, a DB write that will not land. Those earn the retry budget and the
report. The failed RUN surfaces where it already does — the ledger row, the runs
UI, and the kind's own notification.

## Cancellation is ONE action here

`cancelSupervisedJob(job, runId)` signals the process group and stops.

The usual advice for a workflow blocked on `ctx.waitFor` — kill the work AND
`abortDurableRun` — **inverts for a supervised job, and following it loses
data.** The kill reaches the shim's TERM trap, which writes a `143 TERM` marker;
that marker is what the suspended handler wakes on, and waking is what runs
`onEnded`. The wait is not a leak to plug, it is how the cancellation gets
recorded. Abort it and the handler never returns: no stamp, no terminal work, and
the kind's in-flight index then refuses every future run of that kind.

Every cancellation path closes itself. A SIGTERM leaves a marker and wakes
immediately; a hard SIGKILL leaves none, and the next bounded wake sees an empty group
and records the hard-kill outcome.

### A user's Cancel: `cancelSupervisedJobByLock(job, input)`

A bare `143 TERM` cannot say WHO sent it: a user's Cancel and a reboot read the
same. On the built-in ledger that means a Cancel retries, then dead-letters and
files an alert. So a user-facing Cancel goes through
`cancelSupervisedJobByLock(job, input)` instead, which:

1. finds the open run of `job` holding `lock(input)` (the caller names the run
   the way the claim did — no run id to keep), answering `{ kind: "not-running" }`
   when there is none;
2. stamps its `cancelled_at` **first**, then
3. signals it through the same kill path (`{ kind: "cancelled", runId, outcome }`).

Because the stamp lands before the signal, the wake reads it: `onEnded` gets
`meta.cancelled: true` and the failure policy answers `done` (no retry, no
dead-letter). A run that exited 0 before the signal reached it is a success,
`cancelled: false`. Any TERM without the stamp — a reboot, `cancelSupervisedJob`
— stays a retryable failure. The ladder stops on the verdict, not the exit code
(`onEnded` in `superviseRuns` answers `done | retry`).

Built-in-ledger jobs that declare `lock` only; any other job throws (an own
ledger cancels by id and records the cancellation in its own row). A run whose
child is still being spawned (its row still holds the claiming backend's seed
pid) is stamped but not signalled — `outcome.reason: "not-spawned"`: the child
runs on, and closes as cancelled only if it fails.

## Residuals

- **A dead workflow costs its run the side effects, not the ledger.** If the
  workflow is permanently failed — or the backend dies in the millisecond between
  the child being spawned and the spawn step committing, so a replay's `claim`
  loses to its own predecessor's row — the reconciler still closes the row
  through `closeRow`, so the kind is not wedged, but nothing runs `onEnded`: no
  notification, no convergence reconcile. The dead-letter is itself loud, so the
  loss is visible. `claim` is handed the `workflowRunId` so a consumer that wants
  to attribute such a row to its (gone) owner can record it; nothing here reads
  it back.
- **A recycled pid reads as alive.** After a reboot, a run whose pid was reused
  by an unrelated process never satisfies "dead pid, no marker", so its workflow
  waits one interval forever. `supervised-run`'s reconciler has the same
  property; the fix, if it ever matters, belongs there.
- **The close rule is written once** — `observeRun` in `core/`, called by both
  `awaitSupervisedRun` and the reconciler's `settleRun`, so the two cannot
  disagree about whether a run ended.

## The supervisor: detach, transcript, exit marker, reconciler

_Folded in from the former `supervised-run` plugin; now `server/internal/run/` and `core/`._

Work that outlives the backend that started it: a build, a release, a deploy.
One primitive owns detach + pid + transcript + reconcile + re-attach.

### The file IS the stream

**The child's stdout and stderr go to a file descriptor, not a pipe**, and the
supervisor publishes by _tailing that file_. Do not add a pipe-shaped "live"
path beside it. A pipe belongs to the process that created it, so a live pipe
forces a second artifact-shaped recovery path — and the recovery path is the one
that rots, because nothing exercises it until something has already gone wrong.
Release proved it: `resolveOrphanExitCode` read an artifact only the _parent_
wrote, so a genuinely orphaned release always got the `-1` sentinel. One path
means a restart is not a special case — the boot tailer is the same code as the
spawn-time tailer.

Change detection is `file-watcher` (the repo bans polling). ONE subscription
serves every live run of every kind, which is why `runs/` is its own directory
rather than files beside the build artifacts.

**The subscription needs `writesWhileOpen: true`.** The child holds its
transcript descriptor open for the whole run, and macOS FSEvents reports a
file's content change only when the writer closes it — so on the default backend
the tail was pumped once, at exit, and every line landed at the end with one
timestamp. The option switches to kqueue on darwin (one event per write), at one
descriptor per entry in `runs/` — bounded by the artifact prune, and held only
while a run is live.

**stdout and stderr merge** (same fd). Interleaving order survives, the
per-line classification does not — two files with two tailers would invert that
trade, which is worse for a transcript read top to bottom. Cost: log viewers
that tint `stream === "stderr"` red render a supervised run in one colour.
Nothing counts, filters or badges on it.

For a consumer reading the transcript back (deploy's `verbFailureMessage`): a
scan keyed on line CONTENT survives the merge unchanged — feed it the transcript
lines instead of a stderr-only array. Only a "last non-blank **stderr** line"
fallback degrades, to "last non-blank line".

### The exit code is captured by the SPAWN

Every argv is wrapped in a POSIX shim, so this works for any command and
"forgot to record the exit code" is unspellable:

```sh
trap 'g=TERM; i=1' TERM; trap 'g=INT; i=1' INT; trap 'g=HUP; i=1' HUP
"$@" & c=$!
wait "$c"; s=$?
while [ "$i" = 1 ] && kill -0 "$c" 2>/dev/null; do i=0; wait "$c"; s=$?; done
[ -n "$g" ] || g=-
printf '%s %s\n' "$s" "$g" > "$T.tmp.$$" && mv "$T.tmp.$$" "$T"; exit "$s"
```

Marker body: `<status> <signal-or-dash>`, e.g. `0 -`, `143 TERM`. Signal names
are bare POSIX (no `SIG`). A marker that exists but does not parse **throws**
(`RunMarkerError`) — it is a writer defect, and answering `null` would file it
under "hard-killed" behind a plausible `-1`.

Four clauses look redundant and are not:

- **Background child + `wait`, not a foreground `"$@"`.** SIGTERM's default
  disposition kills the shell outright, so a group signal would leave no marker
  and a _cancelled_ run would be indistinguishable from a hard kill.
- **Traps BEFORE the `&`.** Between them the shell still has the default
  disposition, and a signal landing there loses the marker. Safe because a
  handler-trap is reset to default in the child (only `trap ''` is inherited).
- **One trap per signal recording its NAME**, not a shared `trap :`. The null
  command is enough to make `wait` return but throws away the one fact only the
  shell has — see below.
- **The `wait` retry.** A trapped signal makes `wait` return `128+signo`
  **immediately — the child has not necessarily exited**. Without the retry the
  shim recorded `143 TERM` and exited while a child that handles TERM (what
  `./singularity build` does via `installFatalSignalExit`) was still shutting
  down: reparented, unwatched, real exit code lost. With it, `42 TERM`. The
  `kill -0` guard is required, not defensive — a second `wait` on an
  already-reaped pid returns 127 and prints `wait: pid N is not a child of this
shell` into the transcript. `kill -0` succeeds on a zombie and fails once our
  own `wait` reaped it, and a pid cannot be recycled before it is reaped.

⚠️ **SIGINT does not cancel a run.** POSIX makes a non-interactive shell set
SIGINT to ignore for an asynchronous list's commands, and ignore is inherited
across `exec` — measured, the child ran to completion and exited 0. The shim
traps INT so it does not die and orphan the child, and records
`exitCode: 0, signalCode: "INT"`, which is what actually happened.
`killSupervisedRun` uses SIGTERM; don't reach for INT.

#### `signalCode` is observed, never derived

**`128 + signo` cannot tell a kill from a program that chose `exit(143)`** —
they are the same number. That ambiguity is what recorded
`drun-1787890652933-wr3v6d` as `Exited with code 143`, a sentence about a
command that never exited and never refused. So `RunTerminal.signalCode` comes
from the trap having _fired_, and **nothing may re-derive killed-ness from
`exitCode > 128`** — not here, not in a consumer.

In particular the shim deliberately does **not** fall back to
`kill -l $((s-128))` when the trap did not fire. That looks like a free second
source and is the original guess one layer down: it turns a genuine `exit 143`
into `signalCode: "TERM"`. The test pair `a kill and a deliberate exit(143) are
told apart` fails the moment anyone adds it.

The honest cost: a child signalled _individually_, leaving `sh` untouched,
records `null`. Nothing here does that — every kill goes to the process group —
so `null` reads as "not observed as killed", never "exited normally".

**The finish instant is the marker's mtime**, never `new Date()` at reconcile.
Reusing `now` inflates a recovered run's Duration by the whole gap before
something noticed (release does this and is wrong for it).

**No marker ⇒ hard SIGKILL ⇒ the `-1` sentinel, with `signalCode: null`.**
SIGKILL runs no handler, so absence is the only evidence it can leave and there
is no signal name anyone observed; `-1` is a status no child can produce, so the
case stays legible without claiming one.

### The close rule (build's, verbatim)

```
close?  =  !(terminal == null && isRunAlive(pid))
value   =  terminal ?? { exitCode: -1, finishedAt: now }
```

Stated once, as `observeRun` in `core/`; `settleRun` and `awaitSupervisedRun`
both call it.

A marker present closes the run even while the pid is alive — the shim writes it
_before_ exiting. Callers claim their ledger row **before** spawning, seeded
with `process.pid`: the claiming INSERT (partial unique index on the kind's
scope `WHERE finished_at IS NULL`) is what wins or loses the race, and the
seeded pid stops the fresh row looking like an orphan.

**The reconciler is registered once, here, not per consumer** — that is where
`reconcileOrphanBuilds` / `reconcileOrphanReleases` died. `register:` token, so
the register phase completes before any `onReady` sees the kind set.

#### A stamped row is not a finished process

The reconciler also drops runs the ledger no longer lists — the caller's own CLI
closing its own row, which is the ordinary case. **That drop goes through the
close rule above, never through a bare untrack**, and the difference is not
cosmetic: `./singularity build` stamps its row after the health probe and then
runs for another ~100s of compose-serve tail (measured: 75.8s). Dropping it on
the ledger's say-so stopped the tail mid-run — truncating the live log for every
kind that stamps early — and, once it was the last live run, tore down the
watcher, so the exit marker landed with nobody listening and `finish` was
**never called at all**.

So the condition for leaving the live set is the run having ENDED, not its row
having been stamped. **The set is still bounded by exactly the argument it was
before**: every child either writes a marker (every death but SIGKILL runs the
shim's trap) or its pid dies, and the reconcile pass re-checks both on the same
timer. All that moved is WHEN a run leaves — at the first tick after its child
really ended, rather than the first tick after someone wrote to a table.

`supervisor.test.ts` is the regression guard, driven through the real reconciler
with a fake ledger and real child processes.

### Kill signals the process GROUP

`killSupervisedRun` sends to `-pid`. The shim does not forward signals, so
signalling it alone kills the supervisor and leaves the work running,
reparented. The group exists because the spawn is `detached: true` — itself
load-bearing: the gateway hot-restarts a backend by signalling its whole process
group, which is what killed a running deploy 0.9 s after spawn on 2026-08-28.

### Liveness is the process GROUP

`isRunAlive(pid)` is alive while `kill(pid, 0)` OR `kill(-pid, 0)` succeeds
(EPERM counts as alive). It must agree with kill: the row pid is the shim's, and
the real work is another process in the shim's group. When the shim alone is
SIGKILLed (a stray `kill -9 <row pid>`), the worker is re-parented to init but
keeps its group, so:

- the run stays **open and running** while the worker lives — the tail keeps
  publishing and the in-flight lock stays held, so no retry attempt can start
  alongside it (probing the pid alone closed the row as `-1` here, and attempt 2
  ran concurrently with attempt 1);
- once the group is empty it closes with `-1` / `signalCode: null`, because only
  the shim could `wait` for the worker's status and nobody witnessed the end.
  `-1` stays retryable, so a retry may run **after** it — never concurrently.

The `pid` half stays because a freshly-claimed row is seeded with `process.pid`,
and the backend is not guaranteed to lead a group. There is no exported
single-pid probe: every supervised-run liveness decision goes through this one.

### A ledger's verbs

`defineSupervisedJob` builds the kind from the ledger (`finish` = `closeRow` then
announce). `onReattach` is only for a job holding an in-memory live view; the tail
is already restarted by the time it is called.

- **`listUnfinished` must be scoped to this namespace.** A worktree DB is a fork
  of main's and inherits its rows; unscoped, this reaps another machine's runs.
- **`finish` means the run ENDED, not "you are the one closing the row".** It is
  called for a run whose row the caller's own CLI stamped minutes earlier (see
  above), because that is the only edge a consumer's terminal work — a
  notification, a convergence reconcile — has to hang from. So: the write must be
  first-writer-wins (`WHERE finished_at IS NULL`), and anything BESIDE the write
  must still be correct against an already-stamped row. Read the row back rather
  than assuming this call closed it.

### Growth bounds

- **Published**: `TRANSCRIPT_CEILING_BYTES` (16 MiB) per run, then one
  "transcript truncated" line and silence. Protects the channel's ring and its
  `.jsonl` sink.
- **On disk**: newest 50 run sets per kind per worktree, trimmed when the next
  run of that kind starts. `defineRetention` does not apply — it is a nightly
  DELETE over a _table_, and these are files. The trim waits out an in-flight watcher
  subscribe (`pruneOutsideWatcherStart`): kqueue fails the whole subscribe on
  an entry deleted mid-walk.
- **Residual**: one run's transcript file is bounded only by that run. It is a
  kernel fd the child owns; capping it mid-run would race the writer.

## `run` bodies: out-of-process work that is not a command line

_Folded in from the former `supervised-task` plugin; now `server/internal/task/`
(the registry), `server/internal/run-body.ts`, `cli/` (the `supervised-exec`
command) and `core/`._

The supervisor supervises an argv. Build and release each have one; a backup
does not — it is ~11 contributed `BackupSource`s staged into a directory, one
`tar`, and ~2 contributed `BackupTarget`s. A `run` body's task is the argv that
stands for such a body:

```
./singularity supervised-exec <job name> <{"runId","attempt","input"}>
```

The task is registered under the job name by the job's own `register:` token,
and is internal — there is no separate task to declare. Detach, pid, transcript,
exit marker, boot reconcile, suspend and resume are unchanged. A `run` body
changes **what** is spawned, never how it is supervised.

### `exec` is the whole trick

The child runs `server-core`'s `exec` boot mode, which is the same sequence
`serve` runs, stopped after `onReadyBlocking`. So the body sees the contributions
it needs, the config registry and its parent's database — and none of the
machinery a short-lived process must not start: no socket, no graphile runners,
no cron, no git watcher, and above all **no supervised-run reconciler**, which in
a child would adopt and write off the very run that spawned it.

Read `server-core`'s "Boot modes" before adding to `onReadyBlocking` or moving
main-only work earlier: a child of main's backend is HANDED main's namespace, so
`isMain()` is **true** there, and nothing misbehaves today only because every
main-only side effect hangs off a phase `exec` skips.

### What the child is told, and what it merely inherits

**Identity is plumbed, on argv.** `invoke()` appends `--namespace
<runtimeNamespace()>` to every child's command line, and `supervised-exec`
declares that option as REQUIRED — so a child cannot start without being told
which app it is. That namespace resolves both the per-worktree database and,
through that namespace's `spec.json`, the composition registry: same app, same DB
as the parent, because the parent SAID so.

It used to be inherited instead, through a `SINGULARITY_WORKTREE` environment
variable, and that is exactly the failure this replaced: an environment variable
reaches every descendant forever, so a value nobody chose became every agent
session's identity
(`research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md`).

Everything else still comes from the ambient environment —
`startSupervisedRun` spawns with `{ ...process.env }`:

- **`PATH`** — `tar`, `gzip`, `pg_dump` resolve exactly as in the backend.
- **cwd** is `REPO_ROOT`, because `./singularity` is a path.

A task that needs anything else puts it in the payload, not the environment.
Keep payloads small: they are JSON on a command line.

`supervised-exec` declares `detachable: true`. A supervised child is meant to
outlive the backend that started it, and the orphan guard — armed for every
`./singularity` invocation — would otherwise be free to kill it.

### Failure is loud

An unknown id throws, naming the id and listing the registered ones. Returning
quietly would exit 0, the shim would write a `0 -` marker, and the ledger would
record a successful run that did nothing at all. Malformed payload JSON throws
the same way; `execute` parses and runs in one call, so a value the schema
refused can never reach the body.

All of it exits 1, which the shim records and the supervising job reads. A failed
task is a failed RUN, not a failed job — see "A non-zero exit code is DATA" above.

### Why the task is registered by the job, not declared beside it

The child's argv is minted only by the registered task's `invoke`, and the task
and the job are one declaration — so the id in the argv is a registered id by
construction, and the job and the body it spawns cannot drift apart.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Out-of-process work as an ordinary job: defineSupervisedJob composes defineJob + a supervised-run kind into a handler that claims, spawns detached and SUSPENDS — so no worker slot is held while the child runs — then wakes on the supervisedRun.ended event, re-reads the child's exit marker (the authority; the event is only a wake-up) and records the outcome, surviving any number of backend restarts in between.
- Server:
  - Contributes: `fork-data-exclusion` "supervised_job_runs"
  - Uses:
    - `database.db`
    - `database/admin.ExcludeFromFork`
    - `infra/events.defineTriggerEvent`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileWatcher`
    - `infra/host/host-admission.withHostGrant`
    - `infra/jobs.abortDurableRun`
    - `infra/jobs.defineJob`
    - `infra/jobs.isNonRetryableError`
    - `infra/jobs.isSuspendSignal`
    - `infra/jobs.JobCtx`
    - `infra/jobs.JobFactory`
    - `infra/jobs.NonRetryableError`
    - `infra/jobs.ScheduleSpec`
    - `infra/paths.pruneWorktreeRunArtifacts`
    - `infra/paths.REPO_ROOT`
    - `infra/paths.RUN_TERMINAL_SUFFIX`
    - `infra/paths.RUN_TRANSCRIPT_SUFFIX`
    - `infra/paths.worktreeArtifacts`
    - `infra/retention.defineRetention`
  - DB schema:
    - `plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/tables-run-ended.ts`
    - `plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/tables.ts`
  - Exports (types):
    - `CancelByLockResult`
    - `DefineSupervisedJobSpec`
    - `RunEndedPayload`
    - `RunStep`
    - `StepOutcome`
    - `SupervisedJob`
    - `SupervisedJobClaimMeta`
    - `SupervisedJobEndedMeta`
    - `SupervisedJobLedger`
    - `SupervisedJobSpawn`
    - `SupervisedRunContext`
    - `SupervisedStepsContext`
    - `UnfinishedRun`
  - Exports (values):
    - `_supervisedJobRuns`
    - `_supervisedRunEndedTriggers`
    - `cancelSupervisedJob`
    - `cancelSupervisedJobByLock`
    - `defineSupervisedJob`
    - `runEnded`
  - Register:
    - `defineTriggerEvent('supervisedRun.ended')`
    - `defineJob('retention.supervised_job_runs')`
    - `defineFileWatcher('supervised-job.runs-dir')`
- Core:
  - Uses:
    - `infra/paths.worktreeArtifacts`
    - `infra/runtime-identity.runtimeNamespace`
  - Exports (types):
    - `ExecContext`
    - `RunObservation`
    - `RunTerminal`
    - `SupervisedTaskInvocation`
  - Exports (values):
    - `assertRunId`
    - `assertRunKindId`
    - `HARD_KILL_EXIT_CODE`
    - `isRunAlive`
    - `observeRun`
    - `readRunTerminal`
    - `RUN_TERMINAL_ENV`
    - `RunMarkerError`
    - `SUPERVISED_EXEC_COMMAND`
    - `supervisedArgv`
- Cli:
  - Uses: `framework/server-core.runExec`
  - Exports (values): `cliExecContext`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `apps/chord/song-index`
    - `apps/deploy/deployments`
    - `apps/sonata/sources/ultimate-guitar/alignment`
    - `backup`
    - `build`
    - `database/fork`
    - `debug/worktree-cleanup`
    - `framework/cli/op-runtime`
    - `framework/cli/release`
    - `framework/cli/serve-app`
    - `framework/cli/start`
    - `infra/audio-analysis`
    - `infra/deps`
    - `infra/events-test`
    - `release`
- Exemptions:
  - Exempts itself from:
    - `spawn-safety/no-raw-bun-spawn` — `server/internal/run/supervisor.ts` (sanctioned)
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
    - `ids:pk-declared` — `server/internal/tables-run-ended.ts` (debt)
- Test helpers:
  - Core: `@plugins/infra/plugins/jobs/plugins/supervised-job/core/testing`
    - `execContextForTests` — An `ExecContext` for tests: origin `cli`, admission that admits at once.

<!-- AUTOGENERATED:END -->
