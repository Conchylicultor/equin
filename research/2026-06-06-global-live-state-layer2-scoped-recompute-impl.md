# Live-state Layer 2 (scoped recompute) — implementation plan

## Context

The gate passed. Measurement (`research/2026-06-06-global-live-state-layer2-scoped-recompute-gate.md`,
Results) showed that after Layer 1 (keyed delta wire protocol) the DB `[acquire]`
pool-checkout wait **still balloons** under a concurrent cascade burst —
**393 ms** (multi-wave) up to **2382 ms** (full `tasks` view in the recompute
set) at 2316 tasks / 2146 attempts — attributed directly to the cascade loaders
`loader:conversations` / `loader:attempts` / `loader:tasks`. SQL *execution* is
modest (≤~106 ms warm); the cost is concurrent fires each re-acquiring a pool
connection and recomputing the **full** `tasks_v` / `attempts_v` view, then
queueing on the limited pool. Layer 1 shrank the wire payload but not the DB
recompute.

**This plan implements Layer 2 / scoped recompute, hot-path-only.** A conversation
status flip affects exactly one attempt and one task; only those rows are
recomputed (`WHERE id IN (…)`) and diffed, instead of all ~2300. The high-frequency
content-only cascade (the conversation poller + `insertPush`) opts in; every
membership-changing site (create/delete/reorder) stays on today's full-recompute
path, which remains the authoritative self-healer.

**Intended outcome:** a single status flip recomputes ~1 task + ~1 attempt row,
collapsing the per-fire DB work and the pool contention it drives — while the
wire format, client, and all non-opted-in callers are untouched.

### Design invariants (why this is safe)
- **Server-only.** Layer 1's wire format already carries a content-only delta as
  `{kind:"delta", upserts, deletes:[], order:undefined}`. A scoped diff emits
  exactly that shape — **the client needs zero changes.**
- **Opt-in.** Plain `notify()` / `notify(params)` keeps full-recompute semantics
  (today's behavior, correct for membership changes). Only `notify(params, {
  affectedIds })` scopes.
- **Sticky FULL.** If any contributor to a flush is id-less (or an edge can't map
  ids), the pk degrades to FULL. Scoping never silently drops a membership change.
- **Self-heal.** A missed scoped change is corrected by the next FULL notify (any
  membership op) or a resub (full sub-ack reseeds the snapshot). Drift is bounded,
  never permanent.

---

## Part A — primitive: `plugins/framework/plugins/server-core/core/resources.ts`

### A1. `notify` + the pending accumulator (lines ~82-83, ~105, ~199-201, ~301-307)
- Public API: `notify(params?: P, opts?: { affectedIds?: string[] }): void`.
- Replace `RegistryEntry.pendingNotifies: Map<string, ResourceParams>` (line 105) with:
  ```ts
  interface PendingNotify {
    params: ResourceParams;
    affected: Set<string> | null; // null = FULL (sticky, absorbing)
  }
  // pendingNotifies: Map<string, PendingNotify>
  ```
- Add `mergePending(map, pk, params, incoming: Set<string> | null)`:
  - no existing → set `{ params, affected: incoming === null ? null : new Set(incoming) }`
  - existing FULL → return (FULL absorbs everything)
  - incoming null → set existing FULL
  - else → union incoming into existing set
- `scheduleNotify(entry, params, affected)` calls `mergePending(...)` then the
  unchanged flush-scheduling tail. `notify` maps `opts?.affectedIds` →
  `new Set(...)` or `null`. `withNotifyBatch` reads only `.size` — no change.

### A2. Loader ctx (lines ~39-74 type, ~123-125 `timedLoad`)
- `ResourceDefinition.loader: (params: P, ctx?: { affectedIds: readonly string[] }) => Promise<T> | T`.
- `timedLoad(entry, params, ctx?)` passes `ctx` through to `entry.loader`.
- Full loads (sub-ack, handleSub) pass `ctx = undefined` → existing behavior.

### A3. Partial diff `diffKeyedScoped(entry, pk, scopedRows)` (alongside `diffKeyed`, ~348-386)
```ts
// Precondition: snapshot for pk exists (scoped path only entered when hadSnapshot).
const snap = entry.snapshots!.get(pk)!;
const upserts: [string, unknown][] = [];
for (const row of scopedRows) {
  const id = entry.keyOf!(row);
  const hash = JSON.stringify(row);
  if (snap.get(id) !== hash) { upserts.push([id, row]); snap.set(id, hash); } // MERGE, not replace
}
return { upserts }; // deletes:[] order:undefined are constants at the call site
```
- Un-returned affected ids = left intact in snapshot (no upsert). A concurrently
  deleted row is corrected by the delete site's own FULL notify → real `delete`.

### A4. Cascade `affectedMap` (DependsOnEntry ~29-37, DownstreamEdge ~85-88, flush ~459-483)
- Add `affectedMap?: (upstreamAffected: ReadonlySet<string>, upstreamParams: P) => Promise<string[]> | string[]` to `DependsOnEntry`; carry onto `DownstreamEdge`.
- In the cascade arm, compute the downstream affected set per edge:
  ```ts
  let downAffected: Set<string> | null;
  if (pending.affected === null) downAffected = null;        // upstream FULL ⇒ FULL
  else if (!edge.affectedMap)    downAffected = null;        // no mapping ⇒ FULL
  else {
    try { downAffected = new Set(await edge.affectedMap(pending.affected, params)); }
    catch (err) { reportServerError(...); downAffected = null; } // fail safe to FULL
  }
  for (const dp of derived) mergePending(down.pendingNotifies, paramsKey(dp), dp, downAffected);
  ```
- **`affectedMap` must NOT force `needValue`** (it self-queries the DB; forcing the
  upstream value reintroduces the full load we're removing). Keep
  `hasValueAwareDownstream` keyed on `edge.map` only (line ~409-411).
- Non-keyed upstreams (`conversationsLive` = push OBJECT, `pushes` = push array)
  carry `affected` purely as a cascade side-channel — it lives on the pending
  entry, not the snapshot, so their own send path ignores it.

### A5. flushNotifies keyed arm (lines ~399-457)
```ts
const pending = ...; // PendingNotify
let scoped = pending.affected !== null;
if (scoped && pending.affected.size === 0) continue;        // nothing changed → skip send
// version bump unchanged (401-402)
const ctx = scoped ? { affectedIds: [...pending.affected] } : undefined;
const value = await timedLoad(entry, params, ctx);          // try/catch/continue unchanged
if (entry.mode === "keyed" && subs.length > 0) {
  const hadSnapshot = entry.snapshots?.has(pk) ?? false;
  if (scoped && !hadSnapshot) {                             // near-unreachable: subbed pk always has snapshot
    const full = await timedLoad(entry, params, undefined); // reload full; scoped value is partial, unsafe for diffKeyed
    const d = diffKeyed(entry, pk, full); sendUpdate/sendDelta(...);
  } else if (scoped) {
    const { upserts } = diffKeyedScoped(entry, pk, value as unknown[]);
    if (upserts.length) sendDelta(subs, { upserts, deletes: [], order: undefined, version });
  } else {
    const d = diffKeyed(entry, pk, value);                  // FULL path == today
    if (!d.hadSnapshot) sendUpdate(...) else sendDelta(..., d.upserts, d.deletes, d.order);
  }
}
```
- Cascade arm value passed to `edge.map` stays `valueComputed ? value : undefined`.
  All three edges here use the default identity map (no `map`) → none read the
  value, so the partial-value-under-scoping caveat doesn't bite. Document the
  constraint for any future value-reading `map`.
- Version bump, try/catch/continue, base-presence (`!hadSnapshot` → full `update`),
  eviction in `releaseSubRefcount`, `handleSub` snapshot seeding — all unchanged.

---

## Part B — resources: `plugins/tasks-core/server/internal/resources.ts`

### B1. `attemptsResource` loader (lines ~65-88) — scoped branch
```ts
loader: async (_params, ctx) => {
  const ids = ctx?.affectedIds;
  const [attemptRows, convRows] = await Promise.all([
    ids ? db.select().from(attempts).where(inArray(attempts.id, ids)).orderBy(asc(attempts.createdAt))
        : db.select().from(attempts).orderBy(asc(attempts.createdAt)),
    listConversationSummariesByAttempt(ids),   // add optional attemptIds filter
  ]);
  // identical byAttempt assembly
}
```
- `listConversationSummariesByAttempt(attemptIds?)` (`queries/conversations.ts:~112`)
  gains an optional `inArray(conversations.attemptId, attemptIds)` filter.

### B2. `tasksResource` loader (lines ~101-121) — scoped branch
```ts
loader: async (_params, ctx) => {
  const sel = db.select({ /* same 14 cols, no description */ }).from(tasks);
  const scoped = ctx?.affectedIds ? sel.where(inArray(tasks.id, ctx.affectedIds)) : sel;
  return scoped.orderBy(asc(tasks.rank), asc(tasks.createdAt)) as ...;
}
```

### B3. Edge `affectedMap`s
- `conversationsLive → attempts` (attemptsResource `dependsOn[0]`):
  `affectedMap(convIds) =` `SELECT DISTINCT attempt_id FROM conversations_v WHERE id IN (convIds)`
  (`conversations_v` already carries `attemptId`/`taskId`; index `conversations_attempt_id_status_idx`).
- `pushes → attempts` (attemptsResource `dependsOn[1]`): identity — `(ids) => [...ids]`
  (insertPush passes `[attemptId]` as the pushes affectedIds).
- `attempts → tasks` (tasksResource `dependsOn[0]`):
  `affectedMap(attemptIds) =` `SELECT DISTINCT task_id FROM attempts WHERE id IN (attemptIds)`
  (index `attempts_task_id_idx`).

---

## Part C — opt-in call sites

### C1. Poller — `plugins/conversations/server/internal/poller.ts` (tick ~76-251)
- Replace the boolean `changed` with `const changedIds = new Set<string>()` and a
  separate `let adoptedAny = false`.
- Every per-conversation mutation in the loop adds its id: working-flip (~126),
  snapshot-removal (~129), updateConversation (~187), markConversationGone/Closed
  (~146-148), sweep-orphaned (~245-247). **adopt-orphan (~106)** changes
  attempt/task membership → set `adoptedAny = true` (do NOT scope).
- Final call (~250):
  ```ts
  if (adoptedAny) notifyConversationsChanged();              // FULL
  else if (changedIds.size) notifyConversationsChanged([...changedIds]); // scoped
  ```

### C2. `plugins/tasks-core/server/internal/notify-conversations.ts`
```ts
export function notifyConversationsChanged(affectedIds?: string[]): void {
  conversationsLiveResource.notify(undefined, affectedIds ? { affectedIds } : undefined);
}
```

### C3. `insertPush` — `plugins/tasks-core/server/internal/mutations/pushes.ts` (~37-38)
- It already has `attemptId` (input) and `taskId` (resolved ~28). Scope both notifies:
  `pushesResource.notify(u, { affectedIds: [attemptId] })` and
  `attemptsResource.notify(u, { affectedIds: [attemptId] })`.

### C4. STAY FULL (call `notify()` with no ids — unchanged)
createTask, deleteTask, dropTaskTree, backfillMetaParent (`mutations/tasks.ts`);
createAttempt, deleteAttempt (`mutations/attempts.ts`); adoptOrphanConversation
and `cross-table.ts`; sweep-orphaned-attempts; addTaskDependency /
removeTaskDependency (proven scopeable to `{taskId}` but rare → keep FULL, not
worth the subtle reasoning).

---

## Correctness notes
- **Reorder (rank) must be FULL.** `order` is omitted on a scoped delta, so a rank
  change shipped scoped would never reach client ordering. Confirmed no
  content-path site (poller / insertPush) writes `rank` — only create/reorder
  mutations do, all in the FULL set.
- **Dependency-derived fields.** A task's `has_blocking_dep` / `dependencies`
  depend only on rows where `td.task_id = T`, so a dep change touches only T's row
  — but we keep dep mutations FULL anyway (rare).
- **Empty mapping.** A changed conversation that maps to no attempt (system/meta
  conv, or attempt already gone) yields an empty downstream set → flush skips the
  send (no pointless empty delta / version bump).

## Out of scope / residual
The measurement also attributed contention to **`loader:conversations`**.
`conversationsLiveResource` is a push **object** payload (`{active, recentGone,
…}`), not a keyed array, so the `affectedIds` partial-diff doesn't apply to it; it
keeps running its full 4-query loader whenever `conversations` itself has
subscribers. Scoping it would need a different (object-shaped) mechanism and is
**not** part of this plan. Layer 2 here targets the `attempts`/`tasks` keyed
recompute, which is the dominant cost (run A: `loader:tasks` 2382 ms). Note the
conversations residual as a possible follow-up; re-measure after this lands to
quantify it.

---

## Implementation order
1. `resources.ts` (primitive): `PendingNotify` + `mergePending` + `notify`/`scheduleNotify` (A1); loader `ctx` + `timedLoad` (A2); `diffKeyedScoped` (A3); `affectedMap` on edge types + cascade computation, not forcing `needValue` (A4); flush keyed arm (A5). No behavior change until a caller opts in.
2. `tasks-core/.../resources.ts`: scoped loader branches (B1, B2) + the three `affectedMap`s (B3); `queries/conversations.ts` optional `attemptIds`.
3. `notify-conversations.ts` (C2) + `mutations/pushes.ts` (C3).
4. `poller.ts` (C1).
5. `./equin build`; update live-state `CLAUDE.md` + autogen facets; run `plugins-doc-in-sync`.

## Verification
1. **Build:** `./equin build` from the worktree; `./equin check` green
   (eslint, plugin-boundaries, plugins-doc-in-sync).
2. **One-row delta (the win):** 3+ tabs on the tasks list; flip one conversation's
   status; in the WS-frame inspector confirm the frame is a one-row upsert with
   `deletes:[]`, `order` absent — not the full array. All tabs converge.
3. **Profiler before/after** — reuse the gate harness
   (`research/2026-06-06-…-gate.md`): the throwaway `cascade-burst` lever drove
   FULL fires; for Layer 2, add a scoped variant (pass a real conversation id as
   `affectedIds`) and confirm `loader:attempts`/`loader:tasks` `maxMs` and the
   `db [acquire]` wait collapse vs the FULL burst (the 393 ms / 2382 ms baseline).
   `attempts_v`/`tasks_v` execution should drop to ~1-row cost.
4. **Membership still correct (FULL path intact):** create / delete / drag-reorder
   (rank) / drop-all tasks + an empty-list start; after each, assert the client
   array equals a fresh `GET /api/resources/tasks` full refetch (no stale/orphan
   rows, correct order).
5. **Self-heal / reconnect:** restart the backend / close the leader tab to force
   handoff; confirm each tab re-subs, gets a full sub-ack, and the cache is intact.
6. **Sticky-FULL coalescing:** in one tick, interleave a scoped status flip with a
   membership change (e.g. delete a task) → the flush must run FULL and emit the
   real delete, not a scoped no-op.

## Critical files
- `plugins/framework/plugins/server-core/core/resources.ts` — primitive (A1-A5).
- `plugins/tasks-core/server/internal/resources.ts` — scoped loaders + `affectedMap` (B).
- `plugins/tasks-core/server/internal/queries/conversations.ts` — optional `attemptIds` filter.
- `plugins/tasks-core/server/internal/notify-conversations.ts` — optional `affectedIds` (C2).
- `plugins/tasks-core/server/internal/mutations/pushes.ts` — scope insertPush notifies (C3).
- `plugins/conversations/server/internal/poller.ts` — `changedIds` set + `adoptedAny` (C1).
