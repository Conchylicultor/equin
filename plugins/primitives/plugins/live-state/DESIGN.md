# live-state — design

Why the rules in [CLAUDE.md](CLAUDE.md) are what they are. Read before changing or removing one.

## No Suspense — hydrate, don't suspend

- **Why `preload` exists.** React Query garbage-collects a query with no
  mounted observer after `gcTime` (5 min). A boot-hydrated value for a surface
  the user has not opened yet is dropped, and the next mount reads `loading`
  long after boot said the value was known. Concrete failure: a `<DataView>`
  opened mid-session claims "No views configured" for the seconds until its
  sub-ack lands.
- **Why `hydrateResource` sets query defaults before seeding.** `useResource`
  also passes `gcTime: Infinity`, but only when an observer mounts — too late
  for a tuple nobody opens within 5 minutes of boot.
- **Why one flag, on the shared descriptor.** The boot snapshot, the L2 persist
  set, the eager-tier generator and the client's `gcTime` all read the same
  declaration, so they cannot disagree about what is preloaded. `load` sits on
  the shared descriptor for the same reason: server and client cannot disagree
  on whether HTTP is the read path.
- **Why `canonicalParams` everywhere.** Without it, `URLSearchParams` writes
  `"undefined"` into the HTTP fallback URL, and the subscription, the prime and
  the query key can name different tuples for one logical read. The server
  applies the same function and echoes the canonical tuple in every frame, so
  the two ends cannot key a tuple differently.
- **Why a `sub-error` fetches the disabled query directly.** Invalidation skips
  a disabled query, so without the direct fetch the read would be left
  `pending` with no error.

## A burst of landings is one commit (`internal/coalesced-notify.ts`)

Each cache write (one per WS frame) is its own React Query batch, and the
default scheduler gives each flush its own `setTimeout(0)` task. Without the
coalescing scheduler, a cold list's per-row sub-acks arriving back to back are
N React commits. Order and asynchrony are unchanged by coalescing.

## A varying list of tuples — `useResources`

- **Why diff the sub set.** Unobserving and re-observing a kept tuple lets its
  socket subscription lapse.
- **Why share keyed by tuple, not by position.** Positional sharing pairs a
  kept tuple with another tuple's previous data after a reorder, grow or
  shrink, and hands out a deep copy instead of the cache's own object.
- **Why `release: "now"` drops the cached value.** Nothing keeps the tuple
  current once it is unsubscribed, so observing it again must read `loading`
  until the server vouches for a value — never the old one as `ready`.
- **Why unmount still uses keep-alive.** A remount (StrictMode included)
  reuses the live subs.

## Seeded derivation — a sub answered from rows this tab holds

- **Why the `id` is minted per derivation.** A duplicated tab can ask for the
  same slices; the id lets each tab tell its own answer apart.
- **Why only a socket-built value.** A value built from sub-ack / update /
  delta / derived ack applied in order IS the server's snapshot at `version`.
  An HTTP body carries no such guarantee.
- **`source-hydrated` is accepted latency, measured.** A boot-hydrated source
  before its first `sub-ack` cannot seed; the `live-pages` channel counts each
  refused seed so the cost stays visible.
- **Why match on the id alone.** Matching on the sources as the server spells
  them back can make the asking tab drop its own answer.
- **Why dialect-gate the socket.** A bundle that predates derived acks parses
  one's missing value and adopts its version, wedging its read. Naming the
  protocol keeps a tab left open across a vocabulary-changing deploy on a
  socket of its own, while a deploy that did not change it keeps sharing.

## Hazard tests (H1–H7) — the executable correctness argument

Only `WebSocket`, `SharedWorker`, `MessagePort` and `navigator.locks` are
faked; the real SharedWorker host runs in-process, so the tests exercise the
production fan-out. Design:
[research/2026-07-03-global-live-state-client-transport-harness.md](../../../../research/2026-07-03-global-live-state-client-transport-harness.md).

## Replay is ONE `sub-batch` frame; recovery resubs never echo state

- **Why built synchronously.** Snapshot, baseline reset and send in one task,
  so an `observe()` cannot interleave.
- **Why a released tuple misses the echo.** When the old socket's `close` ran
  before the replay, the server released the tuple and opens a new tracking
  span with a fresh version on re-subscribe. The same reason makes the
  missed-update probe ignore a reopened socket: the higher version is a
  re-baseline, not a frame the live socket dropped.
- **Why `unsub-tab` as last will.** A departed tab's subs release immediately
  instead of leaking until the socket cycles.
- **Rejected: a client-side per-sub replay stagger.** Same-socket replays
  short-circuit server-side for ~0 cost, and post-restart replays (and
  reconnects the server already released) are bounded by the server's
  read-admission gate + single-flight dedup. Herd control belongs there, not in
  client pacing.
- **Why "no base" means no server-vouched value.** Another tab's subscription
  on the shared socket can fill the cache before this tab's sub-ack. A scoped
  delta merged onto that value settles the read on a false partial list.

## One socket per origin, shared across tabs

- **Why the version echo is gated on a held value.** The sub outlives the
  query: React Query GCs the query after `gcTime`, so the cached value does not
  always survive a reconnect.
- **Why the ignored `up-to-date` does not force a resub.** Its own ack is
  already in flight, and congestion is what triggers this path — a resub would
  add load exactly then.
- **Why `pushStallMs` rides pings.** It is the only sign a tab gets of a server
  whose pushes stopped while the socket stays open. Resetting it on any socket
  status change keeps a dead server's stall from outliving its connection.
- **Why `sub-error` carries `params`.** So the shared-socket broadcast is gated
  on the local sub entry like every other frame; a params-less frame matches no
  live sub and is dropped safely.
- **Why heal through `prefetchQuery`.** Unlike `invalidateQueries` it reaches a
  query disabled until its first value, and its outcome uses the single
  existing error channel (`q.error`) rather than touching React Query
  internals.
- **Why refusals go to one store.** The fix (reload) is offered once, app-wide,
  not by every failed read.
- **Why `build` rides every frame.** One shared socket carries tabs running
  other bundles.
- **Why terminal errors are not retried.** The same bundle is refused the same
  way.
- **Limit:** `handleResourceHttp` runs no `authorize` check — moot while no
  resource declares `authorize`.

## Scoped pipelines — a subtree talking to another backend

- **Why scope per transport.** A subtree rendered against an in-browser
  backend (the demo scope) must never cache, confirm or report against the
  page's server, and the page must never see its tuples. See
  [research/2026-10-12-global-in-app-demo-scope.md](../../../../research/2026-10-12-global-in-app-demo-scope.md).
- **Why teardown waits a microtask.** StrictMode's remount re-retains the
  pipeline.
- **Why socket identity is the URL.** The ws-status bus is page-global and keyed
  by URL; `socketKindOf` matches only the client's own sockets.
- **Why telemetry is gated but the failing set is not.** Page-wide sinks must
  not report a scope's reads; the failing set stays the scope's own UI state.
- **Why some things are not scoped.** The contract-mismatch store is about the
  page's bundle (version skew), and pending-mount counters are page
  diagnostics.

## One client, one cache — `NotificationsProvider` takes no client

- **Rejected: a `queryClient` prop on the provider.** The singleton client keeps
  the cache it was first built with, so a second provider mounts a cache
  nothing writes.
- **Why the test harness throws outside a running test.** A harness shared
  across a file's tests cannot be written, so no test reads another test's
  cache.

## Patched reads — `patch` frames

**Why keep the wire value.** A patch applies to the value as the server sent
it; a coerced field after the schema parse differs from the wire, so applying
to the parsed value corrupts it.

## Resource schemas

- **Why parse on the server.** The load chokepoint parses before any broadcast
  or HTTP response, so a malformed value is never shipped; a violation takes the
  existing loader-failure path. Keyed scoped loads return a partial array,
  which still satisfies `z.array(Element)`.
- **Why parse on the client too.** TS type and runtime shape cannot drift.
- **Why rethrow via `queueMicrotask`.** It surfaces as an uncaught browser
  error the crash reporter collects — never swallowed into an empty default.
- **Why no `transform` escape hatch yet.** It would bypass Zod for hot-path
  resources whose payloads grow large enough that parsing hurts; current
  payloads are small and parse cost is negligible.

References:
[research/2026-06-08-global-mandatory-resource-schema-server-validation.md](../../../../research/2026-06-08-global-mandatory-resource-schema-server-validation.md),
[research/2026-04-29-global-resource-schema-validation.md](../../../../research/2026-04-29-global-resource-schema-validation.md).

## One version-guarded HTTP write path (`fetchOverHttp`)

Reference:
[research/2026-07-02-converge-http-resource-writes-version-guard.md](../../../../research/2026-07-02-converge-http-resource-writes-version-guard.md).

- **Why return the effective cached value.** React Query's `queryFn` contract
  holds with no separate render path.
- **Why the prime swallows network and stale errors.** The WS sub-ack is truth.
- **Why `readOnce` writes nothing for an unobserved tuple.** An unobserved
  answer must never seed a later mount. A value cached across a reconnect or a
  keep-alive teardown does not count as pushed-current.
- **Why a bytes read invalidates after the ack.** The HTTP read is then no older
  than the tracking span the ack opened.
- **Why `cache: "no-store"`.** A restart-stable ETag lets the browser HTTP cache
  replay an old-boot `{value, version}` (or transparently 304-revalidate it),
  which the cross-boot compare then drops as stale — wedging the read. See
  [research/2026-07-15-global-live-state-http-cache-poisoning-class-fix.md](../../../../research/2026-07-15-global-live-state-http-cache-poisoning-class-fix.md).

### Epoch-aware cross-boot guard

- **Why an epoch.** The version counter resets to 0 every boot, so a bare
  version compare across boots is meaningless.
- **Why an epoch-less body keeps strict `<`.** A server without epochs behaves
  as before.
- **Why case 4 adopts.** It is the WS-down fallback window this path exists
  for; dropping would starve the fallback for a whole outage, and a live
  response beats a memory of unknown vintage. A socket reopen resets the replay
  baseline to -1 before any WS frame applies, so a post-adopt frame cannot
  mis-compare.

### Never settle unvouched

- **Why not return the cached value when nothing was applied.** React Query
  marks the `queryFn` a success and settles a value the server never vouched
  for — the "Close (state unknown)" wedge.
- **Why not apply the stale body.** It can render old-boot data under
  destructive buttons.
- **Why the sink owns no threshold.** The consumer owns the wedge policy (fire
  once at `consecutiveDrops === 3 && neverApplied`); live-state depends only on
  the `report-sink` leaf.

## Commit watermarks (`LiveRegistries.watermarks` / `compareTxWatermark`)

Reference:
[research/2026-07-11-global-never-revert-optimistic-edits.md](../../../../research/2026-07-11-global-never-revert-optimistic-edits.md).

- **Why scoped deltas carry none (Rule B′).** They re-read only affected rows;
  stamping one lets a client wrongly deny a pending optimistic op. Twin of the
  runtime's "etag rides only the `update` frame" rule.
- **Absent watermark cases:** a fresh sub, a central-origin resource, a server
  that stamps none.

### Why no drop on watermark ordering

- "This watermark is older, so this snapshot is older" is unsound: xmin is not
  monotonic. One long-running transaction pins it low for its whole lifetime.
- The predicate does not misfire once — it misfires on every frame for every
  resource while that transaction lives.
- Paired with a forced resub, a nightly job or slow migration turns into every
  tab re-subscribing every resource on every push: a self-amplifying storm
  during exactly the load that motivates the guard.
- **Rejected: report-only.** Same false-positive rate, just quieter.
- **Unaffected:** Rule B's denial inference (a statement about one snapshot,
  not a comparison of two) and the registry's monotonic adopt (cannot regress
  the causal floor).
- The staleness such a guard would catch is cured at the source: a push frame
  cannot be backed by a pre-commit read. See
  [research/2026-08-08-global-live-state-flight-freshness.md](../../../../research/2026-08-08-global-live-state-flight-freshness.md).

## Keyed delta sync (`mode: "keyed"`)

- **Why keep row references.** Memoized row components do not re-render for
  unchanged (or merely moved) rows.
- **Why `order` may be omitted.** It keeps the id list off the wire for the
  common status/title flip.
- **Why keyed-ness is declared once on the client descriptor.** The server
  reads it from there, so the two sides cannot drift; the flat one-arg
  `defineResource` form structurally cannot be keyed.
- **Why the first notify per tuple ships full.** Brand-new clients need a
  complete base.
- Strictly additive: `push` / `invalidate` resources are untouched.
- **Scoped recompute.** Keyed deltas shrink the wire payload; routed refills
  shrink the recompute. A content-only refill ships exactly the content-delta
  shape, so the client needs no change. See
  [research/2026-07-03-global-scoped-membership-m5.md](../../../../research/2026-07-03-global-scoped-membership-m5.md).

### Bounded windows and point reads (window / point descriptors)

- **Why the factories are internal to `network/live`.** The only server half
  that can serve a bounded resource is `windowQueryResource`, which needs the
  `queryPk` the factories record — so there is no second, unservable way to
  mint one.
- **Why points are never preloaded.** Post-mount hydration is the recorded
  decision.
- **Why a canonical encode and strict decode.** Params-key identity is what
  makes boot hydration, the subscription and the server land on ONE per-tuple
  state.
- **Why a future cursor is an extra key.** An absent field is an absent key, so
  cursor-less windows keep their params key.

Reference:
[research/2026-09-25-global-unified-live-resource-api.md](../../../../research/2026-09-25-global-unified-live-resource-api.md).

## Keep-alive subscriptions (deferred teardown)

- **Why.** The WS sub lifetime is aligned with React Query's own cache GC.
  Without it, a transient unmount→remount churns an unsub→resub round-trip on
  the wire — e.g. a reorderable slot rendered per row in a streaming or
  virtualized list. It mirrors React Query's own `setTimeout`-based GC.
- **Why refcount bumps are not logged.** A per-row list would storm the
  low-volume `live-state` channel; `emitDebug()` still fires on every change so
  the live-state-health inspector stays accurate.

## A read is `loading`, `error` or `ready`; an unknown value is `Resolvable`

Keeping "not known yet / failed" and "known to be undeterminable" in separate
channels makes a destructive default unreachable by construction rather than by
a remembered guard.

- **Rejected: merging error into `pending`** "so every gate is correct for
  free"
  ([research/2026-07-09-global-resource-unknown-value-and-error-gate.md](../../../../research/2026-07-09-global-resource-unknown-value-and-error-gate.md)).
  A surface that only asks "is it loading?" renders a failure as a spinner
  forever — the build-history incident
  ([research/2026-09-27-global-live-resource-skew-and-error-state.md](../../../../research/2026-09-27-global-live-resource-skew-and-error-state.md)).
- **Why the ready arm omits `error`/`stale` rather than typing them `null`.** A
  `null`-typed field catches nothing; an absent one is a tsc error.
- **Why the sticky-error clear uses `Query.setState`.** No data write, so no
  cache event a value listener could mistake for a push.
- **Why one report per episode.** Emitted from the client, not per hook, however
  many hooks observe the tuple.
- **Why `useOptimisticResource` stays `ready` on error.** Editors keep painting
  their base under a transient error instead of blanking the document.
- **Why `Resolvable` instead of a throw or an empty value.** A throw wedges the
  resource `loading` forever; an empty value lies (`[]` must mean measured and
  empty). `Resolvable` settles, renders its reason and stops retrying.
- **Limit of its adoption.** `attempt-work` has one unresolved arm only (the
  attempt row no longer exists); every other git failure still throws.

## Readiness gates — every state gets its own answer

- **Why the rules cover `useConfigResult`.** A config's defaults are a
  legitimate value, so collapsing its loading arm produces a wrong state that
  looks exactly like a right one.
- **Why a raw `UseQueryResult` is banned.** It hands the caller `isPending` /
  `isError` and a `data` it can read without asking — the collapse itself.
- **Why `useResource` passes its own "a value landed" flag to `queryResult`.** A
  selector may answer `undefined` for a landed value.
- **Why domain hooks never return bare `T | null`.** "Not loaded yet" and
  "failed" must stay states the caller renders, apart from "absent".

## Slice selectors (`useResource(resource, params, { select })`)

- **Why structural sharing on the select output works for full-payload
  resources too.** The comparison is on the selected value, not the payload,
  so a reparsed whole struct still keeps a deeply-equal slice's reference.
- **Why `notifyOnChangeProps` is an explicit list.** Reading `dataUpdatedAt`
  does not re-enable notifications once the list is explicit.
- **Why the gate latch is derived, not held.** A held latch needs a settle
  effect whose `setState` costs a render; derived, a tuple already cached
  (boot-hydrated, or held by another observer) renders once, narrowed, and a
  params change re-gates exactly when the new tuple has no value yet.
- **Why the listener is dropped once the latch closes.** `QueryCache.notify`
  runs every listener on every event of any query, and each observer of a
  pushed tuple emits one — so a listener per settled gated read makes every
  push cost O(observers × gated reads).
- **Why the selector runs every render.** A selector switched off and on across
  a params change lets React Query hand back the slice it memoized for the
  PREVIOUS tuple.
- **Why a gated read without a selector.** Any `select`, even the identity,
  gives each observer its own structurally-shared copy; without one, every
  observer holds the same object and the same row objects.
- **Why a maybe-absent selector types `T | S`.** tsc never vouches for a slice
  the read may not deliver.
- **Why structural sharing keeps moved elements.** A keyed `order` delta moves
  rows by reusing their cached objects; positional-only sharing would re-mint
  each moved row.

## Debugging

- **Why tracing goes over `clientLog`.** A plain HTTP path keeps traces flowing
  when the notifications WS is wedged — the exact failure it instruments.
- **Why verbose tracing is a `localStorage` flag.** It is a local debug switch,
  not user config.
- **Why `totalMs` is measured, not summed.** A clamped phase can push the sum
  past the real total.
- **Why `receivedAt` is stamped before `JSON.parse`.** Decode cost lands in
  `client-apply`. "Applied" means the cache was written, not that React
  painted.
- **Why hidden samples are dropped.** A throttled background tab measures the
  browser, not the system.
- **Why only frames carrying `timing` are timed.** A sample measures a server
  change reaching the cache; sub-acks, replay answers and resub answers have no
  change behind them, so a reconnect makes no samples.
