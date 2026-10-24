# Live values: the migration contract — every old value option, spelled or retired

## Context

`liveValue` / `serveValue` / `useLive(value)` shipped (`research/2026-09-25-global-live-values.md`)
with only what the bell's unread badge needed. The bulk migration (phase 3 of
`research/2026-09-25-global-unified-live-resource-api.md`; Resources page item 5) cannot start
while old declarations use things the new API cannot say. This doc decides, per missing thing,
its spelling in the new API or why its sites change shape instead, checked against the real
call sites (census 2026-09-26 at `2387cee06`).

**Out of scope** (Resources page items 3 and 7): the tree resources (`tasks`, `attempts`,
`conversations-active` / `-system` / `-gone`, `agent-launches`, `pages`, `page-links`,
`task-categories`, `prompt-task-origins`) and the revision-tick lists (`runs.revision`,
`conversations-revision`, `events.revision`, `events.runs-revision`, `deploy.runs-revision`,
`mail-threads-revision`, `reports.revision`, release runs). Their uses of the options below are
noted but decide nothing.

**Rule held** (Resources page, groupBy decision): an option or entry point is added only when a
real in-scope call site needs it; a new hook only when the result has different *states*.

## Summary of decisions

| Old thing | In-scope sites | Decision |
|---|---|---|
| `debounceMs` | `git-watcher.refHead` 300, `jobs-list` 1000, `queue-health.pulse` 1000, `review.plugin-changes` 3000 | **Kept, renamed `throttleMs`** — a `serveValue` option on both arms |
| `dependsOn` (plain `map`) | `build.deployment`, `attempt-work`, `commits-graph.graph`, `review.plugin-changes` | **`recomputeOn: [served]`** — every subscribed tuple by default; the runtime tracks them, so the hand-kept "active set" disappears |
| `dependsOn` via `rel()` | only `attempts`, `tasks`, `agent-launches` (all tree) | Not spelled here — item 3 |
| `onFirstSubscribe` / `onLastUnsubscribe` (not in the task list; found by the census, 9 sites) | `edited-files`, `jsonl-events`, `subagent-activity`, `subagent-transcript`, `allow-files`, `jobs-list`, `queue-health.pulse`, `attempt-work`, `commits-graph.graph` | **`whileSubscribed(params, notify?) → stop`** — one hook whose return value is the stop |
| `revalidate` | `attempt-work`, `build.deployment`, `edited-files`, `jsonl-events`, `subagent-activity`, `subagent-transcript`, `commits-graph.graph` | **Kept as is**, a `serveValue` option on both arms |
| `ackChannel` | `queue-ranks` only (a point *collection*) | **Retired as a server option** — the optimistic hook asks for acks on its own subscription |
| client `select` (14 sites) | in scope: `mail-labels`, `prototypes` (+ config ×3, deferred to item 9) | **Dropped** — no `select` on `useLive`; every site has a better shape (below) |
| optimistic values | `page-blocks`, `prototypes.picks` (+ `queue-ranks`, a collection) | **`useOptimisticResource` takes a `liveValue` / a collection `{ ids }` read**; the result is `pending` until a base exists, and `mutate` exists only on the settled arm |
| central process | `auth-state` | **`liveValue(…, { origin: "central" })`** + `serveValue` from a new `network/live/central` barrel (external arm only) |
| `Resolvable<T>` (~24 files) | `build.deployment`, `attempt-work`, `commits-graph.graph`, `edited-files` (+ one endpoint) | **Nothing changes** — a payload schema shape; only the three `unresolved("not loaded")` placeholders go |
| hand-written keyed collections (non-tree) | 11 | 10 → `liveCollection` (the scoping param becomes a filterable column; the two one-row tables are read with `useLiveRow`), 1 → param'd `liveValue` array. Two general collection additions: **an optional default window** and **a column's wire codec** |
| `identityTable` on a plain value (7 sites) | chord ×3, `mail-labels`, `mail-sync`, events revisions ×2 | **Dropped** — on a value it only feeds scoped ids to a downstream `rel` edge, and none of these is a `rel` upstream |
| `authorize` | 0 sites | Not spelled |

## 1. `throttleMs` (was `debounceMs`)

```ts
serveValue(refHead, { source: "external", loader, throttleMs: 300 });
```

- Same runtime field (`runtime.ts:326-342`): a trailing fixed window that is **not re-armed**
  by later notifies, and a flush that is already happening drains it early. That is a
  throttle, not a debounce; the new spelling says so. The runtime field keeps its name until
  the old factories are deleted, then it is renamed too.
- On both arms. All 4 in-scope sites are external, but the runtime semantics are
  source-agnostic, and item 7's db-arm ticks will need it (a type split would be arbitrary).
- `plugin-changes` throttles merges from `recomputeOn`, not from `notify`. Same field.

## 2. `recomputeOn` (plain `dependsOn`)

```ts
serveValue(deployment, { source: "external", loader, recomputeOn: [refHeadServed] });
serveValue(pluginChanges, {
  source: "external", loader, throttleMs: 3000,
  recomputeOn: [
    { value: editedFilesServed, params: ({ id }) => ({ conversationId: id }) },
    refHeadServed,
  ],
});
```

- **The bare form recomputes every currently-subscribed tuple** of this value when the upstream
  changes (any of the upstream's tuples). The runtime already knows them (`subscribedParamsFor`,
  `runtime.ts:4799`). Three of the four sites hand-roll exactly this: a module `Set` filled by
  `onFirstSubscribe` / drained by `onLastUnsubscribe` and read back by `map`. That boilerplate
  (and the chance to forget one half) becomes inexpressible (rung 1). `deployment`'s `() => [{}]`
  is the same thing for a param-less value.
- **The mapped form** `{ value, params: (upstreamParams) => P }` covers the one real per-tuple
  edge (`edited-files {id}` → `plugin-changes {conversationId}`).
- Upstreams are `ServedValue`s, so the upstream must migrate first: `git-watcher.refHead`
  (server-only today, a flat `defineExternalResource`) becomes a `liveValue` in git-watcher's
  `core` plus `serveValue` external. It is the first migration in the order below.
- Allowed on both arms: `attempt-work` is a db-arm value (it reads the push ledger through the
  pool) that also recomputes on a ref advance.
- Scoped `rel()` edges (`affectedMap`, `signature`) are **not** spelled: their only users are the
  three tree resources. Item 3 decides them together with loading part of a tree.

## 3. `whileSubscribed` (was `onFirstSubscribe` / `onLastUnsubscribe`)

```ts
serveValue(editedFiles, {
  source: "external", load: "on-demand", loader, revalidate,
  whileSubscribed: async ({ id }, notify) => {
    const wt = await worktreeFor(id);
    return wt ? watchEditedFiles(wt, notify) : () => {};
  },
});
serveValue(attemptWork, {
  source: "db", loader, revalidate, recomputeOn: [refHeadServed],
  whileSubscribed: ({ attemptId }) => () => evictAttemptWork(attemptId),
});
```

- The census found this pair missing from `serveValue`: 9 in-scope sites use it. Uses fall
  into three kinds: tracking the active set for `dependsOn` (removed by §2), starting and
  stopping a source watcher, and evicting a memo.
- **One function whose return value is the stop**, like a React effect: a stop without a start
  cannot be written, and neither can a start without a stop. Today's sites each keep an
  `unsubscribes` map and an `if (unsubscribes.has(id)) return` guard. The runtime owns the
  pairing instead: it awaits a pending start before running its stop, when the last
  unsubscribe arrives first.
- `notify` for this tuple is passed in **on the external arm only**. This also removes the
  self-reference (`editedFilesResource.notify({ id })` inside its own definition). On the db
  arm the hook takes `params` only: a db value is driven by the change feed alone.

## 4. `revalidate`

Kept as is: `revalidate: (params) => Promise<string>`, on both arms, read-path only (a
sub-ack answers `up-to-date`, the HTTP read answers 304). All 7 sites already derive it from the
loader's own `createSignedMemo`, or from the same `onWorktree` branch (the co-production invariant,
`research/2026-07-09-global-etag-value-coproduction.md`). That invariant stays with
`git-read-cache`. A `memo:` option replacing `loader` + `revalidate` was considered and
rejected: 4 of the 7 wrap both halves in an `onWorktree` collapse, so the memo is not the
whole loader.

## 5. `ackChannel` — the reader asks, not the server

- Its one site is `queue-ranks`, a point collection written optimistically. The standalone
  `{ kind: "ack" }` frame exists only so a pending optimistic op is confirmed when its write
  changed nothing visible. Only the client knows it has such an op.
- **Decision:** the `sub` frame gains `acks: true` when an optimistic hook observes the
  tuple (OR-ed across the tab's observers of that tuple). `broadcastAckOnly`
  (`runtime.ts:2072`) sends only to subscribers that asked. The server-side `ackChannel` is
  deleted when `queue-ranks` migrates. Forgetting to turn it on becomes inexpressible, and
  collections nobody writes optimistically pay nothing.
- Values need nothing: `page-blocks` confirms by content, and `prototypes.picks` confirms by coarse
  settle. A value frame is stamped with `ackTx` either way.

## 6. `select` — dropped

What each of the 14 sites becomes:

| Site | Decision |
|---|---|
| `tasks` / `attempts` / `conversations-*` row lookups and derivations (8 sites: `useConversation`, `useLinkedTask` ×2, `useTaskAttempts`, `useTaskConversations`, `useHasActiveSiblings*`, op-status title map) | Tree → item 3. Each becomes `useLiveRow` / a `where` query. The real re-render storm (`useConversation`, ~175 observers) is exactly what a point read fixes at the subscription, not the render |
| revision ticks ×3 (`d => d.rev`) | Out of scope (item 7). Noted: the payload *is* the field, so a `select` there never bailed out of anything |
| `config_v2` scopes ×3 (`useConfigResult`, `useScopeMembership`, `ScopeTabs`) | Stays until item 9 (config is the last `resident`). The likely shape is a per-path value (`{ path }` → scope ids), which needs N preloaded tuples — item 9's own problem |
| `mail-labels` → options (`fields.tsx:70`) | `useMemo` over `useLive(mailLabels)`. Labels change rarely, and the React Compiler memoizes the derived array |
| `prototypes` → one prototype's viewport (`canvas/context.tsx:172`, `gate: true`) | `useLive(prototypes)` plus a lookup by name. The provider re-renders on a list change, but its children do not (the value is a primitive-keyed memo). `gate` is not needed: `useLive` has no placeholder, so `pending → settled` always re-renders |

- Why no option: every in-scope need is either a row-level subscription (which a query shape
  solves better, at the server) or a cheap derivation. A `select` would bring back the
  `gate` subtlety (a silent `pending → false` flip), which exists only because a projection
  can hide the settle.

## 7. Optimistic reads over the new declarations

```ts
const blocks = useOptimisticResource(pageBlocks, { pageId }, { apply, mutate, isConfirmedBy });
if (blocks.pending) return <Loading />;
blocks.mutate(op);                    // only on the settled arm
```

- **Accepts a `LiveValue` (value plus params), or a collection plus `{ ids }`** (the `:rows`
  read, for `queue-ranks`), mirroring `useLive`'s argument shape. The old
  `ResourceDescriptor & { initialData }` overload stays until its three callers migrate, then
  goes, and `initialData` leaves the descriptor with it.
- **New states:** `{ pending: true }` until a base exists, then the settled arm with `data`,
  `serverData` and `mutate`. The base is `data`, or `stale` under a transient error (the
  existing "loud exemption" is kept). It is never a placeholder. An op cannot be made against a
  base nobody has seen (rung 2: `mutate` is not on the pending arm). Today, `prototypes.picks` would
  fold a click onto `{}` before the stored picks load. That stand-in is gone.
- The confirmation logic (`hasAuthoritative`, `resolvePass`) no longer needs its "placeholder
  seen" guard: there is no placeholder.

## 8. Central — `origin: "central"`

```ts
// auth/core
export const authState = liveValue("auth-state", { schema: AuthStateValueSchema, origin: "central" });
// auth/central
export const authStateServed = serveValue(authState, { source: "external", loader });  // from network/live/central
```

- The client needs the origin (it picks the socket, `notifications-client.ts:51`), so it lives on
  the declaration, as `centralResourceDescriptor`'s `origin` does today. `LiveValue` gains an
  origin type parameter.
- **`network/live/central` exports `serveValue`**, built on `central-core`'s runtime, external
  arm only (central has no change feed). The worktree `serveValue` rejects a central
  declaration and the central one rejects a worktree one (both tsc errors). The option
  compilation (`compileValue`) moves to `network/live/shared/` so the two barrels cannot drift.
- Central registration is `resources: [served]` in the central plugin definition, so the
  central served value has no `declare` tuple.
- One site, but the alternative (a stated reason to stay) would keep
  `centralResourceDescriptor` and the old `defineExternalResource` alive for one resource.

## 9. `Resolvable<T>` — unchanged

A payload shape (`resolvableSchema(inner)` / `resolved` / `unresolved`) with no tie to the factories
or to `initialData`. It migrates as `liveValue(key, { schema: resolvableSchema(X), … })`. The
three `unresolved("not loaded")` `initialData` placeholders (`attempt-work`, `commits-graph`,
`edited-files`) are deleted: not loaded is `pending`. It does not interact with `useLiveRow`: `found: false`
means a row is not in a collection, while `resolved: false` is a value's settled answer with
a reason.

## 10. Hand-written keyed collections (non-tree)

"They have no filter columns" does not hold for most of them: the scoping param *is* a
column, and it becomes a filterable column. Where a list has none, `filterable: {}` is legal (every
column is optional in `LiveFilterable`).

| Key | Today | Becomes |
|---|---|---|
| `pushes-by-attempt` `{attemptId}` | fanOut | `liveCollection("pushes", filterable {attemptId}, sortable [createdAt])`; `useLive(pushes, { where: { attemptId } })`. It is also the future anchor for item 3's `attempts` edge (replacing the reader-less `pushes` array) |
| `conversation-summaries` `{conversationId}` | fanOut | collection, filterable `{conversationId, phase}`, sortable `[generatedAt]` |
| `prompt-block-tasks` `{blockId}` | fanOut | collection over `tasks_ext_prompt_block`, id `taskId`, filterable `{blockId}` |
| `mail-thread-messages` `{threadId}` | K/scoped | collection, filterable `{threadId}`, sortable `[internalDate]`. A thread longer than the limit pages with `loadMore` |
| `build.history` | K/full, top 50 | collection, default `startedAt desc` limit 50, `preload: "boot"` |
| `browser-bookmarks` | scopedMembership | collection, `filterable: {}`, sortable `[createdAt]` |
| `plugin-health-reviews` | scopedMembership | collection, filterable `{pluginId}` (the pane filters client-side today → `where`) |
| `deploy.server-health` | identity | collection, id `serverId`; map readers → `useLive(c)`, per-server → `useLiveRow` |
| `agent-notes-authors` `{blockId}` | fanOut, **composite PK** | param'd `liveValue` `{blockId}` → `Author[]`, `unbounded: { reason: "one card's authors — the conversations that wrote into one block" }`. Today's fanOut is already full-recompute-for-table, so this is parity |
| `todo-block-task` `{blockId}` | rowIdentity, 0/1 row | lookup-only collection over `page_blocks_ext_todo_task`, id `blockId`; `useLiveRow(todoTasks, blockId)` — `found: false` is "not linked" |
| `page-block-doc` `{blockId}` | rowIdentity, hand base64 | lookup-only collection over `page_block_docs`, id `blockId`; `state` travels as base64 through the `bytea` column's wire codec; `useLiveRow` |

**One-row tables are collections.** `todo-block-task` and `page-block-doc` hold 0 or 1 row
per block, and every mounted block subscribes to its own. They are rows of a table, so they
are collections read with `useLiveRow` (pending / found / doesn't exist), whose `:rows`
point routing already sends a change to row R only to R's subscribers. A value-side
`oneRow` routing option was rejected: it would re-create a second spelling of "subscribe to
one row of a table" beside `useLiveRow` (audit §8 I), and it breaks the values doc's "scope
policies stay collection-only". Two gaps in the collection API block this today. Both are
general, not written for these sites:

1. **The default window is optional.** Today `liveCollection` requires `sortable` and
   `default: { orderBy, limit }` even when nothing lists the collection. Without `default`
   (and then without `sortable` / `maxLimit`), the declaration mints only `${key}:rows`.
   `useLive(c, { ids })` and `useLiveRow(c, id)` work, and a list read (`useLive(c)` /
   `useLive(c, { where })`) is a tsc error, since the collection declares no order to list in.
   `serveCollection` registers only the point resource, and `preload` is `never` there (an id
   set has no default tuple).
   ```ts
   export const todoTasks = liveCollection("todo-block-task", { row: TodoTaskLinkSchema, id: "blockId", filterable: {} });
   ```
2. **A column's wire form belongs to its column type.** `serveCollection` copies columns
   straight to the row, so a `bytea` column cannot reach the browser, whose JSON wire needs
   base64. A column type may declare a wire codec (`withWire(bytea, { schema: base64String,
   encode: stateToBase64 })`, a helper in `database/sql-column`, which already owns decoded
   columns). `serveCollection` applies `encode` in JS to each projected row: never SQL
   `encode(…, 'base64')`, which folds lines at 76 chars. The row schema's field must be the
   codec's wire type (tsc). `collab-doc`'s `bytea` declares it once, so every bytea column
   gets it, and `page-block-doc`'s hand-written loader and `rowIdentity` are deleted.

The truly final shape of `todo-block-task` is a column contributed by the side table to the
blocks collection (the §9 joined-column open question). Blocks belong to the page tree (item 3), so that waits.

## 11. Migration order and proof sites (this change)

Each new option lands with the first real site that uses it (the phase-3 rule). The old
factories stay untouched.

1. `git-watcher.refHead` → `liveValue` + `serveValue` external, `throttleMs: 300`.
2. `build.deployment` → `recomputeOn: [refHeadServed]`, `revalidate`, `preload: "boot"`, `Resolvable` payload.
3. `edited-files` → `whileSubscribed` with `notify`, `load: "on-demand"`, `revalidate`.
4. `attempt-work` → the db arm with `recomputeOn` + `whileSubscribed` (eviction only). The hand-kept active set is deleted.
5. `prototypes.picks` → `useOptimisticResource(liveValue)`: pending arm, settled `mutate`.
6. `auth-state` → `origin: "central"` + `network/live/central` `serveValue`.
7. `todo-block-task` → a lookup-only collection (optional default window) + `useLiveRow`; `page-block-doc` → the same, plus the `bytea` wire codec.
8. `queue-ranks` → `liveCollection` (sortable `[rank]`) + optimistic `{ ids }` + client-requested acks; `ackChannel` deleted.

The rest of phase 3 (the other ~70 values, `plugin-changes`, `jobs-list`, the eight
collections in §10…) is mechanical against this contract and is not part of this change.

## Critical files

- `plugins/network/plugins/live/core/internal/live-value.ts` (origin), `server/internal/serve-value.ts` (throttleMs, recomputeOn, whileSubscribed, revalidate), `core/internal/live-collection.ts` + `server/internal/serve-collection.ts` (optional default window, wire codecs), new `shared/compile-value.ts`, new `central/index.ts`
- `plugins/database/plugins/sql-column` (`withWire`), `plugins/primitives/plugins/collab-doc/core/internal/bytea.ts` (its codec)
- `plugins/primitives/plugins/optimistic-mutation/web/internal/use-optimistic-resource.ts`
- `plugins/primitives/plugins/live-state/web/{notifications-client.ts,use-resource.ts}` (sub `acks`), `plugins/framework/plugins/resource-runtime/core/runtime.ts` (`broadcastAckOnly` per-subscriber gate; `whileSubscribed` pairing)
- `plugins/framework/plugins/tooling/plugins/resource-vocabulary`, `plugins/plugin-meta/plugins/facets/plugins/resources/facet/parse-resources.ts` (new options, the central barrel)
- The 8 proof sites above; `network/live/CLAUDE.md`; the Resources page's agent status card

## Verification

- `./equin test plugins/network/plugins/live plugins/primitives/plugins/optimistic-mutation plugins/primitives/plugins/live-state plugins/framework/plugins/resource-runtime` plus each proof site's plugin:
  - `serveValue`: `throttleMs` coalesces a burst into one load; bare `recomputeOn` reaches every subscribed tuple and no unsubscribed one; the mapped form reaches only the mapped tuple; `whileSubscribed` runs once per first sub, its stop runs once per last unsub, and a stop that arrives before an async start resolves runs after it; `@ts-expect-error` for `notify` on the db arm and for a central value passed to the worktree `serveValue`.
  - Collections: one without `default` mints only `:rows`; `useLive(c)` on it and `preload` on it are `@ts-expect-error`; a change to row R reaches only R's `useLiveRow`; a `bytea` column round-trips a >76-byte state as unfolded base64 byte-identical to `stateToBase64`, and a row schema typing it as bytes is `@ts-expect-error`.
  - Optimistic: pending until the first value (no `mutate` on that arm, tsc); ops after the settle confirm as today; an ack frame reaches only a subscription that asked.
- `./equin check` (type-check, resource-vocabulary, eager-tier-in-sync, keyed-resource-scope, plugins-doc-in-sync), then `./equin build`.
- E2E: deployment chip moves after a local commit (refHead → deployment); the edited-files pane updates on a save; a prototype option pick survives a reload; a queue reorder confirms (the sync cloud goes to saved); the auth accounts pane renders over the central socket; a collab block's edits sync across two tabs; linking a todo to a task shows the chip, and unlinking clears it.
- `get_runtime_profile`: no new flush stall; the `edited-files` 304 rate is unchanged.

## Result (2026-09-26)

Built as designed: the options, the central `serveValue`, lookup-only collections, the column wire codec, client-requested acks, and the optimistic value overloads. All 9 proof sites are migrated (`refHead`, `build.deployment`, `edited-files`, `attempt-work`, `auth-state`, `prototypes.picks`, `queue-ranks`, `todo-block-task`, `page-block-doc`). `centralResourceDescriptor` and the server `ackChannel` are deleted.

### Deviations

- **`whileSubscribed` pairing** lives in the adapter (`network/live/shared/compile-value.ts` `pairLifecycle`), on top of the runtime's own first/last-subscribe hooks. The runtime gains no new sub-path code.
- **Bare `recomputeOn`:**
  - On a param-less value it compiles to `map: () => [{}]`, so its one tuple still advances its version with no subscriber. A new runtime edge `toSubscribed` would skip that and wrongly answer a later resubscribe `up-to-date`.
  - Values with params use `toSubscribed` (`runtime.ts`). They keep the same pre-existing gap as the change feed.
- **A central value cannot be preloaded** (`preload?: never`): the boot snapshot runs in a worktree backend and cannot load a central key.
- **Acks:**
  - Every `sub` / `sub-batch` entry restates its tab's `acks` flag.
  - A new `op: "sub-acks"` frame toggles the flag on a subscription already held.
  - The client exposes `requestAcks` / `useResourceAcks`, and every optimistic reader calls it, including page-blocks' legacy form.
- **Optimistic hook:** the placeholder guards are kept, because a collection's `:rows` query still seeds `[]`.
- **Lookup-only collection:** `filterable` is `never` (not `{}`). `serveCollection` / `compileCollection` gain a lookup form returning only `rows`.
- **Wire codec:**
  - `withWire` lives in `sql-column/server`.
  - `bytea` and `stateToBase64` moved to `collab-doc/server`, because `core` cannot import `sql-column/server`.
  - `query-resource`'s window spec gained `encodeRow`.
  - The tsc check covers fields bound by name. A wire column used as a filter or as the id throws at load.
- **Resource vocabulary:** a mint can carry `requires: "default"`, so a lookup-only call lists only `:rows`.
- **Barrel moves:** `NotificationsClient` moved from `live-state/web` to `live-state/web/testing` (only a test uses it). `BlockDocRow` left `editor-collab/core`.
- **Not done:** the canvas's `select` on `prototypesResource` stays, because that resource is not migrated. `plugin-changes` and `commits-graph` only point at the new served values; their hand-kept sets go with their own migration.

### Verification

- **Tests:** bun 1279 pass / 1 fail; vitest 146 pass, with 1 file failing to import. Neither failure is in a file this change touches:
  - `canvas/web/internal/layout.test.ts > roomPerFrame`;
  - `instructions-view.test.tsx` (`import.meta.dir` is undefined under vitest).
- **`./equin build`:** checks passed (type-check included), and the app deployed.
- **Collaborative editing** (the proof for the August point-membership revert):
  - `crdt-multitab-agent-verify` 9/9;
  - `crdt-fanout-verify` 13/13 (the second context converges in 253 ms and no other block churns);
  - `crdt-offline-verify` 10/10;
  - `crdt-newblock-verify` 6/6;
  - `crdt-adjacent-surfaces-verify` 3/5 (its 2 known-failing assertions).
- **Contract checks:**
  - the accounts pane renders over the central socket, and the health row says central is connected;
  - new `canvas/e2e/canvas-picks-persist.ts` 6/6: the pick persists, and no stand-in shows at any frame;
  - new `queue/e2e/queue-reorder.ts` 11/11: the reorder confirms with no snap-back or divergence, and survives a reload;
  - todo dispatch 13/13, on a corrected temporary copy of `todo-dispatch-verify`, whose committed selectors are stale. Unlinking has no endpoint; `found: false` shows as the fresh-card state;
  - the deployment row shows "Up to date"; the edited-files and attempt-work chips render;
  - `bell-filter.ts` 24/24.
- **Logs:** no live-state errors, sub-errors, stalls or divergence. Slow-op noise: `auth-state` first load ~1 s over the central socket (×8, during cold e2e loads).
- **Follow-ups found:**
  - `notifications.unread` recomputes once per insert under bulk seeding (~16 no-op pushes/s). A `throttleMs` candidate from the previous commit.
  - Stale e2e scripts: `todo-dispatch-verify` selectors, `row-actions-overflow` (fails on main too), and `runs-surface` (5/21, `plugins/runs`, untouched here).
