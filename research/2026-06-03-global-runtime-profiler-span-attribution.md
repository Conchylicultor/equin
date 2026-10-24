# Runtime profiler — per-span caller attribution (ambient tier)

## Context

The runtime profiler (`research/2026-06-02-global-runtime-profiling.md`, now shipped)
records `http`, `db`, and `loader` spans as **independent per-worktree aggregates**
keyed only by label. There is no link between a slow DB query (or loader) and the
in-flight request/loader that triggered it. N+1 and fan-out patterns therefore show
up only as a high aggregate count ("this query ran 78×") but cannot be attributed to
the caller, forcing manual grep to find the owner.

This adds the **lightweight ambient-attribution tier**: each `db`/`loader` span
records the *single innermost enclosing* request or loader it ran under, so a
repeated-query problem points straight at its source. Full per-request span trees /
distributed tracing remain explicitly out of scope — only one level of immediate
parent is captured.

Confirmed with user:
- **Depth:** immediate parent only (one level).
- **Surfaces:** both the `get_runtime_profile` MCP tool (headline agent surface) and
  the Debug → Profiling → Runtime web tables.

## Mechanism — ambient context via injected AsyncLocalStorage

The natural primitive is Node's `AsyncLocalStorage` (ALS): establish an ambient
`{ kind, label }` at each HTTP/loader entry point; read it when a nested `db`/`loader`
span is recorded; the innermost active context is the immediate parent.

**Constraint (from the v1 doc):** the recorder (`runtime-profiler/core/recorder.ts`)
is **isomorphic core** — it is reachable from the web bundle via
`endpoints/core/implement.ts`, so it must import **no Node APIs**. `AsyncLocalStorage`
(`node:async_hooks`) cannot be statically imported there, nor in `implement.ts` /
`server-core/core/resources.ts` (both isomorphic `core`).

**Solution — dependency injection.** The pure core holds a pluggable, no-op-by-default
context runtime; the server installs an ALS-backed implementation at boot. Web never
installs it, so on the client every entry point is a transparent passthrough.

```ts
// recorder.ts (pure, web-safe)
export interface SpanRef { kind: SpanKind; label: string; }
interface SpanContextRuntime {
  run<T>(ctx: SpanRef, fn: () => T): T;
  current(): SpanRef | undefined;
}
let contextRuntime: SpanContextRuntime = { run: (_c, fn) => fn(), current: () => undefined };
export function installSpanContextRuntime(rt: SpanContextRuntime): void { contextRuntime = rt; }
```

Entry-point helper (records the span with the *outer* parent, then runs children
under a fresh context so the entry never becomes its own parent):

```ts
export async function recordEntrySpan<T>(
  kind: SpanKind, label: string, fn: () => T | Promise<T>,
): Promise<T> {
  const parent = contextRuntime.current();          // outer context
  const t0 = performance.now();
  try {
    return await contextRuntime.run({ kind, label }, fn); // children see {kind,label}
  } finally {
    record(kind, label, performance.now() - t0, parent);  // record with OUTER parent
  }
}
```

`recordSpan(kind, label, dur)` (the existing leaf path, used by the DB pool wrapper)
records with `parent = contextRuntime.current()` — for a `db` span that is the
innermost `http`/`loader` entry, exactly the attribution we want.

Resulting parent chains in practice: `db` → `loader:<key>` (queries inside a loader)
or `db` → `http:<route>` (queries inside an `implement()` handler). WS-driven loaders
(`handleSub`) and push recomputation (`flushNotifies`) have no HTTP ancestor, so their
loader spans have `parent = none` and their `db` children attribute to the loader.

## Data model

```ts
export interface ParentBreakdown { parent: SpanRef; count: number; totalMs: number; maxMs: number; }

export interface Aggregate {
  label: string; count: number; totalMs: number; maxMs: number; lastMs: number;
  byParent: ParentBreakdown[];   // NEW — sorted by count desc in getRuntimeProfile output
}

export interface SlowSpan {
  kind: SpanKind; label: string; durationMs: number; atMs: number;
  parent: SpanRef | null;        // NEW
}
```

The top-level aggregate fields are unchanged (backward compatible); `byParent` is
additive. Internally `byParent` is a `Map<string, ParentBreakdown>` keyed by
`` `${kind}:${label}` `` for O(1) update, materialized to a sorted array in
`getRuntimeProfile()`. Memory stays bounded: parents are code-path-bounded
(routes/loader keys), so each label has a handful of distinct callers.

## Implementation

### Part A — Recorder primitive (`plugins/infra/plugins/runtime-profiler/`)

1. **`core/recorder.ts`**
   - Add `SpanRef`, `ParentBreakdown`; extend `Aggregate.byParent` and `SlowSpan.parent`.
   - Add the injected `contextRuntime` + `installSpanContextRuntime`.
   - Add `recordEntrySpan` (above). Refactor the existing aggregate/ring update into an
     internal `record(kind, label, dur, parent)` that also bumps the matching
     `byParent` bucket and stamps `parent` on the pushed `SlowSpan`.
   - `recordSpan` keeps its signature; delegates to `record(..., contextRuntime.current())`.
   - `getRuntimeProfile` materializes `byParent` arrays (sorted by count desc).
   - Kill switch (`SINGULARITY_PROFILING === "0"`) still short-circuits in `record`.

2. **`core/index.ts`** — export `recordEntrySpan`, `installSpanContextRuntime`, and the
   `SpanRef` / `ParentBreakdown` types.

3. **NEW `server/internal/install.ts`** — ALS-backed runtime, installed as a module
   side effect (web never imports this file):
   ```ts
   import { AsyncLocalStorage } from "node:async_hooks";
   import { installSpanContextRuntime, type SpanRef } from "../../core";
   const als = new AsyncLocalStorage<SpanRef>();
   installSpanContextRuntime({ run: (ctx, fn) => als.run(ctx, fn), current: () => als.getStore() });
   ```

4. **NEW `server/index.ts`** — minimal `ServerPluginDefinition` whose only job is to pull
   in the side effect so the runtime is installed at boot (plugin modules are imported
   when `bin/plugins.generated.ts` loads, before `Bun.serve`):
   ```ts
   import "./internal/install";
   import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
   export default { id: "runtime-profiler", name: "Runtime Profiler", loadBearing: true } satisfies ServerPluginDefinition;
   ```
   Auto-discovered by the registry codegen (glob over `plugins/**/server/index.ts`); no
   manual registration. Barrel purity holds: only imports + a single default export.

### Part B — Instrument the entry points (2 edits; the DB site is unchanged)

5. **`plugins/infra/plugins/endpoints/core/implement.ts`** (~line 74) — replace the inline
   `recordSpan("http", …)` with the entry helper:
   ```ts
   const result = await recordEntrySpan("http", _endpoint.route, () =>
     handler({ params: params as TParams, body, query, req }),
   );
   ```
   (Behavior note: now records in `finally`, so a *throwing* handler's duration is also
   captured — a minor improvement over the current skip-on-throw.)

6. **`plugins/framework/plugins/server-core/core/resources.ts`** — rewrite `timedLoad`
   (line ~103) to use the entry helper so DB queries issued inside a loader attribute to it:
   ```ts
   function timedLoad(entry: RegistryEntry, params: ResourceParams): Promise<unknown> {
     return recordEntrySpan("loader", entry.key, () => entry.loader(params));
   }
   ```
   The three call sites (`flushNotifies`, `handleSub`, `handleResourceHttp`) already
   `await timedLoad(...)` — no change.

7. **`plugins/database/server/internal/client.ts`** — **no change.** The pool wrapper's
   `recordSpan("db", text, …)` now auto-attributes via `contextRuntime.current()`.

### Part C — Read surfaces

8. **MCP `…/profiling/plugins/runtime/server/internal/mcp-tools.ts`** — include per
   aggregate `byParent: [{ parentKind, parentLabel, count, avgMs, maxMs }]` (sorted by
   count desc), and `parent: { kind, label } | null` on each `slowest` entry. Tighten the
   tool description to mention caller attribution (the N+1 headline).

9. **`…/profiling/plugins/runtime/shared/endpoints.ts`** — extend the response zod schema:
   add `byParent` array to `aggregateSchema` and `parent` (nullable `SpanRef`) to
   `slowSpanSchema`. (Required for `useEndpoint` to surface the fields client-side.)

10. **`…/profiling/plugins/runtime/web/components/runtime-section.tsx`** — for the DB and
    Loader tables, surface callers. Plan: render each row's `byParent` as an indented
    sub-line under the label (dominant caller first, e.g. `↳ loader:tasksTree ×78`),
    capped to top ~3 with a `+N more` tooltip. HTTP table unchanged (top-level, no parent).
    Reuse the existing `DataTable` primitive and the `toAggRows` mapping.

### Part D — Docs

11. Update `plugins/infra/plugins/runtime-profiler/CLAUDE.md` (document the injected ALS
    context runtime + new exports) and `plugins/database/CLAUDE.md` (note that `db` spans
    now carry the enclosing request/loader as parent). The autogen reference blocks refresh
    via `./equin build`.

## Critical files

- **Edit:** `plugins/infra/plugins/runtime-profiler/core/recorder.ts`, `core/index.ts`
- **New:** `plugins/infra/plugins/runtime-profiler/server/{index.ts,internal/install.ts}`
- **Edit:** `plugins/infra/plugins/endpoints/core/implement.ts`
- **Edit:** `plugins/framework/plugins/server-core/core/resources.ts` (`timedLoad`)
- **Edit:** `plugins/debug/plugins/profiling/plugins/runtime/{server/internal/mcp-tools.ts, shared/endpoints.ts, web/components/runtime-section.tsx}`
- **Unchanged (verify):** `plugins/database/server/internal/client.ts`
- **Reuse:** `recordSpan`/recorder store, `Mcp.tool`, `implement`/`defineEndpoint`, `DataTable`.

## Cycle / boundary safety

- `recorder.ts` still imports nothing → bottom of the DAG, no back-edge possible.
- `implement.ts` and `resources.ts` import only the recorder core (pure) — no new edges,
  web bundle stays Node-API-free (default no-op runtime).
- New `runtime-profiler/server` imports `runtime-profiler/core` + `server-core/core`
  (type) + `node:async_hooks`; nothing imports it back → no cycle.
- Verify with `./equin check --plugin-boundaries`.

## Verification

1. `./equin build` (no schema/migration changes — in-memory only).
2. `./equin check --plugin-boundaries` and `./equin check` — confirm no cycle,
   barrels clean, docs in sync, eslint (no floating promises in the new async paths).
3. Exercise the app at `http://<worktree>.localhost:9000` — open a conversation, the tasks
   pane, etc. — to generate spans with real nesting (loaders issuing queries).
4. **Agent surface (headline):** call MCP `get_runtime_profile` → each `db` aggregate now
   lists `byParent` (e.g. a query at `count 78` showing `loader:<key> ×78`), and `slowest`
   entries carry `parent`. Confirms repeated-query attribution works.
5. **Web surface:** Debug → Profiling → Runtime → confirm the DB/Loader tables show the
   caller sub-lines; "Reset window" clears them.
6. **Negative check:** an `http` route with queries inside its `implement()` handler shows
   those `db` spans attributed to `http:<route>`; a WS-only loader's queries attribute to
   `loader:<key>` with `parent = none` on the loader itself.

## Out of scope / future

- Full per-request span trees / multi-level ancestry chains (this stores one level only).
- `pool.connect()` → `client.query` direct paths (still bypass the wrapper, as in v1).
- Trace-id propagation correlating a single browser request → handler → exact queries.
