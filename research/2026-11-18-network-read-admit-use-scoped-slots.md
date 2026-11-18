# Read admission: a slot covers only real DB / fs work (use-scoped slots)

Task att-1794963138-aexrp0 (user decision D9, layer 1). Follows
`2026-11-03-framework-read-admission-waiters-yield.md`, which this design
replaces.

## Context

Every restart of main stalls every open tab's live data for seconds. About 15
tabs replay about 3,500 subscriptions through the `read-admit` gate
(`READ_LOAD_CONCURRENCY` = 6, `resource-runtime/core/runtime.ts`).

Tonight's numbers (2026-11-18):

- `report-1794780322-txtjuf` (`wait read-admit`): 699 waits over 2 s in the
  00:00Z hour and 262 in the 23:00Z hour, each 2.8–3.9 s.
- `report-1794958500-rlwkbr` (op-time): 79–156 s of `read-admit` waiting per
  5-min window.

What held the slots, from task-1794961195-igqpmr's holder split (00:40–00:51Z,
about 191 s of holder time):

| What held the slot | Share | Longest hold |
|---|---|---|
| Plain DB reads (notifications, page-block-docs, reports.list, saved-themes) | 35% | 1.9 s |
| `plugin-view.tree` waiting on the faceted-index worker | 23% | 2.6 s |
| Spawn / CLI / git values (claude-code-status, host-account, upstream.*) | 20% | 3.7 s |
| edited-files and transcript-derived values | 16% | — |
| Other | 6% | — |

So 40–60% of the slot time was spent waiting on something that is neither DB
nor fs work.

### Current semantics

- A gated read (a WS sub-ack, an HTTP read, a `revalidate` probe) takes one
  slot at `admitRead`, for the whole loader run. The slot is `yieldable`:
  - `whileWaiting(promise)` gives the slot back while the promise is pending;
  - when the wait ends, the slot is taken back at the head of the queue.
- A plain (non-yieldable) slot in scope pins every yieldable one
  (`runHoldingSlot`). This prevents the lock-order inversion of the 2026-11-05
  host-fs peek wedge.
- The slot is admission, not only a bound. These all hang off the queue:
  - FIFO order;
  - the per-key share (`perClass` 3);
  - point batching (a read queued beside a same-family read joins it);
  - `ReadAbandoned` (a sub nobody is owed any more is dropped at its slot);
  - the answer trail's `queued` stage;
  - `holders` labels.
- Interactive DB statements have no gate of their own (`pg-driver.ts`). They
  are "bounded upstream by readLoadGate", so today read-admit IS the
  interactive DB bound.

Waiter kinds, and how each one gives the slot back today:

| Waiter | Released today by |
|---|---|
| `inflight` join (a shared memo, another read's flight, gateway-drift, the claude probe) | `whileWaiting` in `packages/inflight` |
| keyed-mutex contention | `whileWaiting` in `packages/keyed-mutex` (83f2c9b8db) |
| watched-memo first pass | `whileWaiting` in `packages/watched-memo` |
| prototypes `firstLoad` | `whileWaiting`, hand-placed (4d79c9a049) |
| awaited timed-fs call | `installFsAwait(whileWaiting)` |
| **child process** (git, claude CLI, codesign / ps, host-account) | **nothing: held** |
| **worker thread reply** (faceted plugin index, `awaitReply`) | **nothing: held** |
| **timers, sockets, any other promise** | **nothing: held** |

Each fix released one more kind of wait. The class of bug stays expressible
because "held" is the default and releasing is opt-in at each call site.

## Design: invert the default — a slot is held only around a *use*

### The primitive (`packages/semaphore`)

```ts
export type SlotUse = "db" | "fs" | "spawn";          // closed set, core data

interface SlotOptions {
  /** run only: the slot is held only while the body runs one of these uses. */
  heldFor?: readonly SlotUse[];
  /** with heldFor: take a slot to START the body (admission). Default true. */
  admit?: boolean;
  // weight, onWait, onQueued, label, class — unchanged; `yieldable` deleted
}

/** Run `start` — one leaf use of a resource — holding, for its length, the
 *  innermost slot in scope whose `heldFor` names `use`. */
export function usingSlot<T>(use: SlotUse, start: () => Promise<T>): Promise<T>;
```

How a use-scoped lease behaves:

- **Admission.** `admit` true: the body waits for a slot as today, so FIFO,
  key share, batching, abandonment and the answer trail are unchanged.
- **Held only in uses.** The body's synchronous start runs holding the slot.
  When `fn()` returns its promise (the body is now awaiting something), the
  slot is given back unless a use is open. Each `usingSlot` counts the use
  open (`uses++`). If the slot is not held, it is taken back at the head of
  the queue before `start` runs; the last use to end gives it back.
- **Nothing else holds a slot.** An inflight join, a mutex, a worker reply, a
  child process (on the read-admit gate) or a timer simply holds nothing.
  There is nothing to remember at a call site.
- **Take-backs queue FIFO among themselves** (a front segment), not LIFO.
  Today's `unshift` lets the newest resumer overtake older ones.
- **`admit: false`** (a lazy gate): no slot at the start, so a body that never
  makes such a use never waits on this gate. Used for the spawn gate below.
- **No lease context installed** (a browser host, a bare test): `heldFor`
  degrades to holding the slot for the whole body, as before. Without async
  context no use can find its lease, and releasing would void the bound.
- **Deleted:** `whileWaiting`, `yieldable`, `runHoldingSlot` / the
  `HeldSlot` pin, and `installFsAwait`.

### Why holding while waiting becomes inexpressible

1. **The default is released (rung 1).** No API holds a use-scoped slot
   across an arbitrary await. The only way to hold one is `usingSlot(use, …)`.
2. **`SlotUse` is a closed type (rung 2).** A new resource kind is a type
   change in the semaphore core, reviewed there.
3. **Only the resource primitives may call `usingSlot` (rung 3).** The lint
   rule `semaphore/slot-use-site` reports every call, and each primitive
   declares a sanctioned exemption in its own `exempt/index.ts`:
   - `database` — `machine/internal/pg-driver.ts` (statements and
     transactions);
   - `infra/runtime-profiler` — `server/internal/install.ts` (installs the fs
     and spawn uses);
   - `framework/central-core` — `bin/lease-scope.ts` (central's fs use).

   Tests are out of scope.

Deadlock argument (replaces the plain-pins-yieldable rule):

- A use-scoped slot is held only inside `usingSlot`.
- Every sanctioned `start` is a leaf: a DB statement (connect + query), a file
  call, or a child process. None of them waits on any in-process gate except
  the pg pool's own connection queue, whose holders are themselves leaves or
  non-read requests that never wait on read-admit.
- So every holder finishes, and no wait-for cycle can close through a
  use-scoped gate, whatever plain gates a body holds around its uses. (The
  2026-11-05 peek inversion needed a read-admit holder that waits on the peek
  gate, and that can no longer exist.)
- Admission is never awaited inside a use, so nested reads cannot cycle
  either. The outer read holds nothing while it awaits the inner one.

### Where each bound now lives

| Work in a gated read | Bound | Before |
|---|---|---|
| Interactive DB statement | read-admit, **6** reads at once (one slot per read, however many statements it runs together), held per statement (connect → query) | read-admit, held for the whole loader |
| Interactive transaction (checkout → release) | the interactive pool only. Its body is arbitrary code, not a leaf, so it is not a use (independent review). No served loader opens one. | read-admit, held for the whole loader |
| File call (timed-fs, each glob step) | read-admit, **6**, held for the call; key share 3 still caps one hung mount | released (yielded) |
| Child process (`spawnCaptured`) | **new `read-spawn` gate, 6, key share 3, `admit: false`**; held for the child's life | read-admit, by accident of holding |
| Worker reply, inflight join, mutex, timer | none: the work's owner bounds itself (the worker is one thread; inflight is one run) | released ad hoc, or held |
| Loader JS (CPU) | the one JS thread | — |

- **Spawn bound.** The gate's original purpose was bounding a reconnect herd's
  git/fs spawns. That bound moves to `read-spawn`. It keeps today's effective
  ceiling (at most 6 concurrent children from reads) without letting a 3.7 s
  CLI probe block a DB read.
- **Heavy-read pool.** The host-wide `heavy-read` pool (host-read-pool) still
  bounds heavy git reads across backends on top of this.
- **Order inside the DB driver.** `usingSlot("db")` wraps `runOnce`
  (connect + statement) inside the retry and inside a background gate, so the
  order is `background-query → read-admit → connection`. A retry's backoff
  holds nothing.
- **Hook points:**
  - pg-driver calls `usingSlot` directly;
  - timed-fs takes `installFsUse(<T>(start: () => Promise<T>) => Promise<T>)`
    (the leaf cannot import the gate);
  - spawn takes `installSpawnUse` the same way, with `spawnCaptured` wrapping
    its child.

## Migration

- `packages/semaphore`: the use-scoped lease in `semaphore.ts`, `usingSlot`
  in `lease-scope.ts`, delete the yieldable lease, `whileWaiting` and
  `runHoldingSlot`. Add `lint/slot-use-site`. Tests: `lease-scope.test.ts`
  rewritten.
- `packages/inflight`, `keyed-mutex`, `watched-memo`, `apps/prototypes/files`:
  drop `whileWaiting`, since waiting now holds nothing by default. Their
  gate tests become "a waiter holds no slot" with no helper involved.
- `packages/timed-fs`: `installFsAwait` → `installFsUse`; the call's timing
  still ends when node answers (`untilReturned`).
- `infra/spawn`: `installSpawnUse`, wrapped around each `spawnCaptured`
  child.
- `database` (pg-driver): `usingSlot("db", …)` around each `runOnce`
  attempt. Not around a checkout: a transaction body is not a leaf.
- `infra/runtime-profiler` install and `central-core/bin/lease-scope.ts`:
  install the fs (and spawn) uses.
- `resource-runtime` `admitRead`:
  - `readLoadGate.run(body, { heldFor: ["db", "fs"], … })` inside
    `readSpawnGate.run(…, { heldFor: ["spawn"], admit: false, class: key })`;
  - register the `read-spawn` gauge;
  - `readGateStats()` / `_debug` add the spawn gate;
  - `gateWaitHooks("read-spawn")` server-side.

  Docs: resource-runtime, semaphore, timed-fs and database CLAUDE.md.
- Benches `read-admit-bench.ts` / `fs-yield-bench.ts`: rewritten or removed
  if obsolete.

## Risks

- **More concurrent loaders.** Admission now drains as fast as bodies reach
  a non-resource await, so many more loaders are in flight at once (their
  JS, their promises). Resource work stays bounded. Head-of-queue take-backs
  mean new admissions wait while admitted reads have uses queued, which is
  natural backpressure.
- **Spawn herds.** They are bounded at 6 per backend, as before; the host
  `heavy-read` pool sits above.
- **Disk stalls.** Six fs calls hung on a dead mount now hold read-admit,
  which today's fs-yield avoided. The key share caps one key at 3, and a
  stall across many keys is the disk being the bottleneck, which is what the
  bound should show. Measured by the gate meter after landing.
- **Lock order.**
  - The sanctioned `start`s must stay leaves. The lint makes adding a site a
    reviewed exemption.
  - An interactive transaction inside a read is NOT a use (the review found
    holding the slot across its body could close a cycle: a body awaiting a
    gated read, or another read's flight). Its statements run outside the read
    slot, bounded by the interactive pool alone. No served loader opens one
    today.
  - An HTTP handler holding a connection while it awaits a gated read is the
    same risk as today, not a new one.
- **Thrash.** A body alternating uses gives the slot back between them. The
  fs-yield bench measured no thrash for this pattern (60 reads × 40 stats).

## Verification

- Unit tests (`packages/semaphore`): a use-scoped body awaiting a plain
  promise holds no slot; uses hold it, and concurrent uses share it; take-backs
  queue FIFO at the head; `admit: false`; the no-context fallback; key share
  per use.
- Runtime tests (`runtime-read-admit-uses.test.ts`) that **hang on the old
  semantics**: six reads awaiting
  - a spawn-like deferred,
  - a keyed-mutex holder,
  - an inflight join,
  - a worker-reply deferred,

  while unrelated reads must ack. Plus: at most 6 concurrent `db` / `fs`
  uses; at most 6 concurrent spawns, which never block a DB read.
- `./equin test` on the touched plugins, `./equin check`.
- **After landing, on main's restarts** (main restarts on the push):
  - read-admit wait count and max per restart
    (`slow_ops` / `get_runtime_profile` gates);
  - op-time per window (`op-time:wait:read-admit`);
  - the new `read-spawn` meter;
  - boot onReady times.

  Compare against tonight's figures: 2.8–3.9 s waits, 699 per hour, and
  79–156 s per 5-min window.
