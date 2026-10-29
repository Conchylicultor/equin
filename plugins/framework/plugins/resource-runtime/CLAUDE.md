# resource-runtime

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

The single, parameterized live-state resource runtime behind both
`@plugins/framework/plugins/server-core/core` (per-worktree) and
`@plugins/framework/plugins/central-core/core` (the shared central process).

It owns:

- `defineResource`;
- the broadcast machinery (DAG cascade, keyed delta sync, scoped recompute,
  `withNotifyBatch`);
- the `/ws/notifications` and `/api/resources/:key` handlers.

`createResourceRuntime(opts)` returns a fully isolated instance; each facade calls
it once and re-presents its types as its own public surface.

- **Plugins never call it directly.** Declare with `network/live`'s `liveValue` /
  `liveCollection`, serve with `serveValue` / `serveCollection`
  (`plugins/network/plugins/live/CLAUDE.md`). The only callers are that substrate
  and tests.
- **`mode` has no default**: a non-keyed definition states `push` or `invalidate`.
- **A loader must never do synchronous IO** (convention, unenforced).
  - Loaders run inside the shared flush, so `readFileSync` & co freeze every
    loader, `ws.send` and HTTP handler.
  - Use `node:fs/promises`.
- **Hooks** (`ResourceRuntimeOptions`) are JSDoc'd on the type.
  - `server-core/core/resources.ts` binds all of them; central binds only
    `snapHash`, so every hook must degrade to identity / no-op.
  - `console.error` always fires; `reportError` is additive.
- **Host-agnostic and acyclic**: no `bun`, `node:*` or `Bun.*` (the Bun server,
  central and a browser page all host it).
  - Imports only `zod` and the leaves
    `packages/{inflight,string-hash,canonical-params,value-patch,resource-protocol}/core`.
  - Its socket is the structural `RuntimeSocket`; it declares its own local
    `WsData` / `WsHandler` (importing a facade would cycle).
  - Every frame sent is an `ExactServerFrame` (no undeclared field), every frame
    read a `ReceivedFrame<op>`. The vocabulary lives in `resource-protocol`; a new
    frame field moves `PROTOCOL`.
- Client side and keyed/scoped delta semantics:
  `plugins/primitives/plugins/live-state/CLAUDE.md`.

## Core invariants

- **Optional params have one spelling.**
  - Params are canonicalized where they ENTER: every `sub` / `sub-batch` /
    `unsub` / `sub-acks` frame, HTTP, `notify`, derived `dependsOn` tuples,
    `loadResourceByKey`, `measureSubscribeCycle`, `Resource.load`.
  - `canonicalTuple` drops `undefined`, and `""` for a declared `optionalParams`
    name.
  - Frames echo the canonical tuple; the client canonicalizes with the same
    function (`packages/canonical-params`).
  - Flat one-arg forms take no `optionalParams` (tsc).
- **Flush is level-parallel.**
  - `flushNotifies` groups the dependsOn DAG by depth (`entry.depth`); a level
    drains concurrently, with a barrier between levels.
  - `drainEntry` snapshots + clears pending synchronously and keeps its per-pk
    loop sequential (monotonic versions).
  - The scheduler is ONE state (`flushState`: `idle` | `queued` | `running` |
    `rerun`) with synchronous transitions. Never split it back into booleans: a
    notify landing between a rerun check and the release strands every later push.
  - A failed pass re-queues a requested rerun before reporting.
- **Throttle** (`debounceMs`, a served value's `throttleMs`) is leading-edge: at
  most one drain per window, released only by `debounceDue`. Another entry's flush
  or a cascade into it does not drain it early.
- **Heartbeat `pushStallMs`**: age of the oldest undelivered change.
  - It is the oldest of the running pass's start (re-taken per re-drain pass) and
    the oldest queued pending's `enqueuedAt`.
  - Covers a hung loader and a change no flush ever picks up (e.g. a
    `withNotifyBatch` that never settles).
  - Health's Connection row flags ≥ 30 s.

## `ScopePolicy` — the two questions a keyed resource must answer

The two-arg keyed `defineResource` intersects `ScopePolicy`, so a keyed resource
does not compile without both answers:

1. **Which RESOURCE does a change belong to?** A compiler-minted `routes` plan (see
   *Scoped change routing*).
2. **Which subscribed TUPLE owns the changed row?** Exactly one of `membership`
   (bounded window or point set) / `scopedMembership` (unbounded alias,
   `orderSignatureOf` required). There is no "wake every tuple" spelling — every
   tuple re-reading to diff to empty is the hidden cost this exists to prevent.

Rules:

- A DB-backed keyed entry is always a routed membership entry: `buildEntry`
  refuses keyed-without-membership and routes-without-membership.
- `identityTable` / `fanOut` / `recompute` no longer exist; a cast carrying one is
  refused by name (`refuseLegacyScopeKeys`).
- query-resource compilers build opts behind a cast, so each states an annotated
  `const scopePolicy: ScopePolicy<P>`; the `keyed-resource-scope` check is the
  backstop.
- **D31 — external keyed** (`ExternalKeyedPolicy` = `ExternalWindowPolicy` |
  `ExternalPointPolicy`): truth outside Postgres, so never routed (routes or alias
  throw). Declared as:

  ```ts
  defineExternalResource(contract, {
    loader,
    membership: { kind: "window", limitOf, familyOf },
  });
  // or
  defineExternalResource(contract, {
    loader,
    membership: { kind: "point", idsOf },
  });
  ```

  - `familyOf` is optional; there is no `windowIdsOf` and no `orderSignatureOf`.
  - Its `notify(params)` is a FULL pending that re-reads the tuple and diffs by key
    (`drainMembershipFull`): keyed deltas, per-tuple snapshot, derivable via
    `familyOf`.
  - Postgres reads beside its truth go in a `reach` plan (all routes `full`;
    `routingRecordFor` refuses `reach` on any other keyed entry).
  - It may follow external upstreams; nothing may cascade out of it (D32).
  - Never L2-persisted.
- **Non-keyed** entries have no scope policy.
  - DB-backed ones are reached through a `reach` plan (none ⇒ change-feed refuses
    boot, D6).
  - External ones are reached through `notify()` (+ `reach` if declared).
  - A `dependsOn` upstream must be EXTERNAL (T15, thrown in both registration
    orders and at DAG rebuild).

## Bounded membership (`membership`) and the `scopedMembership` alias

A membership selector makes an INSERT / DELETE / where-flip ship an incremental
delta (refill only the changed rows, reconcile via `diffKeyedScopedMembership`)
instead of a FULL recompute.

| Shape | Params name | Notes |
|---|---|---|
| `membership: { kind: "window", windowIdsOf, limitOf }` | a bounded ordered window (`ORDER BY … LIMIT n`) | The loader at the same params MUST be the matching windowed query, so FULL is always the bounded window read. `limitOf` required. |
| `membership: { kind: "point", idsOf }` | an explicit id set | `idsOf` pure / sync / cheap (runs per tuple on routing). Routed iff changed ids intersect; no ids query; never fans to `{}`. |
| `scopedMembership: { orderOf, orderSignatureOf }` | an unbounded window (alias) | The only shape L2 persists. Mutually exclusive with `membership`. |

Window drain (`drainMembershipScoped`) classifies *entered* / *exited* against the
prior snapshot:

- **Full bounded window**: an entrant or an exit runs `windowIdsOf` once, then
  backfills new tail rows with one scoped refill.
  - Entrant past the tail ⇒ no frame.
  - DELETE outside the snapshot ⇒ no-op.
- **Not-full window** holds its whole range, so exit-only changes derive order from
  the snapshot (zero queries).
  - A drain never records a snapshot shorter than the window `windowIdsOf` named:
    a **torn read** is rebuilt by one bounded FULL read, else its hidden rows would
    never return.
  - A `limitOf` that throws reads as full.
- **Alias**: `orderOf` runs only on an entry or an order move; no backfill.
- **Pure in-place change** never runs the ids query (one upsert, no `order`).
- **Order signature** (`orderSignatureOf(row, params)`): a cheap encoding of
  exactly the ORDER BY fields.
  - A member whose signature moved triggers one re-derive.
  - Missing or failed ⇒ treated as moved (fail-safe).
  - Absent ⇒ the ORDER BY must be update-stable.
- **A membership delta always ships the full `order`** (the client rebuilds from
  it; that is how a squeezed-out tail leaves).
  - `nextSnapshot` is rebuilt FROM the wire order.
  - It throws if a refill id entered but no `orderedIds` was supplied.

**Persistence.**

- `persisted` is:

  ```ts
  !externalSource && !membershipBounded(entry) && shouldPersist(key);
  ```

- Bounded entries are never persisted (read off the definition, never by name).
- A persisted alias keeps its snapshot across N→0; its scoped drains arm a floor
  persist; `drainMembershipFull` seeds / replaces the snapshot even with zero subs.
- A membership entry has no downstream (D32: `dependsOn` onto one throws).

**Boot seed.**

- live-state-snapshot calls `seedPersistedSnapshot(key, "{}", value, base)` before
  catch-up, so the first change is a scoped refill, not a FULL rebuild.
- No-op when a snapshot exists; aliases only (`unboundedWindowKeys`).
- Returns `SeedOutcome`: `seeded` | `skipped` | `invalid` (A30 — the value fails
  the payload schema; the caller clears and recomputes).
- `validatePersistedValue` is the same parse without seeding, run in
  `onReadyBlocking`.

## Seeded derivation (a `sub` frame's `derive`)

A paged read's split / merge may send `sub` with a `derive` field: the new tuple as
slices of held source tuples (at most `DERIVE_MAX_SOURCES` = 2 sources).

```ts
derive: {
  id,
  from: [{ params, version, after, until }],
}
```

`deriveSub` answers synchronously in the same step `handleSub` registers the tuple,
so no change lands between check and copy.

- **Derived** only when all of these hold:
  - the sub's `protocol` equals the server's `PROTOCOL` (else `protocol-skew`);
  - the entry is a bounded window with `membership.familyOf` and no `revalidate`;
  - the sub opened the span;
  - every source is the same family and quiescent (subscribed, snapshot present,
    no pending, not draining, versions equal);
  - a slice through a source's end needs a non-full source;
  - slices don't overlap or exceed `limitOf`.

  Answer: `sub-ack { version, epoch, derived: { id } }` — no value, etag or
  watermark (Rule B′), no load.
- **Otherwise** fall back to a full load (`serveSub`). Refusals are counted by
  reason in `_debug.deriveFallbacks`.
- **Trust boundary**: that the slices cover the new range is the client's claim;
  the runtime checks family, quiescence, completeness and fit.
- The echo matches the client-minted `id` (the shared socket broadcasts every
  frame), never re-spelled sources.
- `sub-batch` entries never derive.

Pinned by `runtime-derive.test.ts` (incl. `makeClientView` convergence under random
interleavings, routed and external windows).

## L2 persists: replace and floor (`PersistMeta`)

`persistSnapshot` takes `{ mode, definition, guardTables }`; calls are serialized
per (key, pk) (`persistChains`).

- **`replace`** — every FULL recompute of a persisted entry.
  - The value is floored by its flight's own watermark; `guardTables` = the run's
    read-set.
  - Replaces `position`, `position_at`, `tables_read` and the definition.
  - It cancels an armed floor window SYNCHRONOUSLY before enqueuing (re-arms on
    failure). Otherwise a mid-write floor would overwrite the fresh row with the
    pre-replace snapshot.
- **`floor`** — a persisted alias's scoped drains arm ONE trailing window
  (`persistWindowMs`, default 2 s, fixed).
  - On fire, the value is rebuilt from the snapshot (`valueOfSnapshot`) and floored
    by the **base floor**.
  - L2 only LOWERS position (`LEAST`).
- **Base floor** (`baseFloors`, per pk, aliases only) = the watermark of the FULL
  read the snapshot was last rebuilt from (`drainMembershipFull`, sub-ack seed,
  `seedPersistedSnapshot`).
  - Unknown ⇒ floor persists skip until the next rebuild.
  - A scoped drain NEVER captures one: its refill reads only some ids, so a capture
    could skip an unrouted lower-xid commit forever.
- **Definition** (`RoutePlanInput.definition`, read via `definitionOf`, never
  copied onto the entry) rides every persist.
  - `persistedDefinitions()` is what L2 rows are matched against.
  - `ReachPlan` carries none.
- `keptSnapshotValue(key)` serves the boot snapshot from the kept snapshot;
  `dropPendingPersists()` runs at shutdown.

## Scoped change routing (`routes` + `routeTableChange`)

Every DB-backed resource declares, as data, which tables reach it — routing never
uses the captured loader read-set. Plans live in `core/routing.ts` (SQL-free, names
no contributor).

**The two plans**

- **`RoutePlan`** (keyed, membership arms only) holds `Route`s, each with:
  - a table occurrence;
  - a `HostMap`: `identity` | `alias` | `reverse` | `full` (`identity` / `alias`
    with no `column` read the table's single-column PK);
  - the referenced `columns`;
  - an optional key filter.

  Plus a pure per-tuple `usesOf(params)` naming the routes a tuple reads, in the
  `membership` or `value` role. An unknown route id is reported and the tuple FULLs
  (A9).
- **`ReachPlan`** (non-keyed, or D31 external) holds `full` routes only, plus:
  - `relations` — views / rollups read whole, indexed under their bases by
    `indexRelationReads()` (A1′ holds bases to a change source);
  - `unfed` — tables the feed skips by declaration (`unfedResourceTables()`);
  - `notified` — external only: changes arrive via its own `notify`;
  - `taggedReads` — route tables covered only by statements carrying a
    `/* read-tag:… */`.

  It may sit beside `dependsOn`; a keyed entry, a non-`full` route or `routes`
  beside it throws.
- **Minted, never written.** Plans carry a module-private brand only
  `mintRoutePlan` / `mintReachPlan` add (a literal is a tsc error, an unminted cast
  throws). The `resource-runtime:compiled-routes` check allows minters only in
  `infra/query-resource`'s `routes.ts` and tests.

**Inputs and layout**

- **Routed entries take no `dependsOn`** (type + throw): a cascade would FULL over
  a scoped refill. Their one non-table input is **`recomputeOn`**: upstream TUPLES
  of EXTERNAL resources (registered first) whose change FULL-recomputes every
  subscribed tuple and drops the memoized `usesOf`.
- **Relation bases**: views / rollups are reached through `opts.relationBases`
  (injected by change-feed via server-core's `setRelationBases`; identity on
  central).
- **Trigger layout is derived**: `routedTableRequirements()` →
  `tableLayoutRequirements` gives per-table CARRY columns and `reads`.
  - CARRY columns are map columns, `rows` keys and `Route.match` columns; matching
    on an undeclared one FULLs the tuple.
  - Change-feed installs triggers from it.

**Routing a change**

- **Targets**: subscribed tuples (`entry.tracked`), plus `{}` for a persisted
  entry (or one with downstream edges while nothing is subscribed).
- **Per tuple**, in order:
  1. gate: a `U` whose `unchanged` lists every route column skips;
  2. key filter: `route.rows` ∧ `use.match`;
  3. the map: identity `D` ⇒ deleted; anything else ⇒ "these host rows may have
     changed" (a side-table I/U/D is a host U).

  Unknown values, `full`, or a throwing `usesOf` / `encode` ⇒ FULL (isolated per
  tuple / entry).
- **`TupleUse.moves`**: a `U` unchanged on all of them is delivered in the `value`
  role. A value-role host that is no member is dropped — only while the tuple is
  quiescent.
- **Reverse routes** resolve in the drain (`resolveReverseRoutes`):
  - once per (entry, route, flush), riding the same pending
    (`PendingNotify.unresolved`);
  - capped at 500 (over-cap / throw ⇒ FULL the readers);
  - `resolve` is supplied by the compiler (`infra/query-resource/CLAUDE.md`,
    *Reverse routes*).
- **A skip is never a pending**: it owes at most an ack (`entry.pendingAcks`). An
  empty scoped pending is a skip on every entry kind.
- **An ack covers the changes routed before its drain**, so a producer must deliver
  a transaction's changes together (change-feed routes one NOTIFY burst per
  macrotask).

**Guards and introspection**

- **Drift guard (A8 / A22)**: after each load, the per-run capture must be ⊆ route
  tables ∪ `derivedReads` (∪ unfed, relations, tagged-with-tag, notified —
  `readCovered`).
  - A miss is reported once per table (`route drift for <key>`).
  - It throws under `strictRoutes` (tests).
  - It **fails open**: the drifted bases FULL-route to the entry.
  - `seedRouteDrift(persisted)` (D7) re-judges persisted `tables_read` at boot.
  - **D5**: the same guard arms on externals with a `reach` plan or `notified` /
    undeclared freshness.
  - **D6**: `unroutedResourceKeys()` — change-feed refuses boot on any.
  - **Follow routes** (`Route.via`): a followed table is never covered by the
    entry's own capture — see *Follows*.
  - Off when no capture is wired (central, DB-free harness).
- **`_debug` (A7 / A26)**: each entry gets a `policy` (`unbound` | `external` |
  `routed` | `unrouted`, via `debugPolicyOf`) plus `routes`, `derivedReads`,
  `routeDrifted`, `readSetBases`, `tuples`, `persisted`, `positionAgeMs`,
  `freshness` and `shape`. Central degrades to empty / false / null.

Pinned by `runtime-table-routing.test.ts`, `routing-layout.test.ts`,
`runtime-declared-reads.test.ts`, `runtime-debug-policy.test.ts`.

## Follows — `Route.via`, `onFollowReached`, `loadResourceFresh`

A served value reading collection TUPLES (network/live's `follows`) carries the
collections' own routes, copied into its reach plan by query-resource's
`followRead` and tagged **`via: { name, collection }`** (`RouteVia`). They route
like any reach route (gate, `rows` ∧ `use.match`, then FULL): no new edge kind.

- **Minting.** A follow owns its tables.
  - `mintReachPlan` refuses an own route, unfed, relation, notified or tagged
    read of a followed table, and one follow name reading two collections.
  - `mintRoutePlan` refuses a follow route (a keyed plan never follows).
  - Two follows may read one table: `RoutingRecord.via` keeps every follow per
    table; the drift and relation refusals name them all.
  - A relation read whole whose BASES include a followed table is refused once
    the bases are known (`indexEntryRelations`).
- **A8.** The follow's read runs in the collection's own loader span
  (`loadResourceFresh`), judged by the collection's drift guard.
  - The follower's OWN capture never covers a followed table (`readCovered`):
    a query on one in the follower's loader is a read by hand — reported,
    thrown under `strictRoutes`, failed open past gate and match
    (`indexDriftBases` serves it FULL).
  - The D7 seed (`"untracked"`) judges a followed table by its name.
- **Each run is judged on its OWN capture** (`wrapLoad`'s `capture`, a
  `RunCapture` the host calls as the run's loader span closes —
  runtime-profiler's `onReads`), an empty one included.
  - `lastReadSet` is read only for a run whose host handed none (a harness
    without `wrapLoad`), and by `persistReadSet` (param-less persisted entries;
    an empty run falls back to the route tables).
- **R1 — paged followers.** An external keyed window / point set takes the same
  full-only reach: a follow route's per-question match re-reads only that
  question's live pages (`drainMembershipFull`).
- **R2 — `onFollowReached(params) → Promise<"repointed" | "unchanged">`**
  (`ResourceDefinition`, two-arg options).
  - Called synchronously from `routeEntryChange`, before the change is
    scheduled and outside any flight, inside `wrapOrigin("bg", key)`, in push
    and invalidate modes.
  - For each TRACKED tuple (never a persisted entry's unsubscribed `{}`) a
    follow route lets the change through to (gate, static rows, the tuple's
    match); a drift-failed-open followed table or an unusable read-set counts
    as reached.
  - network/live re-points the tuple's `whileFollowing` start there
    (`followLifecycle`).
  - `"repointed"` is counted per key (`_debug.followRepoints`); a rejection is
    reported.
  - Declared with no follow route in the plan, it throws (registration / bind).
- **`loadResourceFresh(key, params)`** (re-exported by server-core): one tuple
  read through `timedLoad` (loader span, schema parse, drift guard).
  - Never joins an in-flight read; captures no watermark; touches no tracking
    state.
  - Throws on an unknown key, an unbound deferred one, and a tuple its params
    gate refuses.
- **`_debug`**: `follows: [{ name, collection }]` per key (from the plan's `via`
  routes) and `followRepoints`.
- **Messages.** D32 / T15 and the routed `recomputeOn` refusals point to
  `follows`.

Pinned by `core/runtime-follows.test.ts` (minting, A8 and its fail-open, the D7
seed, the relation refusal, routing and R1, the hook's targets / modes / origin /
counts / refusal, `loadResourceFresh`).

## Deferred resources (`defineDeferredResource` / `bindDeferredResources`)

For a resource compiled only once contributions are known (`LiveColumns.Expose`,
`LiveColumns.Scoped`, union arms), or an EXTERNAL value with computed reads (D4).

- `defineDeferredResource(contract, bind, { mode, freshness })` registers the entry
  NOW from the contract, with a throwing loader.
  - The contract supplies key, mode, schema, `keyOf` and preload — visible to
    `Resource.Declare`, `preloadedKeys()` and `_debug`.
- `bindDeferredResources()` runs each `bind()` through the same `buildEntry`
  validation `createResource` uses.
  - The facade calls it right after contributions are collected, before serving
    and before change-feed rebuilds triggers.
- A bind restating another freshness is refused.

## Keyed snapshot representation (`SnapEntry` / `SnapEncoder`)

Chosen per resource from the definition by `snapEncoderFor`:

| Entries | Encoding | Why |
|---|---|---|
| Default | 64-bit hash of the row's canonical JSON (`snapHash`; Bun hosts wyhash, else `hash64`) | Accepted trade: a collision masks one row update (~n²/2⁶⁵). |
| `scopedMembership` aliases (`retainSnapEncoder`) | full canonical JSON | The persisted path `JSON.parse`s it back. Keyed off the definition, not `shouldPersist`, so it cannot flip; reconstruction throws on a hashed entry. |

`keyed-diff.ts` stays pure (the encoder is passed in); the diff suite runs under
both encoders.

## Frame stamps: etag, watermark, `ackTx`

- **A push ETag rides the `update` frame — and nothing else.**
  - `pushEtag` has one caller, `sendUpdate`.
  - An ETag may accompany only a frame CARRYING its value: `invalidate` and `delta`
    cannot get one (an etag on either is a permanent stale pin).
  - A keyed SCOPED delta must NEVER carry one; a FULL delta could, but the protocol
    declares no field.
- **`sendUpdate` sends the frame itself** — no await before `ws.send` on the
  non-`revalidate` path. Test this directly, never by racing a push against a
  parked sub-ack (that order is a microtask accident).
- **D8 — a value recompute that changed nothing is not a change.**
  - Pushed, non-persisted, non-keyed values keep `held` per tuple (the value as
    served + its version).
  - A drain loads before minting and compares with `diffValue` (`compareHeld`):
    `[]` ⇒ no version, no frame, just the owed ack.
  - `held` is set only when a frame went to EVERY current subscriber in the same
    tracking span (or by the span-opening sub-ack to its sole holder, `noteRead`).
  - It is dropped on load failure, a partial frame, other read content, and N→0.
  - Not for `invalidate`, keyed or persisted entries.
- **Commit watermark** (`opts.captureWatermark` → database `snapshotWatermark`;
  none on central).
  - Rides only frames that fully reconcile: `sub-ack`, `update`, FULL keyed /
    membership deltas, the HTTP body. **A scoped delta never carries one.**
  - Captured BEFORE the loader read, by the single-flight STARTER (joiners adopt
    its pair).
  - A throwing capture is reported and the frame ships without one.
  - The same per-flight capture is the L2 `replace` floor and base floor — never a
    second capture at the drain (it could be newer than the value and make
    catch-up skip the missing commit).
- **`ackTx`** (mutation acks).
  - Change-feed NOTIFY `x` txids coalesce into the pending's `sourceTx`: unioned on
    every merge (incl. FULL absorb), capped at 64 (overflow suppresses —
    `_debug.ackOverflows`).
  - They cascade into downstream pendings and are stamped on the resulting
    `update` / `delta`.
  - Narrow claim: every row W wrote in this tuple is reflected. It may confirm,
    never deny, so a scoped delta may carry it.
  - FULL paths stamp the flight-resolved set (a joiner never stamps its own seed on
    another's value).
  - No value change ⇒ a version-less `{ kind: "ack", … }` frame, sent only to
    sockets whose tab asked (`SocketSubRecord.ackTabs`, set by `acks: true` on
    `sub` or by `op: "sub-acks"`).
  - A loader failure drops the frame and the acks together.
  - Client half: `optimistic-mutation/CLAUDE.md`.
- **HTTP ETag ⇒ `cache-control: no-store`** on both 200 and 304: the handler
  emitting an ETag owns forbidding cache storage (a restart-stable ETag would
  otherwise revalidate an old-boot body into a 304).

## Flight freshness: a stamp describes the flight that produced its value

> A flight may only serve a caller whose freshness floor it satisfies, and every
> stamp a frame carries — etag, watermark, `ackTx`, **version**, persisted floor —
> must describe the flight that produced its value.

All but the version are co-produced by the starter. A push drain mints
`version = current + 1` before loading, so it must REFUSE older flights:

- **Read** frames (`sub-ack`, HTTP) observe the version BEFORE the load and pass no
  floor. A joined older value then reports an older version, which the client
  drops.
- **Push**: the two FULL drain sites (`drainMembershipFull`, the non-keyed FULL
  drain in `drainPendings`) pass `notBefore: pendingEntry.lastNotifyAt`; an earlier
  flight is superseded (`_debug.staleFlightSupersedes`).
- **Never derive the floor from `gated`**: boot-snapshot fan-out and multi-tab
  herds are gated READS, and flooring them reinstates the replay storm.
  `loadResourceByKey` / `measureSubscribeCycle` stay floor-less.
- `lastNotifyAt` is the MOST RECENT notify (not `enqueuedAt`), refreshed before
  `mergePending`'s FULL-absorb / degrade early returns. Assumes autocommit loaders.

## Read path: version short-circuit (bootEpoch), gate-after-dedup, per-tab subs

- **Version short-circuit.**
  - `sub-ack` / `up-to-date` carry `epoch` (`bootEpoch`, per runtime instance).
  - A `sub` echoing a `{ version, epoch }` of THIS boot equal to the current
    counter, on a non-`revalidate` resource, gets `up-to-date` with no load.
  - Relies on: *the per-pk version counter is the complete change signal within a
    tracking span*. So **every span opens with a fresh version** (bumped at global
    0→1 in `registerSubOnSocket`); a pre-span version never matches.
  - `revalidate` resources are exempt (the ETag is their authority).
  - HTTP has no short-circuit.
- **Gate-after-dedup.** The read-admission slot is acquired INSIDE the
  single-flight, so N concurrent reads of one tuple take 1 slot.
- **Per-tab subs + batch replay.**
  - Per-socket records tag the holding tabs (`SocketSubRecord`; untagged ⇒ `""`).
  - `op: "sub-batch"` registers entries first, then `complete: true` releases what
    the tab did not restate, so an identical replay never goes 1→0→1.
  - Current entries collapse into one `up-to-date-batch`.
  - `op: "unsub-tab"` on `pagehide`.
- The HTTP body is `{ value, version, epoch }`, the version read before the load.
- **`sub-error` frames carry `params`** (the shared socket broadcasts to every
  tab).

## The params gate: a contract mismatch is version skew, not a crash

`validateParams` is required on `ResourceContract` (only the flat form may omit
it). It throws `ResourceContractError` (`packages/resource-protocol`) on a
mismatched tuple — typically a tab on the previous bundle.

- **Gate first**: before `authorize` and `registerSubOnSocket`.
  - WS refusal ⇒ `sub-error reason:"contract-mismatch"` + `verdict`, never
    registered.
  - HTTP: 409 (404 for an unknown key, 500 `loader-failed`), a
    `ResourceHttpErrorBody`, `no-store`.
- **Verdict** (`rejectContract`) compares the client `build` with
  `serverBuildGraph()`: `skew` is only `console.warn`ed; `same-build` / `unknown`
  are reported.
- **Backstop**: a `ResourceContractError` from a registered tuple's loader evicts
  it everywhere (`evictOnContractError`) and always reports.
- Declaration-time and encode failures stay plain `Error`s (programmer errors).

## A closed key set — `unserved`

`keySet: () => "closed"` declares a host shipped with its only client (a browser
host — server-core's `bootBrowserHost` closes it via `closeResourceKeySet`).

- **Closed**: an unknown key is a bug; `refuseUnknownKey` answers `unserved`
  (HTTP 404) and reports it.
- **Open** (default): `unknown-key` with a verdict, unreported.

## Refusals — `ResourceRefusal`

A loader throws `ResourceRefusal(code, message)` for an EXPECTED, caller-caused
refusal (missing file, unknown id).

- `code` must be declared in the contract's `refusals`; an undeclared one is
  turned by `declaredLoad` into a plain reported `Error`.
- A declared one is only `console.info`ed, and sent as `sub-error reason:"refused"`
  / HTTP 422 `{ reason, code, detail }`.

## Bytes resources — `bytes: true`

The value is an `ArrayBuffer`, never in a JSON frame.

- HTTP answers `application/octet-stream` with the envelope in headers
  (`resourceBytesHeaders`).
- The WS sub-ack carries no value / etag / watermark and runs no loader (the client
  then reads HTTP).
- Notifies send `invalidate`.
- **`invalidate` mode only** (`buildEntry` throws).

## Patched values — `patches: true`

A pushed value whose changes ship as `patch { base, version, ops }`.

- Per tuple, D8's `held` is the value every holder at its version holds; while it
  stands, a sub-ack is answered FROM it (no load).
- `sendUpdate` diffs against it, synchronously:
  - `[]` ⇒ nothing;
  - ops ⇒ `patch`;
  - a root change or no base ⇒ `update`.
- Dropped on load failure, other HTTP content, N→0 (the next frame is a whole
  `update`).
- Refused at registration with a non-push mode, `revalidate`, or preload.

## Profiling seams (all optional; central binds none)

Bound to profiler spans in `server-core/core/resources.ts`:

| Seam | Wraps |
|---|---|
| `wrapLoad(key, info, fn)` | every loader run (`info.variant`, `info.scopedIds`) |
| `wrapOrigin(kind, key, fn)` | `sub` \| `push` \| `cascade` — cascade is only the reverse-route resolve; `dependsOn` recomputes are `push` |
| `wrapFlush` | a flush |
| `wrapHttp` | an HTTP read |
| `wrapMembership` | `windowIdsOf` |
| `onDelivered(key, ResourceDelivery)` | a delivered frame |

Value frames from a pending with `PendingNotify.changedAt` carry
`timing: { changedAt, sentAt, deliverMs }`, built by `frameTiming(pending)` —
observability only, nothing decides on it.

## Invariant harness (`core/*.test.ts` + `core/test-support.ts`)

DB-free, socket-free suites over the `createResourceRuntime` fake-injection seam;
each `describe` / `test` name states what it pins (`runtime-*.test.ts`,
`keyed-diff.test.ts`).

- `test-support.ts`:
  - `createHarness(opts?)` — runtime + recording fake sockets;
  - `controllable()`;
  - `makeClientView()` — applies frames through the REAL version guard;
    `expectDerived(rows, { id })` for derived subs;
  - `rng`.
- `testing/routed-fixture.ts` (via `core/testing`):
  - `identityPlan`;
  - `defineRoutedTable` — refuses a key the harness answers a read-set for;
  - `wholeReach`, `feedChange`;
  - `createHarness` / `Harness` re-exported.
- **`controllable()` resolves at RELEASE time** and cannot model a SELECT that
  already ran. Stale-flight tests must use `snapshotControllable()` (captures at
  invocation).

Load-bearing results:

- **`serveSub` seeds a keyed snapshot only when the tuple has none.**
  - A sub-ack's read may be older (a regressed base makes routing drop a real
    change for good) or newer (it absorbs an undrained commit, so earlier holders
    never get the row).
  - A held snapshot can only lag a joiner — a redundant row, never a missing one
    (`runtime-reseed-ahead.test.ts`, `runtime-snapshot-base.test.ts`).
- **A snapshot belongs to its tracking span** (`entry.spans`): a keyed drain writes
  it and ships frames only if its starting span is still current (`snapshotOwner`;
  persisted aliases excepted).
- `runtime-revalidate` pins etag-BEFORE-value: a mid-load change must never ship a
  stale value under a current etag.

Out of reach at this seam (DB-backed harness instead):
`live-state-snapshot/server/internal/{persist,catch-up}.test.ts` and
`change-feed/server/internal/listener.test.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Core:
  - Uses: 22 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `packages/resource-protocol` ×15
    - `packages/string-hash` ×2
    - `packages/value-patch` ×2
    - `packages/canonical-params.canonicalParams`
    - `packages/inflight.createInflight`
    - `packages/semaphore.createSemaphore`
  - Exports (types):
    - `AliasMembership`
    - `ChangeSource`
    - `DefineResourceInput`
    - `DependsOnEntry`
    - `DerivedRead`
    - `ExternalKeyedPolicy`
    - `ExternalPointMembership`
    - `ExternalPointPolicy`
    - `ExternalResource`
    - `ExternalWindowMembership`
    - `ExternalWindowPolicy`
    - `FollowReached`
    - `FullRoute`
    - `HostMap`
    - `KeyedDiff`
    - `KeyedMembership`
    - `KeyedMembershipInput`
    - `KeyedResourceContract`
    - `KeyedServerResourceOptions`
    - `NotifiedRead`
    - `NotifyCounts`
    - `PersistedBase`
    - `PersistedValueCheck`
    - `PersistMeta`
    - `ReachPlan`
    - `ReadTags`
    - `RelationRead`
    - `Resource`
    - `ResourceContract`
    - `ResourceDefinition`
    - `ResourceDelivery`
    - `ResourceMode`
    - `ResourceParams`
    - `ResourceRuntime`
    - `ResourceRuntimeOptions`
    - `Route`
    - `RoutedRecomputeOn`
    - `RoutePlan`
    - `RouteVia`
    - `RunCapture`
    - `RuntimeSocket`
    - `ScopedResourceTable`
    - `ScopePolicy`
    - `SeedOutcome`
    - `ServerResourceOptions`
    - `SnapEncoder`
    - `SnapEntry`
    - `TableChange`
    - `TableLayoutRequirement`
    - `TaggedRead`
    - `TupleUse`
    - `UnfedRead`
    - `UnfedResourceTable`
    - `WsData`
    - `WsHandler`
  - Exports (values):
    - `createResourceRuntime`
    - `diffKeyedScopedMembership`
    - `mintReachPlan`
    - `mintRoutePlan`
    - `ResourceGuardError`
    - `retainSnapEncoder`
    - `tableLayoutRequirements`
- Cross-plugin:
  - Imported by:
    - `framework/central-core`
    - `framework/server-core`
- Exemptions:
  - Exempts itself from:
    - `resource-runtime:compiled-routes` — `core/routing.ts`, `core/index.ts` (sanctioned)
    - `live/no-legacy-resource-spelling` — `.` (sanctioned)
- Test helpers:
  - Core: `@plugins/framework/plugins/resource-runtime/core/testing`
    - `buildSnapshot` — Build the id→entry map for a keyed resource's array `value`, in array order.
    - `createHarness` — A runtime under test plus `sockets` (default 1) fake `ServerWebSocket`s opened via `notificationsWsHandler.open`.
    - `defineRoutedTable` — Register a keyed resource over `spec.table` the way a compiled collection is.
    - `diffKeyedFull` — Full diff: compare the new array `value` against `prev` (the prior snapshot, or `undefined` on first notify).
    - `diffKeyedScoped` — Scoped diff (Layer 2): `scopedRows` is a PARTIAL array — only the recomputed affected rows.
    - `feedChange` — One base-table change as the change feed delivers it (`routeChange`).
    - `hashSnapEncoder` — The portable 64-bit hash encoder: the runtime's default `snapHash`.
    - `identityPlan` — The plan `compileWindowQuery` emits for a single-table window / point set / alias: one identity route `base` on `table`, gating on `cols`, read by every tuple in the membership role.
    - `makeClientView`
    - `wholeReach` — The reach plan of a non-keyed value reading each of `tables` whole: one `full` route per table, read by every tuple — so a change to any of them recomputes each tracked tuple (and a param-less persisted / cascading entry's `{}`) FULL.
    - Types: `ClientView`, `DeriveFrame`, `DeriveSourceFrame`, `FedChange`, `Harness`, `KeyedSnapshot`, `RecordedFrame`, `RoutedTable`, `RoutedTableSpec`

<!-- AUTOGENERATED:END -->
