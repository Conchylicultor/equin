# Unify the duplicated live-state resource runtime

## Context

The live-state primitive (`defineResource`, the broadcast machinery, the WS/HTTP
handlers) exists as two near-parallel copies:

- `plugins/framework/plugins/server-core/core/resources.ts` (923 lines)
- `plugins/framework/plugins/central-core/core/resources.ts` (496 lines)

They began as a deliberate v1 mirror (documented at `central-core/core/resources.ts:5-8`),
but `server-core` has since diverged into a **superset**: keyed delta-sync
(`keyOf`/`diffKeyed`/`diffKeyedScoped`/`snapshotOf`), Layer-2 scoped recompute
(`affectedIds`/`affectedMap`/`PendingNotify`/`mergePending`), `withNotifyBatch`,
runtime-profiler spans (`timedLoad`→`recordEntrySpan`), `reportServerError`, and
the `Resource.Declare` debug-owner contribution. `central-core` is a strict
subset. Every change must currently be written twice and the two can silently
drift — most recently the mandatory-schema + server-validation change
(`research/2026-06-08-global-mandatory-resource-schema-server-validation.md`,
"Why not unify now"). This plan eliminates the duplication.

**Intended outcome:** one shared, parameterized resource runtime. server-core and
central-core each instantiate it with their runtime-specific hooks. The ~42
`defineResource` call sites and ~37 `Resource.Declare` contributors **do not
change** — server-core and central-core remain the stable public facades.

**Decisions (confirmed with user):**
- Unify **both** runtimes now (central-core change explicitly authorized this
  conversation — it runs one shared process for all worktrees and merges to main
  on push; it cannot be fully exercised inside this worktree).
- central exposes the **full superset** surface (`keyed`/`affectedIds`/
  `withNotifyBatch` present but dormant — central's lone `auth-state` resource
  uses none of them). No re-narrowing, zero extra wrapper code.

## Design

### New plugin: `plugins/framework/plugins/resource-runtime/` (core-only)

A pure library plugin (no web/server/central runtime registration — precedent:
`boundaries`, `web-sdk`, `collections`, `runtime-profiler/core`). Exposes a
single factory:

```ts
export interface ResourceRuntimeOptions {
  /** Wrap each loader call. server: recordEntrySpan("loader", key, fn); central: omit (identity). */
  wrapLoad?: (key: string, fn: () => Promise<unknown>) => Promise<unknown>;
  /** Report a loader/map/lifecycle failure. console.error ALWAYS fires inside the runtime;
   *  this is the extra hook. server: reportServerError(errorReport(ctx, err)); central: omit. */
  reportError?: (context: string, err: unknown) => void;
  /** Per-key owner metadata for the _debug endpoint. server: from Resource.Declare; central: omit. */
  debugOwners?: () => Array<{ key: string; pluginId?: string; pluginName?: string }>;
}

export interface ResourceRuntime {
  defineResource: <T, P extends ResourceParams = ResourceParams>(
    def: ResourceDefinition<T, P>,
  ) => Resource<T, P>;
  notificationsWsHandler: WsHandler;
  handleResourceHttp: (req: Request, params: Record<string, string>) => Promise<Response>;
  withNotifyBatch: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createResourceRuntime(opts?: ResourceRuntimeOptions): ResourceRuntime;
```

**Implementation = server-core's current `resources.ts`, verbatim**, with every
module-level singleton (`registry`, `sockets`, `topoOrder`, `dagDirty`,
`flushScheduled`, `batchDepth`, `heartbeats`) moved into the factory closure and
every helper (`paramsKey`, `mergePending`, `rebuildDag`, `snapshotOf`,
`diffKeyed`, `diffKeyedScoped`, `scheduleNotify`, `flushNotifies`,
`subscribersFor`, `sendJson`, `timedLoad`, `handleSub`, `handleUnsub`,
`releaseSubRefcount`, `handleResourceHttp`, `handleResourcesDebug`) becoming an
inner closure that captures it. No classes (server-core convention: "no base
classes"); a factory of closures matches the codebase style.

Three call sites consult the injected hooks instead of importing server-core
symbols directly:

- `timedLoad`: `const run = async () => entry.schema.parse(await entry.loader(params, ctx));
  return opts.wrapLoad ? opts.wrapLoad(entry.key, run) : run();`
  (also covers the handle `load()` path so validation stays total).
- Every `console.error(...) + reportServerError(errorReport(...))` pair becomes a
  single local helper `reportLoaderError(ctx, err)` that does
  `console.error(...)` then `opts.reportError?.(ctx, err)`.
- `handleResourcesDebug`: builds `ownerByKey` from `opts.debugOwners?.() ?? []`
  instead of reading `Resource.Declare.getContributions()`.

**Types owned by the runtime** (moved out of both `resources.ts`):
`ResourceMode` (full, incl. `"keyed"`), `ResourceParams`, `DependsOnEntry` (with
`affectedMap`), `ResourceDefinition`, `Resource`, plus internal `DownstreamEdge`,
`PendingNotify`, `RegistryEntry`, `KeyedDiff`, `SocketState`.

**WS types:** `WsData`/`WsHandler` are byte-identical in both runtimes' `types.ts`.
The factory cannot import them from server-core/central-core (would create a
cycle), so it declares its own local copy (4-line structural interfaces). The
returned `notificationsWsHandler` is structurally assignable to each runtime's
`WsHandler` — server/central bins wire it into their `wsRoutes` unchanged. (The
pre-existing WsData/WsHandler duplication between server-core and central-core is
out of scope.)

Runtime imports: only `zod` (`ZodType`) and `bun` (`ServerWebSocket` type). It is
a DAG leaf — nothing in the runtime imports server-core or central-core.

### `server-core/core/resources.ts` → thin instantiation (≈40 lines)

Keeps the file (so `core/index.ts`'s `export … from "./resources"` is unchanged)
but its body becomes:

```ts
import { createResourceRuntime } from "@plugins/framework/plugins/resource-runtime/core";
import type {
  Resource as RtResource, ResourceDefinition as RtDef,
  ResourceMode as RtMode, ResourceParams as RtParams, DependsOnEntry as RtDep,
} from "@plugins/framework/plugins/resource-runtime/core";
import { recordEntrySpan } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineServerContribution } from "./contributions";
import { reportServerError, type ServerErrorReport } from "./error-reporter";

// Re-present the runtime types as server-core's stable public surface (type
// aliases are permitted in barrels; keeps the ~42 consumers untouched).
export type ResourceParams = RtParams;
export type ResourceMode = RtMode;
export type Resource<T, P extends ResourceParams = ResourceParams> = RtResource<T, P>;
export type ResourceDefinition<T, P extends ResourceParams = ResourceParams> = RtDef<T, P>;
export type DependsOnEntry<P extends ResourceParams = ResourceParams> = RtDep<P>;

// Resource.Declare stays here — its ~37 contributors import it from server-core.
export const Resource = {
  Declare: defineServerContribution<{ key: string; mode: ResourceMode }>("resource.declare"),
};

function errorReport(context: string, err: unknown): ServerErrorReport { /* moved from resources.ts */ }

const runtime = createResourceRuntime({
  wrapLoad: (key, fn) => recordEntrySpan("loader", key, fn),
  reportError: (ctx, err) => reportServerError(errorReport(ctx, err)),
  debugOwners: () =>
    Resource.Declare.getContributions().map((c) => ({
      key: c.key, pluginId: c._pluginId, pluginName: c._pluginName,
    })),
});

export const { defineResource, notificationsWsHandler, handleResourceHttp, withNotifyBatch } = runtime;
```

Note `Resource` is both a value (`const`, with `.Declare`) and a generic type
(`export type Resource<T,P>`) — exactly as today; value/type namespaces coexist.
`core/index.ts` is **unchanged** (it already re-exports these names from
`./resources`).

### `central-core/core/resources.ts` → thin instantiation (≈20 lines)

Same pattern, minimal hooks (no profiler, no error reporter, no declare):

```ts
import { createResourceRuntime } from "@plugins/framework/plugins/resource-runtime/core";
import type {
  Resource as RtResource, ResourceDefinition as RtDef,
  ResourceMode as RtMode, ResourceParams as RtParams, DependsOnEntry as RtDep,
} from "@plugins/framework/plugins/resource-runtime/core";

export type ResourceParams = RtParams;
export type ResourceMode = RtMode;       // now the full superset (incl. "keyed")
export type Resource<T, P extends ResourceParams = ResourceParams> = RtResource<T, P>;
export type ResourceDefinition<T, P extends ResourceParams = ResourceParams> = RtDef<T, P>;
export type DependsOnEntry<P extends ResourceParams = ResourceParams> = RtDep<P>;

const runtime = createResourceRuntime();  // console.error-only on failure (matches today)
export const { defineResource, notificationsWsHandler, handleResourceHttp } = runtime;
// withNotifyBatch is available from the runtime but central need not export it yet.
```

`central-core/core/index.ts` is **unchanged** — it re-exports the same names from
`./resources`. central's HTTP handler is path-agnostic (gets `params.key`); the
bin still mounts it under `/api/central-resources/:key`. central's `_debug`
endpoint loses nothing meaningful (it never had owner enrichment).

## Boundary / build compliance (verify, don't assume)

- New plugin imported only as `@plugins/framework/plugins/resource-runtime/core`
  (a legal runtime-barrel import) from server-core/core and central-core/core.
  core→core cross-plugin imports are allowed.
- **Type aliases in barrels are explicitly permitted**; we use aliases (not bare
  `export … from "@plugins/other"`) precisely to avoid the no-cross-plugin-re-export
  rule. The bound value exports (`defineResource`, etc.) are *defined* in
  server-core/central-core's own `resources.ts` (destructured from the factory),
  so they are own-file exports, not proxied symbols.
- Run `./equin check plugin-boundaries` after — if it flags the type
  aliases, fall back to declaring server-core/central-core-local wrapper types
  that `extends`/reference the runtime types. (Expected: passes.)
- `migrations-in-sync` / `plugins-doc-in-sync` checks: no schema changes; docgen
  regenerates the new plugin's reference block (run `./equin build`).

## Files

**New:**
- `plugins/framework/plugins/resource-runtime/package.json`
  (`@singularity/plugin-framework-resource-runtime`, mirror `runtime-profiler`'s)
- `plugins/framework/plugins/resource-runtime/tsconfig.json` (mirror a sibling
  core-only framework plugin)
- `plugins/framework/plugins/resource-runtime/core/index.ts` (barrel: exports
  `createResourceRuntime`, `ResourceRuntime`, `ResourceRuntimeOptions`, and the
  resource types)
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` (the factory —
  server-core's current resources.ts body, closure-scoped + hook-injected)
- `plugins/framework/plugins/resource-runtime/CLAUDE.md` (prose + autogen block)

**Modified:**
- `plugins/framework/plugins/server-core/core/resources.ts` → thin instantiation
- `plugins/framework/plugins/central-core/core/resources.ts` → thin instantiation
- `plugins/primitives/plugins/live-state/CLAUDE.md` — note the single shared
  runtime backing both channels (if it documents the duplication)
- `research/2026-06-08-global-mandatory-resource-schema-server-validation.md` —
  close the "Why not unify now" follow-up (link this doc)

**Unchanged (verify):** all ~42 `defineResource` call sites, all ~37
`Resource.Declare` contributors, both `core/index.ts` barrels, server & central
`bin/index.ts` route wiring, the client (`live-state/web`).

## Verification

1. `./equin build` — TypeScript compiles across all plugins (the type
   aliases + structural WsHandler must resolve). Docgen regenerates cleanly.
2. `./equin check` — `plugin-boundaries`, `eslint` (promise-safety:
   `sendJson`'s bare-catch must keep its existing eslint-disable), and
   `plugins-doc-in-sync` all pass.
3. **Server happy path:** open `http://<worktree>.localhost:9000`, exercise live
   surfaces that span all runtime features:
   - keyed delta lists — tasks tree, conversations sidebar (open one, mutate it,
     confirm a single-row delta lands, not a full reload).
   - push/invalidate — build history, task events.
   - `withNotifyBatch` path — a mutation that notifies several resources.
4. **HTTP fallback:** `curl http://<worktree>.localhost:9000/api/resources/tasks`
   and `/api/resources/_debug` — confirm `{value, version}` and that `_debug`
   still shows `pluginId`/`pluginName` owner enrichment (proves `debugOwners`
   wiring).
5. **Profiler:** confirm loader spans still appear in the Gantt debug pane
   (proves `wrapLoad` → `recordEntrySpan`).
6. **Fail-loud:** temporarily make one loader return a schema-violating value,
   rebuild, subscribe → server logs + crash task fire and the send is skipped
   (proves `reportError` wiring). Revert.
7. **central:** confirm the Accounts UI (`auth-state`, central path
   `/ws/central-notifications`) still connects and drives connected-state. NOTE:
   central runs one shared process across worktrees and only fully exercises
   after push/restart — call this out at review time.
