# resource-runtime — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

Why one parameterized runtime for server and central:
[unification](../../../../research/2026-06-08-global-unify-live-state-resource-runtime.md).

- **`mode` has no default** because an implicit `invalidate` is a delivery
  choice nobody made.
- **Hooks degrade to identity / no-op** because central binds only `snapHash`;
  `reportError` is additive so a host without it still logs. Wait attribution:
  [research](../../../../research/2026-06-19-global-wait-attribution-instrumentation.md).
- **Host-agnostic** so a browser page can host it: the boot epoch is
  `globalThis.crypto.randomUUID()`, ETags are `string-hash`'s `hashHex`, the
  keyed snapshot hash is the injected `snapHash` (default `hash64`; Bun hosts
  pass `Bun.hash.wyhash`).
- **`inflight` does double duty**: read-path single-flight coalescing, and the
  correctness-bearing freshness floor (`notBefore`) the push path uses to refuse
  a flight older than the change it announces (see *Flight freshness*).

## Core invariants

- **Canonical params.** Without one spelling, `paramsKey`, the loader and
  subscriber routing see three tuples for `{ path }`,
  `{ path, scopeId: "" }` and `{ path, scopeId: undefined }`. Frames echo the
  canonical tuple, so the client must canonicalize with the very same function
  (`packages/canonical-params`, one copy for both ends) or its frames never
  match; a frame arriving non-canonical is reported once per key.
- **Level-parallel flush.** `rebuildDag` stamps longest-path depth, so every
  edge strictly increases depth and a level has no intra-level edges.
  - Why the barrier: a cascade merged into a deeper downstream has settled
    before that downstream drains.
  - Why parallel: a slow loader cannot head-of-line-block an unrelated entry at
    the same or an earlier depth.
  - [Research](../../../../research/2026-06-19-global-parallel-flush-notifies.md).
- **One `flushState`, never booleans.** With separate flags, the loop checked
  the rerun flag a few microtask hops before releasing the mutex; a notify in
  that gap left every later push un-flushed until restart (health dot green).
  Now the last check and the release to `idle` share one synchronous segment.
  [Incident](../../../../research/2026-10-26-framework-live-push-wedge-stranded-flush.md).
- **Leading-edge throttle**: an isolated change drains at once (no window of
  lag); only a change inside the window waits. A flush triggered by another
  entry, or a cascade, must not release it early, or "at most one drain per
  window" breaks.
  [Research](../../../../research/2026-10-22-global-live-throttle-holds.md).
- **`pushStallMs`** exists because the ping is the one frame that still reaches
  the tab while pushes are stuck. Both stall shapes are real:
  - a loader that never settles holds the mutex (pushes frozen for 25 min under
    a green health dot —
    [incident](../../../../research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md));
  - a change queued with no flush ever taking it (a `withNotifyBatch` that never
    settles keeps `batchDepth > 0`, so `armFlush` never schedules) — pass age 0,
    so a pass-only metric misses it.
  - Why the pass stamp is re-taken per re-drain pass: a steady notify stream
    holds the mutex across many short delivering passes, which is not a stall.

## `ScopePolicy` — the two questions a keyed resource must answer

- **Why question 2 is mandatory.** Without a tuple answer, every subscribed
  tuple re-runs its own read on every change, finds the row is not its own, and
  diffs to empty. No frame ships, which hides the cost — the read IS the cost.
  A tuple naming one row is a lookup-only `liveCollection` read by id, whose
  `:rows` point membership routes only to tuples holding that id.
- **Legacy keys refused by name** (`identityTable` / `fanOut` / `recompute`):
  no router reads them, so a cast carrying one would silently do nothing.
- **D31 — external keyed.** Its truth is outside Postgres, so no route can
  refill some of its rows; every change is a FULL re-read of the tuple.
  - No `orderSignatureOf`: every change is FULL anyway.
  - No `windowIdsOf`: the runtime can derive it from the loader (the tuple's
    own read, ids mapped); no path calls one, since a scoped pending only exists
    through routes.
  - A `reach` plan still narrows WHICH tuples re-read: its gates
    (`Route.columns`) and per-tuple `match` apply. A paged value reading through
    a compiled lookup is reached only by a write to its question's row that
    moved a column the lookup reads.
- **T15 — a `dependsOn` upstream must be external**: a DB-backed upstream's
  writes are tables the downstream's own routes already reach; the edge would
  serve the change twice.

## Bounded membership (`membership`) and the `scopedMembership` alias

Research: [scoped membership](../../../../research/2026-07-03-global-scoped-membership-m5.md),
[bounded working set](../../../../research/2026-07-18-global-bounded-working-set-resource-contract.md).

- **Window loader = the windowed query** so FULL (no snapshot, sticky-FULL, a
  failed sub-ack load) is bounded by construction: a membership change costs
  O(changed) + O(window), never O(collection).
  - Limit: an empty scoped pending is a skip, so it no longer reloads (and
    incidentally heals) a tuple with no snapshot. A tuple whose sub-ack load
    failed is healed by its client's `sub-error` HTTP fallback.
- **Alias `orderSignatureOf` is required**: a compiler always knows its ORDER
  BY, so an in-place reorder of an alias can never go stale.
- **Full window**: `windowIdsOf` is both the entrant arbiter and the tail-pull
  source, hence run once. A DELETE outside the snapshot is a no-op because a
  window is a prefix of the total order.
- **Not-full window ⇒ whole range** is what keeps paged reads cheap: a split
  page has headroom, so most exits land while it is not full (zero queries).
  - It must hold for every snapshot kind: loaded, rebuilt from a wire `order`,
    and derived (hence "a slice through a source's end needs a non-full
    source").
  - **Torn read** failure mode: a backfill target is deleted or flipped out
    after the ids query read it, or an exit the ids query saw is back in range.
    A short snapshot would then read as holding its whole range, and its exits
    would never pull the hidden row back in.
  - A throwing `limitOf` reads as full because the size test must doubt: "full"
    only costs a re-derive, "not full" can lose rows.
- **Order signature.**
  - It takes `params` so a stored and a fresh signature of one tuple are cut
    alike.
  - Missing ⇒ moved: at worst one extra bounded ids query, never a stale order.
  - Absent ⇒ an in-place UPDATE never reorders the window until the next
    membership delta. query-resource always derives one, so for compiled windows
    the stability rule is only a cost note (one O(window) ids query per
    order-column update).
- **Full `order` on every membership delta**: the client rebuilds the keyed
  array purely from it; that is also how a squeezed-out tail row leaves without
  a `deletes` entry. Rebuilding `nextSnapshot` from the wire order (and
  sanitizing upserts to surviving ids) makes an `orderedIds` disagreement or a
  concurrent delete drop out with no client drift-resub.
- **Persistence.**
  - A persisted alias keeps its snapshot across N→0 because it recomputes on
    every change regardless of subscribers and needs the diff base.
  - Bounded entries are excluded structurally (off the definition) so no name
    list can drift.
- **Boot seed.** Without it the diff base starts empty, so the first post-boot
  change — and every change catch-up replays — pays a FULL O(collection)
  rebuild.
  - Aliases only: theirs is the only durable value byte-sufficient to rebuild
    the base.
  - No-op once a snapshot exists so a sub-ack that arrived first is never
    clobbered.
  - `invalid` covers a row schema that moved in a way the L2 definition does not
    fingerprint (e.g. an opaque transform's body).
  - The snapshot-present and alias checks run BEFORE the parse, so a late value
    over a fresher base is `skipped`, never `invalid`.
  - `validatePersistedValue` runs in `onReadyBlocking` because boot-snapshot's
    persisted fast path is open from readiness, before the seed.

## Seeded derivation (a `sub` frame's `derive`)

Why: a paged read splits and merges its pages, and each new page's rows are
wholly or partly a slice of pages both sides already hold
([research §4.4](../../../../research/2026-10-09-global-live-key-range-pages-v2.md)).

- **At most 2 sources**: a split reads one, a merge two; more would let one
  frame cost O(sources × window).
- **Synchronous with registration**: every change routed from then on reaches
  the new tuple, and none lands between check and copy.
- **Protocol match first**: a bundle on another vocabulary (or none) may mean
  something else by `derive` or read a derived ack differently.
- **Only a span-opening sub**: a held tuple's first subscriber already decided
  its load.
- **Family check**: makes "same query" a fact, not the client's claim — which is
  also why copying the sources' order signatures is sound. A row with none is
  re-derived on its next refill (fail-safe).
- **Non-full source for a slice through its end**: a full window may hide rows
  past its last.
- **No etag, no watermark** in the derived ack: no read ran, and the slice was
  cut from snapshots scoped deltas built, which vouch for no commit floor
  (Rule B′). No base floor either: a bounded window is never persisted.
- **Trust boundary**: a derived tuple is exactly as current as its sources'
  subscribers — their next delta is diffed against the same base.
- **Echo by client id**: matching on re-spelled sources would let a server that
  canonicalizes a source's params differently strand the asking tab.
- **Version skew**: an old bundle would read a derived ack as a `sub-ack` with
  an `undefined` value (parse error), adopt its version and drop its own value
  ack as stale. It never receives one: live-state shares a socket only with tabs
  on the same `PROTOCOL` dialect
  ([networking](../../../primitives/plugins/networking/CLAUDE.md)), and a derived
  ack goes only to the asking socket.
- **`sub-batch` never derives**: a replay asks for full values.

## L2 persists: replace and floor (`PersistMeta`)

- **Replace cancels the floor window synchronously**: the scoped changes the
  window held committed before this value's read began, and the FULL drain
  rebuilds the snapshot only after the replace resolves. A window firing
  mid-write would chain a floor link writing the pre-replace snapshot and floor
  over the fresh row.
- **Fixed trailing window**: a steady stream still persists every window.
- **`valueOfSnapshot`** `JSON.parse`s each retained entry, giving jsonb
  byte-identical to a FULL persist.
- **`guardTables` is never empty** (route tables, or the read-set union), so A6
  judges a first INSERT too.
- **Base floor.**
  - A scoped drain that finds a snapshot seeded under it (a sub-ack landed while
    it read) restores `prev`'s floor, never the sub-ack's newer one.
  - Why a scoped drain never captures one: its refill reads only the requested
    ids, so a drain-time capture could pass over a lower-xid commit this tuple
    has not been routed yet, and catch-up would skip it forever.
- **Definition read off the plan, never copied**, so a deferred entry bound
  later carries it too.
- `keptSnapshotValue` exists because the kept snapshot is fresher than the
  trailing row. Dropping armed windows at shutdown is safe: catch-up replays
  what they held.

## Scoped change routing (`routes` + `routeTableChange`)

Design: [scoped change routing](../../../../research/2026-09-29-global-scoped-change-routing.md);
why routing never uses the captured read-set:
[declared reads](../../../../research/2026-10-17-global-live-declared-reads-externals-session2.md).

**The two plans**

- **Routes on membership arms only**: a scoped refill never deletes, so only a
  membership drain can turn a routed change into an exit.
- **Reach plans are `full`-only**: a push value has no host ids to refill, so a
  change to a table it reads recomputes it and any other reaches nothing.
- **Reach may sit beside `dependsOn`**: with no scoped refill, a cascade and a
  routed change merge into the tuple's one FULL pending.
- **`notified` is refused on a DB-backed entry**: it has no `notify`, so the
  declared path would never fire.
- **Minted, never written**: a route's `columns` decide which updates reach the
  resource, so a hand-written plan could silently drop updates for a column it
  forgot. Only the compiler that sees the SQL may make one.

**Inputs and layout**

- **Routed entries take no `dependsOn`**: a cascade would serve the change a
  second time, a FULL overriding the scoped refill.
- **`recomputeOn`** covers a change that moves the compiled SQL itself (a
  DataView surface's custom column definitions). Its upstream must be external:
  a DB-backed upstream's writes are the entry's own routes to name. It is
  filtered to the one upstream tuple so another tuple's notify reaches nothing.
- **`reads`** in the layout: the feed compares only the columns of sets narrower
  than the table, since only such a route can be skipped.

**Routing a change**

- **The gate needs no column agreement**: `unchanged` lists only columns known
  equal in every row, so a column the producer did not compare is never listed.
- **A side-table I / U / D is a host U**, never a host I / D; the membership
  drain already turns it into an exit, an entrant or a reorder.
- **Failures are isolated per tuple and per entry** so one bad `usesOf` never
  takes the change from the rest.
- **Value-role drop only while quiescent**: a drain admitting that host may have
  read the side table before the write committed.
  - This reads membership off the snapshot, so a membership drain whose loads
    all fail evicts it: its pending is consumed and it could miss an entrant.
- **Reverse routes resolve as groups**: one unbounded probe serves every reader
  when it fits the cap (bounded readers cut it to their ids); over the cap only
  unbounded readers go FULL and bounded ones probe again within their own ids.
  They ride the same pending so its ack leaves only after every route landed.
- **A skip is never a pending**: otherwise a skip is spelled as a reload (a
  persisted entry forces FULL). An owed ack counts as a feed delivery; a skip
  owing none records nothing — the change never reached the tuple.
- **Producers deliver a transaction together**: the runtime cannot know a
  transaction's last change, and an ack is true only if every change reached
  the pending before it drained.

**Guards and introspection**

- **The drift guard fails open**: the drifted relation's bases FULL-route to the
  entry, so a plan missing a relation is never staler than a whole-table read.
- **The boot seed is unreported** (counted in `_debug.routeDriftSeeded`): a
  persisted `tables_read` may predate a declaration change. The next load that
  still reads the table reports it; one that does not drops the seed.
- **Tagged reads**: a read outside the tag may read any column, so it is drift.
  A persisted `tables_read` records no tags, so the boot seed judges a tagged
  table by name.
- **D5 arms on `notified` / undeclared freshness only**: snapshot, fixed and
  immutable externals claim no push.
- **Off with no capture wired** (central, DB-free harness): routing never
  depends on it.

## Deferred resources (`defineDeferredResource` / `bindDeferredResources`)

- Registered at definition so `_debug`, the read-set-gap warning and the D5
  guard read mode and freshness before the bind.
- Bound through the same `buildEntry` as `createResource` so a deferred entry
  cannot skip a validation (scope policy, D32 / T15, minted plans).
- Bound before triggers are rebuilt because the change feed derives its layout
  from the routes.
- Limit: a deferred resource defined after the bind stays unbound (serving it
  throws) until the next call.

## Keyed snapshot representation (`SnapEntry` / `SnapEncoder`)

- **Hash by default**: ~16 B/row instead of a value-sized UTF-16 string Map
  rebuilt on every recompute
  ([research §B1](../../../../research/perfs/2026-07-16-main-paging-victim-investigation-PLAN.md)).
- **Encoder from the definition** so a resource's prior snapshots and the diff
  always use the same encoder; keyed on `shouldPersist` it could flip between
  seeding and consumption.

## Frame stamps: etag, watermark, `ackTx`

- **Etag only on `update`**: an etag on `invalidate` hands the client a
  signature newer than the value it still holds — a permanent stale pin.
  Etag-after-value is safe on `update` because the frame carries the value and
  self-heals via the flush's rerun pass.
  [Research](../../../../research/2026-07-10-global-push-etag-rides-the-update-frame.md).
- **The two `delta` kinds differ**: a keyed FULL delta fully reconciles, so an
  etag there would be safe (a possible optimization: a co-producing builder plus
  a protocol field, moving `PROTOCOL`). A scoped delta deliberately does not
  assert membership, so an etag there is a partial-stale pin.
- **No await before `ws.send`**: a returned-and-awaited frame would defer every
  push by a microtask. A push-vs-parked-sub-ack race is the wrong test: their
  frame order is a microtask-count accident that shifts with how drains join
  flights.
- **D8.**
  - `held` is a copy so a loader mutating its own return cannot move it.
  - It compares with `diffValue`, the same walk a patch is built from, so a
    patched drain diffs once and nothing is serialized or hashed.
  - The cascade still runs: a downstream's recompute is its own decision (its
    own D8).
  - A `revalidate` entry also keeps the raw return: the same object again is
    unchanged without a walk.
  - Set only when the frame reached every current subscriber: a tab subscribing
    during the load may hold an older read.
  - Tied to the tracking span: a drain outliving N→0 must not leave a value a
    later 0→1 would trust (for a patched entry, a sub-ack answered from it with
    no load).
  - Excluded: `invalidate` (no value), keyed (diff per row), persisted
    (boot-snapshot hydrates pages from the L2 row, holders this runtime never
    saw).
  - A skip still fires `onPush` with `changed: false` so the churn monitor sees a
    loader that ran for nothing.
  - Cost: one allocation-free walk per drain when equal, one retained value per
    subscribed tuple.
- **Watermark**
  ([research](../../../../research/2026-07-11-global-never-revert-optimistic-edits.md)).
  - A scoped delta never carries one: it would hand the client a causal floor
    for a value it does not hold, and optimistic-mutation would wrongly drop a
    pending op as superseded.
  - Captured before the read: a pre-read xmin is a valid Rule-B floor
    (`xmin > commitXid` ⇒ the read saw that commit); a post-read capture
    over-claims.
  - Captured by the starter so watermark-newer-than-value is impossible.
  - A throwing capture never blocks the frame.
- **One capture per flight is also the L2 floor**: a drain-time capture can be
  NEWER than the value (a joined flight read earlier); catch-up replays only
  `xid >= watermark`, so it would skip the very commit the value misses and
  cold boot would serve the stale value across restarts. The flight's own floor
  is at worst older, which only over-replays. A throwing capture skips that
  cycle's persist (the row keeps its prior floor).
- **`ackTx`**
  ([research, Part C](../../../../research/2026-07-18-global-bounded-working-set-phase2.md)).
  - Survives a FULL absorb because a FULL recompute reads post-commit (contrast
    `deleted`, which FULL drops); same for downstream cascades.
  - The narrow claim — "every row of this tuple's view that W wrote is
    reflected" — is why a scoped delta may carry it: it can confirm exactly the
    op whose token is W, never deny.
  - A joiner must adopt the starter's seed: stamping its own on another flight's
    value would be a false ack.
  - Client-requested, not declared: only tabs running an optimistic op need
    them.
- **`no-store` beside the ETag**: a restart-stable ETag (e.g. content-addressed
  `edited-files`, for 304 herd-collapse) lets the browser cache revalidate a
  stored old-boot body into a 304 after a restart. Cross-boot versions are
  incomparable, so the client drops it as stale and the pane wedges. Client
  `cache: "no-store"` and server-core's default are two more layers, each a
  standalone fix.
  [Research](../../../../research/2026-07-15-global-live-state-http-cache-poisoning-class-fix.md).

## Flight freshness: a stamp describes the flight that produced its value

[Research and the incident behind it](../../../../research/2026-08-08-global-live-state-flight-freshness.md).

- **Why the version needs refusal, not adoption**: the other stamps are
  co-produced by the starter, but a push drain mints `version = current + 1`
  before loading — an assertion that "this is the state as of my change". No
  adoption rule makes an older SELECT satisfy it.
- **Why reads stay floor-less**: a read frame reports a version observed before
  the load, so a joined older value reports an older version the client drops.
  This keeps read coalescing (and gate-after-dedup) intact.
- **Why never derive the floor from `gated`**: it looks like "this is a push"
  but is not — boot-snapshot fan-out and multi-tab sub herds are gated reads,
  exactly what single-flighting collapses. Flooring them gives each its own
  flight and brings the replay storm back, for no correctness gain.
- **Why `lastNotifyAt` is sound**: `pg_notify` arrives only after commit, and
  the stamp is taken after the listener routed the change, so
  `startedAt >= lastNotifyAt` ⇒ the flight's first SELECT began after every
  commit folded in. It is refreshed before the FULL-absorb early returns
  because an `ids: null` change absorbing into a FULL pending is the commonest
  shape.
  - Errs safe: a gated flight stamps `startedAt` before its admission wait, so
    the cost is false refusals (one extra load), never a false join.
  - Limit: assumes loaders issue autocommit statements, not an earlier-opened
    snapshot.
  - Non-zero `staleFlightSupersedes` means the pre-commit join is still
    reachable under load and is being refused rather than broadcast.

## Read path: version short-circuit (bootEpoch), gate-after-dedup, per-tab subs

Why: clients chronically replay their full sub set, and each replayed push sub
used to run the full loader behind the 6-slot read gate
([replay storm](../../../../research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md)).

- **Fresh version per span**
  ([research](../../../../research/2026-09-27-global-live-substrate-gaps.md)):
  outside a span nothing bumps the counter — the change feed routes to
  subscribed tuples only and a `whileSubscribed` watcher stops at the last
  unsubscribe. A version minted before (acked to a tab whose socket then
  dropped, or read over HTTP with nobody subscribed) could otherwise match a
  stale value.
  - A reconnect on a new socket takes the full path; a replay on the same socket
    registers before it reconciles, keeps its span and still short-circuits.
- **Epoch**: versions are per-boot memory, so a cross-boot echo is
  incomparable.
- **`revalidate` exempt**: its truth may live outside the notify stream (e.g.
  git); the ETag is the authority.
- **No HTTP short-circuit**: the invalidate-mode refetch must return a body at
  an equal version (the client guard is strict `<`).
- **Batch replay** avoids an identical replay transiting 1→0→1: no lifecycle
  hook churn, no keyed-snapshot eviction, no new span. A short-circuit never
  lands on an evicted snapshot, since eviction is at N→0 and the resub opens a
  new span.
- **Version read before the load** (HTTP too): read after, a body could pair a
  value SELECTed at T0 with a version pushes bumped since; the strict `<` guard
  applies it and the stale value pins. Read before, an older value reports an
  older version, is dropped and refetched.
- **`params` on `sub-error`**: the shared socket broadcasts to every tab, which
  must gate it on its own sub like `update` / `delta`; a params-less frame
  matches no sub and is dropped.

## The params gate: a contract mismatch is version skew, not a crash

- **Gate before `authorize` / registration** so no push, revalidate or scoped
  path ever reruns a refused tuple.
- **Skew is only warned** because a tab on the previous bundle is expected after
  a deploy; a same-build mismatch is a real decode bug, so it is reported.
- **Declaration-time errors stay plain `Error`s**: programmer errors must crash
  loudly, not be dressed as skew.

## A closed key set — `unserved`

- An unknown key is skew only on a host deployed under tabs that may run another
  bundle. A browser host is loaded by the same bundle that reads it, so there it
  is a bug.
- Closed by `bootBrowserHost` with no option, so no browser host can forget it.

## Refusals — `ResourceRefusal`

- A refusal is a caller-caused answer, not a server failure, so it is never
  reported.
- An undeclared code is a server bug, so it becomes a reported `loader-failed`
  and only declared codes reach the wire.

## Bytes resources — `bytes: true`

- `invalidate` only: a push would serialize the buffer as `{}`.
- The WS sub-ack carries no value, etag or watermark because each describes a
  value it does not carry.

## Patched values — `patches: true`

[Research](../../../../research/2026-10-21-global-live-value-patches.md).

- **Sub-ack answered from `held`**: a tab joining mid-stream holds exactly what
  the others hold; a change since is already a pending notify whose drain
  patches every holder forward. Two racing first reads leave no `held`.
- **Refused with `revalidate`**: an `up-to-date` answer would name a value the
  base does not.
- **Refused with preload**: persisted values are read with nobody holding the
  base.

## Invariant harness (`core/*.test.ts` + `core/test-support.ts`)

Research: [in-memory harness](../../../../research/2026-07-03-global-live-state-server-invariant-harness.md),
[DB-backed harness](../../../../research/2026-07-03-database-live-state-db-backed-invariant-harness.md).

- **Why `serveSub` seeds only an empty tuple.** H5c is green, but *not* because
  sub-ack and push coalesce: a drain refuses an older flight, so the sub-ack's
  value may come from a different read.
  - Older read: harmless for the diff (extra rows, never fewer), but the router
    reads membership off the same snapshot, so a regressed base drops a real
    change for good.
  - Newer read (after a commit whose NOTIFY has not drained): seeded at the same
    version, the base absorbs the commit. Its drain diffs to nothing and ships
    an ack, while earlier holders drop the newer sub-ack as not newer than their
    own — they never receive the row. Observed: a new conversation stuck
    Unranked in one tab while another tab subscribed the same ranks tuple.
- **Why a snapshot belongs to its span**: a drain that outlived the last
  unsubscribe would resurrect a base nothing routes to, which a later
  subscriber's routing would read membership off.
- **Why etag-before-value**: a later `up-to-date` / 304 would pin a stale value
  shipped under an already-current etag forever.
- **Why `snapshotControllable()`**: `controllable()` resolves at release time,
  so it cannot model a SELECT that already ran.
