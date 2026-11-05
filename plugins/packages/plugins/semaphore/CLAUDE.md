# semaphore

Bounded-concurrency primitive: `createSemaphore(max)` returns
`{ run(fn, opts?) }` that keeps the held WEIGHT of the running bodies at or below
`max`, queueing the rest FIFO. A counter plus a waiter queue — releases in a
`finally` so a rejecting body never leaks capacity. `opts.onWait(waitMs)` fires
once at acquisition with the time spent queueing (≈0 when there was room), so
callers can make the gate observable — e.g. record a profiler span — without
coupling this primitive to a profiler. `stats()` returns a zero-cost occupancy
snapshot (`{ active, queued, max }` — `active` is held weight) so a gate owner can
expose a gauge — e.g. sample occupancy into a flight recorder — again without
profiler coupling.

`opts.weight` (default 1) is how many of the `max` units one caller occupies, for
a gate whose callers are NOT all the same size — `host-admission`'s grant, where a
type-check worker costs several `PER_UNIT_BYTES` quanta. It is acquired
**atomically**, and admission is **strictly FIFO**: once anyone is queued, a later
lighter caller queues behind it even if its own weight would fit in the free
capacity. That is what stops light callers starving a heavy one and what makes two
heavy callers each holding half — a deadlock — unrepresentable. A `weight > max`
could never be admitted, so it throws *synchronously at the call site*; the clamp
belongs to the layer that knows the ceiling (the grant clamps a spend to the units
it holds). Everything is byte-identical to an unweighted gate when every caller
weighs 1.

There is ONE spelling of the options — no positional `onWait` overload — so a
weight and a wait hook can never be two different-looking calls.

`acquire(opts?)` is the same capacity, leased: it resolves once there is room and
hands back the release fn, for lifetimes that are not a function call — `run` is
`acquire` plus a `finally`, and both share the one slot-accounting path. Its
motivating consumer is the background *transaction* gate, where the slot is taken
when `pool.connect()` hands out a client and freed when `client.release()` is
called. The returned release fn is **idempotent**: a lease outlives the call that
took it, so its owner may release twice (`pg`'s `client.release` is call-once, and
the DB wrapper patches it) — a second free would return a slot the lease never
held, letting occupancy exceed `max` and silently voiding the gate's invariant.

**Holders** (`opts.label`). A caller that says what it is is listed in
`stats().holders` (`{ label, heldMs }`, longest-held first) while it holds
weight — a yielded slot is not held, and comes back with a fresh `heldMs`. So
a gate owner's gauge can say WHO a queued caller waits behind (runtime-profiler
stamps a gauge's holders on a filed slow wait). Unlabelled callers are counted
in `active` but never listed. User: the live read-admission gate.

**Classes** (`createSemaphore(max, { perClass })` + `opts.class`). At most
`perClass` weight of one class holds the gate at once. A queued caller whose
class is at its share is passed over — not ahead of anyone — while every other
caller keeps its FIFO place (and the heavy-waiter rule holds among them). A
yielded slot gives back its class's share too, which is why a per-class cap
belongs IN the gate rather than in a second gate around it: an outer gate held
across an inner yield can deadlock. A gate without `perClass` ignores
`opts.class` and is byte-identical to before. User: the live read-admission
gate (class = resource key), so one slow resource cannot take every slot.

**Yieldable slots** (`opts.yieldable`, `run` only). A gate bounds the bodies
that RUN; a body that holds a slot while it only waits on work another caller
is doing stalls everyone queued behind it for nothing. `whileWaiting(promise)`
(called where a caller merely waits — `packages/inflight`'s joiner path) gives
back the INNERMOST yieldable slot the current async context holds for the length
of the wait (outer ones stay held: taking several back at once could deadlock
nested bodies), and takes it back at the HEAD of its gate's queue (the body was admitted
before every caller now queued). Overlapping waits in one body give back once
and take back once; each take-back reports its queue time through `onWait`; a
wait started after the body settled takes nothing. The context is an injected
runtime (`installLeaseContextRuntime`, mirroring the profiler's span context):
the server installs an AsyncLocalStorage one at boot (`runtime-profiler/server`'s install, beside its span context); elsewhere
`whileWaiting` is the very promise and the slot is held, as before. Never make a
slot yieldable when it stands for a held resource (a DB connection, a file
handle) — it is still in use while its holder waits. Deliberately NOT done at a
gate's own queue: a read queued for a DB connection that gave its read slot back
would take it back while holding the connection. User: the live read-admission
gate (`resource-runtime`).

**A plain slot pins every yieldable one.** A `run` body without `yieldable`
sits in the lease scope while it runs (`runHoldingSlot`), and a `whileWaiting`
anywhere inside it — a timed-fs call — gives nothing back, whichever yieldable
slots are around or inside it. Giving a slot back while holding a plain one is a
lock-order inversion: others take the freed slots and queue for the plain one,
holding theirs, and the take-back waits forever. (The trade: a read inside a
plain gate — a heavy git read — holds its read slot through its own file
waits, as every read did before yieldable slots.) Measured 2026-11-05: the file explorer on `/tmp` — each
folder peek ran host-fs's plain peek gate around a `readdir` inside the live read
gate, and every read of the backend (the sidebar's included) wedged behind six
slots no one would free. Pinned by `lease-scope.test.ts`. An `acquire` lease
cannot pin (its lifetime is not a call): never `whileWaiting` while holding one
inside a yieldable body.

Used at the per-worktree DB connection gate
(`plugins/database/server/internal/client.ts`) to cap concurrent loader-kind
queries below the Postgres pool `max`, reserving capacity for interactive
(HTTP/mutation) work — so a cascade flush's queries queue at the semaphore
instead of stampeding `pool.connect()`. The seam records `onWait` as a
`db [background-acquire]` span (sibling to the pool's own `[acquire]`) so a saturated
gate stays visible in the profiler rather than hiding queue-wait. (Previously the
gate wrapped whole loader *bodies* at the live-state `wrapLoad` seam; it moved to
the connection — the actual scarce resource — so in-memory loaders that issue no
query never wait.) See
`research/2026-06-19-global-live-state-unified-read-path-v2.md` (Task 2) and
`research/2026-06-15-global-live-state-cascade-contention.md` (Change 4).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Cross-plugin:
  - Imported by:
    - `database/migrations`
    - `framework/tooling`
    - `framework/tooling/checks`
    - `framework/tooling/codegen`
    - `framework/tooling/web-artifacts`
    - `infra/endpoints`
    - `network/live/resource-runtime`
    - `packages/inflight`
    - `plugin-meta/barrel-import`
- Core:
  - Exports (types):
    - `LeaseContextRuntime`
    - `LeaseScope`
    - `Semaphore`
    - `SlotHolder`
    - `SlotOptions`
  - Exports (values):
    - `createSemaphore`
    - `installLeaseContextRuntime`
    - `whileWaiting`

<!-- AUTOGENERATED:END -->
