# Live-state flight freshness — a stale snapshot must never ship as the newest version

**Status:** plan, awaiting approval
**Category:** global (`framework/resource-runtime`, `packages/inflight`)

## Context

On 2026-08-08 the owner was editing page `block-1785414005456-mh56vv` while the box
was under a duress episode (11:39:51–11:58:55 UTC). A whole `/todo` subtree they
had just typed — plus every nested block under it — vanished from the screen and
the page reverted to a several-minutes-old state. It did **not** heal on its own:
the wrong content stayed for ~10 minutes, until the backend restarted at 12:03.

No data was lost. Every row is still in `page_blocks` with `deleted_at = null`.
What broke is the live-state transport: the browser was handed a **snapshot taken
before those blocks existed, stamped with a version number that said it was the
newest state**, and it had no way to refuse it.

The optimistic overlay could not save them. Never-revert protects ops that are
still pending; these had been acknowledged and confirmed by an earlier, genuinely
fresh push minutes before, so the overlay was empty and server truth rendered raw.

This is not page-specific. Any resource whose loader is slow enough for a commit
to land mid-flight is exposed, and loader spans of 8–15 s are routine on this box
(`tasks` sub loader 15.6 s, `attempts` 8.5 s in a healthy window).

## Root cause

**1. A read flight has no freshness contract.** `getResourceValue`
(`runtime.ts:1418-1486`) coalesces every FULL load per `${key} ${paramsKey}`
through `inflight`, whose own doc says it is "a *concurrency* deduplicator, NOT a
cache: it only collapses work that overlaps in time." Overlapping in time is the
wrong sharing rule for a caller that needs a read to reflect a commit that landed
*during* the flight. A caller arriving at T2 receives a SELECT that ran at T0 < T2.

**2. The push drain stamps a new version on whatever it gets.** The drain assigns
`version = current + 1` **before** the load (`runtime.ts:2561`, `:2994`, `:3109`),
then calls `getResourceValue`, which may join a flight started before the very
commit that triggered this drain. The pre-commit value is broadcast at the new
version.

The runtime already knows this join happens and already defends the *claims* that
ride along — etag, watermark and `ackTx` are each co-produced by the flight, so a
joiner adopts the starter's rather than over-claiming. `resource-runtime/CLAUDE.md`
says it outright:

> FULL paths stamp the FLIGHT-resolved set (a drain joining an in-flight read —
> whose SELECT may predate the commit — adopts the starter's absent seed and ships
> un-acked, the same co-production idiom as the etag/watermark)

The **version** is the one field never co-produced, and shipping a pre-commit
value under a fresh version is the bug. The same "staleness-sharing contract" is
written down and accepted in `git-read-cache/…/git-state-memo.ts:67-70` — it is
sound there (nothing mints a version) and unsound here.

**3. The client trusts version order alone.** The only guard is numeric —
`if (msg.version <= entry.version) drop`
(`live-state/web/notifications-client.ts:1408`) — and `applyUpdate` (`:1542`) then
writes the value unconditionally.

**And it sticks.** `drainEntry` clears its pending notify (`runtime.ts:3055`)
before the load, and nothing re-enqueues it. Once a stale flight satisfies a
notify, that change counts as delivered — no path re-reads. The wrong value stands
until an unrelated later write to the same tuple: the 10-minute stall observed.

### Why the tests never caught it

`runtime-ack-channel.test.ts:383-428` already stages this exact race and asserts
the value **ships** (`expect(joined.upserts).toHaveLength(1)`) with only `ackTx`
absent — the buggy behaviour, pinned as acceptable. It reads as correct only
because `controllable()` (`test-support.ts:207-232`) resolves at `release()` time,
not at loader-invocation time, so the fake loader cannot model a SELECT that
already ran. `runtime-h5.test.ts` H5a has the same blind spot.

### Production evidence

| Signal | Value |
|---|---|
| duress episode | 11:39:51 → 11:58:55 UTC (`decompressionsPerSec`) |
| `push deliver:page-blocks` | **243 254 ms** first-notify → send, last seen 11:53:47 |
| `sub page-blocks` | 23 151 ms |
| `element page-blocks {pageId: …mh56vv}` | 4 350 ms at 11:54:04 — this page, this minute |
| blocks in DB | all present, `deleted_at = null`, created 11:49:40 → 11:53:52 |
| `live_state_snapshot` for `page-blocks` | no row — L2 cold boot **not** implicated in this incident |

## Two more instances of the same class, found while designing

**The HTTP fallback.** `serveSub` reads the version **before** the flight
(`runtime.ts:3654`, deliberately, with a comment). `handleResourceHttp` reads it
**after** (`:4085-4086`, following `await gatedRead`). So an HTTP body can pair a
T0 value with a version read at T0+Δ, after fresh pushes bumped it — and the
client's same-boot HTTP guard is strict `<`, so an equal-or-greater version is
applied. Reachable through the `invalidate`-mode refetch.

**The L2 persist floor — worse, because it survives a restart.** Both persisted
FULL paths capture the persist watermark and *then* load (`:2587-2594` → `:2603`,
`:3147-3158` → `:3169`), so a joined pre-commit value is persisted under a
**post-commit** floor. Catch-up replays only `xid >= watermark`, so that commit is
skipped and cold boot serves the pre-commit value indefinitely.

## The invariant

> A flight may only serve a caller whose freshness floor it satisfies, and every
> stamp a frame carries — etag, watermark, ackTx, **version**, and the persisted
> floor — must describe the flight that produced its value.

Two kinds of version stamp, each needing a different guarantee:

- A **read** frame (`sub-ack`, HTTP body) *reports* an existing version, so the
  version must be observed **before** the load — then a joined older value can
  only ever report an older version, which the client already drops.
- A **push** frame *mints* a version, asserting "this is the state as of this
  change". That assertion must not be backed by a read that began before the
  change.

## Design

### 1. `packages/inflight` — a freshness floor, and supersede rather than chain

`plugins/packages/plugins/inflight/core/internal/inflight.ts`. Store
`{ promise, startedAt }` per key, stamped before `fn` runs. Replace the third
parameter with an options object:
`run(key, fn, opts?: { onWait?; notBefore?: number; onSupersede?: () => void })`.

- no entry → start, `startedAt = performance.now()`;
- entry with `startedAt >= (notBefore ?? -Infinity)` → join (byte-identical to
  today when `notBefore` is omitted);
- entry too old → **supersede**: fire `onSupersede`, start a fresh flight and
  **overwrite** the map entry. The old flight keeps serving its existing joiners;
  every new arrival coalesces onto the fresh one.

Superseding rather than chaining behind the stale flight is deliberate. Chaining
does not avoid the second load — both loads run either way; it only guarantees the
fresh one starts after the stale one finishes. On the incident's own numbers that
turns a 243 s stale-value push into a ~486 s fresh-value push. Peak DB concurrency
is already bounded by the read-admission gate and the loader DB gate, which is the
correct layer for admission control. Per-tuple concurrency stays bounded at 2:
only a drain supersedes, drains for one `(key, pk)` are serialised by
`flushRunning` plus the sequential per-pk loop, and the drain awaits its own flight.

Supersession requires an **identity-checked release** in the settle handler
(`if (pending.get(key)?.promise === p) pending.delete(key)`) — today's
unconditional `delete` would let the old flight evict the new entry. That is a
latent-correctness fix on its own.

`inflight` has **four** consumers, not one (`resource-runtime`, `endpoints`'
`dedupe`, `git-read-cache`, `commits-graph`); three pass `onWait` positionally, so
this is a 3-call-site mechanical migration.

### 2. `PendingNotify.lastNotifyAt` — the drain's floor

`enqueuedAt` is documented as the **first** notify and is load-bearing for the
delivery-latency metric — leave it. Add `lastNotifyAt`, refreshed on every merge.

**It must be set immediately after `unionSourceTx` at `runtime.ts:1701`, before
the two early returns at `:1702` (FULL absorbs) and `:1706` (degrade to FULL).**
A FULL-absorbing merge is exactly the shape an `ids: null` change takes — the
incident's own shape — so a floor set after those returns would leave the bug
intact in its most common form.

Soundness: `pg_notify` is delivered only after the notifying transaction commits,
and `lastNotifyAt` is stamped after the listener routed the change, so
`startedAt >= lastNotifyAt` ⇒ the first SELECT began after every commit folded
into this pending. Two preconditions to write into the comment: it assumes the
loader does not inherit a transaction snapshot opened earlier (true today —
loaders issue autocommit statements), and it is deliberately conservative because
a gated flight records `startedAt` *before* its admission wait, which yields false
refusals (an extra load) and never false joins. Say so, or someone will "fix" it
by moving the stamp inside the factory and make it unsound.

### 3. The three FULL drain sites pass the floor

`drainMembershipFull` (`:2603`), the legacy `drainEntry` branch (`:3169`), the
keyed reload (`:3242`) — all pass `notBefore: pendingEntry.lastNotifyAt`.

**The read path passes no floor**, so `gatedRead`'s coalescing — and with it the
gate-after-dedup replay-storm fix — is preserved exactly. `loadResourceByKey` and
`measureSubscribeCycle` also stay floor-less; the floor is passed explicitly from
the three drain sites and never keyed off `gated`, which would silently strip
coalescing from the boot-snapshot fan-out.

### 4. Close the two sibling instances

- **HTTP**: hoist the `pk`/`version` read above `gatedRead`, mirroring `serveSub`.
  One line of motion; it can only make the reported version older, which is the
  safe direction (the client drops it and RQ's `retry: 1` refetches).
- **L2 persist**: persist `flightWatermark` — the floor the flight's own starter
  captured before its read — and delete the separate `captureWatermark()` calls at
  `:2587-2594` and `:3147-3158`. Sound by the same co-production rule: persisted
  entries are forced FULL so `flightWatermark` is always present, and a joiner's
  older floor means over-replay, which the hook's doc already calls harmless.
  Saves a round-trip per persisted drain. `drainMembershipScoped`'s persist is
  unchanged — its refills are `ctx` loads that never coalesce.

### 5. Bonus: the ack channel becomes exact

Once a drain cannot join a pre-commit flight it can always stamp its own
`sourceTx` as `ackTx`, so the "ships un-acked, degrades to the watermark backstop"
caveat disappears for FULL paths.

### 6. No client-side change — and why

I planned a browser-side watermark gate and am dropping it. `captureWatermark` is
`pg_snapshot_xmin(pg_current_snapshot())`, and **xmin is not monotonic**: a
long-running transaction pins it low for its entire lifetime. So "strictly older
watermark" does not prove "older snapshot", and the predicate would not misfire
once — it would misfire on *every* frame for *every* resource for the whole
duration of any long transaction. Paired with `forceFullResub` that converts a
nightly job or a slow migration into every tab re-subscribing every resource on
every push: a self-amplifying storm during exactly the load window that produced
the incident. Report-only has the same false-positive rate, just quieter.

Nothing degrades by leaving the client alone: `noteResourceWatermark` is already
monotonic, so a joiner-adopted older watermark cannot regress the optimistic
layer's causal floor, and Rule B's denial inference is a statement about one
snapshot, not a comparison of two, so it is unaffected by non-monotonicity.

If defence in depth is ever wanted, the sound signal is **not** a watermark but a
monotonic per-runtime **read sequence** minted when a flight starts, co-produced
like the other four stamps and carried on value-bearing frames beside `epoch`. The
client drops and re-baselines only on `msg.epoch === entry.epoch && msg.readSeq <
entry.lastReadSeq` — a predicate with no false positives. Out of scope here; the
source fix makes it unreachable. This decision gets written into
`live-state/CLAUDE.md` so the xmin gate is not reinvented.

## Implementation

Six commits; 1–2 are independently green, 3 is the behaviour change.

1. **`packages/inflight`** — `startedAt`, the options object, `notBefore`,
   supersession, identity-checked release, JSDoc. Migrate the three positional
   `onWait` call sites (`endpoints/core/implement.ts:110`,
   `git-read-cache/…/git-state-memo.ts:71`, `runtime.ts:1484`). Tests in
   `inflight.test.ts`: floor older → one run; floor newer → two runs, `onWait` not
   fired for the superseder, `onSupersede` once; the old flight settling does not
   evict the new entry; a rejected superseded flight clears cleanly; one-hop
   termination. Note that `size` no longer counts superseded flights.
2. **`runtime.ts` plumbing** — `PendingNotify.lastNotifyAt` (JSDoc contrasting it
   with `enqueuedAt`, saying they must not be merged); set it in `mergePending`'s
   `created` literal and before the early returns; a trailing `notBefore?` on
   `getResourceValue` threaded into `inflight.run`; a per-key
   `staleFlightSupersedes` counter plus `opts.onStaleFlightSupersede?.(key)`,
   surfaced in `_debug` beside `subShortCircuits` — this is how we learn whether
   the mechanism still fires in production.
3. **The three drain sites** pass `pendingEntry.lastNotifyAt`.
4. **HTTP version hoist** and **persist `flightWatermark`** (§4).
5. **Tests** (below).
6. **Docs** (below).

### Tests

`test-support.ts` gains a sibling to `controllable` rather than changing it (five
suites depend on release-time resolution):

```ts
/** A `controllable` whose loader captures the value at INVOCATION time — a
 *  faithful model of a SELECT that has already run. `controllable` resolves at
 *  RELEASE time and so structurally cannot express a pre-commit read: any test
 *  about stale-flight joins MUST use this one. */
export function snapshotControllable<T>(initial: T)
```

New `runtime-stale-flight.test.ts`: the production bug end to end (park a read
flight holding pre-commit rows, `applyDbChange` with `ids: null`, assert the
client view converges to the post-commit value — and record in the comment that
pre-fix the joined value equals the snapshot, so the diff is empty and **no frame
is emitted at all**, which is the ten-minute stick); version/value pairing; a
drain does *not* supersede a flight that started after its notify; per-tuple
concurrency never exceeds 2; a value-aware cascade `map` receives the post-commit
value; the persisted `(value, watermark)` pair is co-produced; two subs still
coalesce; termination under a notify racing the supersession decision.

Re-pins, all of them behaviour we *want*:

- `runtime-ack-channel.test.ts:383-428` — `ackTx` flips from absent to present;
  rename the `describe` to state refusal rather than join.
- `runtime-h5.test.ts` H5a — frame order flips (sub-ack then update). Keep the
  convergence assertions, assert `subAck.version < update.version`, and **delete**
  the `seq` assertion rather than inverting it: post-fix the order is a
  microtask-count accident with no invariant behind it, and pinning an accident is
  what let this suite mask the bug.
- `runtime-h5.test.ts` H5c — the sub-ack's snapshot seed now precedes the push's
  diff, so the push ships a delta, not an `update`. Re-pin on convergence and
  no-drift, not on frame kind. Its stated rationale ("GREEN because full loads
  coalesce, so the re-seed is idempotent") is no longer true; the new argument is
  that a read-path re-seed can only regress the diff base to an older one, and an
  older base ships extra rows, never fewer.
- `runtime-revalidate.test.ts:557` — restructure to pin `sendUpdate`'s
  no-await-before-send property directly instead of racing it against a sub-ack
  whose relative timing this change moves.

Verified **not** at risk: `runtime-gate-dedup.test.ts` (all three cases are
subscribes only), `runtime-watermark.test.ts:260` (two subs, no notify),
`runtime-revalidate.test.ts`'s read-path etag cases, and H5d (which usefully pins
that read→push coalescing still works).

### Docs

`resource-runtime/CLAUDE.md`: the ackTx paragraph's "a drain joining an in-flight
read … ships un-acked" sentence becomes false and must be replaced by the new
invariant; the watermark paragraph gains the persist-floor change; the "Two
results worth knowing" H5c rationale is rewritten; the read-path section gains
"read frames report a version observed before the load". `inflight`'s and
`packages/CLAUDE.md`'s entries document `notBefore`, supersession and the
identity-checked release. `live-state/CLAUDE.md`'s commit-watermark section
records that xmin is not monotonic and that no client-side drop may be built on
watermark ordering.

## Verification

1. `./equin test plugins/framework/plugins/resource-runtime plugins/packages/plugins/inflight`
   — the new suite plus every re-pin.
2. `bun run test:dom plugins/primitives/plugins/live-state plugins/primitives/plugins/optimistic-mutation`
   — unchanged by this plan; run them to prove the client is untouched.
3. `./equin check` then `./equin build`.
4. Live: open a page at `http://<worktree>.localhost:9000`, type several nested
   blocks, and confirm they persist. Then reproduce the incident's shape — hold a
   slow read open (the Debug → Live-State Emit pane drives synthetic pushes; a
   `commits-graph`/`edited-files` sub supplies a genuinely slow loader) while
   editing, and confirm no revert.
5. `get_runtime_profile` / `_debug` for the new `staleFlightSupersedes` counter:
   non-zero under load proves the mechanism was live in production and is now
   being refused rather than shipped.

## Out of scope

- The client read-sequence backstop (§6) — a follow-up if we ever want it.
- `git-read-cache`'s memo shares the staleness-sharing contract
  (`git-state-memo.ts:67-70`) but mints no version, so it is sound today; it could
  adopt `notBefore` later.
- Why the box was in duress at all (the 243 s delivery latency) — a separate
  performance question. This plan makes the transport correct under that load, not
  faster.
