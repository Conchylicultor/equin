# host-semaphore

Cross-process twin of `packages/semaphore`.
`createHostSemaphore({ slots, size, backgroundLimit? })` returns the same
`{ run(fn, hooks?) }` shape, but the bound is enforced *across* processes — at most
`size` `run` bodies execute at once across every process sharing the same `slots`
directory, not just within one. Use it to cap CPU-heavy work (git subprocesses, `git archive | tar`,
filesystem walks, JSONL scans) across the ~16 worktree server processes sharing one
box, where a per-worktree in-process `createSemaphore` of N still admits ~16×N
concurrent spawns.

`backgroundLimit` (optional, default `size` — no reserved floor) partitions the pool
into two lanes; see **Reserved floor** below.

The bound is N `flock(2)` advisory lock files — `slot-0.lock … slot-(N-1).lock`
inside `slots` (one holder per fd, so at most `size` holders host-wide). flock
auto-releases when the fd closes **or the holding process dies**, so a SIGKILLed
server never leaks a slot — the same crash-safety every host pool relies on (all
declared through `@plugins/infra/plugins/host-admission`, the sole importer of this
primitive).

## The slot directory is handed in, never derived

`slots` is a **declared** `DataDir` (`@plugins/infra/plugins/paths`), supplied by
the caller. This primitive derives no path of its own — and that is a deliberate
correction, not a style choice. It used to do
``join(SINGULARITY_DIR, `${name}-slots`)`` itself, which meant one primitive
silently minted a top-level directory in `~/.singularity/` per pool: ten existed on
disk, only seven had a live `defineHostPool`, and nothing in the repo could
enumerate any of them because the paths existed only as a template literal inside a
function.

The pool's identity — the `name` in every error message below — IS `slots.spec.name`,
so a pool cannot be named one thing and stored under another. The path is read
through `slots.path` on every use rather than captured at construction, because
`defineHostPool` runs at consumer module eval and the data root is env-overridable
after that (see `dataRoot()`).

## Hybrid acquire — fast path in-process, fan-out only under contention

A blocking `flock(fd, LOCK_EX)` is fatal in a long-running server event loop (it
freezes the loop until the lock frees). So acquire is hybrid:

- **Fast path (in-process):** a non-blocking `flock(LOCK_EX | LOCK_NB)` sweep over
  the N fds. A single `LOCK_NB` syscall is microseconds and never freezes the
  loop. When a slot is free this is the whole story — no subprocess, no tax.
- **Slow path (all slots busy):** we must *wait* for a slot without blocking the
  loop, and without stranding on one slot. A blocking `flock(LOCK_EX)` parks on a
  **single** open file description, so a waiter that picks one slot is never woken
  when a *different* slot frees — that slot then sits idle. Instead the head waiter
  **fans out**: it starts one `waitForFlock` per slot (a `flock-wait` child each,
  `packages/flock`) and takes the **first** to grant `granted\n`. Any freed slot
  wakes it — including one freed by a **SIGKILLed** holder, since flock releases on
  death too. The losers are then SIGKILLed and reaped (`await exited`), which cancels
  their blocked flocks and hands back any slot a loser had already grabbed, before the
  caller re-sweeps for extras. If every child closes stdout without granting, acquire
  throws loudly rather than silently dropping the bound.

### First come, first served — one line per class

Waiters queue in a **FIFO line** (`packages/ticket-line`) and only the line's
**head** fans out. A ticket is a flocked file named by the machine-wide
monotonic clock; each waiter blocks on the ticket just ahead of it (one
`flock-wait` child), so a leave — or the death of the process ahead, which
drops its flock — wakes exactly the next waiter. Process cost per contended
class is `size + (W − 1)` (the head's fan-out plus one ticket-wait child per
other waiter), versus a naive `size × W`.

**One line per class, not per pool.** A class is (lane, priority), each with its
own line `line-<lane>-<priority>/` in the slot directory:

- **Within a class, strict arrival order.** An acquire takes the fast path only
  while its own line is empty, so a fresh caller never barges past an earlier
  one of its class.
- **Across classes, the existing rules.** Lanes partition slot capacity (below),
  `low` yields to waiting `normal` acquires (*Priority*), and the heads of two
  classes that share slots race for a freed one. One shared line would break
  both: a main build (interactive) parked behind an agent build waiting for a
  background slot the main build does not even need.

A `low` acquire keeps its ticket across every yield to `normal` demand, so
yielding never costs it its place among `low` acquires.

**Deadlock-free.** A ticket is only ever held by *waiters*; a slot-holder never
needs one, and the head waits only for a slot, which holders always release. The
wait-for graph is acyclic.

### Every wait is one `waitForFlock`

The ticket wait, the size-guard wait and each fan-out slot are each one
`waitForFlock(path, { signal })` from `packages/flock`: a `flock-wait` child
(`packages/flock/scripts/flock-wait.ts`) that parks the blocking flock on a
worker thread, relays `granted`, and holds the lock until the returned
`HeldFlock` is released — or until this process dies. Why the block sits on a
worker thread (the orphan hole) is documented there. The scripts lived here
until `packages/single-flight` needed the same wait; the fan-out now aborts the
losers' waits (each reaps its own child before settling) instead of killing raw
children.

### Reserved floor — the `background` / `interactive` lanes

`backgroundLimit < size` partitions slot *capacity* so that
saturating background work can never starve interactive work of the whole pool. Each
`acquireShare(max, hooks?)` / `run(fn, hooks?)` draws from a lane via `hooks.lane`
(default `"background"` — the safe choice, since it can never reach the floor):

- **`background`** sweeps and fans out only over `slot-0 … slot-(backgroundLimit-1)`.
  Its window is `backgroundLimit` slots; `max` clamps to that. Slots at or above
  `backgroundLimit` are never even *opened* by a background caller, so the reserved
  floor is structurally unreachable — a saturated background lane blocks rather than
  spilling onto it.
- **`interactive`** may use all `size` slots but sweeps them **high-index-first**
  (`slot-(size-1) … slot-0`). This reversal is the whole trick: without it,
  interactive holders would take the low slots in file order and the reserved floor
  (the high slots background can never reach) would sit empty while background starves.
  So an interactive caller lands on the reserved floor first and only touches the
  shared low slots once the floor is full.

When `backgroundLimit === size` (the default — the un-partitioned pools) the two
windows cover the same slot set — `interactive` reversed, `background` forward — and
lane windowing is behaviourally inert; the four historical non-laned pools are
byte-for-byte unchanged.

### Size and split are the pool's identity — and the live pool wins

`size` names the slot-file *set*, so an old-size process holding `slot-7.lock` is
invisible to a new-size process that only sweeps `slot-0..3` — the bound would be
silently exceeded. `backgroundLimit` names where the reserved floor begins, so two
processes that disagree on it carve the same slots at different indices — one's
background slot is another's reserved-interactive slot, and the floor guarantee
silently breaks. A `<dir>/size` sentinel encodes **both** as
`"<size>:<backgroundLimit>"` and is **the one authority every process defers to**.

The identity is **host state, not a per-process belief.** A pool's size is derived
from code (`infra/host/host-admission`'s reserved-pool table) and this box runs many
checkouts at once, so any commit that moves the budget leaves every *other* checkout
at the old pair. A process that finds the pool already open at a different pair
therefore **adopts** the live one (and logs it) rather than throwing: joining the set
everyone else sweeps is the only choice under which the bound holds and the floor
sits where the holders think it does. The declared pair still lands — it is written
the moment the pool is genuinely idle — so a budget change rolls out on its own.

Mechanically, on **every** acquire: read the sentinel; if it already names the
declared pair, proceed (one small file read — the steady state). Otherwise take a
guard on `<dir>/.size.lock` (non-blocking flock in-process; if contended — another
process is mid-initialization, a benign race — it **waits** for the guard via one
`flock-wait` child, never crashing on the contention), re-read under the guard, and
then: absent → write the declared pair; different on either number → a non-blocking
sweep decides — pool idle ⇒ claim the declared pair (rewrite the sentinel, unlink
now-extra slot files), pool live ⇒ adopt the sentinel's pair for this instance.
`liveSize()` reports which set is actually being swept. Because the cheap test
compares against the *declared* pair, an adopted instance keeps re-reconciling and
converges back the first time the pool drains — an adoption is never permanent.

A bare legacy `"<size>"` sentinel (pre-reserved-floor) reads as `size:size` (no floor),
so the historical non-laned pools migrate silently; a number missing/invalid,
`backgroundLimit > size`, or a stray third field is corruption and throws — now the
**only** throw on this path. The reconcile is memoized as an in-flight promise
(concurrent in-process callers share one run) and cleared on settle.

### Priority — `low` yields to waiting `normal` acquires

`hooks.priority` (default `normal`) is orthogonal to the lane: the lane decides
WHICH slots an acquire may take, the priority WHO GOES FIRST. The sidequest
track's ops (`./singularity` build / check / test / e2e / push from a checkout
whose task is a sidequest) acquire at `low`, so they never take a slot a
main-track op is queued for.

The mechanism is one more flock file, `demand.lock`, per pool:

- A `normal` acquire on the **slow path** holds it **shared** for as long as it
  waits (`flockTryShared`, else a shared `waitForFlock`), released in the same
  `finally` as its ticket. Fast-path acquires never touch it.
- A `low` acquire (1) takes it **exclusive** non-blocking to ask "is anyone
  waiting?" — if not, releases it at once; if so, waits for the exclusive lock in
  one `flock-wait` child, granted by the kernel the instant the last `normal`
  waiter stops waiting (push-based, no polling); (2) takes slots like anyone
  else; (3) re-asks, and if a `normal` waiter appeared meanwhile — typically
  while it was fanned out for the very slot it won — hands everything back and
  returns to (1), so the `normal` waiter's fan-out takes the slot.

flock grants a shared request whenever no exclusive HOLDER exists (a pending
exclusive request does not block it), so a `low` waiter never delays a `normal`
one's announcement; the only contention is the instant a `low` acquire holds the
lock exclusive, which the `normal` side covers with its shared wait child.

What it is not: pre-emption (a `low` holder keeps its slot until it releases),
and starvation-free (`low` waits as long as `normal` demand persists — the
point). Crash-safe like every lock here: a dead `normal` waiter's shared lock
goes with its process. `onWaitStart` fires once per acquire however often a
`low` acquire goes back to waiting, and `depth()` counts a `low` acquire parked
on the demand gate.

## `acquireShare(max)` — a whole share up front

`run` holds exactly one slot. A caller that fans out N units of heavy work would
otherwise `run`-wrap each unit precisely when the box is already under pressure.
`acquireShare(max, hooks?)` is the answer: **acquire the whole share once, before
fanning out.** It blocks until at least one slot is held, then greedily takes any
additional free slots up to `max` with a single non-blocking sweep, returning a
`HostShare { slots, release }` naming how many it actually got (`1 … min(max, size)`).

- **Idle pool = pure fast path.** The up-front `flock(LOCK_NB)` sweep grabs up to
  `max` free slots in-process — no subprocess. This is the whole story when slots
  are free.
- **All slots busy (or a waiter of the class queued) = line + fan-out.** The
  acquire queues in its class line and, at the head, fans out one child per slot (see above),
  taking the first grant; a second non-blocking sweep then picks up any extra slots
  that freed while we waited.
- `max` is clamped to the acquiring lane's window size (`backgroundLimit` for
  `background`, `size` for `interactive`; asking for more than the window holds is
  capped, not an error); a non-integer or `< 1` `max` throws loudly. `slots` is never
  `0` — the call blocks or throws instead, so a caller never has to distinguish "got a
  share" from "got nothing".
- `release()` is idempotent: it closes the held fds (flock auto-release) and reaps
  the winner child if one was spawned. Trade-off: the whole share is held until
  `release`, so there is some tail waste once only the slowest unit is left —
  releasing slots as work drains is a possible later refinement.

`run(fn, hooks)` is a thin wrapper — `acquireShare(1, hooks)` then
`try { fn() } finally { share.release() }` — so both entry points share one acquire
path and `depth()` / crash-safety are identical between them.

## Cancellation — `hooks.signal`

Every wait in this primitive accepts an optional `AbortSignal`. It is optional
everywhere, so a caller that passes none gets byte-identical behaviour.

**Why it exists.** A worker that gives up on a wedged handler has exactly one
lever: it aborts a signal. It cannot un-await a promise. So whether giving up
releases anything at all depends on whether what the handler is blocked on accepts
a signal — and this acquire did not. On 2026-08-17 a handler sat inside a
`worktree-mutate` acquire (a **host-wide** flock) and blocked worktree checkouts on
every backend on the machine. Until the acquire took a signal, "forfeiting" that
handler's slot was bookkeeping; with one, the host resource actually comes back.

Two effects, which answer different questions:

1. **A pending acquire stops waiting.** An abort while queued — in the class line,
   or fanned out over the lane's slots — unwinds the wait and **throws
   `signal.reason`** (unwrapped, the standard `AbortSignal` contract, the same
   shape `SpawnBound.signal` uses). Every `flock-wait` child spawned and every fd
   opened on the way is cleaned up first: a leaked child holds a slot the pool can
   no longer see, which is worse than the wedge being cancelled. An acquire that
   has already won its slots when the abort lands hands them straight back and
   throws too, rather than returning a share to an owner that has stopped running.
2. **`run` stops HOLDING the slot mid-body.** An abort while `fn` is still pending
   releases the slot immediately instead of at settle. `run` does **not** cancel
   `fn` — `fn` owns its own cancellation and holds the same signal — it only
   declines to occupy a host slot on behalf of work that has been written off. A
   body that ignores its signal keeps running; it just stops costing the host a
   slot. Safe because `release()` is idempotent: the `finally` still runs and is
   then a no-op for the slots plus the child reap. A body that finishes anyway
   keeps its result.

`acquireShare` gets effect 1 only. Once a share is in the caller's hands its
lifetime is theirs — a signal cannot know when they are done with it — which is
exactly the difference from `run`, which owns that lifetime.

**How cancellation is expressed, and why it is not a `Promise.race`.** Both waits
are reads of a child's stdout. Racing the signal against them would abandon a
pending `reader.read()` whose later rejection has no owner — a floating rejection
on the very path being made safe. So an abort instead **SIGKILLs our own
children**: a dead child closes its stdout, the read completes normally as EOF, and
the wait unwinds through the `finally` that already knows how to reap. The EOF then
*looks* like this pool's loud "a child died before granting" failure, so both
outcomes are re-checked against the signal and replaced by `signal.reason` — we
killed them, so reporting a pool fault would be a lie.

`HostShare.releaseSlots()` is the synchronous half of `release()` that makes effect
2 possible: closing the fds and killing the winner hands every slot back the
instant it returns (flock releases on process death), leaving only the reap for
`release()`. It exists for abort listeners, which cannot await.

**One deliberate gap.** The size-sentinel reconcile (`ensureSizeIdentity`) is NOT
cancellable. It is a shared, memoized run — a signal threaded into it would abort
it for co-waiters, and racing it would abandon a promise whose failure nobody would
see. It also holds nothing host-wide (its probe fds are closed synchronously and
its guard fd before the guard child is spawned), and its only wait is on
`.size.lock`, held across a handful of syscalls by a process doing a first touch or
a resize, never across a slot wait, and released by the kernel if that process
dies. `acquireShare` brackets it with `throwIfAborted()` on both sides, so an abort
landing during it stops the call before it starts sweeping for a slot.

## Hooks — observing the wait without coupling to a profiler

`AcquireHooks` carries two optional callbacks, neither of which gates behavior
(`lane` and `signal` on the same object DO — see above):

- `onWaitStart()` — fires when the slow path is entered (every slot busy), **before**
  any child is spawned; never on the fast path. Lets a caller *open* a "waiting for a
  slot" span.
- `onAcquired(waitMs)` — fires once, fast path or slow, at acquisition before the body
  runs, with the milliseconds waited (≈0 on the fast path). Replaces the old positional
  `onWait` and keeps identical semantics.

A **cancelled** acquire never fires `onAcquired`, even where `onWaitStart` already
fired. A consumer pairing the two must tolerate a wait that ends in a throw.

Crash-safety holds on both paths: the held fd is closed in a `finally`, so a
rejecting `fn` never leaks a slot, and parent death closes every fd (or EOFs the
winner child), releasing whatever slot was held. See
`research/2026-06-16-global-host-wide-cpu-admission-flock-broker.md` (Change 1) and
`research/2026-07-10-global-host-semaphore-any-slot-wakeup.md` (fan-out + turnstile).

Exposed from a **`server`** barrel (not `core`): it uses `bun:ffi`, `node:fs`, and
`Bun.spawn`, none browser-safe. The barrel carries the conventional inert
`ServerPluginDefinition` default export (description only — no routes, resources,
or hooks); it is consumed purely as a library via its named `createHostSemaphore`
export.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Cross-process concurrency primitive: createHostSemaphore bounds work across processes via flock slot files (the host-wide twin of packages/semaphore).
- Server:
  - Uses:
    - `packages/flock.flockTry`
    - `packages/flock.flockTryShared`
    - `packages/flock.HeldFlock`
    - `packages/flock.waitForFlock`
  - Exports (types):
    - `AcquireHooks`
    - `HostSemaphore`
    - `HostShare`
    - `Priority`
    - `RepoLockDir`
  - Exports (values): `createHostSemaphore`
- Cross-plugin:
  - Imported by: `infra/host/host-admission`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/host-semaphore.ts` (debt)

<!-- AUTOGENERATED:END -->
