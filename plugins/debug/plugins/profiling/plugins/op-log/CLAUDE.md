# op-log

The **one** durable record for every op that competes for a host resource —
`build`, `push`, `check`, `test`, `e2e`. One record type, one writer, one
reader, one orphan reconciler.

See [`research/2026-07-17-global-op-log-unified-wait-profiling.md`](../../../../../../research/2026-07-17-global-op-log-unified-wait-profiling.md).

## Why it exists

Three ops each hand-rolled their own lifecycle logging (and `check` had none at
all — a standalone `./singularity check` takes a host CPU grant, making every
other agent's build queue, while appearing nowhere). The duplication had already
drifted: `PushContentionRecord` existed in **three** independent copies, one of
which had silently lost `opSlug` and the in-flight synth. Adding `check` as a
fourth parallel mechanism would have meant a third orphan reconciler and a fourth
record type. The abstraction was missing.

## `waits` is a list, and that is the whole point

An op genuinely blocks on several distinct resources **in sequence** — a build
waits on the build lock, then the duress valve, then the host CPU grant, and can
re-do the last two N times across requeue cycles. A scalar `waitMs` is what made
a build stall unattributable: a build that queued 5 min and worked 1 min rendered
identically to one that worked 6.

`OpWait.startMs` is relative to the op's `requestedAt`, **not** to the previous
wait: waits are interleaved with real work (a build does migrations and codegen
between releasing the build lock and queueing for the grant), so segments are
painted at their true offsets inside the op's span, never packed head-to-tail.

`waitMs` survives as a **derived** read-model field (`sum(waits)`) so the stats
panes keep working.

## The event stream (v2) and the one reducer

Since 2026-09-29 the writer emits **change-only events**, one line per state
change — see
[`research/2026-09-29-global-unified-op-status.md`](../../../../../../research/2026-09-29-global-unified-op-status.md):

| event | written when | carries |
|---|---|---|
| `requested` | once, before the first wait | full identity + `pid` |
| `wait-start` | a wait opens | `wait`, `reason` (e.g. the duress trip cause), `cycle` |
| `wait-end` | a wait closes | `startMs`, `durationMs`, `result` (`acquired` / `cleared` / `fail-open` / `aborted`), and `reason` + `cycle` again so it is self-contained (a fast-path grant emits one with no `wait-start`) |
| `requeue` | a build released its grant to re-hold at the duress valve | the new `cycle` |
| `granted` | the op stops queuing for its ENTRY ticket | — |
| `completed` | terminal, `by: "self"` or `"reconciler"` | a **self-contained summary**: identity, times, every wait, outcome, steps |

Every event carries a per-op `seq`, the wall instant `at`, and `t` (monotonic ms
since `requested`, the clock every wait offset is on).

`core/internal/fold.ts` is the ONE reducer every reader uses —
`applyOpEvent(state, line)` / `foldOpLines(lines)` → `OpFoldState` (plain data
that maps onto a DB row), `toOpRecord(state, now, sleepNow)` → the read model,
and `liveTimes(state, now, sleepNow)` → waited vs worked vs asleep. Rules: a
terminal wins and every line after it is ignored; a non-terminal event applies only when
`seq > lastSeq` (re-ingest is idempotent); an op whose `requested` was clipped
away is *headless* and renders nothing until its self-contained terminal.

**Who reads what.** Every UI surface — the op-status banner and chip, the
Ops Gantt and detail, the stats/pushes charts — reads the DB fold the
[`op-store`](plugins/op-store/CLAUDE.md) child keeps (`opsInFlight` /
`opsHistory`, `op_log_ops`). `readOpRecords()` / `readOpenWait()` (this
plugin's `server` barrel, a direct fold of the file) remain for the CLI only —
`./singularity await` — which must never depend on the DB.

**Legacy lines** (a pre-v2 CLI's `phase: requested | granted | completed`
snapshots, `requested` re-stamped on every wait open/close) still fold, with the
old semantics, until Phase 5 of the plan removes them: the freshest `requested`
wins for identity and the open wait, and between re-stamps and the `granted`
snapshot the longer wait list wins — wait lists only append, so the longer one
is by construction the newer (`requested.waits ?? granted.waits` would let a
never-re-stamped `waits: []` clobber a populated `granted` list).

### `granted` does not mean "will never block again"

`markGranted()` means *the op stopped queuing for its entry ticket and began
doing its own work*. It does **not** mean the op is done waiting — and for two of
the three kinds the most diagnostically important wait is **post-`granted`**:

| kind | grants at | waits AFTER `granted` |
|---|---|---|
| `push` | the push mutex | its nested rebased-checks subprocess queues for an interactive `host-grant` |
| `build` | the build lock | minutes of migrations/codegen, **then** `duress-valve` + `host-grant`, possibly over several requeue cycles |
| `check` | the host grant | none |
| `test`, `e2e` | the host grant | none — the two direct ops that joined `check` on `withDirectOp` (op-runtime) |

So the wait list keeps growing after `granted`, exactly as before it. Freezing it
there is what made a build parked 5 minutes in `host-grant` render as a
motionless "running" bar — the precise failure this record exists to kill.

The outcome stays `"running"` while parked in a post-grant wait; it does **not**
flip back to `"waiting"`. The op *has* been admitted, the Gantt maps both states
to the same pulse treatment, so the flip would buy nothing and would lie.

Both in-flight branches share one `liveWaits` helper. That sharing is
load-bearing: the two branches having their own copies is exactly how the
post-`granted` waits came to be dropped in the first place.

`toOpRecord` and `liveTimes` take `now` as a **parameter**; they never read the
clock. That is what makes the live synthesis testable (`core/fold.test.ts` for
legacy lines, `core/fold-v2.test.ts` for the event stream).

## Sleep: a nap is neither work nor waiting

`t` is `performance.now()`, which **pauses while the machine sleeps**; `at`,
`totalMs` and the live tail are wall clock. So every event also carries `sleep`
— the machine's sleep clock (`packages/sleep-clock`: boot id + cumulative
`asleepMs` since boot + last wake). Two stamps of one boot differ by exactly the
sleep between them; `advanceSleeps` (the ONE rule, shared by the reducer, the
writer's running fold, the reconciler's close and the reader's live tail) turns
that into an `OpSleep` on the wall axis — exact when the stamp's `wakeAtMs` falls
in the gap, else pinned to the gap's end (`approx`). A new boot resets the stamp
and invents nothing; a line without a stamp leaves it untouched (a legacy op folds
with `sleeps: []`). Each wait also carries its wall extent (`atMs`/`wallMs`).

`sleepNow` (the reader's current reading, `null` = unknown) is a **required**
parameter so no call site silently drops the live tail. The read model's split
is ONE helper (`breakdown`): asleep = union of sleeps; waiting = the waits' wall
extent minus sleep; working = the rest — so `waitingMs + workingMs + asleepMs ===
elapsedMs` by construction, and `OpRecord.waitMs`/`asleepMs` come from it. Plan:
[`research/2026-10-08-global-op-sleep-accounting.md`](../../../../../../research/2026-10-08-global-op-sleep-accounting.md).

## One identity field: `opSlug`

A record names exactly one thing — the checkout the op ran in — and `opSlug` is
it: `basename(worktree root)`, the op-marker slug `isWorktreeOpActive()` reads.
Every writer derives it from its own git root (`checkoutNamespace(root)`), so it
is true for the process that wrote the line. The op-store reconciler reads the
slug's markers for liveness, and the profiling reader groups a Gantt row on it.

The record used to carry a second field, `worktree`, read from the
`SINGULARITY_WORKTREE` environment variable — and the reader preferred it. An
environment variable reaches every descendant forever: once the tmux server
inherited main's copy, every agent's build, check and test filed itself under
`singularity`, and each conversation's own Op profiling pane went empty. Two
fields for one thing meant one of them could be wrong while the other was right.
The variable is gone (see
[`research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md`](../../../../../../research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md)),
and so is the field.

A line with no slug at all — a foreign writer, or one predating July — is filed
under its branch instead, canonicalized to the same bare shape
(`claude-web/att-x` → `att-x`). That is a fallback for old lines, not a second
identity.

## Vocabulary is borrowed, not invented

`OpKind` **is** the worktree op marker's kind: one declaration, `OP_KINDS` in
`infra/worktree/core`, which this plugin and the marker primitive
(`infra/worktree/server`) both import — identical by construction, not by
convention. Those markers are ephemeral by design (one flocked file per op,
deleted when it ends, no history) so they cannot *be* the durable store — but the durable store speaks
their vocabulary rather than inventing a second one. This barrel deliberately
does not re-export `OpKind`; import it from worktree's `core`. `OutcomeByKind`
is keyed on it, so a kind added there without an outcome vocabulary here is a
type error.

## Storage

`~/.singularity/logs/op-log/op-log.jsonl`, append-only. Append (never rewrite) is load-bearing
even in the reconciler: concurrent CLI processes are writing the same file.

A malformed final line is tolerated (a torn partial append), and **only** that:
a `SyntaxError` is skipped, anything else rethrows.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Unified op log: the one durable record for every host-contending op (build / push / check), its per-resource wait list, the writer, and the merged file reader. Its op-store child ingests it into the DB and owns the orphan reconciler.
- Core:
  - Uses:
    - `infra/worktree.OP_KIND_IDS`
    - `infra/worktree.OpKind`
  - Exports (types):
    - `LegacyOpenWait`
    - `OpClosedBy`
    - `OpenWait`
    - `OpEvent`
    - `OpEventKind`
    - `OpFoldState`
    - `OpIdentity`
    - `OpLine`
    - `OpLiveTimes`
    - `OpOutcome`
    - `OpRecord`
    - `OpSleep`
    - `OpSleepStamp`
    - `OpStep`
    - `OpSummary`
    - `OpWait`
    - `OpWaitSpan`
    - `OutcomeByKind`
    - `RawOpRecord`
    - `SleepStamp`
    - `TerminalOutcome`
    - `WaitKind`
    - `WaitKindMeta`
    - `WaitResult`
  - Exports (values):
    - `advanceSleeps`
    - `applyOpEvent`
    - `emptyOpState`
    - `foldOpLines`
    - `isOpEvent`
    - `isTerminalState`
    - `liveTimes`
    - `orphanedOps`
    - `reconcilerCompletedEvent`
    - `sumWaits`
    - `toOpRecord`
    - `toOpRecords`
    - `WAIT_KINDS`
- Cross-plugin:
  - Imported by: `debug/profiling/op-log/op-store`
- Server:
  - Exports (types):
    - `OpProfiler`
    - `OpProfilerOptions`
  - Exports (values):
    - `appendOpLog`
    - `createOpProfiler`
    - `OP_LOG_FILE`
    - `readOpenWait`
    - `readOpRecords`
    - `readOpStates`
    - `readSleepNow`
- Sub-plugins:
  - **`op-store`** — Op-store web presence: eagerly registers the boot-critical op-store.in-flight.all live collection so boot-snapshot can hydrate it before first paint. Op-log read model: every serving backend ingests…

<!-- AUTOGENERATED:END -->
