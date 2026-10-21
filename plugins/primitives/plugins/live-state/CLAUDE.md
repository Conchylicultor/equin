# live-state

## No Suspense — hydrate, don't suspend

Resource reads are **non-suspending** by design: `useLive` / `useLiveRow` (and
the `useResource` they are built on) return a `status` (`loading` / `error` /
`ready`) and never throw a
promise. There is **no `<Suspense>` boundary
anywhere in the app** — a genuinely suspending read (`React.lazy`,
`useSuspenseQuery`) must wrap itself in its own. To avoid a first-paint flash of
default values, seed the cache **before render** with `hydrateResource(resource,
params, value)` (canonical use: the boot snapshot's `Core.Boot` task, which hydrates
every preloaded tuple — config's documents included).

**Hydration expires unless the resource says otherwise.** React Query garbage-collects a
query with no mounted observer after `gcTime` (5 min), so a boot-hydrated value for a
surface the user has not opened yet is dropped, and the next mount reads
`dataUpdatedAt === 0` — `loading` again, long after boot said the value was known. That is
not a theoretical window: it is why a `<DataView>` opened mid-session could claim
"No views configured" for the seconds until its sub-ack landed.

**One flag: `preload`** (`ResourcePreload = "boot" | "boot-and-keep"`, absent ⇒ on
first mount), declared on the shared descriptor (`liveValue` / `liveCollection` spec, or
the old factories' trailing options) and read by every runtime reader: the boot snapshot
keys and the L2 persist set (`preload !== undefined` via `Resource.Declare` — minus an
enumerated preload, whose Declare carries `preloadTuples`), the
eager-tier generator (through the resource vocabulary), and the client's `gcTime`.
`"boot-and-keep"` is `"boot"` plus a resident cache (`gcTime: Infinity`) — only for
values small and universally read enough to hold for the tab's lifetime; never for
large collections. Resident means EVERY tuple of the key, observed or not:
`hydrateResource` registers `setQueryDefaults([key], { gcTime: Infinity })` before it
seeds, because `setQueryData` builds the query with the client's defaults and its
constructor arms the 5-minute GC timer — `useResource`'s own `gcTime: Infinity`
(applied when an observer mounts) would come too late for a tuple nobody opens within
5 minutes of boot. A parameterized `liveValue` may be preloaded as well; its served
half names the tuples (`preloadParams` — see `network/live/CLAUDE.md`). The legacy
`resident: true` flag is gone (config was its last user).

**One tuple per logical read (`canonicalParams`, `packages/canonical-params`).** An `undefined`-valued param
is dropped, and so is a `""` for a param the descriptor declares optional
(`optionalParams`, a `liveValue`'s `"scopeId?"`). `useResource`, `useResourceAcks` and
`hydrateResource` canonicalize on entry, so the subscription, the HTTP fallback URL
(`URLSearchParams` would write `"undefined"`), the prime and the query key all name the
same tuple. The resource runtime applies the same function on the server and echoes
the canonical tuple in every frame (`resource-runtime/CLAUDE.md`), so the two ends
cannot key a tuple differently.

**`params === null` is the skip.** `useResource(resource, null)` reads nothing: every
hook still runs, but no `observe`, no HTTP read or prime (the query's `queryFn` is
React Query's `skipToken`, on a per-key skip key), and no pending-mount count; the
result is `{ pending: true, error: null }`. Public spellings: `useLive(value, null)` and
`useLiveRow(c, null)` (network/live).

**No descriptor has a placeholder.** Not known yet is a state, never a stand-in
value: a query holds no data until the first value and reads `loading`
(`dataUpdatedAt === 0`). A pushed query stays disabled until a value lands, so it
makes no HTTP fetch on mount (the WS sub-ack fills it). The
exception is an on-demand descriptor (`load: "on-demand"`, the server's `invalidate`
mode): its value never rides the socket, so HTTP is its read path and it fetches on
mount. `load` sits on the shared descriptor so server and client cannot disagree.
A disabled query is skipped by `invalidateQueries`, so a `sub-error` does not
invalidate: the client fetches that query directly (`prefetchQuery`, the same
version-guarded read), and its failure is the query's error — never a read left
`pending` with no error. It stays in that error until a push, a reconnect replay
or a `refetch()`: React Query's retry-on-mount does not reach a disabled query.
`useOptimisticResource` reads a declaration (a `liveValue`, or a collection's
`{ ids }`), whose overlay has no base — and no `dispatch` — until a real value
lands, so it stays `loading` instead. (The old `resourceDescriptor` factory and
its `initialData` placeholder are deleted —
`research/2026-10-08-global-page-tree-and-agents-routed.md`.)

Data the first render needs is a `liveValue` declared `preload: "boot"` /
`"boot-and-keep"` (the boot snapshot hydrates it); there is no seeder for
endpoint reads.

## A burst of landings is one commit (`internal/coalesced-notify.ts`)

Each cache write (one per WS frame) is its own React Query batch, and the
default scheduler gives each flush its own `setTimeout(0)` task — N frames
back to back (a cold list's per-row sub-acks) were N React commits.
`use-resource.ts` installs a coalescing scheduler on import
(`notifyManager.setScheduler`, page-global): every flush queued before the
pending timer fires runs in that one task, so the burst is one commit. Order
and asynchrony are unchanged. Do not remove it as "redundant with React
batching": React batches per task, and the default scheduler makes one task
per frame. Pinned by `web/__tests__/landing-commits.test.tsx`.

## A varying list of tuples — `useResources`

`useResources(resource, paramsList, options?)` reads a list of tuples of ONE
resource whose length changes over time (network/live's paged read: one window
per live page), which a hook call per tuple cannot express. Each tuple is read exactly
as `useResource` reads it — one shared `tupleQueryOptions` builds the query (key,
HTTP fallback, enabled rule, GC rule), the same `observe` / `unobserve`
refcount (a tuple another component also reads is subscribed once), the same
cold-start prime, the same pending-mount count until its first value, the same
once-per-tuple mount→settle report (one shared `reportTupleSettled` feeds
`slowResourceReportSink`, so a page's slow read reaches Debug → Slow Ops) —
and yields the same `ResourceResult` states, in list order. No `select`, no
`gate`. What is not shared is only the effect shape: one tuple per hook against
a list moved by diff.
The subscription set moves by DIFF: a tuple kept across a list change is never
unobserved and re-observed (its socket subscription would lapse), and a removed
tuple is released after the new ones are observed. Its read states are
structurally shared KEYED BY TUPLE (the `combine` returns a record, not an
array), so a kept tuple's `data` stays the cache's own object across a reorder,
a grow or a shrink — positional sharing would pair it with another tuple's
previous data and hand out a deep copy. Pinned by
`web/__tests__/use-resources.test.tsx`. network/live's
`useLive(value, [p1, p2, …])` is its value-level reader.

- **`{ release: "now" }`** — a tuple dropped from the list while the hook stays
  mounted is unsubscribed at once (`unobserve(…, "now")`: the WS `unsub` goes
  out on the 1→0 transition, no keep-alive window), for a reader that drops a
  tuple on purpose and will not remount it (a paged read's page leaving its
  band). The tuple's cached value goes with it (`removeQueries`): nothing keeps
  it current any more, so observing it again reads `loading` until the server
  vouches for a value — never the old one as `ready`. Unmounting the hook
  still releases through the keep-alive, so a remount (StrictMode included)
  reuses the live subs.
- **`appliedSeq`** — each result is a `ResourceTupleResult` (`ResourceResult &
  { appliedSeq }`): where the tuple's value was last written on the client-wide
  apply sequence (`NotificationsClient.appliedSeq(key, params)`, bumped in
  `markApplied` on every WS or HTTP apply). Of two tuples, the higher holds the
  more recently applied value — what a paged read's dedup keeps a row by when
  two pages hold it. `0`: nothing applied through this tab's sub yet (a
  boot-hydrated value included).
- **`{ derive }`** — per tuple of the list (`ResourceDerivation | null`, same
  order): how to SEED a tuple from rows this tab already holds when it enters
  the list — a paged read's split or merge, whose new page is a slice of the
  pages it replaces. Read on a fresh sub only (`observe`'s 0→1), never on a
  refcount bump, a replay or a forced resub. See *Seeded derivation* below.

Pinned by `web/__tests__/use-resources.test.tsx` and, for the client half,
`web/__tests__/notifications-subs.test.ts` (*release now*, *appliedSeq*).

## Seeded derivation — a sub answered from rows this tab holds

`observe(key, params, origin, schema, keyOf, derive?)` with a
`ResourceDerivation` (`{ from: [{ params, appliedSeq, after, until }] }`, at
most two sources) cuts, from each source tuple's cached rows, the slice after
the row `after` (exclusive; `null` = its first) through the row `until`
(inclusive; `null` = its last), by `keyOf`, and sends the sub with `derive: {
id, from: [{ params, version, after, until }] }` — `id` minted per derivation
(`crypto.randomUUID()`, so a duplicated tab asking the same slices tells its
answers apart). The resource runtime's half: `resource-runtime/CLAUDE.md`,
*Seeded derivation*. The caller vouches that those slices ARE the new tuple's
value (its params name exactly their range); the server checks they are the
same query, current and complete.

- **Only from a value that stands as decided.** Each source must be a sub of
  this tab whose `appliedSeq` is still the one the caller read beside the rows it
  decided on, and whose cached value the socket built (`ActiveSub.socketValue`:
  sub-ack / update / delta / derived ack applied in order — so it IS the
  server's snapshot at `version`; an HTTP body clears it). Otherwise (or a bound
  naming no row, or more than two sources) the sub goes out plain — traced
  `derive skipped … reason=…`. A source nothing was applied to through this
  tab's sub yet (`appliedSeq` 0) is either still loading (`source-loading`:
  nothing cached, or a derivation of its own in flight) or holds a
  boot-hydrated value before its first `sub-ack` (`source-hydrated`) — only
  the latter is also counted on the `live-pages` channel (`seed refused: …`,
  one line per refused seed): accepted latency, measured.
- **The derived `sub-ack`** carries no value and echoes the derivation's `id`.
  The tab adopts its held slice (the same row objects, no re-parse, no
  watermark) at the ack's version only when that id is its own in-flight
  derivation's; any other tab holding the tuple — a plain sub, or another
  derivation, on the shared socket — drops it (`not-our-derivation`) without
  adopting the version, and its own answer still applies. Matching on the id
  alone, never on the sources as the server spells them back, so the asking
  tab cannot drop its own answer.
- **The fallback** is an ordinary value-carrying `sub-ack`; it clears the
  derivation. So do a `sub-error`, a replay and a forced resub (each asks for a
  full value): a derived ack arriving after one of them is dropped.
- **Only tabs that read it share its socket.** A bundle that predates derived
  acks would parse one's missing value and adopt its version, wedging its read.
  The client's socket names its dialect — `PROTOCOL`, the id of the frame
  vocabulary (`packages/resource-protocol`; `SOCKET_OPTIONS`,
  `SharedWebSocketOptions.dialect`) — so a tab left open across a deploy that
  changed the vocabulary keeps a socket of its own and never sees one, while a
  deploy that did not keeps it on the shared socket.
- **Only under the server's vocabulary.** Every `sub` / `sub-batch` frame names
  the tab's `protocol`; the runtime reads a `derive` only under its own
  `PROTOCOL` and otherwise loads (`protocol-skew`). Frames are typed by the
  protocol both ways: the client reads `ServerFrame` and sends only
  `ClientFrame`s carrying no undeclared field (`wire` takes an
  `ExactClientFrame`), and `DERIVE_MAX_SOURCES` is the protocol's.

Pinned by `web/__tests__/notifications-derive.test.ts`.

## Hazard tests (H1–H7) — the executable correctness argument

The client transport hazards are pinned by named vitest tests under
`web/__tests__/`; the test names are the authoritative index of what each pins.
`notifications-subs.test.ts` — H4 (duplicate subs + keep-alive), the `no-sub`
broadcast gate, the version guard, the delta-no-base/drift forced resubs, per-tab
frame tagging + the `unsub-tab` last will, watermark adoption.
`notifications-reconnect.test.ts` — H1/H1b (reopen-gap convergence via one
`sub-batch`, version/epoch echoes, baseline reset at send), H2 (restart
version-counter reset), the same-boot `up-to-date-batch` resync, H7 (level-state
convergence + `probeMissedUpdates`). `notifications-cross-tab.test.ts` — H6
(a tab dying leaves the others' subs live + per-tab replay batches). `notifications-http-fetch.test.ts` —
the `fetchOverHttp` guard matrix. They run real `NotificationsClient` +
`SharedWebSocket` stacks on `createTransportHub`'s deterministic fakes from
`@plugins/primitives/plugins/networking/web/testing`, which run the real
SharedWorker host in-process; only `WebSocket`/`SharedWorker`/`MessagePort`/
`navigator.locks` are faked. Server-half siblings
(H5, the version short-circuit, gate dedup, sub-batch) live in
`plugins/framework/plugins/resource-runtime/core/`. Design:
`research/2026-07-03-global-live-state-client-transport-harness.md`. Run them
whenever you touch `notifications-client.ts`, `shared-websocket.ts`, or
`shared-ws-host.ts`:
`./singularity test plugins/primitives/plugins/networking plugins/primitives/plugins/live-state`.

## Replay is ONE `sub-batch` frame; recovery resubs never echo state

On every socket (re)open — and for the missed-update probe's forced resync —
`replaySubs` sends the channel's whole sub set as ONE `{op:"sub-batch", tabId,
epoch?, complete:true, entries}` frame, built synchronously (snapshot + baseline
reset + send in one task, so an `observe()` can't interleave). Each entry echoes
the sub's pre-reset version; `epoch` is the server boot identity learned from
ack frames. A same-boot server answers every already-current entry from its
in-memory version counter in one `up-to-date-batch` — no loader, no
read-admission slot — but only for a tuple it kept tracking since that version:
one it released (the old socket's `close` ran before this replay) opened a new
tracking span with a fresh version on re-subscribe, so its echo misses and it
gets a full sub-ack (see `resource-runtime/CLAUDE.md`). For the same reason the
missed-update probe (`probeMissedUpdates`) never counts a sub whose channel's
socket reopened during its settle window (`SocketChannel.opens`): that higher
version is a re-baseline, not a frame the live socket dropped. `complete:true` makes
the batch the server's whole truth for THIS tab, so subs the tab dropped while
disconnected are reconciled away; each channel registers `{op:"unsub-tab"}` as
its socket's last will (`SharedWebSocket.setLastWill`), which the SharedWorker
sends when the tab leaves — closed, hidden into the bfcache, or crashed — so a
departed tab's subs release immediately instead of leaking until the socket
cycles.

## Standalone acks are asked for, per tuple

`requestAcks(key, params, origin)` (hook: `useResourceAcks(resource, params)`)
asks the server for the version-less `{ kind: "ack" }` frames a no-value-change
recompute sends (see `resource-runtime/CLAUDE.md`). It is counted per tuple on
the channel (`ackInterest`), apart from the sub itself, so the order of
`observe()` and `requestAcks()` does not matter: every `sub` frame and every
replay entry restates `acks: true` while the count is positive, and a 0→1 /
1→0 transition while the sub is live sends one `{op:"sub-acks", key, params,
acks, tabId}` — no re-sub, no sub-ack. The server ORs the tabs sharing a
socket. The one caller is `useOptimisticResource`; the received frame is only
noted into the tx-ack registry, exactly as before.

The old per-sub replay **stagger was deleted deliberately**: same-socket replays
short-circuit server-side for ~0 cost, and post-restart replays (and reconnects
the server already released) are bounded by the server's read-admission gate +
single-flight dedup — the correct layer for herd control, not client-side
pacing.

**Recovery resubs never echo state** (`forceFullResub`): a delta with no base or
with drift clears the etag AND resets `version`/`lastAckVersion` to -1 before
sending a version-less sub. "No base" means no server-vouched value
(`hasAppliedValue`), never merely a defined cache: a scoped delta merged onto
anything else — which another tab's subscription on the shared socket can draw
before this tab's sub-ack — would settle the read on a false partial list. The baseline reset is load-bearing — the broken
delta already advanced `entry.version` (the guard adopts before dispatch), so
without it the recovery sub-ack at that same version would be `<=`-dropped and
the cache would never heal (pinned by the "BUG A" tests).

## Per-hop tracing (`live-state` log channel)

`NotificationsClient` traces every hop to the `live-state` log channel
(`logs/live-state.jsonl`, each line `[tabId]`-stamped) via `clientLog` — a plain
HTTP path decoupled from the notifications WS, so traces still flush when that WS
is wedged (the exact failure this instruments).

Always-on lines are low-volume transitions and silent-drop anomalies:
`observe`/`unobserve`, `sendSub`, `sub-ack`, `replaySubs`, `probeMissedUpdates`,
net-diag socket/port transitions, and every `drop reason=…` (`no-sub`,
`stale-version`, `parse-error`, `delta-no-base-resub`).

The per-frame successful `applyUpdate` line is **high-volume**, silent unless you
opt in:

```js
localStorage.setItem("liveState.verboseTrace", "1"); // enable; "0"/remove to disable
```

Deliberately a localStorage flag, not a `config_v2` setting — a local debug
switch, not user config.

## Update latency sample (`clientLatencySink`, signal `update`)

Every applied pushed frame a server change stands behind emits one `update`
sample on `clientLatencySink` (`primitives/perfs/latency-signal`): server change
→ value written into this tab's cache, split into four phases from the frame's
`timing` (`{ changedAt, sentAt, deliverMs }`, `packages/resource-protocol`) and
the tab's own stamps:

| Phase | Computed as |
|---|---|
| `server-notice` | `sentAt − deliverMs − changedAt` |
| `server-deliver` | `deliverMs` |
| `transport` | `receivedAt − sentAt` — the only phase across two clocks |
| `client-apply` | `appliedAt − receivedAt` (decode included) |

`totalMs` is `appliedAt − changedAt`, measured, never the phase sum (a clamped
phase can push the sum past it). Consumers (`debug/slow-ops`,
`debug/latency-ledger`) subscribe; live-state owns no threshold.

- **The receipt stamp** (`receivedAt`) is taken in the socket's `onmessage`,
  BEFORE `JSON.parse`, and threaded into `handleServerMessage` (an optional
  argument defaulting to now, for a frame handed in directly). "Applied" means
  the cache was written, not that React painted.
- **Only frames carrying `timing` are timed**: an `update`, or a `delta` the
  runtime sent because a change happened. Sub-acks, replay answers, a forced
  resubscribe's answer, invalidates and standalone acks carry none, so a
  reconnect makes no samples. The protocol type is the gate — no runtime check.
- **Only an APPLIED delta is timed.** `applyDelta` returns `"applied" |
  "resubscribed"`; a delta that dead-ends in `forceFullResub` (no base, drifted
  base) wrote nothing and emits nothing. Its value arrives with the recovery
  sub-ack, which is timing-less.
- **Hidden rule.** A sample is `hidden` when the page is hidden now, or was at
  any instant since `changedAt`: the client stamps `lastHiddenAt` (wall clock)
  on every `visibilitychange`, so after a return it marks the end of the hidden
  stretch. Consumers drop hidden samples — a throttled background tab measures
  the browser.
- **One sample per tab.** Every tab holding the sub applies the frame and
  reports its own sample; nothing deduplicates across tabs.
- **No work while nobody listens** (`clientLatencySink.hasSubscribers()`).

Pinned by `web/__tests__/notifications-update-latency.test.ts`.

## Scoped pipelines — a subtree talking to another backend

`NotificationsProvider` reads `useTransport()` (`primitives/networking`). Under
the page's own transport (`originTransport` — no `<TransportProvider>` above)
it is the page's singleton pipeline, exactly as before. Under any other
transport it mounts a pipeline of that transport's own: a fresh QueryClient, a
`NotificationsClient` opening `transport.openSocket(transport.socketUrl(path))`
and fetching through `transport.fetch`, and its own causal-floor registries
(`LiveRegistries`: watermarks + tx acks). So a subtree rendered against an
in-browser backend (the demo scope,
`research/2026-10-12-global-in-app-demo-scope.md`) never caches, confirms or
reports against the page's server, and the page never sees its tuples.

- **One pipeline per transport**, shared by every provider under it, created
  during render and torn down a microtask after the last provider unmounts (so
  StrictMode's remount re-retains it).
- **Socket identity is the transport's URL.** The ws-status bus is page-global
  and keyed by URL; `client.socketKindOf(url)` matches only this client's own
  sockets, so two transports must map a path to different URLs.
  `liveStateSocketKind` still names the page's own pipeline's sockets; a hook
  reads its enclosing pipeline's with `useLiveSocketKindOf()`.
- **Registries come from context.** `useLiveRegistries()` returns the enclosing
  pipeline's (the page's own outside any provider, which is what a jsdom test
  driving the optimistic overlay without a provider reads). The module-level
  `noteResource…` / `getResourceWatermark` / `hasResourceTxAck` functions are
  the page pipeline's registries only — test support, not a read path.
- **Not scoped:** boot hydration (`hydrateResource` seeds the
  page's own client), the contract-mismatch store (version skew is about the
  page's bundle) and the pending-mount counters (page diagnostics).

Pinned by `web/__tests__/scoped-pipeline.test.tsx`.

## One socket per origin, shared across tabs

The `NotificationsClient` talks to the server over a `SharedWebSocket`: the real
socket lives in a SharedWorker every tab attaches to; every received frame is
fanned out to **all** tabs. So a given
tab's `handleServerMessage` runs for **every** server frame — including pushes
for resources only *other* tabs subscribed to.

The load-bearing consequence: a tab must apply a frame only for `(key, params)`
it holds a **live local subscription** for. `handleServerMessage` gates on the
local sub `entry` (`channel.subs.get(id)`) before dispatching to
`applyUpdate`/`applyDelta`/`applyInvalidate`, and that same gate carries the
version guard + bump. Because `observe()` registers the schema (and `keyOf`)
together with the sub entry, a present entry guarantees the schema is
registered, so the apply paths can parse safely — dropping the gate reintroduces
the "no schema registered for key=…" crash (pinned by the `no-sub gate` test).

**`entry.version`/`etag` must always name a value THIS tab currently holds** —
the WS twin of `fetchOverHttp`'s never-settle-unvouched rule, gated on
the same `hasAppliedValue` predicate at three points: `handleServerMessage`
ignores a value-less `up-to-date` for a never-applied entry, and
`replaySubs`/`sendSub` echo `version`/`etag` only when backed by a cached value.
Do not "restore" an unconditional echo (an earlier comment claimed the cached
value always survives a reconnect — it does not: the sub outlives the query,
which React Query gc's after `gcTime`) and do not make the ignored `up-to-date`
force a resub (its own ack is already in flight, and congestion is what triggers
this path). Adopting a version you cannot back silently drops your own
value-carrying `sub-ack` as stale.

**Pings carry the server's flush age.** A ping's `flushOpenMs` (missing ⇒ 0)
lands per channel in `ChannelStatuses.serverFlushOpenMs` — the only sign a tab
gets of a server flush stuck while the socket stays open (read by the health
report's Connection row). It resets to 0 on any socket status change, so a dead
server's stall never outlives its connection; listeners fire only when it moves.
Pinned by `notifications-heartbeat.test.ts`.

**`sub-error` frames carry `params` and heal through the HTTP read.** The
frame is `SubErrorFrame` (`packages/resource-protocol`): `{ kind, id?, key,
params, reason, verdict? }`; `params` exists so the shared-socket broadcast is
gated on the local sub entry exactly like every other frame (a params-less
legacy frame won't match a live sub → safe drop). When the entry exists the
client records a contract refusal (`noteContractRefusal`) and calls
`fetchAfterSubError`: the HTTP fallback read runs on that query —
`prefetchQuery`, which, unlike `invalidateQueries`, also reaches a query
disabled until its first value — and **its own outcome** sets `q.error` (the
failed read's typed JSON body — 500 `loader-failed`, 404 `unknown-key`, 409
`contract-mismatch` — surfaces as `ResourceHttpError` with `reason` /
`verdict`) or heals a transient failure — reusing the single existing error
channel rather than touching queryClient internals. (Known hole, out of scope: `handleResourceHttp` runs no `authorize`
check — moot today with zero `authorize` resources.)

**A contract refusal is version skew, surfaced app-wide.** `contract-mismatch`
(the params do not match the resource's declaration — see the runtime's params
gate in `resource-runtime/CLAUDE.md`) and `unknown-key` are what a tab running
an older bundle sees after a deploy. Both the `sub-error` handler and
`fetchOverHttp`'s typed error body record them in the page-global
`resource-contract-store.ts` (`useResourceContractMismatches()`); build's
`useReloadAdvice` turns the `skew`-verdict ones into the red "out of date"
Reload segment, so the fix (reload) is offered once, not by every failed read.
Every `sub` / `sub-batch` frame carries `build` (`VITE_BUILD_GRAPH ?? "dev"`) —
per frame, because one shared socket carries tabs running other bundles —
and every HTTP read the `BUILD_GRAPH_HEADER`, so the server can judge the
verdict. `useResource` does not retry a `contract-mismatch` / `unknown-key`
/ `unserved` error (`isTerminalResourceError`): the same bundle is refused the
same way. `unserved` (a closed-key-set host — a browser host shipped with this
very bundle — does not serve the key) is never skew: it records nothing in the
contract store and reads as a `loader-failed` naming the key.

## One client, one cache — `NotificationsProvider` takes no client

The tab has ONE `NotificationsClient` (`ensureNotificationsClient()`, hoisted
to the start of boot), and it OWNS its `QueryClient` (`client.queryClient`,
the default one `hydrateResource` seeds). `NotificationsProvider`
takes only `children`: it mounts the singleton and that client's own cache,
through the internal `NotificationsClientProvider`, which takes the client
alone — so the cache React reads and the cache the client writes cannot differ.
(It used to take a `queryClient` prop, while the singleton kept the cache it was
first built with: a second provider mounted a cache nothing wrote.)

A test mounts its own pair with `web/testing`'s `createLiveStateHarness(options?)`
→ `{ Wrapper, queryClient, notifications, dispose }`: a fresh client and cache
per test (query defaults `retry: false`, `refetchOnMount: false`,
`staleTime: Infinity`, overridable via `options.queries`), destroyed when the
test finishes (vitest's `onTestFinished`; `dispose()` is idempotent). It
throws outside a running test, so a harness shared across a file's tests cannot
be written. Transport suites that drive sockets build `new NotificationsClient(qc,
hooks)` directly.

## Resource schemas

Every resource **must** declare a `schema` (Zod) — it is required on
`defineResource` (both runtimes) and guarded at registration. The payload is
parsed against that schema **twice**, by design:

- **On the server, at load time** — the single chokepoint (`timedLoad` in the
  shared `resource-runtime/core`, backing both the server and central channels)
  parses the loader output before any broadcast or HTTP response; a violation
  throws there and takes the existing loader-failure path (reported + send
  skipped / `sub-error` returned) rather than shipping a malformed value. Keyed
  Layer-2 scoped loads return a partial array, which still satisfies the
  `z.array(Element)` schema.
- **On the client, on receipt** — before the value lands in the TanStack cache,
  at both write paths: HTTP (`NotificationsClient.fetchOverHttp`, below) and the
  WS push path in `NotificationsClient.applyUpdate` (a key→schema registry
  populated as `useResource` calls `observe`). A WS-path parse failure is
  re-thrown asynchronously (`queueMicrotask`) so it surfaces as an uncaught
  browser error the crashes plugin reports — never swallowed into the empty
  default.

TS type and runtime shape therefore cannot drift; types that don't survive
`JSON.parse` are coerced (`z.coerce.date()`) on the way in. See
`research/2026-06-08-global-mandatory-resource-schema-server-validation.md` and
`research/2026-04-29-global-resource-schema-validation.md`.

## One version-guarded HTTP write path (`fetchOverHttp`)

Every HTTP resource-cache write goes through the **single** method
`NotificationsClient.fetchOverHttp(key, params, origin, read, source)` (`read`:
the declaration's `schema` + `refusals` — a descriptor is one) — its
doc-comment is the detailed spec; this section is the decision table. Callers:
`useResource`'s `queryFn` (`source: "fallback"`, errors propagate to `q.error`)
and the cold-start prime `primeFromHttp` (`source: "prime"`, fire-and-forget —
network/`ResourceHttpError`/`ResourceStaleReadError` swallowed since the WS
sub-ack is truth, a schema failure rethrown via `queueMicrotask`). It writes
through the **same version guard** as WS frames and returns the *effective*
cached value (freshly applied, or retained on a `304`/stale drop) so React
Query's `queryFn` contract holds with no separate render path. Pinned by
`web/__tests__/notifications-http-fetch.test.ts` (11 cases). Design:
`research/2026-07-02-converge-http-resource-writes-version-guard.md`.

**A bytes read** (`ResourceDescriptor.bytes`, a `liveValue` declared `bytes:
true`) takes the same path: the body is read with `arrayBuffer()` and the
envelope (`version`, `epoch`, `watermark`) from the response headers
(`resource-protocol`'s `parseResourceBytesHeaders`, which throws on a JSON
answer), then the same guard and schema parse. Its WS sub-ack carries no
value, so `handleServerMessage` adopts the ack's version / epoch and then
invalidates the tuple — the HTTP read is its value, read no older than the
tracking span the ack opened.

**Both fetches are `cache: "no-store"`, deliberately** — the browser HTTP cache
must never store or transparently 304-revalidate a resource body, or a
restart-stable ETag lets it replay an old-boot `{value, version}` that the
cross-boot compare then drops as stale. The server pairs it with
`Cache-Control: no-store` on the 200 **and** the 304 (see
`resource-runtime/CLAUDE.md`). Design:
`research/2026-07-15-global-live-state-http-cache-poisoning-class-fix.md`.

**Epoch-aware cross-boot guard.** The HTTP body carries
`{ value, version, epoch }` (`epoch` = the server `bootEpoch`, twin of the WS ack
epoch) because a bare version compare across boots is meaningless — the counter
resets to 0 each boot. `ActiveSub` carries `epoch?` labelling which boot
`entry.version` belongs to. The guard is a 4-case matrix, engaged only when
`entry` exists and `body.epoch` is defined (an epoch-less body from a pre-upgrade
server keeps strict-`<` byte-for-byte):

1. **Same boot** (`body.epoch === entry.epoch`) — strict `<`, NOT `<=`. An HTTP
   GET *reports* the version counter without bumping it, so a legitimate response
   can *equal* the version already applied (the normal `invalidate` refetch: the
   frame advanced the client to `N`, the GET returns `N`); `<` accepts that,
   `<=` would silently discard it.
2. **Entry is stale-boot** (epochs differ, `body.epoch === channel.serverEpoch`) —
   **ADOPT**; the WS channel's current server identity vouches for the body, and a
   cross-epoch adopt sets `entry.version = body.version` unconditionally (the old
   number is meaningless).
3. **Body is stale-boot** (epochs differ, `entry.epoch === channel.serverEpoch`) —
   **DROP** (`stale-epoch`), subject to the never-applied escape below.
4. **No arbiter** (epochs differ, `serverEpoch` matches neither / undefined) —
   **ADOPT**. This is the WS-down fallback window — `fetchOverHttp`'s raison
   d'être; dropping here would starve the fallback for a whole outage, and a live
   response beats a memory of unknown vintage. A socket reopen resets the replay
   baseline to -1 before any WS frame applies, so a post-adopt frame can't
   mis-compare.

**Never settle unvouched (`ResourceStaleReadError`).** On a drop (or a
`304`), `hasAppliedValue(key, params)` (`dataUpdatedAt !== 0`) decides: already
applied ⇒ return the cached value; **never-applied**
⇒ **throw** a typed `ResourceStaleReadError`. Never return an unvouched value — RQ
would mark the queryFn a success and settle a value the server never vouched for
(the "Close (state unknown)" wedge) — and never apply the stale body, which could
render old-boot data under destructive buttons. The throw drives RQ's `retry: 1`;
a persistent one settles `q.error`, visible through
`ResourceView`/`matchResource`'s error arm.

**Stale-drop observability sink.** Every stale drop emits a policy-free
`HttpStaleDropReport` into `httpStaleDropReportSink` (`web/stale-drop-reporter.ts`)
carrying a running `consecutiveDrops` count (**reset in `markApplied`** on any WS
or HTTP apply). The primitive owns no threshold — it emits on every drop; the
`reports/live-state-stale-drop` consumer owns the wedge policy (fire once at
`consecutiveDrops === 3 && neverApplied`). Import direction: `live-state` →
`report-sink` (a leaf); `live-state` must never import `reports`.

## Commit watermarks (`LiveRegistries.watermarks` / `compareTxWatermark`)

Full-reconcile frames from a worktree server carry a `watermark` — the snapshot's
`pg_snapshot_xmin(pg_current_snapshot())` as xid8 decimal text, captured by the
resource runtime before the loader read. `NotificationsClient` notes it into
its pipeline's watermark registry (`web/watermark-registry.ts`, keyed `(key,
params)`, monotonic adopt) immediately **before** the cache write it describes,
so a QueryCache listener reading `registries.watermarks.get(key, params)`
synchronously sees the causal floor of the
value it was just handed. optimistic-mutation compares that floor against
mutation ack tokens (`currentTxId`) to confirm — or causally deny — pending
overlay ops.

**Rule B′ (which frames carry one):** only frames that fully reconcile the
client to server truth as of the capture — `sub-ack`, `update`, FULL keyed
deltas, and the HTTP body. Scoped deltas **never** do (they re-read only
affected rows; stamping one would let a client wrongly deny a pending op). This
is the twin of resource-runtime's "etag rides only the `update` frame" rule. An
absent watermark (fresh sub, central-origin resource, pre-watermark server)
means "no causal floor": confirming by content is fine, denial is forbidden.

Compare watermarks and ack tokens only with `compareTxWatermark`
(`live-state/core`) — xid8 decimal text overflows `Number` and is not
lexicographically ordered ("9" > "10"), so BigInt comparison is the only sound
one. Full design:
`research/2026-07-11-global-never-revert-optimistic-edits.md`.

**Never build a client-side drop on watermark ORDERING.** It is tempting to guard
against a stale frame with "this watermark is older than the one I hold, so this
snapshot is older" — it is unsound. The watermark is
`pg_snapshot_xmin(pg_current_snapshot())`, and **xmin is not monotonic**: one
long-running transaction pins it low for its entire lifetime. A strictly-older
watermark therefore does not prove an older snapshot, and the predicate would not
misfire once — it would misfire on *every* frame for *every* resource for as long as
that transaction lives. Paired with a forced resub it turns a nightly job or a slow
migration into every tab re-subscribing every resource on every push: a
self-amplifying storm during exactly the load that motivates the guard. Report-only
has the same false-positive rate, just quieter. Unaffected: Rule B's **denial**
inference, which is a statement about one snapshot rather than a comparison of two,
and `noteResourceWatermark`'s monotonic adopt, which cannot regress the causal floor.
If a backstop is ever wanted, the sound signal is a server-stamped **monotonic read
sequence** minted when a flight starts and co-produced like the other stamps — not a
watermark. The staleness this would have guarded is cured at the source (a push
frame can no longer be backed by a pre-commit read):
`research/2026-08-08-global-live-state-flight-freshness.md`.

## Descriptor registry (`resourceDescriptorByKey`)

Every descriptor factory (`network/live`'s `liveValue` / `liveCollection`)
self-registers its result into a module-level
key→descriptor map at **descriptor-module evaluation time** (the factory call runs
on import, before first paint); `resourceDescriptorByKey(key)` reads it back.
boot-snapshot uses it to resolve the snapshot's boot-critical keys to their client
descriptors *before* the first render.

**Distinct from the observe-time key→schema registry** (populated as `useResource`
calls `observe`, used by `applyUpdate` to parse WS pushes): that one only exists
once a component has mounted and subscribed — **too late** for pre-paint boot
hydration.

## Keyed delta sync (`mode: "keyed"`)

Array resources that rebroadcast the whole list on every change can opt into
row-level delta sync: the resource still runs its full loader, but the server
diffs the new result against a per-`(key,params)` id→hash snapshot and broadcasts
only `upserts`/`deletes`. The client merges by id and keeps unchanged rows' object
references — moved ones included (the cache's structural sharing keeps a
reference the previous array held) — so memoized row components don't re-render.

Client merge contract: when `order` is **present** the client rebuilds the array
from it (authoritative); when **absent** it maps over its prior array in place,
swapping changed rows by id — an omitted `order` strictly means "in-place
upserts, membership unchanged" (`deletes` necessarily empty, no new ids), which
keeps the id list off the wire for the common status/title flip. *Which* frames
carry `order` is the emitter's half (`resource-runtime/CLAUDE.md`).

This is the wire every `liveCollection` rides: its window and `:rows`
descriptors are keyed on the declared `id`, so a collection gets row deltas with
nothing to declare. Keyed-ness is declared in **one place** — the client
descriptor — and the server reads it from there, so the two sides cannot drift:

- **Client/shared** — the descriptor carries `keyOf` (`liveCollection` sets it
  from `id` on its window, `:rows` and `all` descriptors — the only keyed
  descriptors there are). `schema` stays `z.array(Element)`, so callers still
  get `T[]`. The `keyOf` keys prior cache
  rows when merging a delta; per-row parsing goes through the array schema's
  `.element`. A delta that arrives with no cached base is dropped and a fresh
  full sub is forced (load-bearing guard).
- **Server** — the served half takes that descriptor (`serveCollection`, which
  compiles it to the two-arg `defineResource(descriptor, { loader, routes,
  membership | scopedMembership, … })`);
  `key` / `schema` / `mode: "keyed"` / `keyOf` all come from it. Do **not**
  restate `mode`/`keyOf` — `ServerResourceOptions` rejects `mode: "keyed"`, the
  flat one-arg `defineResource` form structurally cannot be keyed, and inline
  `keyed:` contract literals are banned by the `keyed-resource-scope` check. The
  first notify per pk (and every `sub-ack` / HTTP fallback) still ships a full
  `{ value, version }` so brand-new clients get a complete base; subsequent
  notifies ship a `delta`.

  Caveat — the descriptor must live where the server can import it without a
  plugin cycle (a `core/` or `shared/` the server's plugin already reaches).

Strictly additive: `push`/`invalidate` resources are untouched.

### Scoped recompute (a routed refill)

Layer 1 shrinks the wire payload; Layer 2 shrinks the recompute. Every keyed
resource is a routed membership entry (`resource-runtime/CLAUDE.md`, *Scoped
change routing*): a change to a row it reads refills only that row — the
runtime hands the loader `ctx.affectedIds` and it returns only those rows —
and the drain merges them into the snapshot as a delta. A content-only change
ships exactly Layer 1's content-delta shape (`upserts`, empty `deletes`, no
`order`) — **the client needs zero changes**; a membership change (an entrant,
an exit, an order move) MAY assert `order` / `deletes`, which a present `order`
already takes the rebuild path for. There is no hand-scoped notify: `notify()`
(an external resource's only spelling) always recomputes in full. The
server-side mechanics live in
`plugins/framework/plugins/resource-runtime/CLAUDE.md` and
`plugins/infra/plugins/query-resource/CLAUDE.md`. See
`research/2026-07-03-global-scoped-membership-m5.md`.

### Bounded windows and point reads (window / point descriptors)

> **A collection is a `liveCollection`** (`network/live`). Declare it once in
> `core/` (`liveCollection(key, { row, id, filterable, sortable, default,
> maxLimit })`), serve it with `serveCollection(c, { from })`, and read it with
> `useLive(c, query?)` / `useLiveRow(c, id)`. It mints a window and a point resource
> from one declaration, so a consumer asks a query (filter / order / limit, or ids)
> and never picks the bound itself. See `plugins/network/plugins/live/CLAUDE.md` and
> `research/2026-09-25-global-unified-live-resource-api.md`. The window / point
> descriptors below are its substrate, never a declaration of their own. A set
> its readers need whole is a collection declared `all` (one param-less keyed
> tuple), never an unbounded descriptor of its own.

The bounded working-set contract rides the SAME keyed wire — **a window is just a
params tuple**. Live-state owns only the descriptor **types** (`core/window.ts`:
`WindowResourceDescriptor`, `PointResourceDescriptor`, `WindowParams`,
`PointParams`, `WindowSelector`) — no read hook. The factories are internal to
`network/live` (`liveCollection` calls them), because the only server half that
can serve a bounded resource is `windowQueryResource` (`infra/query-resource`),
which needs the `queryPk` those factories record — there is no second,
unservable way to mint one.

- A window descriptor is an ordered window; params are `{ limit: "100" }`.
- A point descriptor is an explicit id set; params are `{ ids: "a,b" }` (sorted,
  deduped, comma-joined). Never preloaded (post-mount hydration is the
  recorded decision).

The descriptor **carries the selector codec** (`.window.encode/decode`,
`.point.encode/decode`), so the client hooks, the boot paths, and the server
compiler (`windowQueryResource` in `infra/query-resource`) all derive params from
one encode/decode pair. Encode is canonical and decode is STRICT (malformed
params throw): the SAME logical selector must always produce the SAME params
object, because paramsKey identity is what makes boot hydration, the
subscription, and the server land on ONE per-tuple state. A future cursor rides
as an additional `cursor` key (absent field = absent key), so cursor-less windows
keep their paramsKey.

`defaultParams` (a generic optional `ResourceDescriptor` field, set by the window
factory to the encoded default window) is how boot-snapshot serves a windowed
preloaded resource: the server's fallback loader runs at
`resourceDescriptorByKey(key)?.defaultParams` and the client hydrates at
`d.defaultParams` — the identical tuple a bare `useLive(c)` subscribes to.

The only public bounded reads are `network/live`'s: `useLive(c, query?)` for a
window (the collection's `key` resource), `useLive(c, { ids })` for an id set and
`useLiveRow(c, id)` for one row (both on its `:rows` point resource).

The server runtime half (membership routing, bounded deltas, the
never-persisted rule) lives in
`plugins/framework/plugins/resource-runtime/CLAUDE.md`; the compiler in
`plugins/infra/plugins/query-resource/CLAUDE.md`.

### Future escape hatch (NOT yet implemented)

A `transform: (raw) => T` descriptor field bypassing Zod for hot-path resources
whose payloads grow large enough that parsing hurts. Don't add it speculatively —
current payloads are small and parse cost is negligible.

## Keep-alive subscriptions (deferred teardown)

The WS subscription lifetime is aligned with React Query's own cache `gcTime`:
when the last observer of a `(key, params)` leaves, the sub stays in
`channel.subs` with refcount 0 and a one-shot `SUB_KEEPALIVE_MS` (30s) timer is
parked in `channel.pendingTeardown`. A resurrecting `observe()` within the window
cancels the timer and bumps refcount back up — **zero WS traffic**; only if the
window elapses with refcount still 0 does the timer fire the `unsub` and delete
the sub. Without it, a transient unmount→remount churns an unsub→resub
round-trip on the wire. This is a one-shot deferred-cleanup timer, **not a
polling loop** (it mirrors React Query's own `setTimeout`-based gc).

The one bypass is `unobserve(…, "now")` (`useResources`' `release: "now"`): a
reader that drops a tuple on purpose tears its sub down on the spot.

The consequence: transient observer churn — e.g. a reorderable slot rendered
**per row** in a streaming/virtualized list — reuses the one live sub instead of
flapping it. This is why a per-row `useLive` of a **row-invariant** value no
longer needs a manual hoist (the old `ReorderHoist` provider): N rows already
share one cache entry and one refcounted sub.

Trace gating follows: the always-on `live-state` channel logs only real
**transitions** — the 0→1 new sub and the eventual `teardown`. Refcount bumps are
silent there so a per-row list doesn't storm the low-volume channel; `emitDebug()`
still fires on every change so the live-state-health inspector stays accurate.

## A read is `loading`, `error` or `ready`; an unknown value is `Resolvable`

Two different things can stand between a consumer and a value; keeping them in
separate channels is what makes a destructive default unreachable by construction
rather than by a remembered guard.

**The `error` channel — its own state.** *"We failed to determine the value; a
retry may succeed."* Every read (`useResource`, `useLive`, `useLiveRow`,
`useConfigResult`, `combineResources`, `mapResource`) returns three arms named by
`status`:

```ts
type ResourceResult<T> =
  | { status: "loading"; refetch }                                  // no value, no failure
  | { status: "error"; error: ResourceError; stale?: T; refetch }   // error is never null
  | { status: "ready"; data: T; refetch };
```

A failure is **not** a flavour of loading. This supersedes the 2026-07-09
decision (`research/2026-07-09-global-resource-unknown-value-and-error-gate.md`)
to merge the two into `pending` "so every gate is correct for free": a surface
that only asks "is it loading?" renders a failure as a spinner forever — the
build-history incident
(`research/2026-09-27-global-live-resource-skew-and-error-state.md`). Its value
invariants stand: the `ready` arm **omits** `error` and `stale` (reading either
is a tsc error — a `null`-typed field would catch nothing), and last-known-good
is the opt-in `stale` on the `error` arm, never what a `.data` read reaches.

**`ResourceError`** (`core/resource-status.ts`) is an `Error` subclass with a
`kind` a surface acts on, derived in ONE place (`web/resource-error.ts`,
`toResourceError`, memoized per raw error):

| kind | from | remedy |
|---|---|---|
| `client-outdated` | `contract-mismatch` / `unknown-key` unless the verdict is `same-build`; a client-side zod rejection | reload the tab |
| `not-found` | a 404 (or `unknown-key` on the same build) | a bug |
| `loader-failed` | any other HTTP failure, a `same-build` contract mismatch, an `unserved` key (message: `<key> is not served by this host`), anything else thrown | retry, else a bug (an `unserved` key is terminal — never retried: the host does not serve it) |
| `transport` | `fetch`'s `TypeError`, a lost version race (`ResourceStaleReadError`) | retry heals it |
| `refused` | a loader's `ResourceRefusal` (`packages/resource-protocol`): HTTP 422 `refused`, its `code` one the read declares (`ResourceDescriptor.refusals`) — on `error.code`, typed by `ResourceResult<T, C>` — and its `detail` the message. A refusal whose code the read does not declare (or with none) is a `contract-mismatch` instead (`fetchOverHttp`: the server only sends its own declared codes, so this bundle declares the resource differently — `client-outdated`, marked `skew`) | none — the message IS the answer (an unknown id, an empty range); `ResourceErrorInline` offers no Retry, it is never retried, never counted as failing (health row), never reported |

There is no boolean that lumps loading and error together: `status` is the only
state a result carries, and neither the loading arm nor the ready arm has an
`error` or a `stale` to read — so a surface that ignores a failed read does not
compile.

**Failure plumbing, all in `NotificationsClient` (once per page, never per hook):**

- **Sticky-error clear.** A value-less `up-to-date` reply (the same-boot replay
  answer) says the value this tab holds is current, so it clears that exact
  tuple's query error via React Query's public `Query.setState` — no data write,
  no cache event a value listener could mistake for a push.
- **Event-driven retry, no timers.** `online` and `visibilitychange → visible`
  refetch only the tuples in error that something still observes (through
  `query.fetch()`: `refetchQueries` skips a disabled query, and a `liveValue`
  that never got a value is disabled). Reconnect replay and the error UI's
  Retry are the other two triggers.
- **Report sink.** The client watches the query cache and keeps the failing
  set (`useFailingResources()`); on a tuple's error going none → set it emits
  `resourceErrorReportSink` once for that episode, however many hooks observe it.
  `reports/resource-errors` collects it (and owns the "Live reads" health row) —
  live-state never imports `reports`.

**The one sanctioned exemption is `useOptimisticResource`** (`OptimisticResult`):
it is named by the same `status`, but once a base has landed a failing read
stays `ready` — editors keep painting their base under a transient error and
report it through the ready arm's `error` + `sync-status` rather than blanking
the document. Its `error` arm is only a first load that failed. Being
`status`-named, it feeds every gate (`combineResources`, `matchResource`,
`foldResource`) like any other read, and the result lint rules cover it.

**The value channel — determinate.** *"The server has an answer, and the answer
is: there is nothing to determine."* A loader branch that **cannot determine**
its value must say so in the payload, via `Resolvable<T>` from `live-state/core`:

```ts
type Resolvable<T> = { resolved: true; value: T } | { resolved: false; reason: string };
liveValue("edited-files", { schema: resolvableSchema(z.array(EditedFileSchema)), params: ["id"], load: "on-demand" })
```

It settles, renders its `reason`, and stops retrying — where a throw would wedge
the resource `loading` forever. It never returns the empty value: `[]` must mean
*measured, and empty*. `edited-files` and `commits-graph.graph` collapse "no
worktree" and "worktree reaped mid-compute" onto one `unresolved(…)` via an
`onWorktree` helper, with `revalidate` returning the matching `"no-worktree"`
ETag from the **same branch** so the pair stays co-produced. `attempt-work` is
the other adopter, with one unresolved arm only — an attempt row that no longer
exists (its standing stays measurable from the main repo without the checkout).
Every *other* git failure still throws.

The resource-payload form of the repo-wide `api-design` rule "Failure must be a
type, not an absorbable value". "Not loaded yet" is never an `unresolved(…)`: a
read is `loading` until the first value.

## Readiness gates — every state gets its own answer

`.data` does not exist until `status === "ready"`. Do **not** defeat that with
`r.status === "ready" ? r.data : []`:
it collapses "still loading", "failed" and "genuinely empty" into one value, and
downstream UI renders a confidently-wrong state (empty lists, zero counts,
destructive default button modes). Three lint rules keep it out:

- `live-state/no-pending-data-collapse` — the collapse itself (allowlist empty —
  never add an entry).
- `live-state/no-ready-negation` — on a result binding, `status` may be compared
  to `"loading"` / `"error"` only: `!== "ready"` and `=== "ready" ? … : …` fold
  loading and error into one branch. An explicit `switch` fall-through
  (`case "loading": case "error":`) is allowed — it names both.
- `live-state/no-handrolled-result` — outside live-state and `network/live`, no
  hand-written `status: "loading" | "error"` result arm or result union: derive
  with `mapResource` / `combineResources` so the typed error, `stale` and
  `refetch` survive; a TanStack query becomes a result through
  `useEndpointResource` / `useQueryResource` (below). Its message lists
  every sanctioned constructor from ONE table, `lint/result-constructors.ts`
  (`{ name, from, use }`), which also derives the owning plugins; a new clean
  form is one row there, and `result-constructors.test.ts` fails if a row names
  something its barrel does not export.

The rules cover **`useConfigResult`** (config_v2) too: a config's defaults are a
*legitimate* value, so collapsing its loading arm produces a wrong state that
looks exactly like a right one. The plain `useConfig` IS that collapse (`stale ??
defaults`), kept for cosmetic reads — anything deciding what a surface asserts
reads `useConfigResult`.

Sanctioned patterns, in order of preference:

```tsx
// One resource, JSX — children only ever run with ready data; loading renders
// `fallback` (default <Loading/>), a failure <ResourceErrorInline variant="block"/>.
<ResourceView resource={songs} fallback={<Loading variant="cards" />}>
  {(rows) => <Grid rows={rows} />}
</ResourceView>

// One resource, expression position.
matchResource(songs, { ready: (rows) => …, loading: () => …, error: (e, stale) => … })

// A plain value (.ts derivation): every handler required, so "what does a failure
// yield" is written down.
foldResource(r, { loading: () => …, error: (e, stale) => …, ready: (d) => … })

// SEVERAL resources — precedence error > loading > ready, so a view never renders
// from a half-loaded snapshot and never spins on a read that failed.
const all = useCombinedResources({ conv, ranks, tasks });
switch (all.status) {
  case "loading": return <Loading variant="rows" />;
  case "error": return <ResourceErrorInline error={all.error} refetch={all.refetch} variant="block" />;
  case "ready": …
}

// List/grid surfaces: DataView's `readiness` — `emptyState` needs ready + zero
// rows; loading renders the skeleton, error renders `errorState`.
<DataView rows={rows} readiness={result} … />
```

**`<ResourceErrorInline error refetch variant />`** is the one rendering of a
failure: `block` (a pane or list body), `inline` (a field or card line), `icon`
(a toolbar control — pass `icon` to keep its face, `subject` to name what
failed). It offers Retry, or "App updated — reload" for `client-outdated`.
Data-dependent **action buttons** render disabled-neutral while loading — never a
default mode, and especially never the destructive one — and the error variant
when the read failed.

**A TanStack query is read through an adapter, never returned raw.** A read
of the SERVER is live — a `liveValue` (`params`, a typed `query`, or
key-range-`paged`) or a `liveCollection`, read with `useLive` (`network/live`),
so it refreshes itself; the `live/no-endpoint-read` lint ratchets the
remaining request/response reads. What is left renders through the result
vocabulary too:

```ts
useEndpointResource(someGetEndpoint, params); // a GET endpoint (legacy — being migrated)
useQueryResource({ queryKey, queryFn: () => import("./x") });  // a LOCAL async load, never a server read
```

Both — and `useResource` itself — map (data, error) through one
`queryResult` (`web/query-result.ts`; `useResource` passes its own "a value
landed" flag, because a selector may answer `undefined` for a landed value): `error` whenever the last
fetch failed (the previous value as `stale`), `loading` while nothing landed,
`ready` otherwise; the failure goes through `toResourceError` (an
`EndpointError` 404 → `not-found`, other status → `loader-failed`). `enabled`
is not an option — a disabled query is `loading` forever. There is no form
keyed by another read's value (a revision tick, the hand-made freshness
`network/live` replaced), and no paged form: a paged server read is a
paged `liveValue`. A paged read's ready arm carries the paging handles
(`ResourcePaging`: `canGrow` / `growing` / `loadMore` — `useLive`'s window,
whose `LiveListResult<Row>` is `PagedResourceResult<Row>`, and its paged
value's `LivePagesResult`); a failed next page is the error arm with what was
already held as `stale`.
Returning a raw `UseQueryResult` hands the caller `isPending` / `isError` and a
`data` it can read without asking — the collapse this section exists to ban.

**Domain hooks keep every arm.** A hook that narrows a read — one row of a
collection, one key out of a record — never returns a bare `T | null`: "not
loaded yet" and "failed" must stay states the caller renders, apart from
"absent". For one row, return `useLiveRow`'s result as is — its `ready` arm
splits into `found: true` (with `row`) and `found: false` (the server answered,
no such row):

```ts
export function useTaskAutoStart(
  taskId: string,
): LiveRowResult<TaskAutoStartRow> {
  return useLiveRow(taskAutoStart, taskId);
}
```

For any other narrowing, return `ResourceResult<T | null>` derived with
`mapResource(r, fn)`, which maps the ready arm (and a `stale` value) and passes
loading and error through, so a ready `null` means "absent".

`no-pending-data-collapse` also flags an early `return null` for the
not-ready states in a value-returning function whenever the ready return can be
`null` too (`?? null` or an optional chain, as in `r.data[0] ?? null`). A
component returning `null` while loading before rendering JSX stays legal.

**Gate restriction:** feed only whole-resource results into gates — never a
`select` result (silent-flip caveat below). For a select-based readiness read,
pass `gate: true` (next section).

## Slice selectors (`useResource(resource, params, { select })`)

**`useResource`, and `useLive(all, { select })`** — a collection declared `all`
(its whole set held in one tuple; `network/live`, always `gate: true`). A window or
value `useLive` has no `select`: one row of a collection is `useLiveRow(c, id)`
(a point read, so a change elsewhere never reaches it), and a derivation of a
value is a `useMemo` over its settled data.

A **point or derived read of a list resource** must not re-render on every push
to the whole list. Pass a `select` to subscribe to a derived **slice**: the
component then re-renders **only when the selected slice changes**.

```ts
const select = useCallback(
  (p: ConversationListPayload) => p.active.find((c) => c.id === id) ?? null,
  [id],
);
const q = useResource(conversationsResource, undefined, { select });
// q.data is the row (or null); re-renders only when THAT row changes.
```

Two React Query mechanics make this work, both engaged **only** when `select` is
present (plain `useResource` is byte-for-byte unchanged):

- **Structural sharing on the select output** — RQ runs `replaceEqualDeep` on
  the selected value, so a deeply-equal slice keeps its previous reference and
  the observer is not notified. This holds even for a full-payload `update`-mode
  resource (the whole struct is reparsed each push): the comparison is on the
  **selected** value, not the payload.
- **`notifyOnChangeProps: ["data", "error"]`** — `useResource` reads
  `q.dataUpdatedAt` for its `loading` state, and `setQueryData` bumps that on
  **every** push; unscoped, that bump alone re-renders every subscriber (the O(C²)
  storm). Reading `dataUpdatedAt` does not re-enable notifications once
  `notifyOnChangeProps` is an explicit list.

Caveat: with `select`, the read turns `ready` **silently** (no re-render) if
the selected slice is identical across the no-value→first-value boundary — a
selector answering `undefined` for the first value (the query held no data
before it).
Harmless for point lookups — the caller sees the same value either way. Pass a
**stable** selector (`useCallback`) so it is not re-run every render.

**`gate: true`** fixes that caveat for select-based READINESS reads (e.g. a
boolean deciding a destructive button mode): the notifications stay un-scoped
until the tuple holds a value, so the loading→ready flip always re-renders,
then narrow to `["data", "error"]` with steady-state behavior identical to plain
`select`. Without it, a gate built on a select result can wedge as loading
forever.

The latch is **derived, never held** (P8 v3 C17, D29): narrowed exactly while
the tuple's query has a value (`dataUpdatedAt` past epoch 0), read from the
query cache through `useSyncExternalStore` (`useTupleHasValue`, woken only by
its own tuple's events). It holds a cache listener only while the latch is
OPEN: `QueryCache.notify` runs every listener on every event of any query, and
each observer of a pushed tuple emits one, so a listener per settled gated read
would make every push cost O(observers × gated reads). A read whose tuple
already holds a value subscribes nothing, and an open read's listener removes
itself with the event that lands the value; after that its own observer covers
a reset (the narrowed observer re-renders on the `data` change). So a tuple
already cached — boot-hydrated, or held by another observer — renders ONCE,
narrowed, on its first render; a params change re-gates exactly when the new
tuple has no value yet; and there is no settle effect whose `setState` costs a
render. Only the notifications are gated: the selector runs on every render
so the slice is always the current tuple's — a
selector switched off and on across a params change let React Query hand back
the slice it had memoized for the PREVIOUS tuple. Pinned by
`web/__tests__/use-resource-gate-latch.test.tsx`.

**A gated read needs no selector** (`useResource(resource, params, { gate:
true })`, `UseResourceGateOptions`): it hands React Query no `select`, so `data`
IS the cached value — every observer of the tuple holds the same object and,
for an array, the same row objects (a select, even the identity, gives each
observer its own structurally-shared copy) — and narrows to `["data",
"error"]` once the tuple holds a value, so a push that leaves the cached value
unchanged re-renders nothing. `useLive(all)` reads its whole set this way. A
selector that MAY be absent (`select: cond ? f : undefined`) types the read
`ResourceResult<T | S>` — it may hand back the whole value — so tsc never
vouches for a slice it does not deliver; an always-present selector is
`{ select, gate: true }` → `ResourceResult<S>`.

This narrows re-renders, not the WS subscription: N callers of the same
`(key, params)` still share one refcounted sub (deduped server-side).

**Structural sharing keeps moved elements** (`internal/structural-sharing.ts`,
the query's `structuralSharing` for every resource, applied to the cache write
and to each select output): positional sharing first (a deeply-equal element
keeps the previous one), and an array element that is not, but IS by reference
an element the previous array held at another index, is kept as that object.
A keyed `order` delta moves rows by reusing their cached objects, so a reorder
keeps every row's identity rather than re-minting each moved row.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Server live-state primitive: useResource hook + NotificationsProvider + NotificationsClient. Thin TanStack Query wrapper over the app's tab-shared /ws/notifications channel. useQueryResource reads a local async load (not a server read — those are live) as a ResourceResult.
- Load-bearing: yes
- Web:
  - Uses: 26 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/networking` ×10
    - `infra/endpoints` ×3
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
    - `ResourceErrorInfo`
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
    - `useEndpointResource`
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
  - Imported by: 257 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×69
    - `conversations` ×49
    - `debug` ×24
    - `ui` ×24
    - `tasks` ×22
    - `page` ×12
    - `primitives` ×12
    - `active-data` ×7
    - `infra` ×7
    - `plugin-meta` ×5
    - `auth` ×4
    - `build` ×4
    - `integrations` ×3
    - `review` ×3
    - `config_v2` ×2
    - `framework` ×2
    - `reports` ×2
    - `code-explorer/commit-detail`
    - `fields/secret/config`
    - `history/dialog`
    - `network/live`
    - `search/quick-find`
    - `shell/notifications`
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
    - `createLiveStateHarness` — A fresh `NotificationsClient` and the `QueryClient` it owns, for ONE test — what the app's `NotificationsProvider` mounts, minus the tab singleton (which keeps the first cache it was built with, so a second test would mount a cache nothing writes).
    - `markResourceContractMismatch` — Record that the server refused `key` for this tab.
    - `mergeKeyedDelta` — Merge a row-keyed delta into the prior cached array.
    - `noteResourceTxAcks` — Record the server-acknowledged source-transaction ids for (key, params), then notify subscribers (emit-after-note: a listener reading `hasResourceTxAck` inside its callback already sees the freshly-noted acks).
    - `noteResourceWatermark` — Adopt a frame's commit watermark for (key, params), monotonically: an equal or older watermark than the stored one is a no-op (compared causally via `compareTxWatermark`, never as strings).
    - `NotificationsClient`
    - `resetResourceContractMismatches` — Forget every mismatch — tests only (via `web/testing`).
    - Types: `LiveStateHarness`, `LiveStateHarnessOptions`

<!-- AUTOGENERATED:END -->
