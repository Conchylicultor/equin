# A1 M4 — Derive the tasks/agents cascade scoping (rel() replaces hand-written affectedMap)

> Status: approved plan (implementation in this worktree). Track 1 Milestone 4 of
> [2026-07-02-global-comms-structural-fixes.md](./2026-07-02-global-comms-structural-fixes.md).

## Context

The only hand-written `affectedMap`/scoping machinery left in the codebase sits on
the load-bearing keyed + boot-critical tasks/attempts/conversations/agents cascade:

- `attemptsResource` — two edges (conversations-active → attempts, pushes → attempts)
  with hand-written `selectDistinct` closures
  (`plugins/tasks/plugins/tasks-core/server/internal/resources.ts`).
- `tasksResource` — one edge (attempts → tasks) plus a hand-written loader whose
  projection/scoping can drift from the schema.
- `agentLaunchesResource` — one edge (conversations-active → agent-launches) with a
  hand-written 3-table join closure
  (`plugins/conversations/plugins/agents/server/internal/resources.ts`).

Hand-written deltas can silently drift from what loaders actually read — degrading
to FULL recompute or, worse, wrong scoping with no failure signal. M4 replaces these
edges with **derived** `rel()` scoping from the `infra/query-resource` compiler:
`tasksResource` becomes fully declarative; attempts' nested loader and agent-launches'
rollup loader stay hand-written but get derived edges; the authored signature gate
(`conversationCascadeSignatures`) is preserved. **Zero changes to `resource-runtime`**
(the M4 constraint from the parent plan).

Key runtime facts that shape the design (verified):

- All four resources are `bootCritical` → persisted → their **own** loaders always
  FULL-recompute (`runtime.ts:1584-1613`). The edges still matter for cascade
  triggering, signature memos, and `coveredOrigins` routing — behavior preservation
  means identical edge semantics, not scoped self-loads.
- Upstream must be defined before downstream (silent edge drop otherwise) — module-eval
  order already guarantees this and is unchanged.
- The runtime never calls `affectedMap` with an empty id set (`runtime.ts:1840`).
- `rel()` has zero production consumers today — its signature is free to redesign.
- The facets docs scanner already parses `queryResource`/`queryResourceDescriptor`
  and ignores `dependsOn`/`edges` — no codegen concern.
- core→core cross-plugin import of `queryResourceDescriptor` is precedented
  (mail/reading-pane core does it).

## Design

### 1. Multi-hop `rel()` (query-resource)

The agent-launches edge is a multi-table mapping, so `Edge` becomes a **hop chain**:

```ts
// spec.ts
/** One join step: read `to` (distinct) from `via` where `from` ∈ the incoming id set. */
export interface Hop {
  via: PgTable | PgView;
  from: PgColumn; // matched against the incoming id set (upstream side)
  to: PgColumn;   // its distinct values become the next hop's id set / the result
}
export interface Edge {
  upstream: Resource<unknown, ResourceParams>;
  hops: Hop[];
  signature?: DependsOnEntry["signature"];
}
```

- `rel(upstream, hops: Hop | Hop[], opts?: { signature? }): Edge` (rel.ts) — keeps the
  documented contravariance-erasure cast on `upstream`.
- `compileEdge(edge, db)` chains one `selectDistinct({v: hop.to}).from(hop.via)
  .where(inArray(hop.from, current))` per hop, `String()`-coercing and deduping ids
  between hops, short-circuiting to `[]` when a hop returns empty.
- New public `compileEdges<P>(edges: Edge[], db?: QueryDb): DependsOnEntry<P>[]`
  (compile.ts, exported from the server barrel with the `Hop` type) so hand-written
  `defineResource` calls can consume derived edges. Defaults to the real drizzle `db`;
  the `as DependsOnEntry<P>[]` cast is the same generic laundering `compile.ts` already
  does (sound: compiled edges never set `map`).

### 2. `tasksResource` — fully declarative

- Descriptor (`tasks-core/core/resources.ts`): `keyedResourceDescriptor` →
  `queryResourceDescriptor<TaskListItem>("tasks", TaskListItemSchema, "id",
  { bootCritical: true })` (row schema, not array; boot-time `queryPk` ↔ keyField
  assertion; additive shape — web consumers only read key/origin/schema/keyOf).
- Server (`tasks-core/server/internal/resources.ts`): the whole
  `defineResource(tasksDescriptor, {...})` block becomes:

```ts
export const tasksResource = queryResource(tasksDescriptor, {
  from: tasks,                              // tasks_v PgView
  identity: { table: "tasks", pk: tasks.id },
  select: { /* every TaskListItem column, id..dependencies */ }
    satisfies Record<keyof TaskListItem, unknown>,   // KEEP the drift guard verbatim
  orderBy: [asc(tasks.rank), asc(tasks.createdAt)],
  edges: [rel(attemptsResource, { via: _attempts, from: _attempts.id, to: _attempts.taskId })],
});
```

  `satisfies Record<keyof TaskListItem, unknown>` keeps the completeness guard while
  `select?: SelectMap` independently enforces value types (view columns from
  `getTableColumns` spread are `PgColumn`; `sql.as()` columns are `SQL.Aliased` — both
  legal SelectMap members, verified against drizzle's `AddAliasToSelection`).
  Loader body + affectedMap closure + the `as unknown as` cast are deleted; the
  load-bearing comments (description excluded from list payload; drift-guard rationale;
  why cascading off conversations-active alone is sound) are preserved as prose.

### 3. `attemptsResource` — derived edges, hand-written loader

```ts
dependsOn: compileEdges([
  rel(conversationsActiveResource,
      { via: _conversations, from: _conversations.id, to: _conversations.attemptId },
      { signature: conversationCascadeSignatures }),
  rel(pushesResource, { via: pushes, from: pushes.id, to: pushes.attemptId }),
]),
```

Base tables replace the old view-based closures (conversations_v inner-joins attempts,
but the NOT NULL FK guarantees the same attemptId set) — proven by the parity diff
before trusting; `Hop.via` accepts a `PgView` as a one-line fallback if a diff appears.
The nested conversations loader (lines 139-169) is untouched.

### 4. `agentLaunchesResource` — derived 2-hop edge, hand-written loader

```ts
dependsOn: compileEdges([
  rel(conversationsActiveResource,
      [
        { via: conversationsView, from: conversationsView.id, to: conversationsView.taskId }, // conv → task
        { via: _agent_launches, from: _agent_launches.taskId, to: _agent_launches.id },       // task → launch
      ],
      { signature: conversationCascadeSignatures }),
]),
```

`conversations_v` already carries `taskId` (via its inner join to attempts), collapsing
the old conv→attempt→task→launch 3-table join into two hops with the identical id set.
The rollup-join loader is untouched. Import bookkeeping: `conversationsView` in,
`_attempts`/`_conversations`/`eq` out.

### Deleted by this change

- attempts' two `affectedMap` closures, tasks' `affectedMap` + entire loader body
  (incl. the `as unknown as` cast), agents' 3-table join closure.
- The hand-authored `identityTable: "tasks"` string (derived from the view identity).

## Files

- `plugins/infra/plugins/query-resource/server/internal/spec.ts` — `Hop`, new `Edge`.
- `plugins/infra/plugins/query-resource/server/internal/rel.ts` — multi-hop `rel`/`compileEdge`.
- `plugins/infra/plugins/query-resource/server/internal/compile.ts` — `compileEdges`.
- `plugins/infra/plugins/query-resource/server/index.ts` — export `compileEdges`, `Hop`.
- `plugins/tasks/plugins/tasks-core/core/resources.ts` — tasks descriptor swap.
- `plugins/tasks/plugins/tasks-core/server/internal/resources.ts` — tasks → `queryResource`, attempts → `compileEdges`.
- `plugins/conversations/plugins/agents/server/internal/resources.ts` — launches → `compileEdges`.
- Tests: `query-resource/server/internal/compile.test.ts`, `compile-runtime.test.ts`.
- Docs: `plugins/infra/plugins/query-resource/CLAUDE.md` (rel section: multi-hop,
  load-bearing, `compileEdges`).

## Order of changes

1. Compiler first: spec → rel → compile → barrel exports; update the 2 existing rel
   tests to the new API in the same step.
2. New tests (below); both suites green.
3. Descriptor swap, then tasks-core server migration, then agents migration
   (bottom-up in module-eval dependency order).
4. `./equin build` + `./equin check`.
5. Parity diff + end-to-end drive.
6. Docs.

## Verification

### Unit (bun:test, manual)

```
bun test plugins/infra/plugins/query-resource/server/internal/compile.test.ts
bun test plugins/infra/plugins/query-resource/server/internal/compile-runtime.test.ts
```

- compile.test.ts: updated single-hop SQL-shape + signature-passthrough tests; new
  `multi-hop chains one selectDistinct per hop, threading ids`, `empty intermediate hop
  short-circuits to []`, `ids are deduped between hops`.
- compile-runtime.test.ts (fake `selectDistinct` added to the local fakeDb): new
  `a rel() edge cascades a scoped upstream change into a downstream keyed delta`,
  `3-level A→B→C cascade (conv→attempts→tasks shape) flows through both edges scoped`
  (closes the missing multi-level invariant-harness gap), and `the signature gate drops
  a transient-only upstream change` (mirrors the conversationCascadeSignatures
  transient-field drop end-to-end).

### Parity diff (derived vs old affectedMap over the real DB)

For each of the four edges, run the OLD query and the NEW derived hop chain over ~50
sampled real ids and assert equal id sets (`EXCEPT` both directions → zero rows), via
`query_db` and/or a scratchpad bun script (`SINGULARITY_WORKTREE` env; `db` import is
side-effect-free, pool builds lazily). The critical claims: base-table hops ≡ the old
view closures, and the 2-hop launches chain ≡ the old 3-table join.

### End-to-end

`./equin build` green, then drive a real mutation (PATCH a task title / observe a
live conversation status change) and confirm:

- scoped keyed frames on `tasks`/`attempts`/`agent-launches` (live-state-health pane);
- Debug → Read-set: `coveredOrigins == read-set`, zero warning chips for the three;
- `GET /api/resources/_debug`: identical `dependsOn`/`downstream` topology as before;
- churn monitor quiet (signature gate still firing — no new no-op pushes).

## Deviation found during implementation

The planned `identity: { pk }`-only form (base table via
`relationIdentityBase("tasks_v")`) is **structurally impossible**: the
`View({ view, identityTable })` contribution that populates that registry is
collected at boot, while `queryResource(...)` resolves at module eval — always
earlier (the owning barrel evaluates its `resources.ts` import first). The
fallback was dead-on-arrival code from M1, first exercised here. Fix applied at
the root rather than the call site: `resolveIdentity` now **requires**
`identity.table` for a `PgView` (loud throw explaining the lifecycle), the
dead `relationIdentityBase` fallback is deleted, and `tasksResource` declares
`identity: { table: "tasks", pk: tasks.id }`. The string is asserted consistent
with reality by the read-set debug ceiling (a mismatch shows as a warning chip).

## Risks

- **Base-table vs view id-set drift** — parity diff gates it; `Hop.via: PgView` is the
  one-line fallback.
- **Dropping the signature gate** would reintroduce no-op cascade churn (not
  incorrectness); guarded by the new signature test + churn monitor check.
- **Rollback** is per-file and total: revert the two resources.ts + descriptor; the
  rel/Edge redesign is consumed only by the migrated resources and tests. No runtime,
  client, or codegen surface changes.
