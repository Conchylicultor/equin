# automations.catalog: reached by status transitions, not by every tasks write

## Context

`automations.catalog` (`plugins/tasks/plugins/automations/machine/internal/catalog.ts`)
is an external `"notified"` value whose loader also reads Postgres. It declares
`reads.tables: [tasksView, tasksOrigin, tasksLaunchDecision, _automationLaunchBatches]`.
`tasks_v` is a VIEW, so the runtime indexes it as a relation read under all of its
bases (tasks, attempts, conversations, pushes, attempt_deliveries,
task_dependencies, and the rollup sources). A view read has no column gate and no
row narrowing, so every write to any of those tables recomputes the whole catalog,
at most once a second (`throttleMs: 1000`). Running agents write those tables
constantly. Measured on main on 2026-10-25: the version went from 3 to 10 in about
3 minutes with an unchanged content hash. D8 stops the frames, but the ~64 ms
recompute still runs.

The catalog reads `tasks_v` only for `status`, through three predicates
(`server/internal/origin.ts`, `server/internal/decisions.ts`):

| Field | Predicate on the task's status |
|---|---|
| `openTaskId` (file) | a FILED task's status not in `done` / `dropped` |
| `runningTaskIds` (launch) | an unreleased LAUNCHED task's status not in `SLOT_SETTLED_STATUSES` |
| `approvedCount` (launch) | an approved task with no origin row, status `new` |

So the only status changes that can move the catalog are transitions of a task
that has an origin row or a launch decision, and only those that flip one of the
three predicates. A turn of a running agent (`in_progress` ↔ `need_action`) flips
none of them.

The domain already announces exactly this: `tasks.statusChanged` is emitted once
per net derived-status transition, from the status chokepoint
(`tasks-core/server/internal/status-scope.ts`, `withTaskStatusChange`). The
automation's pump already relies on it, through `automations.task-status`
(`server/internal/attention.ts`): it wakes a launch automation when a task
settles, and it already raises `catalogChanged()` for every status change of an
automated task. The change feed adds nothing to that signal except noise.

## Design

### 1. A new primitive: a relation read the value's own notify covers (`reads.notified`)

Hand-written loaders declare whole relations today, so narrowing has to come from
somewhere other than the feed. A notified external value may now say that one
relation it reads reaches it through its OWN notify, driven by a domain event that
owns that relation's changes, and not through the change feed:

```ts
serveValue(automationsCatalog, {
  source: "external", changes: "notified",
  reads: {
    tables: [tasksOrigin.table, tasksLaunchDecision.table, _automationLaunchBatches],
    reason: "…",
    notified: {
      relations: [tasksView],
      reason: "status only: tasks.statusChanged → automations.task-status → catalogChanged(), when the transition moves a catalog predicate",
    },
  },
  whileSubscribed: (_p, notify) => onCatalogChanged(notify),
});
```

Layers:

- **resource-runtime** (`core/routing.ts`): `NotifiedRead { relation, reason }` and
  `ReachPlan.notified`. `mintReachPlan` refuses an empty reason, a duplicate, or a
  relation that is also a route, unfed or relation read. In the runtime,
  `RoutingRecord.notified` is accepted by `readCovered` (the A8 / D5 drift guard
  and the D7 seed) and never indexed for routing. `_debug` lists it as
  `notifiedReads`. `routingRecordFor` throws when the entry is not external: a DB
  value has no notify, so the claim cannot hold.
- **query-resource** (`server/internal/routes.ts`): `ValueReads.notified?` is folded
  by `compiledValueReach` into the plan (a view by its view name, a table by its
  base name).
- **network/live** (`server/internal/serve-value.ts`): the db arm's `reads` type
  forbids `notified` (`notified?: never`, tsc). The external `"notified"` arm
  accepts it. Docs go in the live and resource-runtime CLAUDE.md files.

This sits on the type rung for "only a notified external may claim it" and the
runtime rung for the plan's shape. What stays convention is that the notify really
is wired to the event. The `reason` names the event, and the catalog's wiring is
tested.

### 2. The catalog uses it

- `machine/internal/catalog.ts`: `tasksView` moves from `reads.tables` to
  `reads.notified.relations`.
- Core gets one definition of the predicates (`core/internal/catalog-status.ts`):
  `OPEN_FILED_EXCLUDED = ["done", "dropped"]` (used by `origin.ts`'s `isOpen` in
  place of its literal), `SLOT_SETTLED_STATUSES` (already exists), and
  `PENDING_APPROVAL_STATUS = "new"` (used by `decisions.ts`). Beside them:
  `catalogStatusMoved(previous, next)`, true when the transition flips any of the
  three predicates. Built from the same constants, so the queries and the trigger
  cannot disagree.
- `server/internal/attention.ts`: the event schema gains `previousStatus`
  (already in the payload). `catalogChanged()` is raised when
  `catalogStatusMoved(prev, status)` and the task has an origin row (as today) OR
  a launch decision (new: `approvedCount` follows an approved task that a person
  starts by hand). It used to fire on every status change of an automated task.
  The bell and wake logic is unchanged.
- Task deletion: cascades remove the origin and decision rows, which are routed
  table reads, so that path is still covered.

### Cost after

A write to tasks, conversations, attempts, pushes or task_dependencies no longer
reaches the catalog. It recomputes on:

- a write to its own three small tables;
- a config change, filing, launch, release or decision (existing
  `catalogChanged`);
- a predicate-moving status transition of an automated or decided task.

## Files

- `plugins/framework/plugins/resource-runtime/core/{routing.ts,runtime.ts,index.ts}` + a test in `runtime-declared-reads.test.ts`
- `plugins/infra/plugins/query-resource/server/internal/routes.ts` (+ its test)
- `plugins/network/plugins/live/server/internal/serve-value.ts`, `core/internal/compile-value.ts` if the type lives there
- `plugins/tasks/plugins/automations/{core/internal/catalog-status.ts(+test), core/index.ts, server/internal/{origin,decisions,attention}.ts, machine/internal/catalog.ts, CLAUDE.md}`
- CLAUDE.md for resource-runtime, network/live and query-resource

## Verification

- `./equin test` for resource-runtime (the mint refusals, a covered capture under
  `strictRoutes`, the refusal on a non-external entry), query-resource
  (`compiledValueReach` folding `notified`), and automations (the
  `catalogStatusMoved` truth table).
- `./equin build`, then `query_db` / `/api/resources/_debug` on the worktree:
  `automations.catalog` lists `notifiedReads: ["tasks_v"]` and no route on
  tasks / conversations. Its version stays flat while other conversations write,
  and moves when an automated task settles.
