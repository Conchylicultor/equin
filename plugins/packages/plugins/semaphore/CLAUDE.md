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

`opts.onQueued()` is called synchronously, in the caller's context, the moment
a caller has to QUEUE (never when admitted at once — and again for a use-scoped
slot's take-back that queues); the function it returns is called at admission,
just before `onWait`. `onWait` reports a wait once it is over; `onQueued` lets
the owner show it while it lasts (runtime-profiler's `beginWait`, wired with
`gateWaitHooks(layer)`), so a caller queued for minutes is not mistaken for
one busy with its own work.

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
weight — a use-scoped slot between uses is not held, and comes back with a fresh `heldMs`. So
a gate owner's gauge can say WHO a queued caller waits behind (runtime-profiler
stamps a gauge's holders on a filed slow wait). Unlabelled callers are counted
in `active` but never listed. User: the live read-admission gate.

**Classes** (`createSemaphore(max, { perClass })` + `opts.class`). At most
`perClass` weight of one class holds the gate at once. A queued caller whose
class is at its share is passed over — not ahead of anyone — while every other
caller keeps its FIFO place (and the heavy-waiter rule holds among them). A
use-scoped slot between uses gives back its class's share too, which is why a
per-class cap belongs IN the gate rather than in a second gate around it. A gate without `perClass` ignores
`opts.class` and is byte-identical to before. User: the live read-admission
gate (class = resource key), so one slow resource cannot take every slot.

**Use-scoped slots** (`opts.heldFor`, `run` only). A gate bounds the work that
RUNS; a body that holds a slot while it only waits — on another caller's
flight, a mutex, a worker thread, a child — stalls everyone queued behind it for
nothing. So a use-scoped slot is RELEASED by default and held only while the
body runs a declared USE: `usingSlot(use, start)` (`SlotUse` = `"db" | "fs" |
"spawn"`, a closed set) runs `start` — one LEAF use of a resource — holding, for
its length, the innermost live slot in scope whose `heldFor` names `use`. The
body's synchronous start runs holding the slot it was admitted with; once it
returns its promise the slot is given back unless a use is open. A use finding
it given back takes it back at the HEAD of the queue (the body was admitted
before every newcomer), FIFO among take-backs; concurrent uses of one body share
one slot; the last use to end gives it back; each take-back reports its queue
time through `onWait` (and `onQueued` while it queues). `opts.admit: false` is a
lazy gate: no slot to start, taken only by a use (the live read's `read-spawn`
gate). There is no API to hold a slot across any other wait — the wrong thing
has no spelling — and only the resource primitives may import `usingSlot`
(lint `semaphore/slot-use-site`, `noDebt`; each holder a sanctioned exemption in
its own `exempt/index.ts`): the DB driver (`database/machine`), and the hosts
that install timed-fs's and spawn's use hooks (`runtime-profiler/server`'s
install, `central-core/bin/lease-scope.ts`).

**Why it cannot deadlock.** A use-scoped slot is held only inside `usingSlot`,
and every sanctioned `start` is a leaf — a DB statement on a pool connection, a
file call, a child process — that waits on no in-process gate but the pg pool's
own connection queue, whose holders are themselves leaves. Every holder
finishes, so no wait-for cycle closes through a use-scoped gate, whatever plain
gates a body holds around its uses (the 2026-11-05 host-fs peek wedge — a plain
peek gate around a readdir inside the read gate — needed a read slot held while
waiting on the peek gate, which can no longer happen), and admission is never
awaited inside a use (a nested gated read: the outer holds nothing while it
awaits the inner). Pinned by `lease-scope.test.ts`.

The context is an injected runtime (`installLeaseContextRuntime`, mirroring the
profiler's span context; `null` removes it — a test suite restores what it
installed): every Bun host installs an AsyncLocalStorage one at boot — a
worktree server in `runtime-profiler/server`'s install, central in
`central-core/bin/lease-scope.ts`. Without one (a browser host: no
`AsyncLocalStorage`, no TC39 `AsyncContext` yet) no use could find its slot, so
an admitted use-scoped body holds its slot for its whole run and a lazy one
holds none: a browser host's code must not WAIT on another party inside a
gated read — its one such source, a page input, is read as a state, never
awaited (`framework/browser-server`). User: the live read-admission gate
(`resource-runtime`). Design:
`research/2026-11-18-network-read-admit-use-scoped-slots.md`.

Used at the per-worktree DB connection gates
(`plugins/database/machine/internal/pg-driver.ts`) to cap concurrent background
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
  - Imported by: 29 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra` ×9
    - `apps` ×6
    - `debug` ×3
    - `framework` ×3
    - `conversations` ×2
    - `database` ×2
    - `config_v2`
    - `integrations/youtube/song-videos`
    - `network/live/resource-runtime`
    - `plugin-meta/barrel-import`
- Exemptions:
  - Exempted by:
    - `database` (0 debt)
    - `framework/central-core` (0 debt)
    - `infra/runtime-profiler` (0 debt)
    - `network/live/resource-runtime` (0 debt)
- Core:
  - Exports (types):
    - `LeaseContextRuntime`
    - `LeaseScope`
    - `Semaphore`
    - `SlotHolder`
    - `SlotOptions`
    - `SlotUse`
  - Exports (values):
    - `createSemaphore`
    - `installLeaseContextRuntime`
    - `usingSlot`

<!-- AUTOGENERATED:END -->
