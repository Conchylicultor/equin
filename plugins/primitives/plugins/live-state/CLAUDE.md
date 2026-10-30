# live-state

Rationale (why each rule is so, rejected alternatives): [DESIGN.md](DESIGN.md) — read before changing or removing a rule.

The client half of live resources:

- `useResource` — the substrate `network/live`'s `useLive` / `useLiveRow`
  compile to.
- `NotificationsClient` over the tab-shared `/ws/notifications` socket.
- The TanStack Query cache it writes.

Server half: `resource-runtime/CLAUDE.md`.

Whenever you touch `notifications-client.ts`, `shared-websocket.ts` or
`shared-ws-host.ts`, run:

```sh
./equin test plugins/primitives/plugins/networking plugins/primitives/plugins/live-state
```

## No Suspense — hydrate, don't suspend

- Reads never suspend: they return `status` (`loading` / `error` / `ready`).
  - There is **no `<Suspense>` boundary in the app** — a genuinely suspending
    read (`React.lazy`, `useSuspenseQuery`) wraps itself.
- Data the first render needs is a `liveValue` declared `preload`; the boot
  snapshot seeds it before render with
  `hydrateResource(resource, params, value)`. No seeder for endpoint reads.
- **`preload: "boot" | "boot-and-keep"`** (absent ⇒ on first mount) lives on the
  shared descriptor and drives the boot snapshot keys, the L2 persist set, the
  eager tier and `gcTime`.
  - Plain `"boot"` hydration is GC'd after 5 min with no observer (the next
    mount reads `loading` again).
  - `"boot-and-keep"` = resident (`gcTime: Infinity`) for EVERY tuple of the key
    — `hydrateResource` calls `setQueryDefaults([key], { gcTime: Infinity })`
    before seeding, because `setQueryData` arms the GC timer at construction.
    Only for small, universally read values, never large collections.
  - Parameterized preload: `preloadParams` (`network/live/CLAUDE.md`).
- **One tuple per logical read** (`canonicalParams`,
  `packages/canonical-params`): an `undefined` param is dropped, and a `""` for
  a declared-optional param (`"scopeId?"`).
  - `useResource`, `useResourceAcks`, `hydrateResource` and the server all
    canonicalize, so the sub, HTTP URL, prime and query key name the same tuple.
- **`params === null` is the skip**: hooks run, nothing is
  observed/fetched/counted (`queryFn` is `skipToken`); result is `loading`.
  - Public: `useLive(value, null)`, `useLiveRow(c, null)`.
- **No descriptor has a placeholder.** A query holds no data until the first
  value (`dataUpdatedAt === 0` ⇒ `loading`).
  - A pushed query stays disabled until a value lands (no HTTP fetch on mount;
    the WS sub-ack fills it).
  - Exception: `load: "on-demand"` (server `invalidate` mode) — HTTP is its read
    path, it fetches on mount.
- A disabled query is skipped by `invalidateQueries` and by retry-on-mount, so a
  `sub-error` fetches it directly (`prefetchQuery`); the failure is the query's
  error until a push, replay or `refetch()`.
- `useOptimisticResource` stays `loading` (no base, no `dispatch`) until a real
  value lands.

## A burst of landings is one commit (`internal/coalesced-notify.ts`)

`use-resource.ts` installs a page-global coalescing `notifyManager.setScheduler`
so every flush queued before the pending timer runs in one task — N back-to-back
WS frames are one React commit.

Not redundant with React batching: React batches per task, and the default
scheduler makes one task per frame.

Pinned by `web/__tests__/landing-commits.test.tsx`.

## A varying list of tuples — `useResources`

`useResources(resource, paramsList, options?)` reads a changing-length list of
tuples of ONE resource (network/live's paged read;
`useLive(value, [p1, p2, …])`).

Each tuple is read exactly as `useResource` reads it (shared
`tupleQueryOptions`, refcount, prime, pending count, `reportTupleSettled` → Slow
Ops) and yields `ResourceResult`s in list order. No `select`, no `gate`.

- The sub set moves by **diff**: a kept tuple is never unobserved/re-observed;
  removed tuples are released after new ones are observed.
- Results are structurally shared **keyed by tuple** (`combine` returns a
  record), so a kept tuple's `data` stays the cache's own object across
  reorder/grow/shrink.
- **`{ release: "now" }`** — a tuple dropped while mounted is unsubscribed at
  once (`unobserve(…, "now")`, no keep-alive) and its cache entry removed
  (`removeQueries`), so re-observing reads `loading`, never the old value as
  `ready`.
  - Unmount still uses keep-alive.
- **`appliedSeq`** on each `ResourceTupleResult`: position on the client-wide
  apply sequence (`NotificationsClient.appliedSeq`, bumped in `markApplied`).
  - Higher = more recently applied (a paged read's dedup).
  - `0` = nothing applied through this tab's sub (boot-hydrated included).
- **`{ derive }`** — per tuple, a `ResourceDerivation | null` seeding a new
  tuple from rows already held (see below). Read only on a fresh sub (0→1).

Pinned by `use-resources.test.tsx`, `notifications-subs.test.ts`.

## Seeded derivation — a sub answered from rows this tab holds

`observe(key, params, origin, schema, keyOf, derive?)` takes a derivation of the
form:

```ts
// ≤ DERIVE_MAX_SOURCES = 2 sources
{ from: [{ params, appliedSeq, after, until }] }
```

- It cuts each source's cached rows by `keyOf`:
  - after `after` (exclusive; `null` = first)
  - through `until` (inclusive; `null` = last).
- It sends the sub with
  `derive: { id, from: [{ params, version, after, until }] }` (`id` =
  `crypto.randomUUID()`).
- The caller vouches the slices ARE the new tuple's value; the server checks
  they are the same query, current and complete (`resource-runtime/CLAUDE.md`,
  _Seeded derivation_).

Rules:

- **Only from a value that stands as decided**: each source's `appliedSeq` must
  still match and its value must be socket-built (`ActiveSub.socketValue`; an
  HTTP body clears it).
  - Otherwise the sub goes out plain (`derive skipped … reason=…`;
    `source-loading` / `source-hydrated`, the latter also counted on
    `live-pages`).
- **The derived `sub-ack`** carries no value and echoes `id`; only the tab whose
  in-flight derivation has that id adopts its held slice (no re-parse, no
  watermark).
  - Others drop it (`not-our-derivation`).
  - Match on the id alone, never on the echoed sources.
- A value-carrying `sub-ack`, `sub-error`, replay or forced resub clears the
  derivation; a derived ack arriving after is dropped.
- **Dialect-gated**: the socket names its `PROTOCOL`
  (`packages/resource-protocol`, `SharedWebSocketOptions.dialect`), so a tab on
  a bundle with another frame vocabulary gets a socket of its own.
  - The runtime reads `derive` only under its own `PROTOCOL` (`protocol-skew`).
  - The client reads `ServerFrame` and sends only `ExactClientFrame`s.

Pinned by `notifications-derive.test.ts`.

## Hazard tests (H1–H7) — the executable correctness argument

Transport hazards are pinned by named vitest tests in `web/__tests__/` (the test
names are the index):

| File                               | Covers                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `notifications-subs.test.ts`       | H4 duplicate subs + keep-alive, `no-sub` gate, version guard, delta-no-base/drift resubs, `unsub-tab`, watermarks |
| `notifications-reconnect.test.ts`  | H1/H1b, H2, `up-to-date-batch`, H7 `probeMissedUpdates`                                                           |
| `notifications-cross-tab.test.ts`  | H6                                                                                                                |
| `notifications-http-fetch.test.ts` | `fetchOverHttp` matrix                                                                                            |

They run the real `NotificationsClient` + `SharedWebSocket` on
`createTransportHub`'s fakes
(`@plugins/primitives/plugins/networking/web/testing`).

Server siblings (H5, …) are in
`plugins/framework/plugins/resource-runtime/core/`.

## Replay is ONE `sub-batch` frame; recovery resubs never echo state

- On every socket (re)open and the missed-update probe's resync, `replaySubs`
  sends the whole sub set as ONE frame, built synchronously (snapshot + baseline
  reset + send in one task):

  ```ts
  { op: "sub-batch", tabId, epoch?, complete: true, entries }
  ```

  - Entries echo pre-reset versions.
  - A same-boot server answers current ones in one `up-to-date-batch` — except
    tuples it released meanwhile, which get a full sub-ack.

- `probeMissedUpdates` ignores a sub whose socket reopened in its settle window
  (`SocketChannel.opens`) — that version jump is a re-baseline.
- `complete:true` makes the batch the server's whole truth for this tab.
  - `{op:"unsub-tab"}` is the socket's last will
    (`SharedWebSocket.setLastWill`), sent when the tab closes, enters bfcache or
    crashes.
- No client-side replay stagger (deliberately deleted): herd control is the
  server's read-admission gate + single-flight.
- **`forceFullResub`** (delta with no base or drift): clears etag AND resets
  `version`/`lastAckVersion` to -1, then sends a version-less sub.
  - "No base" means no server-vouched value (`hasAppliedValue`), not merely a
    defined cache.
  - The reset is load-bearing: the broken delta already advanced
    `entry.version`, so the recovery sub-ack would otherwise be `<=`-dropped
    forever ("BUG A" tests).

## Standalone acks are asked for, per tuple

`requestAcks(key, params, origin)` (hook `useResourceAcks`) asks for the
version-less `{ kind: "ack" }` frames of no-value-change recomputes.

- Counted per tuple (`ackInterest`), independent of `observe()` order.
- `sub` / replay entries restate `acks: true` while positive.
- A 0↔1 transition on a live sub sends `{op:"sub-acks", …}` (no re-sub).
- Only caller: `useOptimisticResource`; frames go to the tx-ack registry.

## One socket per origin, shared across tabs

The real socket lives in a SharedWorker; every frame is fanned out to **all**
tabs.

- **Apply only for a live local sub.** `handleServerMessage` gates on
  `channel.subs.get(id)` before `applyUpdate`/`applyDelta`/`applyInvalidate`;
  that gate also carries the version guard.
  - `observe()` registers schema + `keyOf` with the entry, so dropping the gate
    brings back "no schema registered for key=…" (`no-sub gate` test).
- **`entry.version`/`etag` must name a value THIS tab holds**
  (`hasAppliedValue`):
  - A value-less `up-to-date` for a never-applied entry is ignored.
  - `replaySubs`/`sendSub` echo version/etag only when backed by a cached value
    (the sub outlives the GC'd query).
  - Don't restore an unconditional echo; don't make the ignored `up-to-date`
    force a resub. Adopting an unbacked version drops your own `sub-ack` as
    stale.
- **Pings carry `pushStallMs`** → `ChannelStatuses.serverPushStallMs` (health
  Connection row, wedge watchdog); reset to 0 on any socket status change
  (`notifications-heartbeat.test.ts`).
- **`sub-error`** (`SubErrorFrame`:
  `{ kind, id?, key, params, reason, verdict? }`) is gated on the local entry
  like any frame, records `noteContractRefusal`, and calls `fetchAfterSubError`:
  an HTTP read via `prefetchQuery` whose own outcome sets `q.error`
  (`ResourceHttpError` with `reason`/`verdict`) or heals.
- **Contract refusals are version skew, surfaced once.**
  - `contract-mismatch` / `unknown-key` (from `sub-error` or HTTP) land in
    `resource-contract-store.ts` (`useResourceContractMismatches()`); build's
    `useReloadAdvice` shows the Reload segment.
  - Every `sub`/`sub-batch` carries `build` (per frame — the socket is shared
    across bundles); HTTP reads `BUILD_GRAPH_HEADER`.
  - `isTerminalResourceError` — `contract-mismatch`, `unknown-key`, `unserved` —
    is never retried.
  - `unserved` (a closed-key-set host doesn't serve the key) is never skew:
    reads as `loader-failed` naming the key.

## Scoped pipelines — a subtree talking to another backend

`NotificationsProvider` reads `useTransport()` (`primitives/networking`) and
mounts that transport's pipeline (one per transport):

- a `NotificationsClient` on `transport.openSocket` / `transport.fetch`;
- its QueryClient;
- its `LiveRegistries` (watermarks + tx acks).

The page's pipeline (`ensureNotificationsClient(pageTransport)`, hoisted in
`web-core`'s `App.tsx`) uses the default QueryClient and root registries. Any
other transport (the demo scope) gets its own, so it never touches the page
server's cache.

- Pipeline created during render, torn down a microtask after the last provider
  unmounts.
- Socket identity is the transport's URL (page-global ws-status bus): two
  transports must map a path to different URLs.
  - `useLiveSocketKindOf()` reads the enclosing pipeline's kind;
    `liveStateSocketKind` is the page's.
- `useLiveRegistries()` returns the enclosing pipeline's.
  - The module-level `noteResource…` / `getResourceWatermark` /
    `hasResourceTxAck` are the page's only — test support, not a read path.
- Telemetry (error/stale-drop/latency sinks) is emitted only when the
  transport's `telemetry` flag is set.
- Not scoped: `hydrateResource`, the contract-mismatch store, pending-mount
  counters.

Pinned by `scoped-pipeline.test.tsx`.

## One client, one cache — `NotificationsProvider` takes no client

The client OWNS its `QueryClient` (`client.queryClient`);
`NotificationsProvider` takes only `children`, so the cache React reads is the
cache the client writes.

Tests:

- `web/testing`'s `createLiveStateHarness(options?)` →
  `{ Wrapper, queryClient, notifications, dispose }`, fresh per test.
  - Defaults: `retry: false`, `refetchOnMount: false`, `staleTime: Infinity`;
    override via `options.queries`.
  - Auto-disposed on test finish; it throws outside a running test.
- Transport suites build `new NotificationsClient(qc, hooks)` directly.

## Patched reads — `patch` frames

A `liveValue` declared `patches: true` gets `patch { base, version, ops }`.

- `applyUpdate` keeps the WIRE value (`ActiveSub.wire`, pre-parse).
- A patch applies (`applyValuePatch`) only when the read holds exactly `base`
  (checked after the stale-version gate, before adopting the version), then goes
  through `applyUpdate` like an `update`.
- Any other base (lost frame; HTTP body and forced resub clear `wire`) →
  `patch-base-resub` (`forceFullResub`).

Runtime half: `resource-runtime/CLAUDE.md`, _Patched values_. Pinned by
`notifications-patch.test.ts`.

## Resource schemas

Every resource **must** declare a Zod `schema` (required, guarded at
registration), parsed twice:

- **On the server at load** (`timedLoad` in `resource-runtime/core`); a
  violation takes the loader-failure path.
- **On the client on receipt**, in both write paths (`fetchOverHttp` and
  `applyUpdate`, via the observe-time key→schema registry). A WS-path parse
  failure is rethrown via `queueMicrotask` (reported as an uncaught error, never
  swallowed).

Non-JSON types are coerced (`z.coerce.date()`).

A `transform` escape hatch bypassing Zod is NOT implemented — don't add it
speculatively.

## One version-guarded HTTP write path (`fetchOverHttp`)

Every HTTP cache write goes through
`NotificationsClient.fetchOverHttp(key, params, origin, read, source)` (its
doc-comment is the spec). Callers:

- `useResource`'s `queryFn` (`"fallback"`; errors → `q.error`);
- `primeFromHttp` (`"prime"`, fire-and-forget; network/HTTP/stale errors
  swallowed, schema failure rethrown).

Same version guard as WS frames; returns the effective cached value. Pinned by
`notifications-http-fetch.test.ts`.

- **`readOnce`** (`useLiveReader`) is not a cache write: a pushed-current
  observed tuple answers from cache; otherwise one deduped read — via
  `fetchOverHttp` if observed, else parsed by the same helpers and written
  nowhere.
- **Bytes reads** (`bytes: true`): body via `arrayBuffer()`, envelope from
  headers (`parseResourceBytesHeaders`).
  - Its WS sub-ack carries no value: adopt version/epoch, then invalidate — HTTP
    is its value.
- **Both fetches are `cache: "no-store"`** — the browser HTTP cache must never
  replay an old-boot body (server sends `Cache-Control: no-store` on 200 and
  304).
- **Epoch-aware cross-boot guard** — the 4-case matrix.
  - Body is `{ value, version, epoch }` (`bootEpoch`); `ActiveSub.epoch` labels
    `entry.version`.
  - Engaged only when the entry exists and `body.epoch` is defined.

  | Case               | Condition                                 | Action                                                                                                   |
  | ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
  | 1 same boot        | `body.epoch === entry.epoch`              | drop only if strictly `<` (a GET reports without bumping; `<=` would drop the normal invalidate refetch) |
  | 2 entry stale-boot | `body.epoch === channel.serverEpoch`      | ADOPT, set `entry.version = body.version`                                                                |
  | 3 body stale-boot  | `entry.epoch === channel.serverEpoch`     | DROP (`stale-epoch`)                                                                                     |
  | 4 no arbiter       | `serverEpoch` matches neither / undefined | ADOPT (the WS-down window this path exists for)                                                          |

- **Never settle unvouched.** On a drop or `304`:
  - already applied (`hasAppliedValue`) ⇒ return the cached value;
  - never applied ⇒ throw `ResourceStaleReadError` (drives `retry: 1`, then
    `q.error`).
  - Never return an unvouched value, never apply the stale body.
- **Stale-drop sink**: every drop emits `HttpStaleDropReport` (with
  `consecutiveDrops`, reset in `markApplied`) to `httpStaleDropReportSink`.
  - Policy lives in `reports/live-state-stale-drop`. live-state must never
    import `reports`.

## Commit watermarks (`LiveRegistries.watermarks` / `compareTxWatermark`)

Full-reconcile frames carry a `watermark`:
`pg_snapshot_xmin(pg_current_snapshot())` as xid8 decimal text, captured before
the loader read.

The client notes it into the pipeline's registry (`web/watermark-registry.ts`,
monotonic adopt) immediately **before** the cache write, so a QueryCache
listener sees the causal floor synchronously. optimistic-mutation compares it
against ack tokens (`currentTxId`).

- **Rule B′**: only `sub-ack`, `update`, FULL keyed deltas and the HTTP body
  carry one; scoped deltas **never** do.
  - An absent watermark means "no causal floor": confirm by content is fine,
    denial is forbidden.
- Compare only with `compareTxWatermark` (`live-state/core`, BigInt) — xid8 text
  overflows `Number` and isn't lexicographically ordered.
- **Never build a client-side drop on watermark ORDERING.**
  - xmin is not monotonic (one long transaction pins it low), so "older
    watermark ⇒ older snapshot" misfires on every frame for that transaction's
    lifetime and, with a forced resub, becomes a resub storm.
  - A sound backstop would be a server-stamped monotonic read sequence, not a
    watermark.

## Descriptor registry (`resourceDescriptorByKey`)

`liveValue` / `liveCollection` self-register into a module-level key→descriptor
map at module evaluation; boot-snapshot resolves boot keys through it before
first render.

Distinct from the observe-time key→schema registry, which exists only after a
mount — too late for boot.

## Keyed delta sync (`mode: "keyed"`)

The wire every `liveCollection` rides: the server diffs each full load against
an id→hash snapshot and sends `upserts`/`deletes`; the client merges by id,
keeping unchanged (and moved) rows' object references.

- **Merge contract**:
  - `order` **present** ⇒ rebuild from it;
  - `order` **absent** ⇒ in-place upserts, membership unchanged (`deletes`
    empty, no new ids).
  - Which frames carry `order` is the emitter's half.
- **Keyed-ness is declared once**, on the client descriptor (`keyOf`, set by
  `liveCollection` from `id` on its window, `:rows` and `all` descriptors);
  `schema` stays `z.array(Element)`.
  - The server takes that descriptor (`serveCollection` → two-arg
    `defineResource(descriptor, …)`).
  - Never restate `mode`/`keyOf` — `ServerResourceOptions` rejects it, and
    inline `keyed:` literals fail the `keyed-resource-scope` check.
  - The descriptor must live where the server imports it without a cycle
    (`core/` / `shared/`).
- A delta with no cached base is dropped and a full sub is forced.
- **Scoped recompute**: every keyed resource is a routed membership entry; a row
  change refills only that row (`ctx.affectedIds`) and ships the same
  content-delta shape — no client change.
  - `notify()` always recomputes in full.
  - Mechanics: `resource-runtime/CLAUDE.md`,
    `plugins/infra/plugins/query-resource/CLAUDE.md`.

### Bounded windows and point reads (window / point descriptors)

A collection is a `liveCollection` (`network/live`):

- declare in `core/`;
- serve with `serveCollection`;
- read with `useLive(c, query?)` / `useLive(c, { ids })` / `useLiveRow(c, id)`.

A set read whole is a collection declared `all`, never an unbounded descriptor.

live-state owns only the descriptor **types** (`core/window.ts`:
`WindowResourceDescriptor`, `PointResourceDescriptor`, `WindowParams`,
`PointParams`, `WindowSelector`); the factories are internal to `network/live`
(only `windowQueryResource` can serve them).

- Window params `{ limit: "100" }`; point params `{ ids: "a,b" }` (sorted,
  deduped). Points are never preloaded.
- The descriptor carries the selector codec (`.window` / `.point`
  `encode/decode`): encode is canonical, decode STRICT (throws), so one logical
  selector ⇒ one params object ⇒ one tuple.
  - A future cursor is an extra `cursor` key.
- `defaultParams` (set by the window factory) is the tuple boot-snapshot loads
  and hydrates — the same a bare `useLive(c)` subscribes to.

## Keep-alive subscriptions (deferred teardown)

When the last observer leaves, the sub stays with refcount 0 and a one-shot
`SUB_KEEPALIVE_MS` (30 s) timer in `channel.pendingTeardown`; a re-`observe()`
within the window cancels it with zero WS traffic.

- A deferred cleanup, not polling. Bypass: `unobserve(…, "now")`.
- So per-row `useLive` of a row-invariant value needs no hoist — rows share one
  cache entry and sub.
- The `live-state` log channel logs only 0→1 and `teardown`, not refcount bumps;
  `emitDebug()` fires on every change.

## A read is `loading`, `error` or `ready`; an unknown value is `Resolvable`

Every read (`useResource`, `useLive`, `useLiveRow`, `useConfigResult`,
`combineResources`, `mapResource`) returns:

```ts
type ResourceResult<T> =
  // no value, no failure
  | { status: "loading"; refetch }
  // error is never null
  | { status: "error"; error: ResourceError; stale?: T; refetch }
  | { status: "ready"; data: T; refetch };
```

- A failure is **not** a flavour of loading (a "loading?" check would spin
  forever on an error); no boolean lumps them.
- The `ready` arm omits `error`/`stale` (tsc error to read them).
- Last-known-good is the opt-in `stale` on the error arm.

**`ResourceError`** (`core/resource-status.ts`) carries a `kind`, derived once
in `web/resource-error.ts` (`toResourceError`):

| kind              | from                                                                                                                                                                                                       | remedy                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `client-outdated` | `contract-mismatch` / `unknown-key` unless verdict `same-build`; a client zod rejection                                                                                                                    | reload                                                                         |
| `not-found`       | 404 (or `unknown-key` on the same build)                                                                                                                                                                   | a bug                                                                          |
| `loader-failed`   | other HTTP failure, `same-build` mismatch, `unserved` key (terminal, not retried), anything else thrown                                                                                                    | retry, else a bug                                                              |
| `transport`       | `fetch` `TypeError`, `ResourceStaleReadError`                                                                                                                                                              | retry                                                                          |
| `refused`         | a loader's `ResourceRefusal` (HTTP 422) whose `code` the read declares (`ResourceDescriptor.refusals`; typed `ResourceResult<T, C>`, on `error.code`); an undeclared code is a `contract-mismatch` instead | none — the message is the answer; no Retry, never retried, counted or reported |

Failure plumbing lives once in `NotificationsClient`:

- **Sticky-error clear**: a value-less `up-to-date` clears that tuple's error
  via `Query.setState` (no data write).
- **Event-driven retry, no timers**: `online` / `visibilitychange → visible`
  refetch observed tuples in error via `query.fetch()` (`refetchQueries` skips
  disabled queries); plus replay and the UI's Retry.
- **Report sink**: failing set (`useFailingResources()`); one
  `resourceErrorReportSink` emission per error episode, collected by
  `reports/resource-errors`.

**`useOptimisticResource`** (`OptimisticResult`) is the one exemption:

- once a base landed, a failing read stays `ready` with `error` + `sync-status`;
- its `error` arm is only a failed first load;
- it still feeds every gate.

**`Resolvable<T>`** (`live-state/core`) — a loader branch that **cannot
determine** its value says so in the payload, never by throwing (wedges
`loading`) or returning empty (`[]` must mean measured-and-empty):

```ts
type Resolvable<T> =
  { resolved: true; value: T } | { resolved: false; reason: string };

liveValue("edited-files", {
  schema: resolvableSchema(z.array(EditedFileSchema)),
  params: ["id"],
  load: "on-demand",
});
```

- Adopters: `edited-files`, `commits-graph.graph` (`onWorktree` helper;
  `revalidate` returns the matching `"no-worktree"` ETag from the same branch),
  `attempt-work`.
- "Not loaded yet" is never `unresolved(…)`.

## Readiness gates — every state gets its own answer

`.data` exists only when `status === "ready"`. Never
`r.status === "ready" ? r.data : []` — it collapses loading, failed and empty
into a confidently-wrong UI.

Lint rules:

- `live-state/no-pending-data-collapse` — the collapse (allowlist empty — never
  add one).
  - Also flags an early `return null` for not-ready states in a value-returning
    function whose ready return can be `null` too.
  - A component returning `null` while loading is fine.
- `live-state/no-ready-negation` — compare `status` only to `"loading"` /
  `"error"`; a `switch` fall-through naming both is allowed.
- `live-state/no-handrolled-result` — outside live-state and `network/live`, no
  hand-written result arms/unions; derive with `mapResource` /
  `combineResources` / `useQueryResource`.
  - Its sanctioned constructors come from ONE table,
    `lint/result-constructors.ts` (a new form is one row;
    `result-constructors.test.ts` checks barrel exports).

They cover `useConfigResult` too; plain `useConfig` IS the collapse
(`stale ?? defaults`), for cosmetic reads only.

Sanctioned patterns, in order of preference:

```tsx
<ResourceView resource={songs} fallback={<Loading variant="cards" />}>
  {(rows) => <Grid rows={rows} />}
</ResourceView>

matchResource(songs, {
  ready: (rows) => …,
  loading: () => …,
  error: (e, stale) => …,
});

// plain value
foldResource(r, {
  loading: () => …,
  error: (e, stale) => …,
  ready: (d) => …,
});

// error > loading > ready; switch on all.status
const all = useCombinedResources({ conv, ranks, tasks });

// emptyState needs ready + zero rows
<DataView rows={rows} readiness={result} … />
```

- **`<ResourceErrorInline error refetch variant />`** is the one failure
  rendering.
  - Variants: `block`, `inline`, `icon` (`icon` keeps the face, `subject` names
    it).
  - Offers Retry, or "App updated — reload" for `client-outdated`.
  - Data-dependent action buttons render disabled-neutral while loading — never
    a default (especially destructive) mode.
- **A TanStack query is never returned raw.** Server reads are live (`useLive`).
  - A local async load uses
    `useQueryResource({ queryKey, queryFn: () => import("./x") })` — no
    `enabled` option (disabled = `loading` forever), no keyed-by-another-read
    form, no paged form.
  - Both it and `useResource` map through `queryResult` (`web/query-result.ts`).
  - Paged reads' ready arm carries `ResourcePaging` (`canGrow` / `growing` /
    `loadMore`; `LiveListResult<Row>` is `PagedResourceResult<Row>`); a failed
    next page is the error arm with `stale`.
- **Domain hooks keep every arm.** Never return bare `T | null`.
  - One row: return `useLiveRow`'s `LiveRowResult` as is (ready splits into
    `found: true` / `found: false`).
  - Other narrowing: `ResourceResult<T | null>` via `mapResource(r, fn)`.
- **Feed only whole-resource results into gates** — never a `select` result; use
  `gate: true`.

## Slice selectors (`useResource(resource, params, { select })`)

Available on `useResource` and `useLive(all, { select })` (always gated). A
window/value `useLive` has no `select`: one row is `useLiveRow`, a derivation is
a `useMemo`.

`select` re-renders the component only when the selected slice changes. Pass a
**stable** selector (`useCallback`):

```ts
const select = useCallback(
  (p: ConversationListPayload) => p.active.find((c) => c.id === id) ?? null,
  [id],
);
const q = useResource(conversationsResource, undefined, { select });
```

Only with `select`:

- RQ structurally shares the select output (`replaceEqualDeep`);
- `notifyOnChangeProps: ["data", "error"]` stops the per-push `dataUpdatedAt`
  bump re-rendering every subscriber (the O(C²) storm).

Details:

- **Caveat**: with plain `select`, the loading→ready flip can be silent if the
  slice is the same across it (a selector answering `undefined`). Harmless for
  point lookups; a readiness gate on it can wedge `loading`.
- **`gate: true`** fixes it: notifications stay un-scoped until the tuple holds
  a value, then narrow.
  - The latch is **derived, never held** — `useTupleHasValue` via
    `useSyncExternalStore`, holding a cache listener only while open (a listener
    per settled gated read would make every push O(observers × gated reads)).
  - The selector runs every render, so the slice is always the current tuple's.
  - Pinned by `use-resource-gate-latch.test.tsx`.
- **Gated read without a selector** (`{ gate: true }`,
  `UseResourceGateOptions`): `data` IS the cached value (same object, same rows
  for every observer). `useLive(all)` reads this way.
  - A maybe-absent selector types `ResourceResult<T | S>`;
    `{ select, gate: true }` → `ResourceResult<S>`.
- Narrows re-renders, not the sub: callers of one tuple share one refcounted
  sub.
- **Structural sharing keeps moved elements** (`internal/structural-sharing.ts`,
  for every resource's cache write and select output): positional first, then by
  reference to an element the previous array held elsewhere — so a keyed `order`
  delta keeps row identity.

## Debugging

- **Per-hop tracing**: `NotificationsClient` traces to the `live-state` channel
  (`logs/live-state.jsonl`, `[tabId]`-stamped) via `clientLog` (plain HTTP, so
  it flushes while the WS is wedged).
  - Always on: `observe`/`unobserve`, `sendSub`, `sub-ack`, `replaySubs`,
    `probeMissedUpdates`, socket transitions, every `drop reason=…`.
  - The per-frame `applyUpdate` line needs a local debug flag (not config):

    ```js
    localStorage.setItem("liveState.verboseTrace", "1");
    ```

- **Update latency sample** (`clientLatencySink`, signal `update`): one sample
  per applied pushed frame carrying `timing`
  (`{ changedAt, sentAt, deliverMs }`).
  - Only `update` and change-driven `delta`;
    sub-acks/replays/resubs/invalidates/acks carry none (the protocol type is
    the gate).
  - A delta ending in `forceFullResub` emits nothing.

  | Phase            | Computed as                                |
  | ---------------- | ------------------------------------------ |
  | `server-notice`  | `sentAt − deliverMs − changedAt`           |
  | `server-deliver` | `deliverMs`                                |
  | `transport`      | `receivedAt − sentAt` (two clocks)         |
  | `client-apply`   | `appliedAt − receivedAt` (decode included) |
  - `totalMs = appliedAt − changedAt`, measured (not the sum).
  - `receivedAt` is stamped in `onmessage` before `JSON.parse`.
  - `hidden` if the page is or was hidden since `changedAt` (`lastHiddenAt`);
    consumers drop those.
  - One sample per tab; no work without subscribers.
  - live-state owns no threshold (`debug/slow-ops`, `debug/latency-ledger`
    consume).
  - Pinned by `notifications-update-latency.test.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Server live-state primitive: useResource hook + NotificationsProvider + NotificationsClient. Thin TanStack Query wrapper over the app's tab-shared /ws/notifications channel. useQueryResource reads a local async load (not a server read — those are live) as a ResourceResult.
- Load-bearing: yes
- Web:
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/networking` ×10
    - `primitives/css/spacing` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/css/center.Center`
    - `primitives/css/inline.Inline`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/loading.Loading`
    - `primitives/log-channels.clientLog`
    - `primitives/scope/tab-id.getTabId`
  - Exports (types):
    - `ChannelStatuses`
    - `CombinedResources`
    - `DebugSnapshot`
    - `DebugSub`
    - `FailingResource`
    - `FoldResourceHandlers`
    - `GateDataOf`
    - `GateInput`
    - `GateStatus`
    - `HttpStaleDropReport`
    - `LiveRegistries`
    - `LiveStateSocketKind`
    - `MatchResourceHandlers`
    - `MissedFrame`
    - `PagedResourceResult`
    - `PendingMountSnapshot`
    - `PointParams`
    - `PointResourceDescriptor`
    - `PortableGateInput`
    - `QueryResourceOptions`
    - `ResourceContractMismatch`
    - `ResourceDerivation`
    - `ResourceDescriptor`
    - `ResourceErrorInlineProps`
    - `ResourceErrorKind`
    - `ResourceKey`
    - `ResourceOrigin`
    - `ResourcePaging`
    - `ResourceReadiness`
    - `ResourceResult`
    - `ResourceStatus`
    - `ResourceTupleResult`
    - `ResourceUnavailable`
    - `ResourceViewProps`
    - `SlowResourceInfo`
    - `TransportInfo`
    - `UnansweredSubReport`
    - `WindowParams`
    - `WindowResourceDescriptor`
    - `WindowSelector`
  - Exports (values):
    - `combineResources`
    - `ensureNotificationsClient`
    - `foldResource`
    - `getNotificationsClient`
    - `httpStaleDropReportSink`
    - `hydrateResource`
    - `liveStateSocketKind`
    - `liveStateSocketUrl`
    - `mapResource`
    - `matchResource`
    - `NotificationsProvider`
    - `pendingMountSnapshot`
    - `queryKeyFor`
    - `readyResource`
    - `refuseResource`
    - `resourceDescriptorByKey`
    - `ResourceError`
    - `ResourceErrorInline`
    - `resourceErrorReportSink`
    - `ResourceStaleReadError`
    - `ResourceView`
    - `slowResourceReportSink`
    - `subscribePendingMounts`
    - `unansweredSubReportSink`
    - `useCombinedResources`
    - `useFailingResources`
    - `useLiveRegistries`
    - `useLiveSocketKindOf`
    - `useNotificationsChannelStatuses`
    - `useNotificationsClient`
    - `useNotificationsStatus`
    - `useQueryResource`
    - `useResource`
    - `useResourceAcks`
    - `useResourceContractMismatches`
    - `useResources`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/shadow --shadow`
  - Imported by: 306 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×82
    - `conversations` ×50
    - `debug` ×29
    - `ui` ×25
    - `tasks` ×24
    - `page` ×16
    - `primitives` ×16
    - `infra` ×9
    - `active-data` ×7
    - `build` ×7
    - `plugin-meta` ×5
    - `auth` ×4
    - `apps-core` ×3
    - `integrations` ×3
    - `review` ×3
    - `shell` ×3
    - `audience` ×2
    - `config_v2` ×2
    - `framework` ×2
    - `hints` ×2
    - `reports` ×2
    - `stats` ×2
    - `code-explorer/commit-detail`
    - `fields/secret/config`
    - `history/dialog`
    - `menu-bar/app-grid`
    - `network/live`
    - `reorder`
    - `screenshot`
    - `search/quick-find`
- Exemptions:
  - Exempts itself from:
    - `endpoints/no-raw-web-fetch` — `web/use-resource.ts` (sanctioned)
    - `endpoints/no-raw-web-fetch` — `web/notifications-client.ts` (sanctioned)
    - `live/no-legacy-resource-spelling` — `.` (sanctioned)
    - `live/no-endpoint-read` — `web` (sanctioned)
  - Exempted by: `apps/file-explorer/git` (0 debt)
- Core:
  - Exports (types):
    - `PointParams`
    - `PointResourceDescriptor`
    - `Resolvable`
    - `ResourceDescriptor`
    - `ResourceErrorKind`
    - `ResourceOrigin`
    - `ResourcePreload`
    - `ResourceReadiness`
    - `ResourceStatus`
    - `ResourceUnavailable`
    - `WindowParams`
    - `WindowResourceDescriptor`
    - `WindowSelector`
  - Exports (values):
    - `compareTxWatermark`
    - `registerResourceDescriptor`
    - `resolvableSchema`
    - `resolved`
    - `resourceDescriptorByKey`
    - `ResourceError`
    - `tolerantEnum`
    - `unresolved`
- Test helpers:
  - Web: `@plugins/primitives/plugins/live-state/web/testing`
    - `createLiveStateHarness` — A fresh `NotificationsClient` and the `QueryClient` it owns, under a transport, for ONE test — what the app's `TransportProvider` + `NotificationsProvider` mount, minus the page's pipeline (which keeps the first cache it was built with, so a second test would mount a cache nothing writes).
    - `markResourceContractMismatch` — Record that the server refused `key` for this tab.
    - `mergeKeyedDelta` — Merge a row-keyed delta into the prior cached array.
    - `noteResourceTxAcks` — Record the server-acknowledged source-transaction ids for (key, params), then notify subscribers (emit-after-note: a listener reading `hasResourceTxAck` inside its callback already sees the freshly-noted acks).
    - `noteResourceWatermark` — Adopt a frame's commit watermark for (key, params), monotonically: an equal or older watermark than the stored one is a no-op (compared causally via `compareTxWatermark`, never as strings).
    - `NotificationsClient`
    - `resetResourceContractMismatches` — Forget every mismatch — tests only (via `web/testing`).
    - Types: `LiveStateHarness`, `LiveStateHarnessOptions`, `ResourceErrorInfo`

<!-- AUTOGENERATED:END -->
