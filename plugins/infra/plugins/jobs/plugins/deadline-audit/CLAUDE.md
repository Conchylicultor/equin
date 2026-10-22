# deadline-audit

Turns the parent's deadline announcements into reports, so a run that was given
up on reaches the notification bell and Debug → Reports instead of vanishing.

**A deadline that fires silently is worse than no deadline.** Without this
plugin, a handler aborted at its class deadline just fails — and its failure
looks like any other failure, with nothing saying the worker killed it. That is
the same shape as the bug the deadline exists to fix: a real condition that only
a human happening to look could find.

## Why it is a sub-plugin and not part of `jobs`

`jobs` is load-bearing infrastructure and must not name the observability stack.
`reports` owns interpretation — kinds, fingerprints, duress shedding, the bell,
task filing — and `jobs` owns mechanism. That is the same rule
`queue-health/CLAUDE.md` gives as the reason for its own placement.

It is also a cycle if written the other way. `reports` already imports `jobs` by
two independent routes (`record-report.ts` → `shell/notifications/server` →
`ttl-cleanup.ts` → `jobs`, and `reports/plugins/engine/server/internal/retention.ts` →
`infra/retention/server` → `jobs`), because `reports` is a **user** of durable
background work. A primitive cannot import its own user, and severing those two
routes would only leave a standing rule that "reports must never use a background
job" — a worse constraint than a sink. There is no cycle exemption to reach for:
`boundary-config.ts`'s `exclude` skips whole files and is reserved for
composition roots, and `runtimeExceptions` bypasses only runtime isolation — such
an edge still enters `detectCycle`.

The parent has faced this exact shape once already: it needs `registerTrigger`
from `events` for `ctx.waitFor`, and `events` imports `jobs`. The answer there
was `UNSAFE_installDurableHooks`. This is that answer again, through the
factored-out `defineReportSink` primitive rather than a hand-rolled setter.

The child importing the parent is not a cycle — the parent never imports the
child. It gets `jobDeadlineSink` and `JobDeadlineEvent` from
`@plugins/infra/plugins/jobs/server`.

## The three kinds

All three `duressExempt: true`. The two run-level kinds dedupe per `jobName` —
one handler overrunning across many dispatches is one problem, not N — and the
pool-level one dedupes per worktree.

| kind | variant | fires |
| --- | --- | --- |
| `job-deadline-exceeded` | `warning` | at the class deadline, when `ctx.signal` is aborted |
| `job-zombie` | `error` | a grace period later, if the handler still has not settled |
| `job-slot-floor` | `error` | when the written-off slots add up to a runner that can no longer do its job |

The split is the whole point. The first is **the system working**: the run was
given up on, and a handler that threads `ctx.signal` into what it waits on fails
cleanly from here and frees its slot. The second is the failure the deadline
exists to catch and cannot fix — the handler ignored the abort, so the slot is
gone until it settles on its own or the backend restarts. Different urgency,
different renderer.

`job-deadline-exceeded` is the **escalation of `queue-slot-hog`** for the same
job, and its renderer says so: slot-hog reports at a fraction of the same
deadline, so a job that reached this one should already have a slot-hog report
sitting beside it.

`job-zombie` and `queue-wedged` are complements, not rivals. This one names one
handler from the inside at the instant we gave up on it; that one says the queue
as a whole stopped draining. A fully-zombied pool trips both.

### `job-slot-floor` — the pool-level one

The other two are about one run. This one is about what the written-off slots
add up to, and it is the only kind here whose report the parent writes **itself**
— synchronously, to the reports crash buffer, immediately before a deliberate
`process.exit(1)`. There is no handler for it on the seam: `recordReport` is a
Postgres write, and the caller's next statement is the exit.

Two arms, discriminated by `action`, one kind — because they are one condition
(a runner lost slots it cannot get back) seen at two severities:

- `crashed` — the runner serving the longest hold class fell below its floor of
  usable slots, so the backend exited. Exiting is what recovers it: Postgres
  drops every advisory lock at teardown, and the next boot's sweeper reclaims
  those rows provably rather than by inference.
- `degraded` — the process stayed up. Either a narrower runner went fully
  forfeited (its work still reaches the wider runners, so the pool is degraded
  rather than dead), or the floor tripped and the anti-loop latch suppressed a
  fourth exit within the hour. `restartSuppressed` tells those apart, and the
  renderer says which happened in plain sentences.

One rolling row per worktree (fixed fingerprint; the reports unique index is
`(fingerprint, worktree)`). Deliberately not per runner: what is being reported
is the state of this worktree's worker pool, and the upsert refreshes `data` on
the newest occurrence, so the row always shows the latest and worst of it.

**The kind string is imported from the parent, not typed here.** The parent
writes the durable line; a second spelling that drifted would leave that line
unresolvable on the next boot — a failure visible only as one log entry on a
backend that had already restarted. For the same reason the payload carries a
tsc-level assertion (`slot-floor-kind.ts`) that this kind's schema is exactly
what the parent writes: nothing maps field-by-field between them, so without it
nothing would catch a rename.

**Why the flush finds the kind.** The report is buffered before an exit and
replayed by `reports`' `onReady`. Contributions are collected for every plugin
in `server-core`'s `bin/index.ts` *before* any `onReady` runs, so this kind is
in the registry by the time the flush reads the file.

### `duressExempt`

A job wedging its slot and a host duress episode are the same event far more
often than not: the box is in trouble, the sentinel latches duress, and the
reports funnel starts shedding. Without the flag `recordReport` buffers exactly
the reports that describe the outage and returns `{ reportId: null }` — the alarm
for the outage silenced by the outage. That was Silencer 2 of the 2026-08-17
incident, and it is the argument `wedged-kind.ts`, `duress-shed` and
`duress-episode` all make: this report **is** the durable record of the
condition, so shedding it loses the only evidence there was one.

## No renderer restates a number from the class table

Every duration a renderer prints — the deadline, the hold, the overrun — arrives
in the payload, and the payload got it from `deadlineMsFor`. Nothing here spells
`60 s` or `10 min`. Two reasons, and both bite:

- A restated number goes stale the moment the class table is edited, and the
  report is the last place anyone would look for the drift.
- The payload's `deadlineMs` is what was claimed **at the moment of the trip**.
  Re-deriving it at render time would let a later config or table edit silently
  rewrite what a past report said.

`queue-health/CLAUDE.md` states this rule for its own kinds; it applies here for
the same reason.

## Good news is declined, not claimed

The seam has a third phase, `unforfeited`: a run we had already written off as a
zombie finally settled, and its slot came back. This plugin returns `false` for
it — there is no kind, deliberately. The durable record it would update is a
`job-zombie` row, and bumping that row's count to say "it recovered" would make
the count mean two opposite things. The parent has a branch for exactly this: it
logs the recovery and files nothing, rather than routing good news through the
server *error* reporter.

## The seam's boolean

`jobDeadlineSink` is `ReportSink<JobDeadlineEvent, boolean>`, and the handler
here returns `true` synchronously while the `recordReport` write is still in
flight. `true` means *this event has a durable home and is on its way there* —
which is the only question the parent's fallback branch needs answered, because
it distinguishes "nobody is listening" from "a consumer owns this". The parent
falls back to `reportServerError` on anything else, so the abort can never be
silent.

The handler cannot await: it is called from the deadline timer, on the abort
path, and the seam contract is synchronous. A failure inside `recordReport`
surfaces as an unhandled rejection, which the reports plugin itself files.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Job deadline audit: registers a handler on the jobs plugin's deadline seam and turns each announcement into a report — job-deadline-exceeded (warning) when a run passes its hold class's wall-clock deadline and has ctx.signal aborted, job-zombie (error) when it is still holding its slot a grace period later, and job-slot-floor (error) when the written-off slots add up to a runner that can no longer do its job.
- Server:
  - Contributes:
    - `report-kind` "job-deadline-exceeded"
    - `report-kind` "job-slot-floor"
    - `report-kind` "job-zombie"
  - Uses:
    - `infra/jobs.JOB_SLOT_FLOOR_KIND`
    - `infra/jobs.JobDeadlineEvent`
    - `infra/jobs.jobDeadlineSink`
    - `infra/jobs.JobSlotFloorReport`
    - `reports.ReportKind`
    - `reports/engine.recordReport`
  - Exports (values):
    - `deadlineExceededKind`
    - `jobZombieKind`
    - `slotFloorKind`
- Core:
  - Uses: `infra/jobs.HoldClassSchema`
  - Exports (types):
    - `JobDeadlinePayload`
    - `JobSlotFloorPayload`
  - Exports (values):
    - `JobDeadlinePayloadSchema`
    - `JobSlotFloorPayloadSchema`

<!-- AUTOGENERATED:END -->
