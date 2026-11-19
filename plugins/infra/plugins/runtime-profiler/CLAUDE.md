# runtime-profiler

In-memory, per-worktree runtime span recorder (`http` / `db` / `loader`, plus the `sub` /
`push` *origin* entries that trigger loaders). Zero-dependency and **isomorphic** (`core`
only, no Node APIs) so `core` can sit low in the DAG and be imported by `endpoints/core` and
`database/server`. The store is bounded and lost on restart.

> **Do not import this plugin from `server-core/core`** — this plugin's `server/index.ts`
> imports `ServerPluginDefinition`, so the reverse edge closes a cross-plugin cycle
> (rejected by `./equin check plugin-boundaries`). server-core's resource runtime
> instead calls the no-op profiler seam it owns (`server-core/core/profiler-hooks.ts`), and
> this plugin **injects** the real recorder into it at boot from `server/internal/install.ts`
> (`setProfilerHooks(...)`), mirroring `setErrorReporter`.

## Caller attribution (ambient tier)

Each `db`/`loader` span records the single innermost enclosing request/loader it ran under
(its immediate `parent`), so N+1 / fan-out patterns point straight at their source — one
level only, keyed by **label** (`SpanRef` is `{kind,label}`), which is what the `byParent`
aggregate breakdown groups by. A loader triggered by a WS subscription or a push cascade
nests inside a `sub` / `push` origin entry, so its `parent` names the request class that
triggered it instead of being `null`.

Per-*instance* identity is a separate, finer axis (`id` / `parentId`, see the
flight-recorder section); `SpanRef` deliberately carries **no** id — an aggregate is a
roll-up over many runs of one label, where an instance id would be meaningless.

## Wall-clock decomposition (wait / child / self)

Every entry span decomposes its wall-clock into **`waitMs`** (time covered by named
gate/pool waits at any depth of its subtree), **`childMs`** (time covered by direct-child
entry executions), and **`selfMs`** (the remainder: its own orchestration/CPU — on a
composite span a *conservative upper bound* of own work, since untracked awaits land here).
A wait is charged as it ends (a `beginWait` handle's end, a gate's `onWait` —
see *Waits in progress* below); the interval `[now − ms, now]` propagates to **every open ancestor entry** (innermost included) up the
live `EntryContext.parent` chain, so a composite span like a `flush` draining many loaders
names the gates its subtree waited on rather than showing huge wall-clock with empty `waits`.
(These are the *display* unions. What an op is judged on, `excludedMs`, takes direct items
only — see *Own time* below.)

The load-bearing math is the **interval-union** (`Track`, per ancestor): a flush
drains loaders concurrently, so *summing* child waits into an ancestor could exceed its
wall-clock (20 loaders × 60 s gate wait inside a 90 s flush ≠ "1200 s wait"). Each ancestor
instead unions the intervals over its own timeline, guaranteeing `waitMs ≤ wall` and
`selfMs ≥ 0` at every level; per-layer `waits` values are unions too (each ≤ wall). Every
charge arrives at its interval's END (gates call `onWait` at slot acquisition; children
and claims charge at finish), but its start can reach back past time already covered and
over gaps in it (a loader that joined 1500 → 4000 is then claimed 0 → 4000). So a track
keeps its covered set as disjoint intervals (`spans`) and a charge merges the tail ones it
reaches — *exact*, amortized O(1). Past `TRACK_SPAN_CAP` intervals the oldest is frozen
into the track's `floor`; only a charge reaching back past it is clipped (an undercount,
never an overcount). A
finished child charges its execution interval into the *nearest open ancestor only* (its
own interval propagates upward when it finishes — charging every ancestor would
double-count grandchildren); gate waits go to *all* open ancestors because unions are
idempotent under re-covering, which is what makes each level's `waits` self-contained.
Closed ancestors are never mutated (a detached child finishing late cannot corrupt a
recorded span).

### Waits in progress — the only spelling of a wait (`beginWait`, `gateWaitHooks`, `markWait`)

A charge lands at the wait's END, so an entry queued on a gate for minutes
would read, until it is admitted, as minutes of its own work. So a wait is
**announced as it starts**, and the barrel offers no way to meter one that
was not:

- **`beginWait(layer, kind)` → `WaitEnd`** — THE wait primitive. It
  registers the wait on the innermost open entry (its owner) and every open
  ancestor at once; the returned `end()` (idempotent) removes it and charges
  `[start, end]` into the context the wait STARTED in. A join is this shape
  (`inflight`'s `onJoin`: `() => beginWait(layer, "join")`), and so is the pg
  pool's `db-acquire` and a watched memo's `memo-opening`.
- **`beginDescribedWait(layer, kind)` → `DescribedWaitEnd`** — `beginWait`
  for a waiter that knows, once it is over, what the wait was for: its end
  takes a `WaitDetail` (`variant` — which instance of the layer, a closed set;
  `measures`; `subject` — the exact thing, e.g. a path) or `undefined`,
  REQUIRED so the end is never handed to a `.then` that would pass it a value.
  The detail rides on the `OpWait` when that one wait is filed (never on a
  residue or a busy stretch, which sum many): `slow-ops` files it as the
  sample's variant and measures, the subject on the trace. The git runner
  (`primitives/commit-list`) uses it: a slow `wait git:status` names the
  checkout kind and whether git's fsmonitor answered.
- **`gateWaitHooks(layer, kind?)` → `{ onQueued, onWait }`** — the same split
  along a gate's two moments, for `packages/semaphore`'s `SlotOptions` and
  host-admission's pools (`defineHostPool` wires it on every acquire under
  `<id>-acquire`, so no caller can forget): `onQueued` announces a caller that
  has to queue, `onWait` charges at admission, queued or not (≈0 with room),
  so an admission with room pays no announcement. One call, so a gate cannot
  charge a wait it never shows.
- **`markWait(layer)`** — a 0 ms `join` marker (a memo hit / miss): it says
  THAT a layer was consulted, never a duration, so nothing is in progress.
- **`beginDeferredWait(layer, kind, floorMs)` → `WaitEnd`** — the twin for
  a wait that is almost always over in microseconds and is metered on every
  call: a file call (`io`, timed-fs's meter, installed by
  `server/internal/install.ts`). Starting it is one `Set.add` (no ancestor
  walk); `captureFlightWindow` announces every one past its floor, from its
  real start (`promoteDeferredWaits`), so the stuck-span watchdog and traces
  see a call hung on a dead mount as a wait; its end charges `[start, end]`
  only when it reached the floor. Measured ~170 ns a call against ~1.2–1.9 µs
  for `beginWait` under three entries (`scripts/fs-meter-bench.ts`).
- **The bare charge (`chargeWait`) is module-internal.** No caller outside
  the module.
- **Waits on other in-process work are the primitives' to announce, never a
  call site's.** A span awaiting work another party runs — a deduplicated
  flight (`packages/inflight`: `inflight:<name>` unless the caller names it,
  through the join meter `server/internal/install.ts` installs),
  a coalescer run it did not start (`packages/coalesce`: `coalesce:<name>`),
  a watched memo's first pass, a worker thread's answer
  (`WorkerDaemonInstance.awaitReply`: `worker:<daemon>`, kind `io`) — gets the
  wait from the primitive it awaits through, whose name is required. Before
  this (2026-11-14 23:17, main), the `deploy-secrets.status` /
  `composition.data` read that STARTED the plugin-tree memo's compute (its
  joiners already showed `git-coalesce:plugin-tree.facets`) counted the
  worker's ~2.2 s rebuild as its own time.

`captureFlightWindow` gives each open span `pendingWaitMs` (what its
subtree's in-progress waits add to its wait union, through a copy of the
track — exact unless an ended wait overlaps them, then under) and `waiting`
(the waits it owns, oldest first). Consumer: `debug/stuck-spans`, which files
a span queued past its threshold against the gate and its holders instead of
as stuck itself.

### Event-loop stalls (`event-loop`, `noteLoopTurn`, `noteLoopObserved`)

A leaf is timed from issuing the call to the callback that reads its answer, so
time the thread spent blocked — another op's synchronous work, a GC pause, the
process descheduled — lands in every call in flight. Measured on main
(2026-11-05): 79% of slow `db` samples overlapped a loop stall of at least half
their length, against 10.6% of random windows; unrelated statements "took" the
same 600 ms and finished within a few ms of each other.

- `noteLoopTurn(periodMs, toleranceMs)` is called by a probe due every
  `periodMs` (debug/health-monitor's `health.loop-probe`, 100 ms, on every
  backend); a tick more than `toleranceMs` late registers `[due, now]` as a
  stall (a bounded ring, disjoint and ordered).
- A plain leaf (`recordSpan` without `latency`) is charged its overlap with the
  registered stalls as the `event-loop` wait, so it is judged on its own time
  (capped at what the caller's own waits left). A latency leaf keeps its `waits | queue | own` layout.
- **Only registered stalls count — that keeps the culprit charged.** A call
  whose own synchronous work (a huge result decode) blocked the loop records in
  that same macrotask, before anything registered the block.
- **An answer read late registers the stall too (`noteLoopObserved`).** Which
  runs first after a block — the overdue probe tick or the socket callbacks
  queued behind it — is the event loop's phase order: on Bun 1.4 the tick wins
  only when the block ran in a socket callback; in a timer, a microtask of one
  or a setImmediate, the answers are read first. So the database client
  (`database/connection`'s `DbClient`) calls `noteLoopObserved()` on every
  socket chunk, ahead of pg's parser: if the probe is overdue right then, the
  block `[due, now]` is registered before the statement's span records, and
  counts as a loop turn. A culprit's first chunk arrives on time (its decode
  blocks after it), so it is still not charged. The probe's next tick returns
  the observed stall (joined with any late part of its own), so the stall
  stacks still attribute it. Before this, main's `agent-processes` loader — a
  timer-driven drain blocked 2.0–2.4 s in `readdirSync` — had every query in
  flight filed as a slow `db` op of the block's length, ending at one instant.
- **The whole overlap is charged**, not just the part after the answer arrived
  (unknowable here): a query genuinely busy in Postgres during a stall is
  under-charged by at most the stall's length — the safe, under-reporting
  direction.
- **Entries are not charged**: an entry may be the synchronous work that
  blocked the loop, and nothing here tells it apart. Whether a stall deserves
  an alert is debug/stall-monitor's call, with the stacks to name it. So a
  leaf's `event-loop` overlap stays on the leaf and its enclosing entries
  book it as their own time (main, 2026-11-15: ~29 s of 179 s of `db` wall,
  all of it in loaders' and pushes' own time). Charging a victim ancestor
  would need proof that it ran no synchronous turn inside the stall, and the
  runtime gives no per-context turn signal: on Bun 1.4.4
  `async_hooks.createHook`'s `before` never fires and `executionAsyncId()` is
  0. An in-flight leaf proves nothing either (`const p = query(); block();
  await p` is the culprit with a leaf in flight), and the recorder's own call
  sites see only some turns. Without that signal, charging the ancestors
  would let a culprit hide its own block, which is worse than the
  over-count. Thread CPU time does not help: it is per thread, not per
  context.

### Positioned wait bands (`WaitBand`)

`Track` is the *measure* of the covered set; a **`WaitBand[]` per `(entry, layer)`** is the
covered set itself, so a wait has a *when* and not merely a *how much*. A band is pushed
only when `contribute()` covered something, clipped to that ancestor's `startMs`, and merged
into every trailing band it overlaps — the same merge the track does — which is what makes
`Σ band widths === track.unionMs` (below the caps). End-ordered arrival (above) makes the
insert a tail op: no sort.

The list is capped at `WAIT_BAND_CAP` per `(entry, layer)`; on overflow the **smallest** band
is dropped, never merged across a gap — painting time a span was not waiting would be worse
than admitting ignorance (the recorder is conservative in the *under* direction everywhere).
`waitMs` stays the authoritative cross-layer union, so a consumer derives
`residualMs = waitMs − crossLayerUnion(bands) ≥ 0` = "this much wait happened, at positions
we no longer retain". Note the *cross-layer* union: two layers can overlap in time, so their
per-layer widths **sum** to more than `waitMs`.

Bands attach to the `EntryContext` actually charged (a closed intermediate ancestor has
none) and are never reconstructed from a subtree walk — a detached child whose wait
straddles its parent's close would paint a phantom band in a parent deliberately excluded.

Reading it: a leaf loader that is mostly `waitMs` was head-of-line-blocked (the resource is
fast); mostly `selfMs` = genuinely slow. A `flush` with `childMs ≈ wall`, `waits` naming
`background-acquire`/`db-acquire`, and small `selfMs` spent its life awaiting gate-blocked
children. `waitSplit(agg)` returns the per-call averages `{ avgMs, waitMs, childMs, selfMs,
waits }` from the aggregate's summed totals.

Charging layers: `background-acquire` (background DB **query** gate), `background-tx-acquire`
(background DB **transaction** lease gate) and `db-acquire` (pg pool connect wait), all
`database/server/internal/client.ts`; `heavy-read-acquire` / `heavy-read-local`
(`infra/host/host-read-pool`); `read-admit` (resource read admission) and `read-coalesce` (joined
an in-flight resource read) (`server-core/core/resources.ts`); `endpoint-concurrency` /
`endpoint-dedupe` (per-route gates, `infra/endpoints/core/implement.ts` — the `http` entry
span encloses them, so deduped GETs record one span per request with joiners showing
`endpoint-dedupe ≈ wall`, `selfMs ≈ 0`); `git-coalesce:<name>` (joined an in-flight git
recompute) and the 0 ms markers `git-memo-hit:<name>` / `git-memo-miss:<name>`
(`infra/git/git-read-cache`); `memo-opening:<name>` (joined a watched memo's
in-flight first pass, `packages/watched-memo`); `inflight:<name>` (a joiner of
any `createInflight(name)` that names no layer of its own, `packages/inflight`);
`coalesce:<name>` (awaited a coalescer run another caller's settle starts, or
`idle` / `settled`, `packages/coalesce`); `worker:<daemon>` (kind `io`: awaited
a worker thread's answer through `WorkerDaemonInstance.awaitReply`,
`infra/spawn/daemon` — the worker's time, filed as `wait worker:<daemon>`); `fs-stat` / `fs-readdir` / `fs-read` / `fs-glob`
(kind `io`: a file call past `packages/timed-fs`'s floor, a `beginDeferredWait`
from `server/internal/install.ts`'s fs wait meter — a disk stall is the
disk's time, filed as `wait fs-<op>` when slow on its own); `git:<subcommand>`
(kind `io`: a git child of `primitives/commit-list`'s `runGit` / `tryRunGit`,
named through the spawn's wait — slow-ops files a slow one as `wait
git:status`); `spawn:<program>` (kind `io`: any other `spawnCaptured` child,
metered by `infra/spawn`'s `installSpawnWaitMeter`, which
`server/internal/install.ts` installs — from inside its `read-spawn` slot, so
the slot's queue is not the child's time); `event-loop` (below). A wait with no active entry (context-less jobs/pollers)
falls back to a standalone `db [layer]` span so the wait is never lost — recorded
as ALL wait (`waits: { [layer]: ms }`, own time 0) and, for a `queue` wait,
handed to `onSlowWait` with that span as its caller: a wait is never booked as a
`db` op's work. A context-less `io` wait is handed to `onSlowWait` (that same
caller) and records no span: it is no `db` op.

### Gate meters (`getRuntimeProfile().gates`) — where the waits are judged

An op is judged on its own time (`selfTotalMs`: wall minus waits, declared holds
and child executions), so the time it waited must be judged somewhere else, once:
a wait's charge meters every `queue` / `io` wait per layer (`GateMeter`: `count`,
`totalMs`, and what a waiter felt: `maxWaitMs`, the longest single wait, and
`longestBusyMs`, the longest the queue held without a break — every wait,
filed or not), ONCE per wait where it happens — never per ancestor and never per
label. A `join` is not metered (it is the joined run's time, which that run's
own span counts). Cumulative like the aggregates, cleared by a reset.
`debug/op-rate` diffs them per tick and files `op-time` against the gate
(`wait <layer>`, its holders named) — so 85 s of `sub` waits on `read-admit` is
one report about the gate, not one per waiting resource. `Aggregate.totalMs`
stays the WALL sum: a view, never a cost to judge. See
`research/2026-07-02-global-profiler-wait-propagation.md`.

### Own time — what a span is judged on (`excludedMs`)

A monitor judges a span on `durationMs − excludedMs`. An entry's
`excludedUnion` holds, as an interval union over its own timeline:

- **every `queue` / `join` wait it made itself, filed or not** (it was the
  innermost open entry): a queue is the gate's, a join the joined run's;
- **every `io` wait it made itself that was filed as its own op** (`wait
  git:status`, `wait worker:<daemon>`): that work was judged where it
  happened. An `io` wait no subscriber filed is work the op awaited — a child
  process, a worker, the disk — and stays in its own time (see *Awaited
  work* below);
- **its direct child ops' executions, filed or not** — each child is judged on
  its own span (slow-ops shows them as the `child ops` layer);
- **claims on it** (an enclosed leaf filed as its own slow op).

Direct items only: a deeper wait lies inside a child's execution, which the
child hands its parent whole as it closes. So the track holds a few long
intervals, never a subtree's thousands of short ones. When every ancestor
unioned every wait, a loader's file calls filled its `sub`'s track past
`TRACK_SPAN_CAP`. The frozen floor then clipped the loader's interval charged
at its end, and `sub prototypes.list` filed 3.2 s "of its own" around its
3.5 s loader (main, 2026-11-19).

A child that is still running when its parent closes (a race, a deadline, a
detached child) is excluded from the parent up to the parent's close
(`openChildren`): its interval only arrives as it closes, after the parent
recorded.

The direct-only rule does not remove the `TRACK_SPAN_CAP` floor clip in every
case. Clipping needs a long interval that started before 64 later, disjoint
intervals of the same entry closed. That happens with concurrency only: a handler
running a long child beside a loop of its own short waits. Clipped, the long
child reads as the parent's own time: an over-report, never a hidden one.

**Awaited work — an unfiled `io` wait is its waiter's.** An `io` wait is
one piece of work another party did on the op's behalf. It is offered to
`onSlowWait` once, where it happens (`OpWait.kind: "io"`), and slow-ops files
it whoever waited — a background op's slow worker included. Under every bar,
it is neither residue nor a gate's busy stretch (concurrent git children are
not a queue): it stays in the waiter's own time, its layer naming it on the
row. So every second of it is judged exactly once — on its own when it was
slow on its own, else as part of the op that awaited it. The wait carries the
bar its waiter declared (`OpWait.callerBudgetMs`, from `EntrySpanOptions.budgetMs`):
slow-ops holds an `io` wait to the waiter's own bar (a job's hold class, a
warm-up's budget), never below `loaderMs`, so a backup job's minute-long
archive child is part of the job's expected work, not a 2 s slow child. A
context-less `io` wait (no op awaiting it: a sampler's `ps`) is offered as its
own op and records no fallback `db [layer]` span; the meter keeps no busy
stretch for an `io` layer (`longestBusyMs` 0). Between fcd918d4f8
(2026-11-19) and this rule an unfiled `io` wait was excluded from its waiter
and filed by no one: replayed over main's 7 days of traces (2026-11-12 → 11-19), `bg
watch-edited-files:pass` (2.4–3.0 s of git children: 123 traces, now 56 as
the slow child, 67 as the pass whose children were each under the bar),
`plugin-tree:first-build` (its worker's 2–3 s build, declined as a `bg`
waiter's: 72, now 68 as `wait worker:plugin-tree.faceted-index`) and
git-bound loaders (`build.deployment`: 27) were reported nowhere. The tradeoff: an `io` wait is timed to the callback
that reads its answer, so during a busy restart replay its event-loop delay
lands in the waiter's own time too — restart `loader` traces judged slow 272
→ ~328 in the replay; restart `sub` 50 → 52 and `flush` 0 → 0 (their own
time takes no child's).

**A child op stays its own.** Its unfiled time is not rolled into its parent:
a parent of many small children (a `flush` of pushes, a `sub` around its
loader) is judged on its own time, and the latency the children add where
someone waits on it — `deliver:<key>`, an `element`, a job's deadline.
Rolling child work up was replayed too: restart `sub`s judged slow went 50 →
73–109, the restart-contention false positives fcd918d4f8 removed.

**Unfiled queue waits are never own time.** A closing entry offers each gate's
residue (its unfiled queue waits, summed) to `onSlowWait`. What no
subscriber filed climbs to the nearest open ancestor, then the gate's busy
timeline. It is never added back to an op's own time. It used to be
(`residueMs`, 2026-11-14 → 11-19): during main's restart replay every read
queued on `read-admit`, and a `loader prototypes.list` filed at 2.78 s "own"
was 1.62 s queue + 0.13 s file stats + ~1 s of gaps. The waits a report took
off stay on its row as layers.

**What remains is not all CPU.** Own time is the span's code, its leaves
(queries: its work) and awaits nothing meters. It also includes the time its
continuations sat behind other ops' turns on a busy event loop: no
per-context turn signal exists to tell those apart (see *Event-loop stalls*).
During a restart replay that part dominates: on main (2026-11-19 16:01),
`prototypes.list`'s ~1 s of gaps against ~0.1–0.2 s of its own code (thread
ledger), on a thread busy ~9 s of that minute.

The gate's busy stretch is a different measurement (`GateBusyWait`, `busy`
set): the positions of independent ops' leftover waits (`QueueTally.spans`,
carried up with the residue) are laid on the gate's timeline
(`addGateBusy`), and waits that touch join into one stretch — time the queue
held without a break. Its length is the time a burst took to drain, so the
longest a reader arriving at its start could have waited: a latency, judged on
the per-op bar (slow-ops: `loaderMs`), filed at most once per stretch, its
longest single waiter named (`longestWaitMs`). It replaced a 60 s window that
SUMMED the waits (mean queue depth, Little's law): a restart's replay of ~250
reads queued together for 0.5 s summed to 15–20 s and fired it on nearly every
push, while no reader waited 1 s (main, 2026-11-13). Every wait stays in the
gate's meter (`GateMeter`, below) either way.

### Claims — one slow op, filed once (`excludedMs` / `claims`)

An `onSlowSpan` handler gets `(span, claim)`. Calling `claim()` says "I filed
this span as its own slow op": the recorder then names it on every still-open
enclosing entry, on a per-claimant track (`<kind> <label>`, the row's layer), and
takes it off the own time (`excludedUnion`) of the nearest open one only — the
entries above already exclude that one whole as a child op (see *Own time*). Each record carries `excludedMs` (`≤ durationMs`)
and `claims` (per claimant); a monitor judges `durationMs − excludedMs`. So a
slow loader is filed once, not again as its `push`, its `flush`, the watcher
`bg` pass or the `http`/`sub` around it — an enclosing span is filed only when it
was slow on top of what it contained. A child is always recorded (and judged)
before its parent closes, so the order is right by construction; a detached
child finishing after its parent closed claims nothing there (closed entries are
final).

A **latency leaf** — `recordSpan(kind, label, ms, detail, { latency: true,
waits })` — is a window spent waiting on the enclosing entry's work, not work
of its own (a delivery's first-notify → send under the `flush`). It is judged net
of its own `waits` (a declared `throttle-hold`) and of the claims its enclosing
entry collected inside its window (`claimBands`, positioned, bounded at 16 —
overflow drops the smallest, so a leaf can only be judged on more own time,
never less). A plain leaf (a `db` query) never subtracts a sibling's claim:
concurrent siblings are independent work. See
`research/2026-10-30-global-slow-op-one-cause-one-report.md`.

**Joins — another run's time, wherever the latency is judged.** A `join` wait
(awaiting a run already in flight: a coalesced read, a watched memo's pass) is
also kept positioned per entry (`joinBands`, bounded at 16). As an entry
closes it hands them to its nearest open ancestor, KEYED by the run
(`childJoins`, `<kind> <label>`, at most 64 runs per entry). A latency leaf
that names the run whose result it delivers — `joinsOf: { kind, label }`
(server-core: `deliver:<key>` names its `push <key>`) — takes that run's joins
inside its own part off as waits, unioned with the claims there (an interval
both joined and claimed comes off once). Only that run's: the enclosing
`flush`'s own wait bands mix every sibling resource, so subtracting them would
take another resource's wait off this one. `EntrySpanOptions.onJoined(ms)` hands
an entry, as it closes, its subtree's join union — for a latency judged
elsewhere (server-core passes it through `wrapOrigin`, and the runtime stamps
it on the sub-ack as `joinedMs`, which the browser's `element` takes off).
Before this, `deliver:edited-files` was 26 s own of 30 s on main (61 min,
2026-11-06): its time was the `bg watch-edited-files:pass` it joined, filed
there.

**Lanes — a queue behind an earlier entry.** A root entry kind is a *lane*
(`flush` passes run one after another). Every claim that reaches a root entry,
and a root entry filed itself, is also kept in its lane's ring (`laneClaims`,
positioned, bounded at 32, drop-oldest), which outlives the entry. A latency
leaf's window is laid out `waits` | `queue` | own part: `opts.queue: { layer,
ms }` (latency leaves only — a type error otherwise) is the part spent queued
for its lane (a delivery waiting for an earlier pass). The leaf excludes it in
full and is judged on its own part only (claims are intersected with that part,
so nothing is taken off twice). The queue's remainder, net of what the lane
claimed inside it, goes to `onSlowWait` as `{ layer, ms, caller: the leaf,
latency: true }`, so a slow pass is filed once (by its slow op, or as the
lane's queue), never again by each delivery behind it. See
`research/2026-10-30-global-slow-op-flush-queue.md`.

## Windowed max (`recentMaxMs` / `maxAgeMs`)

Each aggregate keeps a rolling ~5-min bucketed max: `recentMaxMs` answers "is it slow NOW"
(0 when idle past the window), while `maxMs` is the sticky since-boot peak and `maxAgeMs`
its age — so a stale spike reads as stale. `getRuntimeProfile()` sorts aggregates by
`recentMaxMs` desc. All timestamps flow through one injectable clock seam (`installClock`,
default `performance.now()`) so union/bucket arithmetic is deterministic under test
(`core/recorder.test.ts`).

The ambient context is supplied by an **injected** `SpanContextRuntime`, so the core stays
pure (no `node:async_hooks`, web bundle unaffected): `core/recorder.ts` holds a
no-op-by-default runtime + `installSpanContextRuntime(rt)`, and `server/internal/install.ts`
installs an `AsyncLocalStorage`-backed one as a module side effect (imported by the routeless
`server/index.ts`, so the registry wires it up at boot, before `Bun.serve`). The web never
imports `server/`, so on the client every entry point is a transparent passthrough.

### Entry points vs leaves

- `recordEntrySpan(kind, label, fn)` — used at the HTTP (`endpoints/core/implement.ts`),
  loader (`server-core/core/resources.ts` `wrapLoad`), origin (`server-core` `wrapOrigin`,
  for the `sub`/`push` entries), and job (`infra/plugins/jobs/server/internal/worker.ts`,
  wrapping each `job.run()` in a `job` entry span labelled by the job name) chokepoints.
  Runs `fn` under a fresh ambient `EntryContext` (chained to the live parent, with per-track
  union accumulators), while recording the entry span itself against the *outer* parent (an
  entry is never its own parent). Records in `finally`, materializing
  `waits`/`waitMs`/`childMs`/`selfMs`.
- `recordSpan(kind, label, durationMs, detail?, opts?)` — leaf path (DB pool wrapper);
  attributes to the current ambient context automatically. A leaf has no decomposition:
  `waitMs`/`childMs` default to 0, `selfMs` to the full duration — unless `opts.waits`
  names waits inside it; `opts.latency` makes it a latency leaf (see Claims).
- `beginWait(layer, kind)` / `gateWaitHooks(layer, kind?)` / `markWait(layer)`
  — see *Waits in progress* above. `kind`
  (`WaitKind`, required) says what the caller waited FOR: `queue` means
  capacity on a shared gate or pool, so the time is the gate's; `join` means an
  identical run already in flight (a coalesce or dedupe), or a 0 ms hit/miss
  marker, so the time is that run's. A slow-op consumer judges a span on its
  own time (its waits excluded), so this is what decides who the waited time
  is charged to. `io` means work another party does — the disk
  (`packages/timed-fs`), a child process, a worker thread: offered
  to `onSlowWait` whoever waited, and, unfiled, its waiter's own time.
- `onSlowWait(handler, { thresholdMs })` — the push seam for a slow `queue`
  or `io` wait (`kind` says which): called once per wait, from its charge (an ancestor's union would
  count it once per level), with the layer, the ms and the innermost open
  entry that waited — and from a latency leaf's `queue` (see Lanes), flagged
  `latency: true`. Context-less waits already become a `db [layer]` span and
  are not handed here. slow-ops files each as `wait <layer>`. A wait handed
  to a subscriber carries `holders` when its gate's gauge names them
  (`GateGauge.holders`, read as it is filed): who it waited behind.
- `currentCallerKind()` — the `kind` of the **innermost** enclosing entry point (or
  `undefined` when none is active). A thin read of the same ambient context; the DB pool
  wrapper uses it to decide whether to capture a query's read-set. Read it synchronously,
  before any await.
- `currentOriginClass()` — the lane (`"interactive" | "background"`) of the **outermost**
  enclosing entry, or `undefined` when none is active; the DB pool gates partition on it.
  Walks the `EntryContext.parent` chain to the root and maps `root.kind` through an
  exhaustive `Record<SpanKind, OriginClass>` (so adding a span kind is a tsc error until it
  picks a lane): `http`/`sub`/`loader` interactive, `flush`/`push`/`cascade`/`job`/
  `bg`/`route`/`membership` background. Root, not innermost, because inside a resource load the innermost kind is
  `loader` regardless of *why* the load runs. Unlike `chargeWait`, the walk does not skip
  closed ancestors (it only reads `kind`). Allocation-free; read it synchronously, before
  any await.
- `runInRootContext(fn)` — run `fn` in the root async context, outside every request,
  loader, lane and suppression scope, so a timer it arms (a change producer's coalescing
  window and flush) is attributed to itself, not to whichever writer triggered it. The
  server installs it over an `AsyncLocalStorage.snapshot()` taken at module eval
  (`server/internal/install.ts`); with no runtime installed (a browser host) it runs `fn`
  as is — attribution only, never correctness.
- `runInBackgroundLane(fn)` — declare that `fn` is background work whatever triggered it,
  overriding the origin walk. Backed by its own AsyncLocalStorage (`server/internal/install.ts`),
  so it propagates through awaited DB work — including down to the `pool.connect()` a nested
  `db.transaction()` takes. Used by the observability writers (slow-ops, reports, trace
  capture, contention), whose transactions would otherwise inherit the origin of whichever
  human request tripped them, and by the jobs worker's post-run cleanup writes, which sit
  outside the `job` entry span. Deliberately **separate** from `runWithoutProfiling`: "don't
  record" and "isn't background" are different claims — `debug/profiling/boot-bench`'s
  load-generator wants the former while deliberately holding real gate slots. See
  `research/2026-07-09-global-interactive-lane-origin-based-db-gating.md`.

### Span detail (`variant` + `measures`)

Both recording calls take an optional last argument, `SpanDetail`:
`{ variant?: string; measures?: Partial<Record<SpanMeasure, number>> }`.

- `variant` names *which instance* of the operation ran. The loader span uses it for the
  canonical params. The label stays the resource key, so one resource is still one
  aggregate / one slow-op row, and consumers break a row down by variant themselves.
  Capped at 200 chars. Never put per-call values in a **label**. That is what `variant`
  is for.
- `measures` are numbers from the closed `SPAN_MEASURES` set: `subscribers` / `frameChars`
  (on `push deliver:<key>`), `ids` (a scoped refill loader, a `route`), `sinceChangeMs`
  (a `route`). Closed like `SPAN_KINDS`, so every surface can label each one. Each
  aggregate keeps `measuresMax`: the largest value of each measure across its records.
  That makes the widest fan-out or largest frame visible even when no single span was
  slow.

An empty detail is recorded as none. `SlowSpan.detail` carries it to `onSlowSpan`
subscribers (slow-ops persists it). The flight ring does not carry it.

### Live-state plumbing kinds (`route`, `membership`)

- `route`: the change-feed routing one Postgres change into the resource runtime (label =
  the table; `change-feed/server/internal/route-span.ts`). A leaf with no parent.
- `membership`: a window resource's ids-only query (`windowIdsOf`), under its `push`
  origin (label = the resource key; the runtime's `wrapMembership`). Its own kind for the
  same reason as `cascade`: it stays out of the loader read-set index, and it is told
  apart from the value query.

The live-state HTTP fallback records as `http` `GET /api/resources/<key>` (the runtime's
`wrapHttp`), 304s included. See
`research/2026-09-23-global-live-state-plumbing-slow-op-coverage.md`.

`getRuntimeProfile()` returns each aggregate (sorted by `recentMaxMs` desc) with its
`byParent` breakdown (count desc) and summed `waitTotalMs`/`childTotalMs`/`selfTotalMs`, and
each `slowest` span with its `parent` and per-span `waitMs`/`childMs`/`selfMs`.

## Boot work a hook leaves running (`runBootHook`, `outlivesBootHook`)

server-core runs each boot hook (`onReadyBlocking`, `onReady`, `onAllReady`) through
`runBootHook` (the profiler seam): the hook runs in a boot-hook scope (its own
AsyncLocalStorage, installed by `server/internal/install.ts`), every `runTracked` started
inside it — however deep in the hook's call chain — is counted until it settles, and the
labels still running a macrotask after the hook returned come back as `leftRunning`. On a
serving desktop backend (`serve`) server-core files them as a `BootHookLeftWorkRunning`
error report, one row per plugin and hook: that work runs inside the restart replay
(every reopened tab re-reading its live data), competing with reads the user waits on,
and the replay gate the settled phase waits on (`whenReplaySettled`) never sees it.

What a flagged site becomes:

- **A catch-up pass** (a first pass, a backfill, a purge) → `defineWarmup`
  (`infra/warmup`), drained once the replay settled.
- **A result a tab's read needs** → computed on demand by that read (prototypes' records,
  `ensurePrototypeRecords`), never a boot task the read waits on.
- **The hook's own setup** (a watcher's first mount, a catch-up pass between a first pass
  and a subscription) → awaited by the hook.
- **A long-lived service, or work that must start at boot** (the change feed's LISTEN
  connection, a digest of the modules this process imported, a contract waiting for the
  previous backend to exit) → `runTracked(label, fn, { outlivesBootHook: "<why>" })`. Its
  run, and everything it starts, runs outside the hook's scope. The reason is the
  justification a reviewer reads.

Work deferred on someone's behalf runs in the asker's context, not whichever one
starts it: `captureContext()` snapshots it, and `packages/coalesce` starts a
trailing run in the context of the trigger that asked for it first — otherwise a
file change folded behind a boot hook's awaited first pass would run as the
hook's leftover work.

Why runtime and not a lint rule: the launch is usually in a helper in another file
(`startXWatcher` → `void runTracked(…)`), and the type-check lint sees other files as
`.d.ts`, so no rule can follow a hook into its callees. Work started after the hook
returned (a timer's tick, a watch delivery) is not counted; a promise detached WITHOUT
`runTracked` is invisible to it (`detached-work-safety/no-untracked-detached-work` already
makes `void <call>` in server code a `runTracked`).

## Monitoring self-meter (`getSelfMeter`)

Every observability write runs inside `runWithoutProfiling`, so monitoring's own cost is
invisible to the profiler — the tool you'd reach for. So `runWithoutProfiling` **meters
itself**: everything suppressed is by definition monitoring work, so two module counters at
that one chokepoint attribute all of it with zero per-callsite edits, and being plain
numbers outside the recorder's span path they can never re-feed the profiler.

`getSelfMeter()` returns cumulative-since-boot `{ count, totalMs }`: one *op* per
**outermost** `runWithoutProfiling` scope, `totalMs` its wall-clock from call to settlement
(sync return, sync throw, or promise settle — observed on a detached derived promise, so the
original result passes through untouched and a rejection is never absorbed). A scope opened
while suppression is already active (detected via `suppressed()` itself, ALS semantics, so
it holds across awaits) adds neither count nor time — never double-counted. Two *concurrent*
outermost scopes each meter their full wall (a sum, like CPU-time accounting): separate
monitoring work items. The meter is monotonic and **never reset** (not by
`resetRuntimeProfile` either) — consumers diff successive readings, and a reset would
surface as a negative delta.

Consumer: the health sampler (`debug/health-monitor` `process-sampler.ts`) diffs it each
10 s tick into the optional `HealthSample.monitorOps` / `monitorMs` per-tick deltas →
`health.jsonl` → the Debug → Health charts. So a monitoring storm shows up as a spike even
though every one of its spans is suppressed.

## Loader→table read-set capture

Each `loader` entry captures the tables its DB queries read (`recordReadTables`, from the
pool chokepoint, matching only `FROM`/`JOIN`) and, in `recordEntrySpan`'s `finally`, hands
them once to the **installed loader read-set sink** (`installLoaderReadSetSink`) — an
EMPTY set for a run that read nothing, so the per-run capture always describes the
last run (a nested loader entry — a followed collection's fresh read inside a
follower's loader — captures its own reads, never its parent's). The same
capture is also handed to the entry's own `onReads` (`recordEntrySpan`'s
last argument — server-core's `wrapLoad` passes the runtime's `RunCapture`),
so the drift guard judges each run on its own reads, never on whichever run
of the key closed last. The index
it feeds — the per-run capture the runtime's route drift guard (A8 / D5) judges and the L2
persist seam stores as `tables_read`, plus the append-only union `_debug` shows — is runtime
state owned by `server-core/core/read-set.ts`, not profile data: no change is routed through
it (every DB-backed resource declares its reads), but the drift guard and the persisted seed
depend on it. `server/internal/install.ts` wires the sink to server-core's
`recordLoaderReadSet`, `resetRuntimeProfile()` does not touch it, and the capture is **not**
gated on the `EQUIN_PROFILING=0` kill-switch (a kill-switched profiler would blind the
drift guard). It still honours `runWithoutProfiling` suppression, which is an attribution rule —
observability writes inside a loader's context are not that loader's dependencies. No sink
installed (the web, a bare test) = nothing captured. The per-run capture is also the input
of the runtime's route drift guard (A8): a ROUTED resource's loader reading a table none of
its routes names is reported (a failed load under a test runner — pinned by
`server/internal/install.test.ts`). See
`research/2026-09-29-global-scoped-change-routing.md` (P0, P1).

## Flight-recorder substrate

Three side-structures let a slow-event consumer materialize ONE coherent instant — who was
in flight, who just finished, how saturated each gate was — from which the true call tree
can be rebuilt in a single read (see
`research/2026-07-02-global-slow-event-flight-recorder.md` and
`research/2026-07-09-global-span-instance-identity-call-tree.md`):

- **Open-entry registry** — a `Set<EntryContext>` maintained by `recordEntrySpan` (add
  before the run, delete in the `finally` — paired on every path, including throws), which
  lets a snapshot enumerate every concurrently in-flight op. Leaf `db` spans have no context
  and are not registered (the completed ring covers them). The delete runs *before*
  `record()`, so a tripping span is never in its own `open` list — the ring carries it (see
  the ordering note below).
- **Recently-completed ring** — a preallocated 4096-slot circular buffer written inside
  `record()` for spans ≥ 5 ms (the blocker often finishes before its victim's span ends,
  so open entries alone can't name it). Slots are mutable and overwritten in place;
  placement inside `record()` puts it behind the `EQUIN_PROFILING=0` kill-switch and
  the suppression early-returns. A completed **entry** span also parks its `waits` and
  `waitBands` in the slot, so it carries the same per-layer breakdown an open one does. The
  per-query **leaf** path (`recordSpan`) writes scalars only and stays allocation-free.
- **Gate-gauge registry** — `registerGateGauge(layer, read)` (throws on a duplicate layer)
  + `readGateGauges()` + `resolveGateGauges(readings)`. Layer names use the SAME vocabulary as the `chargeWait` layers
  above, so a snapshot's gate occupancy joins directly to span `waits`; gate *owners*
  self-register — the recorder never names a gate. A reader is **synchronous and
  in-memory** — it is read at a trace's trip instant, as a slow wait is filed (`holders`)
  and in `getRuntimeProfile()` — so it never does I/O. A gate shared across processes
  (host-admission's pools: the holders are other backends' flocks) cannot know its
  `active` without opening every slot file, so its reading carries
  `active: { probe }` (`GateReading`) instead of a number; `resolveGateGauges` awaits the
  probes, one gate at a time, off the hot path (the trace `gates` class's enrich, the
  stuck-span watchdog). The union keeps a sync reader from mistaking a missing host
  count for one. Before this, the host pools' gauge opened every slot file
  synchronously on each read — on the thread that was filing the slow wait.

### Per-instance identity (`id` / `parentId`)

`{kind,label}` names a span *class*, not a *run* — two concurrent `loader:tasks` runs under
different parents are indistinguishable by label, so a label-keyed window cannot be
reassembled into a tree. Every span run therefore gets an `id` from one monotonic
process-lifetime counter, and carries the enclosing entry run's `id` as `parentId` (`null`
at the top level), resolved off the live `EntryContext.parent` chain. An entry mints its id
at **open**, before `fn` runs, so a child can name it while it is still in flight; a leaf
mints at record time. `SlowSpan` and `FlightSpan` both carry the pair.

The counter is **never reset** — not by `resetRuntimeProfile()`, which deliberately leaves
live EntryContexts alone (they deregister in their own `finally`); a restarted counter would
hand an in-flight parent's id to a fresh child, splicing one call tree into another. Because
a parent always opens before its child, `parentId < id` holds for every span: the edge set is
**acyclic by construction**, and a consumer can refuse `parentId >= id` as corruption. A
`parentId` that resolves to nothing in the window is an **orphan**, not corruption — the
parent may be a sub-5 ms span the ring never took, one evicted before capture, or (for a
detached child) one that closed long ago. Consumers render such a span as a root.

### `captureFlightWindow`

`captureFlightWindow({ windowStartMs, maxOpen?, maxCompleted? })` (defaults 200/400)
synchronously materializes both span sources into a `FlightWindow` `{ atMs, open, completed }`
of `FlightSpan`s. Open spans carry `t1: null` and per-layer `waits` + `waitBands` read
mid-flight — sound, since a track's union is monotonic accumulated coverage and its band list
only ever extends (the bands are **copied**, as the live context may extend them after the
capture). Completed spans are the ring slots overlapping the window, newest first, carrying
the same `waits`/`waitBands`. Ids are unique across `open ∪ completed` (a context leaves the
registry before its span reaches the ring), so a consumer indexes both by `id` and links by
`parentId`.

The open set is **ancestor-closed**: after taking up to `maxOpen` entries from the registry,
every still-open ancestor of a taken entry is pulled in too, so `maxOpen` is a *soft* cap
(hard-bounded by `openEntries.size`) — a hole mid-chain would silently reparent a whole
subtree onto a root it never ran under. The walk stops at a closed ancestor: that edge is a
legitimate orphan, not a fillable hole. Completed spans need no such pass — a parent
finishes *after* its child, so it is newer in the ring with `t1 ≥ child.t1 ≥ windowStartMs`,
surviving both the window filter and the newest-first `maxCompleted` cut before its children.

**Ordering inside `record()`: the ring write must precede the `onSlowSpan` notify loop**
(covered by `core/recorder.test.ts`) — a handler calls `captureTrace` →
`captureFlightWindow` *synchronously*, and by then the tripping entry is already out of
`openEntries`, so a ring write after the notify would leave the trip span in neither source.
Both early-returns still guard the write, so kill-switch and suppression semantics are
unchanged. `resetRuntimeProfile()` clears the ring (profile data) but keeps gauges
(structural registrations), leaves open entries to their own `finally`, and does not touch
the id counter.

Overhead: one `++` per span, one paired `Set.add`/`Set.delete` per *entry* span (entry spans
are low-rate — never per-DB-query), a comparison + ~12 field writes per qualifying completed
span (label strings and the `waits`/`waitBands` references are shared, not copied), and per
`chargeWait` one comparison plus at most one push into a `WAIT_BAND_CAP`-bounded array. The
remaining allocations are one flat band array per completed entry span, and whatever
`captureFlightWindow` builds on a (rate-limited) slow-event trip.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Load-bearing: yes
- Core:
  - Uses: `infra/launcher/env-names.readEnv`
  - Exports (types):
    - `Aggregate`
    - `BootHookScope`
    - `ContextRunner`
    - `DescribedWaitEnd`
    - `EntryContext`
    - `EntryCost`
    - `FlightSpan`
    - `FlightWindow`
    - `GateGauge`
    - `GateHolder`
    - `GateMeter`
    - `GateReading`
    - `InProgressWait`
    - `LeafSpanOptions`
    - `LoopStall`
    - `OriginClass`
    - `ParentBreakdown`
    - `RunTrackedOptions`
    - `SlowSpan`
    - `SlowSpanHandler`
    - `SlowWait`
    - `SlowWaitHandler`
    - `SpanDetail`
    - `SpanKind`
    - `SpanMeasure`
    - `SpanMeasures`
    - `SpanRef`
    - `Track`
    - `WaitBand`
    - `WaitBreakdown`
    - `WaitDetail`
    - `WaitEnd`
    - `WaitKind`
  - Exports (values):
    - `__contribute`
    - `__pushBand`
    - `beginDeferredWait`
    - `beginDescribedWait`
    - `beginWait`
    - `captureContext`
    - `captureFlightWindow`
    - `currentCallerKind`
    - `currentEntryLabel`
    - `currentOriginClass`
    - `gateWaitHooks`
    - `getRuntimeProfile`
    - `getSelfMeter`
    - `installAsyncContextRuntime`
    - `installBackgroundLaneRuntime`
    - `installBootHookScopeRuntime`
    - `installLoaderReadSetSink`
    - `installProfilingSuppressionRuntime`
    - `installSpanContextRuntime`
    - `loopStallsSince`
    - `markWait`
    - `noteLoopObserved`
    - `noteLoopTurn`
    - `onSlowSpan`
    - `onSlowWait`
    - `profilerNowMs`
    - `readGateGauges`
    - `recordEntrySpan`
    - `recordReadTables`
    - `recordSpan`
    - `registerGateGauge`
    - `resetRuntimeProfile`
    - `resolveGateGauges`
    - `runBootHook`
    - `runInBackgroundLane`
    - `runInRootContext`
    - `runTracked`
    - `runWithoutProfiling`
    - `SLOWEST_CAP`
    - `SPAN_KINDS`
    - `SPAN_MEASURES`
    - `waitSplit`
- Cross-plugin:
  - Imported by: 78 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra` ×24
    - `debug` ×21
    - `apps` ×7
    - `conversations` ×6
    - `database` ×3
    - `packages` ×3
    - `build` ×2
    - `reports` ×2
    - `tasks` ×2
    - `auth`
    - `companions/browser-extension`
    - `config_v2`
    - `framework/tooling/web-artifacts/served-addresses`
    - `integrations/google-maps/browser-config`
    - `network/live/change-feed`
    - `plugin-meta/plugin-tree`
    - `primitives/log-channels`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `server/internal/install.ts` (debt)
    - `timed-fs/no-untimed-fs-read` — `scripts/fs-meter-bench.ts` (sanctioned)
    - `semaphore/slot-use-site` — `server/internal/install.ts` (sanctioned)
- Test helpers:
  - Core: `@plugins/infra/plugins/runtime-profiler/core/testing`
    - `installClock`

<!-- AUTOGENERATED:END -->
