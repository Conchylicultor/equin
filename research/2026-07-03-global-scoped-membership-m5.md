# A1 M5 — Opt-in scoped membership (`scopedMembership`) for keyed resources

> Status: approved plan (implementation). Track 1 M5 of
> [2026-07-02-global-comms-structural-fixes.md](./2026-07-02-global-comms-structural-fixes.md)
> — the only milestone touching `resource-runtime`/`keyed-diff`. 5a (DELETE)
> ships before 5b (INSERT); default-off is byte-identical to today.

## Context

Row-level membership changes (INSERT/DELETE) on keyed resources unconditionally
FULL-recompute today: `applyDbChange` hard-codes `scopable = op === "U"`
(`runtime.ts:2336`), so even a plain table scan re-runs its whole loader when
one row is inserted or deleted. Worse, the exploration surfaced a second,
compounding fact: the conversation scans (`conversations-active`,
`conversations-system`) are `bootCritical` → L2-persisted → `drainEntry`
forces **every** recompute of them to FULL (`scoped = affected !== null &&
!persisted`, `runtime.ts:1594`) — the existing Layer-2 scoped-update path is
dead for them since L2 persistence landed. M5 therefore must both add
membership scoping AND make the persisted path compatible with it, or enabling
it "on the conversation scans" (the milestone's stated target) delivers
nothing.

Two wire-contract facts shape the design (verified in
`keyed-delta-merge.ts` / `notifications-client.ts:965`):

- The client rebuilds a keyed array **purely from `order`**; the `deletes`
  field is informational. So any membership-changing delta MUST ship the full
  `order` array. "DELETE ships `{deletes:[id]}` with no loader run" from the
  super-plan is realized as: deletes + `order = prevOrder − deleted` — the
  order comes free from the in-memory snapshot, still **zero DB queries**.
- An `order` id resolvable from neither upserts nor the client's base forces a
  drift-resub. The INSERT path's ids-only order query races the refill, so its
  result is sanitized to known ids (unknown ids are dropped; their own pending
  feed event delivers them).

The change-feed already captures pk ids for ALL ops (statement triggers with
transition tables: `new_rows` for I/U, `old_rows` for D) and `route-change.ts`
forwards op+ids scoped through the identity-view fan-out — so no DB/trigger
changes are needed.

## Design

### Opt-in surface

New field on the keyed two-arg `defineResource` server options (and
`RegistryEntry`):

```ts
scopedMembership?: {
  /** Ids-only ordered membership query: the full ORDER BY'd id list for params. */
  orderOf: (params: P) => Promise<string[]>;
};
```

- Requires `mode: "keyed"` + `identityTable` (loud throw with `recompute:full`
  or non-keyed). Unreachable from the flat `DefineResourceInput` form.
- `orderOf` is an injected closure — `resource-runtime` stays drizzle-free.
- Absent ⇒ byte-identical to today (all existing tests must pass unchanged).

The opt-in also changes **UPDATE** semantics for opted-in resources into
"membership-aware": a scoped refill that fails to return a requested id which
is in the snapshot is a membership **exit** (mutable-`where` flip or concurrent
delete → shipped as delete+order), and a refill row NOT in the snapshot is a
membership **entry** (where-flip false→true → placed via `orderOf`). This is
what makes the mutable-`where` rule (query-resource CLAUDE.md) relaxable and
the conversation scans (`where active = true`, `active` mutable) sound under
scoping.

### Pending pipeline

`PendingNotify` gains one optional field; `affected` keeps its exact meaning
(refill set = U ∪ I ids; `null` = sticky FULL):

```ts
interface PendingNotify {
  params: ResourceParams;
  affected: Set<string> | null; // refill ids (U ∪ I); null = FULL (sticky)
  deleted?: Set<string>;        // op-D ids — only ever set for scopedMembership entries
  enqueuedAt: number;
}
```

`mergePending` rules (FULL stays absorbing, incl. dropping `deleted`):

| existing        | incoming affected | incoming deleted | result |
|-----------------|-------------------|------------------|--------|
| none            | null              | —                | FULL   |
| none            | Set A             | Set D            | copy both |
| FULL            | anything          | anything         | unchanged (absorbs) |
| scoped          | null              | —                | degrade FULL, drop deleted |
| scoped          | Set A             | Set D            | union both |

`applyDbChange` own-identity branch becomes op-aware, gated on
`entry.scopedMembership`:

- `U`: unchanged (`ids → affected`).
- `I`: with scopedMembership + ids → `affected = ids`; else FULL (today).
- `D`: with scopedMembership + ids → `affected = ∅, deleted = ids`; else FULL.

Edge-covered `continue` and uncovered-FULL branches unchanged. Non-opted
entries: byte-identical.

### Pure diff core — `diffKeyedScopedMembership` (keyed-diff.ts)

```ts
diffKeyedScopedMembership(prev, refillRows, { requestedIds, deletedIds, orderedIds? }, keyOf)
  → { upserts, deletes, order, nextSnapshot }
```

1. Merge refill rows into a copy of `prev` (changed/new → upserts).
2. Exits = `(requestedIds ∪ deletedIds) ∩ prev` minus refill-returned ids →
   removed from snapshot, listed in `deletes`.
3. Entered = refill ids not in `prev`. No entries and no deletes → Case A:
   `{upserts, deletes: [], order: undefined}` (identical shape to
   `diffKeyedScoped`).
4. Membership changed: order source = prior snapshot order minus exits (no
   entries ⇒ no `orderOf` run), else the caller-provided `orderedIds`.
   Reconcile: `finalOrder = orderSource.filter(id => merged.has(id))`; rebuild
   `nextSnapshot` FROM `finalOrder` so snapshot ≡ wire order; filter upserts to
   surviving ids. Unknown `orderedIds` ids drop out (no client drift);
   snapshot ids missing from `orderedIds` (concurrent delete) drop out — their
   own feed event becomes a no-op.

Edge cases (all covered by tests): insert-then-delete of a brand-new id →
no-op; delete-then-reinsert of an existing id → plain upsert; update
entering/exiting membership; requested id in neither snapshot nor refill
(insert filtered by `where`) → no-op; pure DELETE → zero queries.

### drainEntry restructure

Per pending entry, for `sm = entry.scopedMembership`:

1. `sm` absent → **today's code, untouched** (persisted-FULL, scoped, FULL).
2. `sm` present, `affected === null` (sticky FULL) → FULL loader +
   `diffKeyedFull`, **and seed/replace the snapshot even with zero subs** (so
   the next membership merge has a base), persist if persisted.
3. `sm` present, scoped, **no snapshot** → degrade to (2) — first post-boot
   change, eviction, near-unreachable races.
4. `sm` present, scoped, snapshot exists → the membership path:
   - Skip (no version bump) only when `requestedIds` and `deletedIds` are both
     empty.
   - Persisted: capture watermark **before** any read.
   - `refillRows = requestedIds.size ? loader(params, {affectedIds}) : []`
     (pure-DELETE ⇒ **no loader run** — 5a).
   - `entered = refillIds − snapshot` non-empty ⇒ `orderedIds = await
     sm.orderOf(params)` (5b's ids-only query); else undefined.
   - `diffKeyedScopedMembership(...)` → store `nextSnapshot`.
   - Persisted: reconstruct `full = finalOrder.map(id =>
     JSON.parse(nextSnapshot.get(id)))` and `persistSnapshot(key, pk, full,
     watermark, readSet)`. Byte-identical jsonb to a FULL persist
     (`JSON.stringify∘JSON.parse` round-trip of canonical row JSON).
   - Send `delta {upserts, deletes, order, version}` when non-empty; `order`
     present iff membership changed. Loader/`orderOf` throw → fall back to (2).
   - Downstream cascade: `deletedIds` non-empty → FULL (an `affectedMap`
     cannot translate a vanished row) + clear `edge.lastSignatures`; else
     cascade `requestedIds` through the existing signature/affectedMap gate
     (rows exist — incl. where-flip exits — so translation works).

Snapshot eviction (`releaseSubRefcount`): keep the snapshot across N→0 for
**persisted scopedMembership** entries (they recompute on every change
regardless of subs and need the base). Bounded to opted-in resources.

### Persisted reconstruction soundness

- Watermark captured before the refill/orderOf reads ⇒ catch-up's
  `xid >= floor` predicate cannot under-replay; over-replay is idempotent.
- The snapshot is membership-complete by the opt-in's definition: the feed
  delivers every I/U/D on the identity table scoped through the own-identity
  path; missed invalidations are structurally impossible (change-feed L4).
- Catch-up needs **no changes**: replayed I routes through the same membership
  path (or degrades to FULL with no snapshot); replayed D maps to FULL today —
  safe, just unoptimized.
- Behavioral change to document: a persisted scopedMembership entry no longer
  FULL-recomputes per change; it re-anchors to FULL on boot, sticky-FULL, or
  any fresh sub-ack (which overwrites the snapshot from a full load).

### Compiler (query-resource)

`QueryResourceSpec.scopedMembership?: true`:

- Throws (module eval) when combined with `limit` or `recompute` — a windowed
  read cannot membership-scope.
- Derives `orderOf` = `db.select({ [keyField]: pkColumn }).from(rel)
  [.where][.orderBy]` → `rows.map(r => String(r[keyField]))` — same `QueryDb`
  seam as the loader (fake-db unit-testable).
- Emits `scopedMembership: { orderOf }` into `serverOpts`.
- The mutable-`where` RULE is relaxed for scopedMembership resources (a
  where-flip becomes a detected exit/entry).

### Enablement — the conversation scans

Migrate `conversations-active` / `conversations-system` to fully-declarative
`queryResource` (same pattern as `tasksResource`; same exported names; the
`attempts` `rel()` edge and definition order are untouched):

```ts
// core/resources.ts: keyedResourceDescriptor → queryResourceDescriptor (ConversationSchema, "id", { bootCritical: true })
// server/internal/resources.ts:
queryResource(conversationsActiveDescriptor, {
  from: conversations,                       // conversations_v (1:1 view)
  identity: { table: "conversations", pk: conversations.id },
  where: and(eq(conversations.active, true), ne(conversations.kind, "system")),
  orderBy: desc(conversations.createdAt),    // immutable column → stable order
  scopedMembership: true,
  debounceMs: 250,
});
// conversations-system: where and(eq(kind,'system'), eq(active,true)), no debounce
```

No `select` projection needed (select-all from the view matches
`ConversationSchema`, unlike tasks' description-dropping projection).
`conversations-gone` (LIMIT-30 window) keeps its `recompute:{full}` opt-out.

## Files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — types,
  `applyDbChange` gating, `mergePending`/`scheduleNotify` threading,
  `drainEntry` restructure, eviction guard.
- `plugins/framework/plugins/resource-runtime/core/keyed-diff.ts` —
  `diffKeyedScopedMembership`.
- `plugins/framework/plugins/resource-runtime/core/keyed-diff.test.ts` +
  new `runtime-scoped-membership.test.ts` (harness from `test-support.ts`).
- `plugins/infra/plugins/query-resource/server/internal/{spec,compile}.ts` +
  `compile.test.ts` / `compile-runtime.test.ts`.
- `plugins/tasks/plugins/tasks-core/{core,server/internal}/resources.ts`.
- Docs: query-resource CLAUDE.md (RULE relaxation), resource-runtime
  CLAUDE.md, live-state CLAUDE.md keyed section.

## Tests

- keyed-diff scenarios: pure delete; where-flip exit (no orderedIds); insert
  entering at position; insert-then-delete new id no-op; delete-then-reinsert;
  reactivation entry; unknown orderedIds id dropped; requested id absent
  everywhere no-op; in-place update `order: undefined`.
- keyed-diff property fuzz (mulberry32 `rng`): random I/U/D/where-flip
  sequences; membership path's snapshot must equal the `diffKeyedFull` oracle
  for the same table state; frames fed to `makeClientView` converge with zero
  drift-resubs.
- runtime harness: DELETE-only window → delta with order + **zero loader
  calls**; INSERT → refill + orderOf exactly once; mixed I/U/D coalesce to one
  frame; sticky-FULL absorbs membership; empty window no-op (no version bump);
  persisted reconstruct-persist (persistSnapshot gets the FULL-equal value,
  watermark before refill); no-snapshot degrade; snapshot survives N→0 for
  persisted sm; deletes cascade downstream FULL, inserts scoped; default-off
  frame-for-frame regression.
- compile: orderOf SQL rendering; throws on limit/recompute combos;
  compile-runtime end-to-end op I / op D / where-flip U via `applyDbChange`.

## Verification

- `bun test plugins/framework/plugins/resource-runtime`
- `bun test plugins/infra/plugins/query-resource`
- `bun run test:dom plugins/primitives/plugins/live-state` (client contract untouched)
- `./equin build` + `./equin check`
- E2E: create a conversation → one scoped `delta` (upsert + order) on
  `conversations-active`, cascade scoped into attempts/tasks; flip a
  conversation done → row leaves the list via delete+order (the mutable-where
  case); delete a conversation → delta with zero loader runs; churn monitor
  quiet on poller ticks; cold-boot restart → boot-snapshot hydrates, first
  change degrades to one FULL then resumes incremental; no drift-resubs in
  `logs/live-state.jsonl`.

## Follow-ups (file, don't do)

- ~~Sweep `scopedMembership` onto the remaining SIMPLE-SELECT keyed resources
  once the conversation scans bake.~~ **DONE (2026-08-18).** Full audit + decision
  record: `research/2026-08-18-global-scoped-membership-sweep.md`. Outcome: the
  mutable-`where` archetype (`notifications`) was solved instead by the later
  bounded-working-set `windowQueryResource` migration; zero un-migrated
  `recompute:{full, where-filtered}` resources remained. Two genuinely
  domain-bounded whole-list scans (`browser-bookmarks`, `plugin-health-reviews`)
  were opted in. The remaining candidates are per-parent point-shaped side tables
  — the correct fix is a `point` migration under the bounded-working-set contract,
  not `scopedMembership`; filed as follow-ups there.
- Seed `entry.snapshots` from the persisted L2 value at boot (kills the
  one-FULL-per-boot for persisted sm entries).
- Catch-up could replay D scoped for sm entries (currently FULL — safe).
- Remove `listActiveConversations`/`listActiveSystemConversations` if
  resource-only (verify callers).
