# L3 read-set capture — automatic loader→table dependency index

> **Category:** global (runtime-profiler, database, server-core, resource-runtime, debug)
> **Status:** plan / ready to implement
> **Parent vision:** [`2026-06-19-global-live-state-sync-engine.md`](./2026-06-19-global-live-state-sync-engine.md) — this is **§8 step 1 (L3)**, the foundation step.
> **Scope:** observability / foundation **only**. No behavior change — invalidation, cascade, and `notify()` are untouched. This only *observes* what loaders read and surfaces it.

## 1. Context

Live-state invalidation today rides on two hand-maintained things: ~155 `notify()`
call sites and ~37 hand-asserted `dependsOn` edges, plus the author's memory of
which tables each loader reads. A loader that reads a table not reflected in its
`dependsOn` (and not covered by a `notify()`) **silently serves stale UI**;
over-broad edges cause wasted recomputes (cascade amplification).

The real read-set is already observable but unused: the DB pool wrapper
(`database/server/internal/client.ts`) runs **every** loader query under the
loader's `AsyncLocalStorage` `EntryContext` (that's how the profiler attributes
`db` spans to loaders). We extend that one chokepoint to also record the **set of
tables** each loader touched, building an automatic `table → [resource keys]`
index — and surface it next to a diff against the hand-drawn `dependsOn` graph so
the gaps (latent stale-UI bugs) and over-broad edges become visible.

This is the substrate the later L4 DB-derived change-feed consumes; nothing here
changes runtime behavior.

## 2. Design at a glance

Two existing seams do all the work; we mirror them rather than invent:

- **Wait-accumulation precedent** — the profiler already carries a mutable
  `waits: Map` on each `EntryContext`, populated mid-loader via `chargeWait(...)`
  and materialized in `recordEntrySpan`'s `finally`. We add a `tables: Set` the
  exact same way, populated via a new `recordReadTables(...)`.
- **`_debug` injection precedent** — the resource runtime already injects
  server-only data into its `/api/resources/_debug` payload via optional hooks
  (`loaderStats`, `debugOwners`). We add one more hook, `readSet`, so each
  resource in `_debug` gains its captured table list. No new endpoint, no new
  server plugin barrel.

Data flow:

```
pool.query(text)                          [client.ts — the chokepoint]
  └─ if caller is a loader:
       recordReadTables(extractTablesFromSql(text))   ── unions tables into the
                                                          loader's live EntryContext
recordEntrySpan("loader", key) finally    [recorder.ts]
  └─ flush ctx.tables → readSetIndex[key]            ── module-level Map<key, Set<table>>

GET /api/resources/_debug                 [runtime.ts handleResourcesDebug]
  └─ per resource: { key, mode, dependsOn, downstream, loaderStats, readSet }

Debug pane (web-only, consumes _debug)    [plugins/debug/plugins/read-set]
  └─ invert readSet → table→[resources] index  +  diff vs dependsOn (both directions)
```

## 3. Server changes (small, all in named §11 critical files)

### 3a. `plugins/infra/plugins/runtime-profiler/core/recorder.ts`
- Add an optional `tables?: Set<string>` to the `EntryContext` interface (lazy —
  not allocated for the many non-loader entries).
- Add a module-level `const readSetIndex = new Map<string, Set<string>>()` keyed
  by entry `label` (which, for loader entries, **is** the resource key).
- Add and export `recordReadTables(tables: readonly string[]): void` — mirrors
  `chargeWait`: read `contextRuntime.current()`; if an entry is active, do
  `cur.tables ??= new Set()` and add each name. (Also short-circuit when
  `SINGULARITY_PROFILING === "0"`, consistent with `record()`.)
- In `recordEntrySpan`'s `finally`: if `kind === "loader"` and `ctx.tables?.size`,
  union them into `readSetIndex` under `label`. (Gating on loader kind here means
  a stray table captured under an `http` entry is never indexed.)
- Add and export `getReadSetIndex(): Record<string, string[]>` (materialize the
  Map→Record of sorted arrays).
- Clear `readSetIndex` inside `resetRuntimeProfile()` so the index shares the
  profiler's lifecycle.
- Export `recordReadTables` + `getReadSetIndex` from `core/index.ts`.

Why here: `recorder.ts` already owns the `EntryContext` lifecycle and treats
`label` opaquely — `tables` stays just-opaque-strings, no SQL/resource knowledge
leaks in. This is the file §11 names as the read-set home.

### 3b. `plugins/database/server/internal/client.ts`
- Add a small pure `extractTablesFromSql(text: string): string[]` — regex over
  the **already-compiled** SQL (`text`, line 82) matching quoted identifiers after
  `FROM` / `JOIN` / `INTO` / `UPDATE` / `DELETE FROM`:
  `/\b(?:from|join|into|update|delete\s+from)\s+"([^"]+)"/gi`. Drizzle always
  emits double-quoted table identifiers, so this is reliable for ORM queries; raw
  ``sql`…` `` and CTE aliases fall back to coarse over-capture, which is
  explicitly acceptable (§5 of the parent doc). SQL knowledge lives in the
  database plugin, not the profiler.
- In the existing `currentCallerKind() === "loader"` branch (synchronously,
  before the gated promise — the ambient context is still active there), call
  `recordReadTables(extractTablesFromSql(text))`. This is the **only** behavior
  added at the chokepoint; timing, gating, and execution are unchanged.

### 3c. `plugins/framework/plugins/resource-runtime/core/runtime.ts`
- Add optional `readSet?: (key: string) => string[]` to `ResourceRuntimeOptions`.
- In `handleResourcesDebug()` (the `_debug` payload builder, ~L1094), add
  `readSet: opts.readSet?.(entry.key) ?? []` to each resource object, alongside
  the existing `dependsOn: entry.upstreamKeys` and `downstream`.

### 3d. `plugins/framework/plugins/server-core/core/resources.ts`
- Wire the new hook in the `createResourceRuntime({...})` call (next to
  `loaderStats`): `readSet: (key) => getReadSetIndex()[key] ?? []`, importing
  `getReadSetIndex` from the runtime-profiler core barrel (already imports from
  it). Central-core omits the hook (like `loaderStats`/`debugOwners`).

No schema/migration changes. No `defineResource` consumer touched. The `_debug`
payload gains one additive field.

## 4. Web change — new debug sub-plugin `plugins/debug/plugins/read-set`

Web-only, consuming the existing `GET /api/resources/_debug` route, mirroring the
`live-state-health` precedent (a debug pane that declares its own typed contract
for a kernel-served route it does not implement). Files:

- `package.json` — `@singularity/plugin-debug-read-set`.
- `shared/endpoints.ts` + `shared/schema.ts` — `defineEndpoint({ route:
  "GET /api/resources/_debug", response })` where each resource is
  `{ key, mode, dependsOn: string[], downstream: string[], readSet: string[],
  loaderStats?, ... }`. (Own contract — `shared/` is plugin-private, so we can't
  import live-state-health's; declaring a second typed view of the same route is
  the established pattern. Zod strips unknown keys, so the two views coexist.)
- `web/index.ts` — default `PluginDefinition` contributing `Pane.Register` +
  `DebugApp.Sidebar` (title "Read-set", a table icon, `openPane(..., {mode:"root"})`).
- `web/panes.tsx` — `Pane.define({ id: "debug-read-set", segment: "read-set" })`
  wrapped in `PaneChrome`.
- `web/components/read-set-view.tsx` — `useEndpoint(readSetDebug, {}, {
  refetchInterval })`; two sections:

  **Section A — captured index (the new ground truth).** Invert `readSet` across
  all resources into `table → [resource keys]`. Render as a searchable, sortable
  table (table name, the resources that read it, count).

  **Section B — diff vs `dependsOn` (both directions).** Per resource, using
  `reads(R)` = its `readSet` and `upstreams(R)` = its `dependsOn`, and treating an
  upstream `U` as "about" `reads(U)`:
  - **(a) Missing edges / latent stale-UI** — tables in `reads(R)` not covered by
    any transitive dependsOn upstream's read-set. Each is a candidate undeclared
    dependency (or a direct `notify()` — see caveat).
  - **(b) Over-broad edges / cascade amplification** — declared dependsOn edges
    `U → R` where `reads(U) ∩ reads(R) = ∅` **and** the edge has no `affectedMap`
    scoping. Candidate edges that fan out recomputes without a shared data reason.

  Render a prominent caveat: this is a heuristic — **direct `notify()` sites are
  not modeled in this phase** (that's L4), so a "missing edge" may be covered by a
  self-`notify()` rather than being a true bug; confirm by mutating the table with
  current code and watching for a stale tab (parent doc §12).

  Also surface a "only loaders that have run since boot/reset appear" note —
  boot-critical resources warm at boot; others populate on first subscribe.

After creating the files, `./equin build` regenerates the web/server
registries from the filesystem — no manual registration.

## 5. Critical files

- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` — `EntryContext.tables`,
  `readSetIndex`, `recordReadTables`, `getReadSetIndex`, reset wiring (3a).
- `plugins/infra/plugins/runtime-profiler/core/index.ts` — export the two new symbols.
- `plugins/database/server/internal/client.ts` — `extractTablesFromSql` + the one
  `recordReadTables` call in the loader branch (3b).
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — `readSet` hook +
  `_debug` field (3c).
- `plugins/framework/plugins/server-core/core/resources.ts` — wire `readSet` hook (3d).
- `plugins/debug/plugins/read-set/**` — new web-only debug pane (4).

## 6. Verification

1. `./equin build`; open `http://<worktree>.localhost:9000`, then the Debug →
   Read-set pane. Browse a bit so loaders run (subscriptions trigger loads).
2. **Capture correct:** Section A lists `table → [resources]`. Spot-check a known
   case — the `attempts` loader reads both `attempts` and `conversations`, so
   `conversations → [attempts, …]` must appear with no authored edge.
   Cross-check with `mcp__singularity__get_runtime_profile` (loader aggregates)
   and `mcp__singularity__query_db` (table names exist).
3. **Diff direction (a):** confirm every existing `dependsOn` edge shows up as
   "covered," and inspect each "missing edge" — for at least one, mutate that
   table out-of-process (`psql` / `query_db` is read-only, so use the app's own
   mutation) and confirm whether an open tab goes stale (true gap) or updates
   (covered by a `notify()`), validating the caveat.
4. **Diff direction (b):** confirm any flagged over-broad edge truly shares no
   read table and lacks an `affectedMap`.
5. **No behavior change:** live-state still updates as before (cascade/notify
   untouched); `./equin check` passes; type-check clean. The only new code
   paths are observation-only.

## 7. Findings from the L3 implementation (input to L4)

Implemented and verified live (`/debug` → Read-set pane; 15 resources / 18 tables
captured on a warm boot):

- **Loaders read derived *views*, not base tables.** The captured names are
  `conversations_v`, `attempts_v`, `tasks_v`, `agents_v`, etc. — the
  `database/derived-views` outputs. This is correct for the read-set (it's what
  the loader actually queries), but the **L4 change-feed must bridge view → base
  table**: `AFTER` triggers fire on base tables (`conversations`,
  `conversations_ext_*`, …), so the feed needs a view→base-table dependency map to
  translate a base-table write into the view-named read-set keys. The
  `derived-views` rebuild already knows each view's source tables — that's the
  natural place to emit the mapping. **Flagged as a prerequisite for L4.**
- **Correctness bug found + fixed during verification — capture must honor
  `runWithoutProfiling`.** A slow loader query fires the profiler's `onSlowSpan`
  handler *synchronously inside that loader's ambient context*; the reports /
  slow-ops subsystem then files a report — `INSERT INTO reports` plus the report's
  `createTask`/`getTask` (reads `tasks_v`) — wrapped in `runWithoutProfiling()` so
  it doesn't pollute the profiler. `record()` honors that suppression, but the
  first cut of `recordReadTables` did **not**, so those suppressed writes leaked
  `reports` + `tasks_v` into whichever loader tripped the slow span (observed on
  `agent-launches`). Fix: `recordReadTables` early-returns under
  `suppressionRuntime.suppressed()`, exactly like `record()`. After the fix, every
  captured read-set equals the loader's true reads (verified: 277 reports filed,
  zero leaks under heavy concurrent load). *Lesson for any future capture at this
  chokepoint: it must compose with the observability self-feedback guard.*
- **The diff's two heuristic directions both fire on real edges, and both hits are
  the predicted caveat cases**, confirming the honesty note rather than bugs:
  - *Over-broad:* `attempts → pushes` and `tasks → attempts` — declared edges whose
    endpoints share no read table. Both are legitimately `affectedMap`-scoped
    (row-id join), which the table-level diff can't see. → motivates surfacing
    `affectedMap` presence in a future `_debug` field to suppress these.
  - *Missing:* every root/self-notified resource (`conversations`, `pushes`,
    `tasks`, …) flags its own table as "uncovered," because direct `notify()`
    sites aren't modeled yet. → this is exactly the set L4 will replace, so the
    flag list doubles as the L4 migration worklist.
