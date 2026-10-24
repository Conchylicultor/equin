# Task 1 — Unify the resource read path behind `getResourceValue` + single-flight

**Date:** 2026-06-19
**Category:** global (resource-runtime)
**Implements:** Task 1 of [`research/2026-06-19-global-live-state-unified-read-path-v2.md`](./2026-06-19-global-live-state-unified-read-path-v2.md).
**Diagnosis it relieves:** [`research/2026-06-19-global-parallel-load-loader-contention.md`](./2026-06-19-global-parallel-load-loader-contention.md) §A, finding 6 ("No coalescing of duplicate loads").

## Context

App load fans out N independent per-resource DB loads that stampede the 16-connection pool. Inside the live-state runtime, every read funnels through `timedLoad` (`resource-runtime/core/runtime.ts`), but it runs the loader **unconditionally** for every WS `sub`, every HTTP GET, and every `loadResourceByKey`. So N tabs each firing boot-snapshot, N sockets subscribing the same global resource, or a GET racing a `sub` each re-run the same loader concurrently — multiplying the herd that hits the pool.

The `inflight` single-flight primitive (`@plugins/packages/plugins/inflight/core`) exists and is proven (wired into `endpoints` + `get-edited-files`) but is **not** wired into the runtime's read path.

This task introduces `getResourceValue` as the **one named read accessor**, with `inflight` single-flight inside it, so concurrent identical `(key, params)` full loads collapse to one loader run. It is the lowest-risk, immediate-relief foundation for the rest of the v2 end-state (cache, gate-at-checkout, boot-from-cache). **No cache yet** — behavior is identical except duplicate concurrent loads coalesce.

**Critical correctness guard:** scoped keyed-delta loads (`ctx.affectedIds`, Layer 2) return a *partial* array. They must be **excluded** from coalescing — otherwise a plain full-load subscriber could attach to a partial scoped load and ship a torn snapshot, and two scoped loads with different `affectedIds` are not the same work.

## Design

In `plugins/framework/plugins/resource-runtime/core/runtime.ts`:

### 1. Instantiate one `inflight` per runtime

Next to `const registry = new Map(...)` (~`:258`), inside `createResourceRuntime`:

```ts
import { createInflight } from "@plugins/packages/plugins/inflight/core";
// ...
const inflight = createInflight();
```

One instance per runtime — isolated like the registry/sockets/DAG, so the per-worktree and central runtimes never share an in-flight map.

### 2. Demote `timedLoad` to the internal refill primitive; add `getResourceValue` as the one read accessor

`timedLoad` stays as the *only* thing that runs `entry.loader` (parse + `wrapLoad`/profiler span). `getResourceValue` becomes the single read entry point that all read call sites go through:

```ts
// Internal refill primitive — the ONLY place entry.loader runs. Parses the
// output against the resource schema and establishes the profiler/ambient
// context via wrapLoad. Private to the read accessor + the keyed reseed below.
function timedLoad(entry, params, ctx?) {
  const run = async () => entry.schema.parse(await entry.loader(params, ctx));
  return opts.wrapLoad ? opts.wrapLoad(entry.key, run) : run();
}

// The single read accessor. Full loads (ctx === undefined: sub-ack, HTTP
// fallback, loadResourceByKey, plain notify-reload) share ONE in-flight loader
// promise per (key, params) — collapsing the multi-tab / GET-races-sub herd.
// The shared parsed value is treated as IMMUTABLE by every coalesced caller
// (all current downstream consumers are read-only). inflight clears the key the
// instant the promise settles, so the next load is fresh — error/staleness
// sharing is safe.
//
// Scoped keyed-delta loads (ctx.affectedIds, Layer 2) return a PARTIAL array
// and NEVER coalesce: a plain subscriber must not attach to a partial load
// (torn snapshot), and two scoped loads with different affectedIds are not the
// same work. They run the refill directly.
function getResourceValue(entry, params, ctx?) {
  if (ctx) return timedLoad(entry, params, ctx);
  return inflight.run(`${entry.key} ${paramsKey(params)}`, () => timedLoad(entry, params));
}
```

Single-flight is **outside** the loader semaphore (the semaphore lives in `wrapLoad`, which runs inside the `timedLoad` body wrapped by `inflight.run`) — a deduped caller awaits the in-flight promise without consuming a gate slot. Mirrors the proven dedupe-outermost ordering in `endpoints/core/implement.ts:96`.

### 3. Route the call sites through `getResourceValue`

Five existing `timedLoad` call sites → `getResourceValue`:

| Call site | Line (approx) | `ctx` | Coalesces? |
|---|---|---|---|
| `handleSub` (sub-ack) | `:841` | none | yes |
| `handleResourceHttp` (HTTP GET) | `:920` | none | yes |
| `loadResourceByKey` (boot-snapshot warm-up + snapshot handler) | `:982` | none | yes |
| `flushNotifies` value compute | `:629` | scoped *or* undefined | only when full |
| `flushNotifies` keyed-reseed (near-unreachable) | `:651` | undefined | yes |

The `flushNotifies:629` site passes `ctx = scoped ? {affectedIds} : undefined`, so the `if (ctx)` guard automatically excludes scoped recomputes while still coalescing a notify-triggered **full** reload with a concurrent sub-ack. (`flushNotifies` already skips empty scoped sets at `:610`, so a defined `ctx` always carries ≥1 id — the guard is a clean discriminator.)

**Out of scope (left untouched):** the `resource.load()` handle method (`:394`) bypasses `timedLoad` entirely and has no callers today; folding it into `getResourceValue` belongs to Task 5 (harden / un-bypassable). No cache, no gate changes, no `gate:` taxonomy (Task 2/3).

### 4. Update the DAG-leaf claim (new edge `resource-runtime → packages/inflight`)

`resource-runtime` is no longer a pure leaf — it now imports `packages/inflight` (itself a leaf, so still no cycle). Update:
- The file header comment in `runtime.ts` (`:27`–`:31`, "imports only `zod` … and `bun`").
- The "It is a **DAG leaf**: it imports only `zod` … and `bun`" prose in `plugins/framework/plugins/resource-runtime/CLAUDE.md`.
- The autogen reference blocks (`plugins-details.md`, `plugins-compact.md`, the CLAUDE.md `Uses` line) are regenerated by `./equin build` — do **not** hand-edit; the `plugins-doc-in-sync` check guards drift.

## Critical files

| Concern | File |
|---|---|
| `getResourceValue` + `inflight` + call-site rewrite | `plugins/framework/plugins/resource-runtime/core/runtime.ts` |
| The single-flight primitive (reused, no change) | `plugins/packages/plugins/inflight/core/internal/inflight.ts` |
| Reference ordering (dedupe-outermost) | `plugins/infra/plugins/endpoints/core/implement.ts:96` |
| DAG-leaf prose | `plugins/framework/plugins/resource-runtime/CLAUDE.md` |

## Correctness invariants

- **Scoped loads never coalesce and never serve a full subscriber** — the `if (ctx)` guard.
- **The shared parsed value is immutable** — all coalesced callers read it; none mutate. (One-line comment added; current consumers already comply.)
- **Coalescing is strictly safer for keyed full reloads:** a `flushNotifies` full reload sharing one value with a concurrent sub-ack means both seed identical `id→hash` snapshots from the same array (vs. today's two independent loads that could read different DB states and race the snapshot). No torn snapshot is introduced.
- **Failure/staleness sharing is safe** — `inflight` deletes the key in `finally`, so a rejection is shared only by the in-flight callers, then the next call retries fresh.
- **No version-semantics change** — `entry.versions` is read/bumped at each call site outside `getResourceValue`, unchanged.

## Verification

1. **Build + checks:** `./equin build` then `./equin check` (type-check, plugin-boundaries, plugins-doc-in-sync all green; confirms the new `resource-runtime → packages/inflight` edge is legal and docs regenerated).
2. **Coalescing works (the point of the task):** fire many concurrent identical reads and confirm the loader runs once.
   - `for i in $(seq 1 16); do curl -s "http://<wt>.localhost:9000/api/resources/<some-db-loader-key>" >/dev/null & done; wait`
   - Inspect `mcp__singularity__get_runtime_profile kind:"loader"`: the loader **count** for that key should be ~1 per concurrent burst (not 16). Before this change it is 16.
3. **Herd relief on boot:** under the 16-concurrent-`boot-snapshot` storm, `[loader-acquire]` / `[acquire]` max (`get_runtime_profile kind:"db"`) drops because the distinct work shrinks (counts fall, not just latency).
4. **No torn / stale keyed data (the correctness guard):**
   - Trigger an **isolated** keyed change (e.g. one task/attempt status change) with two tabs open on that resource → the scoped delta lands promptly in both, no torn snapshot (scoped loads bypassed coalescing).
   - Trigger a **burst** → one coalesced refill, correct final value.
   - Open the same keyed resource in N tabs simultaneously (sub-ack storm) → all tabs show identical, complete data.
5. **Optional co-located unit test** (`runtime.test.ts`, `bun:test`): build a runtime with a call-counting loader; assert two overlapping `getResourceValue` calls with the same `(key, params)` and no `ctx` invoke the loader **once**, while two calls with distinct `ctx.affectedIds` invoke it **twice**.
