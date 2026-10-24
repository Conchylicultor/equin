# Derived state primitive v2: Drizzle views + `dependsOn`

Supersedes `2026-04-16-global-derived-state-primitive.md`.

## What changed from v1

v1 proposed a single primitive — `dependsOn` on `defineResource` — with
the actual derivation happening in the resource's TS loader
(`rows.map(t => ({ ...t, status: computeStatus(...) }))`). An
afterthought section promoted that to `sql\`…\`` templates when perf
mattered.

Two problems with that shape:

1. **No SQL-level optimisation by default.** Loader-level TS joins
   can't use Postgres indexes on the derived field, can't `WHERE` /
   `ORDER BY` the derived column at the DB, can't aggregate. Every
   read pulls all upstream rows into TS and recomputes. The "phase 4
   materialise later" escape was a cathedral; phase 1 was a tent.
2. **Typing regression.** `sql\`…\`` templates are stringly typed.
   Column names drift, SELECT projections go un-checked, and plugin
   code becomes a mix of Drizzle and raw SQL. We'd re-introduce the
   class of bug the ORM exists to prevent.

v2 resolves both by leaning on a Drizzle primitive that already
exists: `pgView`. Derivation is authored in the Drizzle query builder,
typed end-to-end, and emitted as a real Postgres view by the migration
pipeline. `dependsOn` remains — but it becomes orthogonal, concerned
only with **invalidation propagation**, not with *how* derivation is
computed.

## The two primitives

### 1. `pgView` — typed SQL derivation (Drizzle-native)

Tables and views live **together** in `plugins/{name}/server/schema.ts`.
The public name (`tasks`) is always the thing consumers should use.
When derivation exists, `tasks` is a `pgView`; the underlying physical
table takes an internal name with a leading underscore (`_tasks`) and
is not exported beyond the plugin:

```ts
// plugins/tasks/server/schema.ts
import { pgTable, pgView } from "drizzle-orm/pg-core";
import { sql, eq, getTableColumns } from "drizzle-orm";
import { attempts } from "../../attempts/server/schema";

// Internal: the physical table. Writers (INSERT/UPDATE/DELETE) use this.
// Not re-exported from api.ts.
export const _tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // ... stored columns only
});

// Public: the unified structure consumers see. Readers use this.
export const tasks = pgView("tasks_v").as((qb) =>
  qb.select({
    ...getTableColumns(_tasks),
    status: sql<"todo" | "in_progress" | "completed">`
      CASE
        WHEN ${attempts.completedAt} IS NOT NULL THEN 'completed'
        WHEN ${attempts.id}           IS NOT NULL THEN 'in_progress'
        ELSE 'todo'
      END
    `.as("status"),
  })
  .from(_tasks)
  .leftJoin(attempts, eq(attempts.taskId, _tasks.id))
);

export type Task = typeof tasks.$inferSelect;
```

If a plugin has no derivation yet, there is no view — `tasks` is the
`pgTable` directly, exported without the underscore. When a derivation
is later introduced, the rename is a one-shot local edit (`tasks` →
`_tasks`, add the `pgView` named `tasks`). External callers do not
change, because they always imported `tasks`.

- `drizzle-kit generate` emits `CREATE TABLE tasks` and `CREATE VIEW
  tasks_v …` into migrations. Applied automatically on server boot.
- Callers `db.select().from(tasks)` with **full types** including the
  derived `status`.
- Writers inside the plugin `db.insert(_tasks).values(...)` — the
  underscore is the signal that you are touching stored state.
- Indexes on base tables (`attempts(task_id)`) participate in the
  planner's execution.
- No `sql\`…\`` at call sites. The narrow
  ``` sql<"todo" | "in_progress" | "completed">`CASE …` ``` lives
  inside the view definition, typed.

- `drizzle-kit generate` emits `CREATE VIEW tasks_with_status …` into
  a migration alongside tables. Applied automatically on server boot.
- Callers `db.select().from(tasksWithStatus)` with **full types**
  including the derived `status`.
- Indexes on base tables (`attempts(task_id)`) participate in the
  planner's execution. Predicates pushed through the view where the
  planner can, materialised intermediate where it can't.
- No `sql\`…\`` at call sites. The single narrow
  ``` sql<"todo" | "in_progress" | "completed">`CASE …` ``` lives
  inside the view definition, typed.

### 2. `dependsOn` on `defineResource` — invalidation propagation

Orthogonal to the view. Drives WS-level invalidation so subscribers
see the change:

```ts
// plugins/tasks/server/internal/resources.ts
export const tasksResource = defineResource({
  key: "tasks",
  mode: "push",
  dependsOn: [
    { resource: attemptsResource },
    { resource: conversationsResource },
  ],
  loader: () => db.select().from(tasksWithStatus),
});
```

When `attemptsResource.notify()` fires, the framework schedules
`tasksResource.notify()` on the same microtask flush. The loader
re-reads from the view; subscribers receive the fresh value.

Cycle detection, fan-out coalescing, and parameter mapping work
exactly as in v1 (see "Parameter mapping" and "Fan-out coalescing"
below — unchanged).

## Materialisation tiers

The same Drizzle declaration backs three storage strategies. Promotion
is a **one-token change** at the declaration site. Plugin code that
`SELECT`s from the view does not change.

### Tier A — `pgView` (default)

**Storage:** none. The view is a named query plan.
**Read cost:** runs the JOIN each SELECT. Microseconds for small
tables with the right indexes.
**Write cost:** none.
**Freshness:** always current.
**Propagation:** the resource-cache layer caches the loader result.
For `mode: "push"` resources, the JOIN runs **once per upstream change
across all subscribers**, not once per subscriber — so effectively
"precomputed per tick."

This is the right default for everything we have today (tens of
tasks, hundreds in a year). Already fast, already typed, zero infra.

### Tier B — `pgMaterializedView`

**Storage:** real rows on disk.
**Read cost:** plain table scan. Free.
**Write cost:** `REFRESH MATERIALIZED VIEW CONCURRENTLY …` is a full
recompute; `CONCURRENTLY` keeps reads non-blocking.
**Freshness:** stale between refreshes.
**Propagation:** the framework runs `REFRESH` immediately before
`notify()` fires, driven by `dependsOn`. One extra line in the
primitive's flush.

```ts
// promoted from pgView:
export const tasksWithStatus = pgMaterializedView("tasks_with_status").as(
  /* same body */
);
```

Pick this tier when:
- The JOIN is measurably expensive (>tens of ms).
- The client list sorts or filters by the derived column, and clients
  fetch often enough that per-read recompute is wasteful.
- Rows change infrequently relative to reads.

Cost: refresh is O(view-size), not O(changed-rows). Fine up to the
low millions; past that, graduate.

### Tier C — `pg_ivm` (incremental materialized view)

**Storage:** real rows on disk.
**Read cost:** plain table scan. Free.
**Write cost:** **only the affected rows** are recomputed, via
triggers on base tables. No `REFRESH` call at all.
**Freshness:** continuously current.
**Propagation:** the DB does it. `dependsOn` in the framework still
fires `notify()` to WS subscribers so clients invalidate, but the
backing data is already up-to-date before the notify lands.

```sql
-- migration emitted manually alongside the Drizzle declaration
CREATE EXTENSION IF NOT EXISTS pg_ivm;
SELECT create_immv('tasks_with_status_immv', $$
  SELECT … FROM tasks LEFT JOIN attempts …
$$);
```

`pg_ivm` is the only tier Drizzle does not natively emit — the
extension's DDL (`create_immv`) isn't standard SQL. We'd emit it via a
hand-written migration file and have the Drizzle side reference the
same view name (read-only `pgView` stub with matching columns for
types).

Pick this tier when:
- Refresh cost from tier B itself becomes a problem.
- The derivation is computed continuously (dashboards, real-time
  aggregates).
- The extension is acceptable infra (Postgres-only, not on managed
  services that disallow extensions).

Cost: extension install, slightly more complex migrations, fewer
supported query shapes (pg_ivm has restrictions — no correlated
subqueries, limited aggregates).

### Promotion path

```
pgView                         ← start here
  ↓ (measured read cost high)
pgMaterializedView + REFRESH   ← declaration one-token change
  ↓ (measured refresh cost high)
pg_ivm create_immv             ← manual migration + pgView stub
```

Every step leaves plugin code untouched. The resource's `loader`
stays `db.select().from(tasksWithStatus)` across all three tiers.

## Principle (unchanged)

1. **Derivation is declared.** A derived value names its shape (the
   `pgView`) and its upstream resources (via `dependsOn`). The
   framework owns invalidation.
2. **Never stored, never manually written.** If a value can be
   computed from others, it is a column in a view, not a column in a
   table. No writer ever issues `UPDATE tasks SET status = …`.

Both rules are enforced by `./equin check` (see §Enforcement).

## Parameter mapping

Unchanged from v1. For parameter-keyed resources (e.g. `edited-files`
keyed by conversation id), `dependsOn` takes a `map`:

```ts
dependsOn: [
  {
    resource: conversationsResource,
    map: (upstreamParams, upstreamValue) =>
      upstreamValue.map((c) => ({ id: c.id })),
  },
],
```

Default when `map` is omitted: identity.

## Cycle detection

Unchanged. `dependsOn` forms a DAG over resource keys. At boot, the
framework walks the DAG and throws on any cycle. Error names the
offending keys.

## Fan-out coalescing

Unchanged. One upstream notify cascades through the DAG within a
single microtask flush. Per-resource, per-params-tuple coalescing
means one loader call per derived key per tick regardless of upstream
volume.

For tier-B resources, the cascade runs `REFRESH MATERIALIZED VIEW
CONCURRENTLY` exactly once per flush per view, before the downstream
`notify()` fires.

## TS-loader escape hatch

Some derivations can't be expressed in SQL:
- fs state (`edited-files` count from the worktree directory)
- Cross-service values (external API response blended with a row)
- Values that need a runtime function the DB doesn't have

These keep the plain `loader` shape — same as today, with `dependsOn`
added for invalidation:

```ts
export const editedFilesResource = defineResource({
  key: "edited-files",
  mode: "invalidate",
  dependsOn: [{ resource: fsWatchResource }],
  loader: async ({ id }) => getEditedFiles(worktreePathForSync(id)),
});
```

The escape hatch is narrow on purpose. If the derivation *can* be
expressed as a `pgView`, the enforcement check (below) pushes it
there.

## Schema convention

One file, one canonical name per entity, two declaration kinds.

**`plugins/{name}/server/schema.ts`** holds both `pgTable` and
`pgView` / `pgMaterializedView` declarations. The canonical name a
plugin exposes (`tasks`, `conversations`, `edited_files`) is **always
the most-derived form**:

- When no derivation exists, the canonical name is the `pgTable`.
- When derivation exists, the canonical name is the `pgView`, and the
  underlying physical table is renamed with a leading underscore
  (`_tasks`). The underscore marks it as **internal to the plugin —
  writers only**. Other plugins must not import underscored names.

This achieves "one unified structure for consumers":

- Agents and other plugins import `tasks` and never choose between
  "the table" and "the view." The underscored form does not appear in
  public autocomplete because it lives in the same `schema.ts` and
  plugins are expected to re-export only the public name via `api.ts`.
- Internal writers use `_tasks` (the table), because `INSERT` /
  `UPDATE` / `DELETE` only work against tables. The underscore is the
  reminder: you are mutating stored state.
- Introducing a derivation later is a local rename, not an API change.

Corollary: a plugin's `pgTable`s are the **stored** schema; its
`pgView`s are the **exposed** schema. They live together, but serve
different audiences.

## Enforcement

Five `./equin check` additions:

1. **`derived-not-stored`** — AST check: for each `defineResource`,
   columns in the loader's typed return that are not in any imported
   `pgTable` must come from a `pgView` / `pgMaterializedView`.
   Forbids silently adding a derived field to a `pgTable`.
2. **`no-underscored-cross-plugin-import`** — grep across plugins:
   `_<name>` imports from another plugin's `schema.ts` are forbidden.
   Writers stay inside their owning plugin; consumers get the
   canonical public name only.
3. **`no-writes-to-public-name`** — AST check: `db.insert(tasks)`,
   `db.update(tasks)`, `db.delete(tasks)` are forbidden when `tasks`
   resolves to a `pgView`. Writes go through the underscored table.
   Catches the mistake at `./equin check` instead of runtime.
4. **`no-manual-notify-on-derived`** — grep for
   `<derivedResource>.notify(` outside the resource's own file.
   Derived resources are invalidated by the framework only.
5. **`dependsOn-acyclic`** — runs at build; reuses the boot-time DAG
   walk so the failure surfaces in CI before deploy.

Note: raw SQL migrations that create views are allowed only in the
explicitly allow-listed `pg_ivm` escape path. Anywhere else,
derivations live in Drizzle.

## Phased rollout

### Phase 1 — the primitives (~1–2 days)

- `server/src/resources.ts`: add `dependsOn`, DAG registration,
  cascade inside `flushNotifies`. No cycle detection yet (warn-only).
- Verify `pgView` declarations are picked up by `drizzle-kit generate`
  (they are — this is a configuration confirmation, not code).
- No migrations of existing resources.

### Phase 2 — first adopters

- `task.status`: rename the physical table in
  `plugins/tasks/server/schema.ts` to `_tasks`; add a `pgView` named
  `tasks` alongside it; update internal write sites to target
  `_tasks`. `tasksResource.loader` becomes
  `() => db.select().from(tasks)`; `dependsOn: [attemptsResource]`.
- `conversation.phase`: migrated off its ad-hoc tracking (see
  `2026-04-15-conversations-phase-indicator.md`).
- Update `plugin-core/CLAUDE.md` and `server/CLAUDE.md` to document
  the unified-name convention (`_foo` stored / `foo` exposed) and
  `dependsOn` semantics.

### Phase 3 — enforcement

- Land the four checks. Use the first real violation (inevitable) to
  tighten rules before they proliferate.
- Promote `dependsOn-acyclic` from warn-only to hard-fail.

### Phase 4 — on signal, per-view

- Promote specific views to `pgMaterializedView` when measurement
  shows reads are slow or refresh cost is acceptable.
- Wire `REFRESH MATERIALIZED VIEW CONCURRENTLY` into the `dependsOn`
  cascade (one extra branch in `flushNotifies` for tier-B resources).

### Phase 5 — only if needed

- `pg_ivm` for views where refresh cost itself hurts. Requires
  extension install, hand-written migration for `create_immv`, and a
  `pgView` stub for Drizzle typing.

## Tradeoffs

- **Tier-A read cost at the DB.** Every `loader()` runs the JOIN.
  Mitigated by the resource cache (one JOIN per tick, not per
  subscriber) and by indexes. If measurement ever says otherwise,
  promote that view to tier B.
- **Debuggability of cascades.** A single upstream notify fans out to
  every dependent. The `/api/resources/_debug` endpoint must surface
  the DAG and the last cascade tree — missing today, small addition
  in phase 1.
- **`pgMaterializedView` refresh is full, not incremental.** Correct
  answer at tier B. Incremental requires tier C (`pg_ivm`), which is
  not free infra.
- **Underscore rename at derivation introduction.** Adding the first
  derivation to a plugin renames `tasks` → `_tasks` internally (and
  introduces a `pgView` named `tasks`). Local, one-shot, caught by
  the type checker. External imports do not change.
- **Drizzle view migration story.** `drizzle-kit` emits `CREATE VIEW`,
  but renames and column changes may drop+recreate. Acceptable for
  views (no data loss). Tier B / C have sharper edges (dropping a
  matview drops its data) — document in `server/CLAUDE.md`.

## Non-goals

- **Full streaming SQL / `pg_ivm` from day one.** Tier A covers
  current needs. The primitive's shape leaves room for C.
- **Client-side reactive queries (Convex / Zero-style).** The existing
  `useResource` + WS push covers our needs. This primitive still fits
  underneath a future sync engine.
- **Replacing event-bus-style cross-plugin coordination.** Derivation
  is for "Y is a function of X." Side effects ("when a task is
  created, kick off a worktree") stay in their current shape.

## Open questions

- **DB-table `dependsOn`.** Many resources are thin wrappers over one
  table (`tasksResource → tasks`). Letting `dependsOn: [tasks]`
  (a Drizzle table) stand in for `[tasksResource]` would reduce
  boilerplate. Requires observing DB writes — either routing all
  mutations through a primitive that auto-notifies, or Postgres
  `LISTEN/NOTIFY`. Defer until phase 2 tells us whether it's the
  common case.
- **Per-params `dependsOn`.** Today every notify on the upstream
  cascades to every params of the downstream. For sparse upstreams
  (`edited-files[id=A]` shouldn't invalidate `task[id=B]`), the
  `map` callback narrows this. Works; the question is whether a
  tighter default is worth the complexity.
- **Client-side derivation.** If a plugin wants `useDerived(resource,
  fn)`, should it mirror the server API? Likely yes for consistency.
  Out of scope for phase 1.
- **Testing.** `pgView` logic is tested by querying it in an
  integration test per plugin (write upstream rows, assert view
  output, assert resource notify fires). A shared harness in
  `plugin-core` once two plugins need it.

## Critical files (phase 1)

- `server/src/resources.ts` — add `dependsOn`, DAG registration,
  cascade in `flushNotifies`, debug-endpoint surface.
- `server/CLAUDE.md` — document `dependsOn`, the `derived.ts`
  convention, and the tier-A/B/C promotion path.
- `plugin-core/CLAUDE.md` — add the schema convention and link to
  this doc.
- `cli/src/checks/` — five new checks (phase 3, not phase 1).

## Why this is the right foundation

- **One authoring language.** Drizzle for tables, Drizzle for views.
  No string SQL in plugin code. Types flow from base tables through
  views through resources through WS to clients.
- **Tiny primitive surface.** `pgView` is Drizzle's. `dependsOn` is
  ~100 lines added to `resources.ts`. The enforcement is five checks.
- **Swappable implementation.** Same declaration, three storage
  strategies. Performance becomes a per-view knob, not an
  architectural fork.
- **Enforceable.** Manual propagation and stored-derived fields are
  check failures, not code-review hopes.
- **Reusable.** Every future "X depends on Y" relationship — across
  plugins, across projects in the monorepo — is a `pgView` +
  `dependsOn` declaration. Agents learn two primitives once.

The durable investment is not the code. It is the discipline, enforced
by the framework, that **every value in the system is either stored in
a table or declared in a view, and consumers see only the unified
public name** — never both, never manually propagated, never a raw
SQL string floating in plugin code, never a choice between "which
version do I import."
