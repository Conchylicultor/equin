# network/live substrate gaps: stale values after a reconnect, placeholder window descriptors, `Resource.Declare` undefined at runtime

## Context

Phase 3 of the live-resources work (`research/2026-09-27-global-live-resources-phase3-bulk-migration.md`, Follow-ups; on main
since `f14d715a4`) left three gaps in the substrate:

1. **Stale value after a reconnect.** An external `serveValue` whose `notify` is wired only inside `whileSubscribed`, with no
   `revalidate`, answers a reconnecting tab `up-to-date` from memory — although nothing watched its source while no tab was
   subscribed. Named cases: `queue-health.pulse` (a wedged queue keeps showing healthy), `jobs-list`, `allow-files`.
2. **Placeholder descriptors.** `network/live`'s window and `:rows` point descriptors (`core/internal/window-descriptor.ts`) and
   `liveCollection`'s `:groups` descriptor still seed `initialData: []`, which `liveValue` does without. This is the part of
   `ResourceDescriptor.initialData` that does not wait on Resources page items 3 / 7 / 9.
3. **`Resource.Declare.from` / `getContributionsIfCollected`** (`server-core/core/resources.ts`) are typed but `undefined` at
   runtime, so a caller type-checks and then crashes.

Each gets the structural fix, not a patch at the named sites.

## What the investigation found

### Gap 1 is wider than filed

The runtime's version short-circuit (`resource-runtime/core/runtime.ts`, `handleSub` and `handleSubBatch`) answers a `sub` that
echoes `(epoch, version)` with `up-to-date` when the epoch is this boot and the version equals the pk's counter. It rests on one
invariant (`resource-runtime/CLAUDE.md`): *for a non-`revalidate` resource the per-pk version counter is its complete change
signal*. That is only true while something tracks the tuple:

- **External value, notify wired in `whileSubscribed`:** the watcher stops at the last unsubscribe. (Filed.)
- **Any parameterized DB-backed tuple** (every collection window, `:rows` point set, grouping, param'd value): `applyDbChange`
  fans a change out to *subscribed* tuples only (`subscribedParamsFor`, falling back to `{}`). With no subscriber the tuple's
  counter does not move. (Not filed.)

A reconnect replay (`ws.onopen` → `replaySubs` → one `sub-batch` echoing each sub's version) lands on a NEW socket after the
server already ran the old socket's `close` (every tuple it held went N→0). The echo matches, and the tab keeps the value it had
before the gap. A probe test on the harness (two sockets: subscribe on 0, close 0, change the truth, replay on 1 with the echo)
answers `up-to-date-batch` for BOTH an external lifecycle-watched value and a param'd `defineResource` with a read-set.

Two more ways to hold a version that no longer describes the truth:

- **Resubscribed by someone else in between.** Socket A holds `v`, closes; the tuple changes untracked; socket B subscribes
  (full load, sub-ack of the FRESH value at the unchanged `v`); A's tab reconnects on C, echoes `v`, is not first → match.
- **An HTTP read of an untracked tuple** reports the current version with a value that stops being tracked the moment it is read.

Same-socket replays — the missed-update probe, one of the two chronic replay triggers the replay-storm investigation measured
(`research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md`) — register their entries before reconciling, so a
restated tuple never goes 1→0→1 and stays tracked throughout. Those short-circuits are sound.

### Gap 2 has a latent prerequisite

Removing the placeholder is not free. `useResource` keeps a placeholder-less query `enabled: false` until its first value (so
it does not fetch on mount). The one refetch trigger a keyed collection can get before its first value is a `sub-error` (the
loader threw on the first sub): the client answers it with `invalidateQueries`, which skips disabled queries
(query-core 5.99 `refetchQueries` filters `!query.isDisabled()`). So a first-sub loader failure leaves the read `pending` with
`error: null` forever — the loud failure the sub-error path exists for (`live-state/CLAUDE.md`: "instead of leaving the resource
wedged `pending` forever with `error: null`") never surfaces. This is already true for every `liveValue`; removing the collection
placeholders would extend it to every collection. It is fixed first.

### Gap 3's cause

`Resource.Declare` is a hand-written wrapper around a `defineServerContribution` token (it projects a `Resource` down to
`{ key, mode, preload }`), cast `as typeof declareToken & …`, with only `getContributions` copied across. The cast is what lets
`from` / `getContributionsIfCollected` type-check while missing.

## Design

### 1. A version is comparable only inside one tracking span

A tuple is **tracked** exactly while it has a subscriber (N ≥ 1). The rule: **every tracking span opens with a fresh version** —
`registerSubOnSocket`, on the global 0→1 (`firstGlobal`), bumps `entry.versions[pk]`.

Why it is complete: versions only increase, and every span starts above every version minted before it (under an earlier span,
or by a notify / HTTP read while untracked). So a client echo can equal the current version only if it was minted inside the
current span, during which every change reached the counter. That covers all four cases above in one line, for every source,
and needs nothing from `compile-value.ts` or the named sites.

- A first subscriber can never short-circuit (its registration just minted the version). `handleSubBatch`'s detached
  `onFirstSubscribe` branch inside the up-to-date arm becomes unreachable and is deleted; the full path already runs the hook.
- A first sub-ack reports version ≥ 1 (was 0). The client accepts any version above its `-1` baseline; nothing else reads the
  number (the boot snapshot carries none).
- **Cost, accepted:** a reconnect replay that arrives after the server processed the old socket's `close` now reloads every
  tuple, exactly as a backend restart already does (new epoch). Same-socket replays keep short-circuiting. A replay that arrives
  before the old `close` is processed still short-circuits, soundly (the old socket held the tuples, so they were tracked).
- `entry.versions` gains an entry per distinct tuple ever subscribed (was: ever notified). Small numbers, reset per boot.

Not chosen: bumping at N→0 only (misses the HTTP-read case), exempting "continuously tracked" tuples (param-less DB values,
globally-notified externals — each exemption is a correctness claim the runtime cannot check), and a server-side linger on socket
close (keeps quick reconnects cheap; recorded as a follow-up, it is a perf optimisation on top of a correct rule).

Also: `compileRecomputeOn`'s comment for the param-less `{}` edge says it exists so "a later subscriber must not be told its old
copy is current". The runtime now guarantees that; the edge stays for its other reason (an L2-persisted or value-mapped value must
recompute with no subscriber). The comment is corrected.

### 2. `network/live` mints its three descriptors without a placeholder

**Prerequisite — sub-error reaches a disabled query.** In `NotificationsClient.handleServerMessage`'s `sub-error` branch, replace
`applyInvalidate` with a direct fetch of that query: `queryClient.prefetchQuery({ queryKey, queryFn: () =>
fetchOverHttp(key, params, origin, schema, "fallback"), staleTime: 0 })`. `prefetchQuery` fetches regardless of `enabled`, records
a failure in the query's own error state (`q.error`, the single error channel) and never rejects (RQ's own sanctioned
fire-and-forget). The `invalidate` frame keeps `invalidateQueries` (only on-demand values get those, and they are enabled).

**Descriptors:**

- `primitives/live-state/core/window.ts`: `WindowResourceDescriptor` / `PointResourceDescriptor` declare `initialData?: never`
  (no placeholder: not known yet is `pending`) instead of `initialData: El[]`.
- `network/live/core/internal/window-descriptor.ts`: both factories build the descriptor object themselves and register it with
  `registerResourceDescriptor` (the `liveValue` pattern) instead of `keyedResourceDescriptor(…, [], …)`.
- `network/live/core/internal/live-collection.ts`: `:groups` is minted the same way; `LiveGroupsDescriptor` gets
  `initialData?: never`.
- `QueryResourceContract` (the tree's `queryResourceDescriptor`) keeps its `initialData: Row[]` — item 3.

After this, `initialData` is seeded only by the tree (item 3), the ticks (item 7) and config (item 9).

### 3. A contribution token owns its projection

`defineServerContribution` gains an optional `project: (input: I) => P`. Without it `I = P` (today's behaviour); with it the
token's call signature takes `I` and stores `project(input)`. `ServerContributionToken<P, I = P>`. Every method
(`getContributions`, `getContributionsIfCollected`, `from`) is built by the factory, so a projected token has all of them by
construction. `Resource.Declare` becomes the token itself — no wrapper, no cast:

```ts
Resource.Declare = defineServerContribution<ResourceDeclarePayload, ResourceDeclarePayload>("resource.declare", {
  docLabel: (r) => r.key,
  project: (r) => ({ key: r.key, mode: r.mode, preload: r.preload }),
});
```

`Fields.Storage` (`fields/server-capabilities`) wraps a token too, but declares its own honest interface (no `from`) and needs a
side effect plus a generic call signature, so it is left as is.

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — `registerSubOnSocket`, `handleSubBatch`
- `plugins/framework/plugins/resource-runtime/core/*.test.ts` — new `runtime-tracking-span.test.ts`; version literals in the
  existing suites (`runtime-version-shortcircuit.test.ts` rewrites its evicted-snapshot case: that state is now unreachable)
- `plugins/network/plugins/live/shared/compile-value.ts` — comment only
- `plugins/primitives/plugins/live-state/web/notifications-client.ts` — sub-error fetch
- `plugins/primitives/plugins/live-state/core/window.ts`, `plugins/network/plugins/live/core/internal/{window-descriptor,live-collection}.ts`
- `plugins/framework/plugins/server-core/core/{contributions,resources}.ts` (+ `contributions.test.ts`)
- Docs: `resource-runtime/CLAUDE.md` (read path), `live-state/CLAUDE.md` (replay, `initialData`), `network/live/CLAUDE.md`
  (`whileSubscribed`, collections have no placeholder)

Framework files change here (`resource-runtime`, `server-core`): the task itself names both sites.

## Verification

- `./equin test` on `plugins/framework/plugins/resource-runtime`, `plugins/framework/plugins/server-core`,
  `plugins/network/plugins/live`, `plugins/primitives/plugins/live-state`, `plugins/primitives/plugins/optimistic-mutation`,
  `plugins/infra/plugins/query-resource`.
- New tests pin: the four stale cases answer a full sub-ack after the fix (and the probe's shapes fail before it); a same-socket
  replay still short-circuits; a first-sub `sub-error` on a placeholder-less read ends in `pending` with an error (and heals when
  the HTTP read succeeds); descriptors carry no `initialData`; a projected token's call / `from` / `getContributions` /
  `getContributionsIfCollected` return the projected payload, `Resource.Declare.from(plugins)` included.
- `./equin build` (all checks), then an e2e run against the deploy: a tab holding a live window, its socket dropped while
  the backend stays up, a row changed during the gap, the socket back — the window shows the change.

## Report (2026-09-27)

All three gaps are fixed as designed, in branch `att-1790510418-62ex` on top of `f14d715a4`. Uncommitted, awaiting review.
Deployed: http://att-1790510418-62ex.localhost:9000 (receipt `status: ok`, build `f14d715a4-1790525603654`, every check green —
the build after the review round below).

### What changed and why

1. **Every tracking span opens with a fresh version** (`resource-runtime`). `registerSubOnSocket` bumps the pk's version on the
   global 0→1 subscription. A version the server vouches for is therefore always one minted while the tuple was continuously
   subscribed — the only time the change feed routes to it and a `whileSubscribed` watcher runs. It fixes the filed case
   (`queue-health.pulse`, `jobs-list`, `allow-files`) and the wider one the investigation found: every parameterized DB-backed
   tuple (every collection window, `:rows` set, grouping, param'd value) answered a reconnect replay `up-to-date` over a change
   made while its socket was down. Nothing changes in `compile-value.ts` or at the named sites. `handleSubBatch`'s detached
   `onFirstSubscribe` branch in the up-to-date arm is deleted (a 0→1 entry can no longer short-circuit). A first sub-ack now
   reports version ≥ 1.
2. **`network/live` mints its window, `:rows` and `:groups` descriptors without a placeholder.** `WindowResourceDescriptor` /
   `PointResourceDescriptor` / `LiveGroupsDescriptor` declare `initialData?: never`; `window-descriptor.ts` and `live-collection.ts`
   build and register the descriptor objects directly (the `liveValue` pattern), so `network/live` no longer imports
   `keyedResourceDescriptor` / `resourceDescriptor`. `initialData` is now seeded only by the tree, tick and config descriptors
   (items 3 / 7 / 9). Prerequisite, fixed first: a `sub-error` on a query with no value and no placeholder (every `liveValue`
   already, every collection read after this change) used `invalidateQueries`, which skips a disabled query, so a first-sub
   loader failure left the read `pending` with no error forever. `NotificationsClient.fetchAfterSubError` now runs the fallback
   read with `queryClient.prefetchQuery` (fetches whatever `enabled` says, never rejects, failure lands in `q.error`).
3. **A contribution token owns its projection** (`server-core`). `defineServerContribution` takes an optional
   `project: (input: I) => P`; `ServerContributionToken<P, I = P>`'s call takes the input and every read returns the projected
   payload. `Resource.Declare` is the token itself — no wrapper, no cast — so `from` and `getContributionsIfCollected` exist by
   construction (`Resource.Declare.from(plugins)` now works). The factory's JSDoc says never to wrap a token.

Docs updated: `resource-runtime/CLAUDE.md` (read path, batch replay), `live-state/CLAUDE.md` (`initialData`, `sub-error`,
replay), `network/live/CLAUDE.md` (no placeholder, `whileSubscribed`), `compile-value.ts`'s `recomputeOn` comment,
`live-state/core/resource.ts` JSDoc.

### Files touched

- `plugins/framework/plugins/resource-runtime/core/runtime.ts`, `test-support.ts` (comment), new
  `runtime-tracking-span.test.ts`; version literals / rewritten cases in `runtime{,-ack-channel,-catchup,-h5,-revalidate,`
  `-scoped-membership,-scoped-routing,-stale-flight,-sub-batch,-version-shortcircuit,-watermark,-window-membership}.test.ts`;
  `resource-runtime/CLAUDE.md`
- `plugins/framework/plugins/server-core/core/{contributions,resources}.ts` (+ both `.test.ts`)
- `plugins/primitives/plugins/live-state/core/{window,resource}.ts`, `web/notifications-client.ts`,
  `web/__tests__/notifications-{subs,http-fetch,reconnect}.test.ts`, `CLAUDE.md`
- `plugins/network/plugins/live/core/internal/{window-descriptor,live-collection}.ts` (+ both `.test.ts`),
  `shared/compile-value.ts` (comment), `CLAUDE.md`, new `e2e/reconnect-after-gap.ts`
- `docs/plugins-details.md`, `e2e-harness/CLAUDE.md` (regenerated reference blocks)

### Verification

- **Before the fix**, a harness probe (subscribe on socket 0, close it, change the truth, replay on socket 1 echoing the version)
  answered `up-to-date-batch` for both an external lifecycle-watched value and a param'd `defineResource`. After it, a full
  `sub-ack` with the new value. `runtime-tracking-span.test.ts` pins the four stale shapes (external watcher, param'd DB tuple,
  another socket resubscribing in between, a version read over HTTP while unsubscribed) and the two that must still
  short-circuit (a same-socket replay; a replay reaching the server before the old socket's close).
- **Runtime suite**: the bump shifted version literals in 21 existing cases; fixed in the tests only (runtime untouched by that
  pass). Two cases pinned a now-unreachable state (a short-circuited resub over an evicted keyed snapshot) and were rewritten
  to pin what happens instead (the resub is a full sub-ack that re-seeds, the next change is a scoped delta), with the
  still-reachable no-snapshot FULL self-heal kept, reached through a failed sub-ack load.
- `./equin test` on `resource-runtime`, `server-core`, `network/live`, `live-state`, `optimistic-mutation`,
  `query-resource`: 573 bun + 122 vitest, all pass; after the review round, the same minus `query-resource`: 535 bun +
  124 vitest (the two new client tests included), all pass. New client tests: a `sub-error` on a disabled (placeholder-less, valueless)
  query runs the HTTP read — a 500 becomes `q.error`, a 200 heals.
- **Full suite**: 27 bun + 4 vitest failures (+1 vitest file that fails to load), none in a changed plugin. The same 14 files run
  on a clean checkout of the base `f14d715a4` fail the same cases (the DB ones are the known `define-extension.test.ts`
  `mock.module` leak: "Transactions are not supported by the Postgres Proxy driver").
- **Build**: `./equin build` with all checks — ok.
- **E2E** `plugins/network/plugins/live/e2e/reconnect-after-gap.ts` (new; notifications bell window): proxies
  `/ws/notifications` with `page.routeWebSocket`, closes the server side (the backend releases the tab's subs), holds the
  client's reconnect, creates a notification over HTTP, releases. Passed on every run (twice by me, twice by its author,
  once more on the final build): the row appears within ~0.5 s and the
  `notifications` replay on the new socket is answered by a `sub-ack`, never `up-to-date-batch`. Not run against a pre-fix
  deploy (it would need a second deploy of the base); the harness probe above is the before/after evidence.
- **E2E** `shell/notifications/e2e/bell-filter.ts` (windows, `:groups`, grow past 200, live dismiss, boot preload): 23/24, twice.
  The failing step reads the bell's labels right after `boot()` (networkidle + 1.5 s) on a no-WebSocket page and gets `[]`. A
  probe showed the bell mounts 2–4 s after that settle on this (loaded) host in BOTH socket modes, and its first frame is
  already the exact total — the property the step pins holds; the script reads before the bell exists. Not caused by this
  change (no render gate changed; the bell mounts late with the WebSocket up too); I did not run it against the base.

### Review round (adversarial reviewer, after the first report)

Fixed:

- **False "missed update" alerts (review #1).** The missed-update probe counted a sub as missed when its resync
  sub-ack came back at a higher version. With spans, a replay on a NEW socket (the probe's batch queued while the
  socket was down and flushed onto the new one, or the reopen's own replay, landing inside the 1.5 s settle window on
  a wake from sleep) comes back higher whether or not anything changed, and would have raised "Live updates stalled"
  plus a crash task. `SocketChannel.opens` counts socket opens; the probe skips a sub whose channel reopened during
  the probe. Test: `notifications-reconnect.test.ts` "a socket that reopens during the probe re-baselines".
- **Explicit first-subscriber rule (#6).** Both short-circuits (`handleSub`, `handleSubBatch`) now also require
  `!firstGlobal`, so "the subscriber that opens a span is never up-to-date" is stated, not just implied by the bump.
- **Delta base guard (#7).** `applyDelta`'s "no base" check read `getQueryData === undefined`, which a placeholder
  defeats: a scoped delta drawn by another tab's subscription before this tab's sub-ack was merged onto the tree's
  `[]`, settled the read on a false empty list, and the adopted version then dropped the tab's own sub-ack. The guard
  is now `!hasAppliedValue` (server-vouched value), for every keyed descriptor. Collections no longer have a
  placeholder, so this was live only for the tree (item 3) descriptors. Test: `notifications-subs.test.ts` "a
  placeholder is no base".
- **Stale comments.** `RegistryEntry.versions` (runtime.ts), `ActiveSub.version` (notifications-client.ts), the
  `releaseSubRefcount` eviction note, and `resource-runtime/CLAUDE.md`'s FULL-branch case list, suite list and
  `sub-error` paragraph now describe spans. `live-state/CLAUDE.md` records #8 (below) and the probe skip.
- **Gap 3 typing (#9)** was already closed by the overloads (`project` required whenever `I` is given).

Left, with the reason:

- **No freshness floor on a span's reads (#2).** `serveSub` joins any read flight in progress, so a flight that started
  before the span (the cold-start HTTP prime, the boot snapshot's `loadResourceByKey`, another tab's HTTP read) can
  serve the span's first sub-ack a value read before a change nothing tracked. This is not a regression: the base
  joined the same flights and lost the same change (it reported the older version with it, which later same-socket
  replays short-circuited on just the same). The obvious fix — `notBefore: spanOpenedAt[pk]` on every serve — would
  refuse the boot snapshot's in-flight loads for every preloaded resource on every page load, and the cold-start prime
  for every resource a deep link mounts: double loads through the 6-slot gate in exactly the windows the
  gate-after-dedup work tuned. The sound cheap version needs a per-entry change stamp (`lastChangeAt`) advanced on
  every path the runtime learns of a change — `applyDbChange` per affected key before fan-out, `scheduleNotify`,
  `cascadeDownstream` before tuples are derived — plus `spanOpenedAt` for entries whose change signal lives in a
  subscription hook (and, transitively, their downstreams). That is a flight-freshness design of its own, with its
  own tests; recorded as a follow-up.
- **Async `onFirstSubscribe` window (#3).** A second subscriber arriving while the first one's async hook is still
  starting does not wait for it, so it can load before the watcher runs. Theoretical today: the one async start
  (`edited-files`) is a `revalidate` resource. Follow-up (keep the pending start per pk, await it in every serve). The
  reviewer also found that `measureSubscribeCycle` (boot-bench) fires the hooks without registering, so a concurrent
  real 0→1 can have its watcher stopped by the benchmark's teardown (`pairLifecycle`'s one record per tuple) —
  pre-existing, follow-up.
- **Reconnect and leader-handover cost (#4).** Accepted as designed; a leader handover (closing the leader tab) also
  makes every remaining tab replay onto a new socket and reload. The two cheaper sound options — a server-side linger
  on socket close, or bumping a DB entry's span version only when an entry-level change counter moved since its last
  N→0 — are follow-ups, to be sized by `subShortCircuits` vs sub-ack loads around reconnects. (The design's "not
  chosen" note undersold one of them: param-less DB tuples are continuously tracked by `applyDbChange`'s `{}`
  fallback, except when fed by a `toSubscribed` edge.)
- **`entry.versions` growth (#5).** One entry per distinct tuple ever subscribed, reset per boot — `:rows` tuples are
  keyed by whole id sets, and main runs for days. Follow-up: mint every version from one runtime-wide clock, delete
  `versions[pk]` at N→0, and have an untracked read report the clock (never `0`, or a WebSocket-down HTTP fallback
  body would be dropped as older than the tab's held version).
- **A failed read no longer retries on remount (#8).** A placeholder-less query is disabled, so React Query's
  retry-on-mount does not reach it: after a failed `sub-error` fetch it stays in error until a push, a reconnect
  replay or `refetch()` — as every `liveValue` already did. Documented in `live-state/CLAUDE.md`; follow-up if remount
  should retry.

### Deviations from the plan

- Added the e2e script (the plan only described the scenario).
- The client fix is named `fetchAfterSubError`; `applyInvalidate` stays for `invalidate` frames.

### Follow-ups

- **Review leftovers** (reasons in "Review round" above): a freshness floor for a span's reads (#2, the substantive
  one), awaiting an async span start in every serve (#3), the `measureSubscribeCycle` hook overwrite (#3), one
  runtime-wide version clock (#5), retry-on-remount for placeholder-less reads (#8).
- **Cheap reconnects (perf, optional):** a replay on a new socket now reloads every tuple, as after a restart. A server-side
  linger (keep a closed socket's tuples subscribed for a few seconds) would keep a quick reconnect inside its span. Measure
  first: `_debug`'s `subShortCircuits` vs sub-ack loads around reconnects.
- **`bell-filter.ts` step 5** should wait for the bell before reading the recorded labels.
- **`Fields.Storage`** (`fields/server-capabilities/server/internal/storage.ts`) wraps a contribution token under an
  `as unknown as` cast too. It is honest today (its own interface, no `from`), but a new read on the token would be missed the
  same way; if it ever needs `from`, give the factory an on-declare option rather than extending the wrapper.
- A console `429 Too Many Requests` shows on every e2e page load of this deploy (source not traced; also present in the
  bell-filter run, unrelated to live-state frames).
- Resources page, item 9: the `initialData` note can drop `network/live`'s window / point / groups — only tree (3), ticks (7)
  and config (9) seed it now.

### For the later tasks

- **Config (task 2):** `config-v2.values` is external with a global notify, and its tuples now reload on a reconnect replay
  after a socket drop (no cross-socket short-circuit). A placeholder-less read now surfaces a first-sub loader failure as
  `q.error` — relevant when config drops its `{}` placeholder.
- **Collections (task 3):** window / `:rows` / `:groups` reads have no placeholder: `pending` means no data at all, and a
  grown window's new tuple is disabled until its sub-ack (unchanged `growing` behaviour, covered by bell-filter's grow step).
- **In-memory routing (task 9):** tracking spans are why routing only subscribed tuples is sound. The bump at 0→1 stays
  correct if routing ever reaches unsubscribed tuples (it only costs a reload), so it needs no change there.
- **Latency (task 8):** expect fewer `subShortCircuits` and more `sub` loader spans right after reconnects.
- **Framework:** this task changed `resource-runtime` (`registerSubOnSocket`, `handleSubBatch`) and `server-core`
  (`contributions.ts`, `resources.ts`); the task text named both sites, which is the approval this relied on.
