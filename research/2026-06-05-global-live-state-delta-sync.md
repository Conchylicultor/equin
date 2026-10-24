# Live-state row-level delta sync — stop rebroadcasting whole lists on every change

## Context

The `tasks` (~2268 rows) and `attempts` (~2096 rows) live-state resources are
`mode: "push"`. On every cascade fire (`conversationsLive → attempts → tasks`,
triggered by the ≤1 Hz conversation poller and every conversation mutation) the
server reruns each loader and **rebroadcasts the entire row array** to every
connected tab. A single conversation status flip changes the derived status of
*one* attempt and *one* task, yet all rows are recomputed and re-sent.

This full-array fan-out is the named source of event-loop contention: the single
Bun thread `JSON.stringify`s a ~900 KB array once **per socket**, and when many
loaders fire at once everything queued behind it stalls — `[acquire]` (pool
checkout) and db spans balloon to ~340–390 ms even though each view itself
executes in ~20 ms warm.

This is **axis B**, the follow-up to the axis-A payload-trim + list/detail split
(`research/2026-06-05-tasks-list-detail-payload-split.md`, task
`task-1780657195387-se55nl`). Axis A dropped `description` from the list payload;
it did **not** change the all-rows-every-fire fan-out. A separate change added
`conversations(attempt_id, status)` / `attempts(task_id)` indexes to make the
view recompute itself cheap
(`research/2026-06-04-global-conversations-live-cascade-amplification.md`).

**Intended outcome:** a genuine status flip ships *one changed row*, not the
whole list — collapsing the WS serialization, client re-parse, and re-render
churn that drive the contention.

### Why a delta protocol (sync-engine survey)

Every modern incremental-sync engine separates row **identity** from list
**membership** and ships row-level `put`/`del` ops keyed by id, never whole
arrays:

- **Replicache** — client is a persistent key-value store; the server `pull`
  returns a `patch` of `{op:'put',key,value}|{op:'del',key}|{op:'clear'}`
  computed as the delta since the client's `cookie` (version cursor); a WS/SSE
  "poke" just says "pull again". Merge-by-key on the client.
- **Rocicorp Zero** — IVM: "hydrate once, then incrementally push diffs" against
  a streaming query pipeline fed by Postgres logical replication; syncs only the
  rows a query matches; client keeps a local store of recently-used rows.
- **ElectricSQL** — a "shape" is a partial replica (WHERE/columns subset); the
  server streams a "shape log" of insert/update/delete with monotonic offsets;
  client materializes the log; the offset gives resumability.
- **Normalized GraphQL caches (Apollo/Relay)** — normalize objects by
  `__typename:id`; lists hold references; a mutation/subscription returning one
  changed object updates just that normalized entry; lists referencing it
  re-render.

Common thread: a normalized id→row store, row-level put/del deltas, and a
monotonic version/offset cursor that guards ordering and enables resume. Our
design borrows exactly this shape, scoped to a single subscription per list (we
do **not** adopt an external engine — the live-state primitive is load-bearing
and used by every resource; we grow it a first-class, opt-in delta mode instead).

## Decision

- **Layer 1 (keyed delta wire protocol)** — build now. The resource still runs
  its full loader, but the server keeps a per-`(key,params)` snapshot, diffs the
  new result by row id, and broadcasts only changed rows + the id order. The
  client merges by id. Removes the fan-out / serialization / re-parse / re-render
  cost named in this task. Strictly additive and opt-in.
- **Layer 2 (scoped recompute)** — fully designed below as a documented
  follow-up; **do not build yet**. It recomputes only the affected rows in the
  DB (attacking the view-recompute cost) but needs a new cascade side-channel and
  changes to ~40 `notify()` call sites. Execute only if the profiler still shows
  DB contention after Layer 1. Layer 2 reuses Layer 1's snapshot + delta wire
  format unchanged, so Layer 1 is a strict prerequisite, not throwaway.

API direction: a **first-class opt-in mode** on the primitive
(`mode: "keyed"` + `keyOf`), so any array resource opts in with a ~two-line
change. `tasks` and `attempts` are the first adopters.

---

## Layer 1 — Keyed delta wire protocol (BUILD NOW)

### API surface

Add a third `ResourceMode`, not a separate factory — keyed mode is a *transport*
refinement of `push` (same DAG, same loader, same `notify`, same sub-lifecycle);
the only new input is a row-identity function.

Server — `plugins/framework/plugins/server-core/core/resources.ts`:
- `export type ResourceMode = "push" | "invalidate" | "keyed";`
- `ResourceDefinition<T,P>` gains `keyOf?: (row) => string`. Guard at
  `defineResource`: throw if `mode === "keyed"` and `keyOf` is missing. `T` must
  be an array type (the loader's first result confirms; throw if not an array).

Client — `plugins/primitives/plugins/live-state/core/resource.ts`:
- `ResourceDescriptor` gains `keyed?: true`.
- New constructor `keyedResourceDescriptor<T extends unknown[]>(key, schema, initialData)`
  mirroring `resourceDescriptor`, setting `keyed: true`. The client does **not**
  need `keyOf` (ids travel on the wire — see format). `schema` stays
  `z.array(Element)`, so `T` is unchanged and **`useResource` callers get the
  same `T[]` with no changes**.

Ordering: **the server sends order; the client preserves it.** The loader returns
rows in canonical SQL order (`ORDER BY rank, createdAt` for tasks; `createdAt`
for attempts). The delta carries an explicit `order: string[]` (the full ordered
id list) so the client never re-derives order (rank is a fractional-index string,
`createdAt` a coerced date — fragile to re-sort client-side). The id list is
small (~2268 short ids) next to full rows-with-nested-conversations.

### Wire format

Extend `ServerMsg` (the server literal in `flushNotifies` and the client union in
`notifications-client.ts:42-47`):

```ts
| { kind: "delta"; key; params; upserts: [string, unknown][]; deletes: string[]; order: string[]; version }
```

`upserts` are `[id, row]` tuples so the client never calls `keyOf` and the
server's id is authoritative. `sub-ack` and the HTTP fallback stay **full-value**
(`{ value, version }`) — first hydration is always a complete snapshot and is the
reconnect/SSR base.

### Server changes — `resources.ts`

- `RegistryEntry` gains `snapshots?: Map<pk, Map<id, hash>>` (allocated only for
  keyed entries). Store **hash per id only**, not rows — minimizes memory to
  ~2268 short strings per list; `upserts` come from the new value, `deletes` are
  stored-ids − new-ids.
- New `diffKeyed(entry, pk, value)` → `{ upserts, deletes, order, hadSnapshot }`.
  Serialize each new row to canonical JSON once and hash it (fast non-crypto hash
  over the JSON string, or compare the string directly). Compare against the
  stored `Map<id, hash>`: differing/new id → upsert; stored id absent from new →
  delete; `order` = new ids in order. Hashing ~2268 small rows **once per fire**
  replaces `JSON.stringify`-ing the full array **once per socket**.
- `flushNotifies` keyed arm (parallel to the `push` arm at **lines 322-330**):
  after computing `value`, call `diffKeyed`. If `!hadSnapshot` (first notify for
  this pk), send a full `{ kind:"update", value, version }` like push mode and
  populate the snapshot. Else broadcast `{ kind:"delta", … }` to each sub. Update
  the snapshot **only after** a successful diff; the existing `try/catch …
  continue` at line 313 already skips send+cascade on loader failure, leaving the
  snapshot untouched (no corruption).
- `handleSub` (**lines 444-455**): unchanged shape — still sends a full
  `sub-ack` — but must **also populate the snapshot** for this pk so the next
  notify can diff. (Two sockets → two equivalent sub-acks; the per-pk snapshot is
  shared and idempotent.)
- Snapshot eviction in `releaseSubRefcount` (**~line 479**, the N→0 transition):
  `entry.snapshots?.delete(pk)`. Re-subscribe re-hydrates via full sub-ack and
  rebuilds the snapshot. Bounds memory to actively-observed pks.

### Client changes — `notifications-client.ts`

- Add `"delta"` to `ServerMsg` and a branch in `handleServerMessage` (~line 217)
  → `applyDelta`.
- `applyUpdate` stays the full-replace path (sub-ack, full re-hydrate, first-notify
  full send) — unchanged, still runs for keyed resources on sub-ack.
- New `applyDelta(channel, key, params, upserts, deletes, order, version)`:
  - **Version guard** identical to `applyUpdate` (drop if `version <= entry.version`).
  - **Base-presence guard (load-bearing):** if `queryClient.getQueryData(queryKey)`
    is `undefined` (no base yet), drop the delta and re-`sendSub` to force a fresh
    full snapshot. Prevents applying a delta to a missing base.
  - **Per-row parse:** parse each upsert row via `schema.element` (Zod array
    schemas expose `.element`). Do **not** re-parse the whole array — that's the
    cost we remove.
  - **Merge:** `setQueryData(queryKey, (prev) => order.map(id =>
    upsertMap.get(id) ?? existingById.get(id)))`, dropping `deletes`. Unchanged
    rows keep their **identical object reference**, so memoized row components
    don't re-render (the re-render-churn win). The new array reference makes
    TanStack re-render the list container only.

### Edge cases

- **Empty list / full clear:** first sub-ack `value: []`; a clear yields
  `deletes` = all ids, empty `upserts`/`order` → client merges to `[]`.
- **Identity stable, content changed** (the status-flip case): id in both, hash
  differs → **upsert** (not del+insert). One-row delta.
- **Nested `conversations` array in attempt rows:** the per-row hash is over the
  row's full canonical JSON, which serializes nested conversations — a child
  conversation status change changes the parent attempt's hash → one-row upsert.
  No special-casing.
- **`conversationsLiveResource` is an OBJECT** (`{active, recentGone, …}`), not an
  array — keyed mode applies **only to the two array resources** (`attempts`,
  `tasks`). `conversations` stays plain `push`; the cascade is unaffected.
  Document: keyed mode requires an array payload.
- **HTTP fallback** (`GET /api/resources/:key`) stays full `{value, version}`;
  `useResource`/`useSuspenseResource` parse the full array via `schema.parse`.
  Unchanged (WS-down path, not hot).

### Versioning / reconnect consistency

The monotonic per-`(key,pk)` `version` is unchanged and authoritative. A base is
established by `sub-ack`/`update` at version V; subsequent deltas are V+1, V+2…;
the client's version guard enforces in-order application and drops stale/dupes.
On reconnect / leader handoff, `replaySubs` (line 190) resets `sub.version = 0`
and re-subscribes → server replies with a fresh full `sub-ack` → client
full-replaces. **Deltas can never apply to a stale/missing base** because (a) the
first message after reconnect is always a full sub-ack, (b) the server snapshot
was evicted on disconnect and rebuilt at sub-ack, and (c) the `applyDelta`
base-presence guard drops any orphan delta. Server restart resets versions
in-memory; the existing `version=0` reset already tolerates a lower version.

### Backward compatibility

Opt-in: `push`/`invalidate` arms untouched; all other resources and consumers
unchanged. Migrating a resource = `mode: "push"` → `mode: "keyed"`, add
`keyOf: (r) => r.id`, switch the client descriptor to `keyedResourceDescriptor`.
The ~40 bare `notify()` call sites are untouched. `useResource` callers of
`tasksResource`/`attemptsResource` need **no changes** (still `T[]`).

### Files to modify (Layer 1, ordered)

1. `plugins/framework/plugins/server-core/core/resources.ts` — `ResourceMode +=
   "keyed"`; `ResourceDefinition.keyOf`; `defineResource` guard;
   `RegistryEntry.snapshots`; `diffKeyed` helper; `flushNotifies` keyed arm
   (~322-330); `handleSub` snapshot populate (~444-455); eviction in
   `releaseSubRefcount` (~479).
2. `plugins/primitives/plugins/live-state/core/resource.ts` — `keyed?: true` on
   `ResourceDescriptor`; `keyedResourceDescriptor` constructor.
3. `plugins/primitives/plugins/live-state/web/index.ts` — export
   `keyedResourceDescriptor`.
4. `plugins/primitives/plugins/live-state/web/notifications-client.ts` —
   `ServerMsg += delta`; `handleServerMessage` branch; `applyDelta` (per-row
   `schema.element` parse, merge-by-id via `order`, base-presence guard).
5. `plugins/tasks-core/server/internal/resources.ts` — flip `attemptsResource`
   and `tasksResource` to `mode: "keyed"`, add `keyOf: (r) => r.id`.
6. `plugins/tasks/core/resources.ts` — switch the `tasks` (line 30) and
   `attempts` (line 36) descriptors to `keyedResourceDescriptor`.

`use-resource.ts` needs **no change**. Update the live-state `CLAUDE.md` +
autogen facets and run `plugins-doc-in-sync`.

Reuse: existing `paramsKey`, `subscribersFor`, `versions`, `sendJson`,
`reportServerError` on the server; existing `queryKeyFor`, `schemas` map,
`SharedWebSocket` replay on the client.

---

## Layer 2 — Scoped recompute (DESIGNED; DEFERRED)

Goal: stop running the *full* `tasks_v`/`attempts_v` query on every fire —
recompute only the affected rows. This is the only lever that reduces the DB
view-recompute cost the cascade doc calls dominant.

**Why `dependsOn.map` is the wrong channel.** The list resources are
parameterless (`params` always `{}`); `map` returns downstream *params*, and an
id can't ride in params without fragmenting the subscription/version space (every
tab subscribes to `tasks` with `{}`, not `tasks?id=X`). Layer 2 needs a
**separate affected-ids side-channel** through the cascade:

- `notify(params, { affectedIds })`; `pendingNotifies` accumulates an id-set per
  pk (union across coalesced notifies in a flush).
- A loader variant `loader(params, { affectedIds })` that does `… WHERE id IN
  (…)` and returns only those rows. The cascade edge maps upstream affected ids
  to downstream affected ids (conversation → its `attempt_id` → that attempt's
  `task_id`) — itself a small indexed lookup.
- The server diffs the scoped rows into the existing snapshot, treating
  **un-returned ids as unchanged, not deleted** — so the keyed diff needs a
  "partial result" flag distinguishing scoped from full loads. This is the main
  new complexity and the reason it's a distinct path.

**Why deferred.** ~40 bare `notify()` sites (e.g. `notifyConversationsChanged`
from a dozen exit/resume/close handlers) know only "something changed," not which
ids; without ids the scoped loader degrades to a full recompute. Wiring ids
through is broad and touches many plugins. The cheaper DB lever (the
`conversations(attempt_id,status)` / `attempts(task_id)` indexes) already exists
and helps the full query too. Build Layer 2 only if, after Layer 1, the profiler
still shows DB/`[acquire]` contention under load.

**Composability.** Layer 2 emits the same `delta` wire message and reuses the
Layer 1 snapshot, so nothing in Layer 1 is wasted.

---

## Verification

1. `./equin build` from this worktree.
2. **Fan-out shrank (the win):** open 3+ tabs on the tasks list
   (`http://<worktree>.localhost:9000`), flip one conversation's status, and in
   the browser WS-frame inspector confirm the frame is a one-row upsert +
   id list — **not** the full array. Confirm all tabs converge.
3. **No re-render churn:** with a render counter / React DevTools highlight,
   confirm only the changed row's component re-renders (unchanged rows keep
   object identity), not the whole list.
4. **Profiler before/after** (`mcp__singularity__get_runtime_profile`, reset via
   `POST /api/debug/profiling/runtime/reset`): drive a burst of conversation
   flips. Expect WS send-side time and client parse to collapse. Layer 1 leaves
   `loader`/db spans ~unchanged (full query still runs) — if `[acquire]`/db still
   balloon to ~340–390 ms under burst, that quantifies whether Layer 2 is
   warranted.
5. **Reconnect correctness:** restart the backend / close the leader tab to force
   handoff; confirm each tab re-subs, gets a full sub-ack, and the cache is intact
   (no stale/orphaned rows from a delta on a missing base).
6. **Edge fuzz:** add / delete / drag-reorder (rank) / drop-all tasks and an
   empty-list start; after each, assert the client array equals a fresh
   `GET /api/resources/tasks` full refetch.
7. **Checks:** `./equin check` passes (`eslint`, plugin-boundaries,
   `plugins-doc-in-sync`).
