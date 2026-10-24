# Runtime profiling — agent-readable request / query / loader timing

## Context

The app feels slow (loads/displays take a while) and **nothing measures runtime latency**.
The repo profiles the *build/deploy lifecycle* well (build spans → `build-profile.json`,
boot spans in-memory, push contention JSONL, a stats-endpoint `Server-Timing` fan-out shown
in Debug → Profiling Gantt) but has **zero per-request, per-query, or per-loader timing** at
runtime. The DB client (`plugins/database/server/internal/client.ts`) is a plain
`drizzle(pool)` with no logger; the endpoint wrapper (`implement()`) and the live-state
`loader()` calls are untimed.

Key constraint surfaced by the user: **agents cannot see Chrome DevTools.** So profiling must
land somewhere an *agent* can read — not a browser panel. The chosen surface is an **in-memory
ring buffer + rolling aggregates per worktree process, read by agents via a new MCP tool**, plus
a human-facing section in the existing Profiling pane, plus a scripted Playwright harness that
harvests browser `performance` entries to a JSON file the agent can `Read`.

Decisions (confirmed with user):
- **Storage: in-memory + MCP** (no DB table — avoids write-amplification and the recursive
  "profiling-the-profiling-INSERT" problem; near-zero hot-path overhead; window-bounded, lost on
  restart, which is fine for live iterate-and-measure).
- **Scope: full stack** — recorder + 4 instrumentation points + MCP tool + web Profiling section
  + `e2e/perf.mjs` frontend harness.

The closed loop this enables: change code → `./equin build` → call the MCP tool / run the
e2e script → see which routes/queries/loaders are slow → fix → re-measure. No human-in-DevTools.

---

## Architecture

Three span kinds, all recorded through one zero-dependency primitive:

| Kind     | Recorded at (chokepoint)                                              | Label (group key)            |
|----------|----------------------------------------------------------------------|------------------------------|
| `http`   | `endpoints/core/implement.ts` — around the single `handler()` call   | `_endpoint.route`            |
| `db`     | `database/server/internal/client.ts` — wrap `pool.query`             | normalized SQL text (capped) |
| `loader` | `server-core/core/resources.ts` — 3 loader call sites via `timedLoad`| `entry.key`                  |

The recorder keeps, per kind:
- **Rolling aggregates** keyed by label: `{ count, totalMs (→ avg), maxMs, lastMs }`.
- **A bounded "slowest recent" buffer** (cap ~50/kind) of full spans with detail (route / SQL /
  key + durationMs + a relative timestamp from `performance.now()`), for the "what was slow just
  now" view.

Memory is tiny and bounded (labels are code-path-bounded: hundreds of routes/queries/keys).

### Why a standalone zero-dep plugin for the recorder (cycle safety)

The recorder is imported by `endpoints/core`, `database/server`, and `server-core/core` — all
load-bearing and low in the DAG. It must import **nothing** so no back-edge can ever form a cycle
(notably: the Profiling sub-plugin that *reads* the recorder uses `implement()` + `Mcp.tool`, so
it depends on endpoints — the recorder must not live there or it'd be a direct cycle).
`implement()` is exported from `endpoints/**core**` and bundled isomorphically, so the recorder
must be **isomorphic (a `core` barrel, pure JS, no Node APIs)** — it works everywhere; only the
server process accumulates meaningful data.

---

## Implementation

### Part A — Recorder primitive (new plugin, core-only, zero deps)

`plugins/infra/plugins/runtime-profiler/`
- `core/index.ts` — barrel. Mirror an existing pure-library primitive's barrel shape
  (e.g. `plugins/primitives/plugins/rank/core/index.ts`) for the `definePlugin`/export
  convention; no contributions, not registered in any `plugins.ts` (pure library, imported
  directly).
- `core/recorder.ts` — the store + API:
  ```ts
  export type SpanKind = "http" | "db" | "loader";
  export interface SlowSpan { kind: SpanKind; label: string; durationMs: number; atMs: number; }
  export interface Aggregate { label: string; count: number; totalMs: number; maxMs: number; lastMs: number; }

  export function recordSpan(kind: SpanKind, label: string, durationMs: number): void;
  export function getRuntimeProfile(): {
    aggregates: Record<SpanKind, Aggregate[]>;   // sorted by maxMs desc
    slowest: Record<SpanKind, SlowSpan[]>;       // most recent slow spans
    sinceMs: number;                             // window start (process-relative)
  };
  export function resetRuntimeProfile(): void;    // for the "reset window" button / fresh measurement
  ```
  - Guard each `recordSpan` with a cheap kill switch: `if (process.env.SINGULARITY_PROFILING === "0") return;`
  - Cap stored SQL/label text length (~500 chars). For `db`, store the **query text only** (pg
    params are separate `$1,$2…` placeholders → already normalized, no literal values leak).

### Part B — Instrument the chokepoints (4 edits, no call-site changes elsewhere)

1. **`plugins/infra/plugins/endpoints/core/implement.ts`** (line 73): wrap the one `handler()` call.
   ```ts
   const t0 = performance.now();
   const result = await handler({ params: params as TParams, body, query, req });
   recordSpan("http", _endpoint.route, performance.now() - t0);
   ```
   Note: record after the call but still inside `try` is fine; on throw the span is skipped (the
   handler errored — surfaced elsewhere). Keep it simple: one line after the existing `const result`.

2. **`plugins/database/server/internal/client.ts`** (after `new Pool(...)`, before `drizzle(pool)`):
   wrap `pool.query` to time every query.
   ```ts
   const origQuery = pool.query.bind(pool);
   // Only the promise form is timed (drizzle/node-postgres uses it); callback form passes through.
   pool.query = ((...a: Parameters<typeof origQuery>) => {
     const text = typeof a[0] === "string" ? a[0] : (a[0] as { text?: string })?.text ?? "?";
     const t0 = performance.now();
     const r = origQuery(...a);
     if (r && typeof (r as Promise<unknown>).finally === "function") {
       return (r as Promise<unknown>).finally(() => recordSpan("db", text, performance.now() - t0));
     }
     return r;
   }) as typeof pool.query;
   export const db = drizzle(pool);
   ```
   Captures all drizzle ORM queries + the `awaitDbReady` `SELECT 1`. Direct `pool.connect()` →
   `client.query` paths bypass (rare); note this limitation in the plugin CLAUDE.md.

3. **`plugins/framework/plugins/server-core/core/resources.ts`** — add a `timedLoad` helper and use
   it at the 3 loader call sites (≈ lines 302 `flushNotifies`, 437 `handleSub`, 505
   `handleResourceHttp`):
   ```ts
   async function timedLoad(entry: RegistryEntry, params: ResourceParams): Promise<unknown> {
     const t0 = performance.now();
     try { return await entry.loader(params); }
     finally { recordSpan("loader", entry.key, performance.now() - t0); }
   }
   ```
   Replace `await entry.loader(params)` → `await timedLoad(entry, params)` at each site (and
   `resourceParams` at the HTTP one). `entry.key` is the stable label.

All three import `recordSpan` from `@plugins/infra/plugins/runtime-profiler/core`.

### Part C — Profiling sub-plugin (reads recorder → MCP + web)

`plugins/debug/plugins/profiling/plugins/runtime/` (mirror the `boot` sub-plugin end-to-end).
- `shared/endpoints.ts` — `export const getRuntimeProfile = defineEndpoint({ route: "GET /api/debug/profiling/runtime" });`
  (+ optionally `POST /api/debug/profiling/runtime/reset`).
- `server/internal/handle-runtime-profiling.ts` — `implement(getRuntimeProfile, () => getRuntimeProfile())`
  from the recorder (import the data fn under a different local name to avoid the endpoint-name clash).
- `server/internal/mcp-tools.ts` — **the primary agent surface**:
  ```ts
  export const runtimeProfileTool = Mcp.tool({
    name: "get_runtime_profile",
    description: "Slowest HTTP routes, DB queries, and live-state loaders in this worktree's server (in-memory window). Use to debug app slowness.",
    inputSchema: { kind: z.enum(["http","db","loader","all"]).optional(), limit: z.number().optional() },
    async handler({ kind = "all", limit = 15 }) {
      // shape recorder output → top-N by maxMs (and avg) per requested kind
      return { content: [{ type: "text", text: JSON.stringify(...) }] };
    },
  });
  ```
- `server/index.ts` — `{ id: "debug-profiling-runtime", httpRoutes: { [getRuntimeProfile.route]: handleRuntimeProfiling }, register: [runtimeProfileTool] }`.
- `web/index.ts` — `Profiling.Section({ id: "runtime", order: 5, component: RuntimeSection })`.
- `web/components/runtime-section.tsx` — fetches the endpoint; renders **three sortable tables**
  (HTTP / DB / Loaders) showing label · count · avg · max, sorted by max desc, plus a "reset
  window" button. **Divergence from the GanttSection precedent is intentional and justified:**
  runtime data is a continuous *aggregate* (count/avg/max per recurring label), not a one-shot
  span timeline like boot/build — a Gantt would misrepresent it. Use the existing
  `plugins/primitives/plugins/data-table/web` primitive.

### Part D — Frontend perf harness (new script)

`e2e/perf.mjs` (standalone Bun script, mirror `e2e/screenshot.mjs` launch shape; dependency-free):
- `page.addInitScript(...)` before `goto` to install `PerformanceObserver`s accumulating into
  `window.__perf` (LCP, CLS, longtasks) — avoids the "buffer empty after the fact" problem; no
  `web-vitals` dependency needed.
- `goto(url)` → `waitForTimeout(waitMs)` → `page.evaluate` to collect:
  - `performance.getEntriesByType("navigation")[0]` (TTFB, DCL, load),
  - `performance.getEntriesByType("resource")` mapped to `{ name, duration, transferSize }`,
    filtered/sorted to surface slow `/api/*` and `/ws` calls,
  - `window.__perf` (LCP / CLS / longtasks).
- **Print a summary table to stdout** (so the agent sees it directly) **and** write
  `/tmp/<out>-perf.json` for deeper `Read`.
- Invocation: `bun e2e/perf.mjs --url http://<worktree>.localhost:9000/c/<id> --out /tmp/run`.

---

## Critical files

- **New:** `plugins/infra/plugins/runtime-profiler/core/{index.ts,recorder.ts}`
- **New:** `plugins/debug/plugins/profiling/plugins/runtime/{shared,server,web}/...` (mirror `…/profiling/plugins/boot/`)
- **New:** `e2e/perf.mjs` (mirror `e2e/screenshot.mjs`)
- **Edit:** `plugins/infra/plugins/endpoints/core/implement.ts` (line 73)
- **Edit:** `plugins/database/server/internal/client.ts` (around line 24–29) + note bypass caveat in `plugins/database/CLAUDE.md`
- **Edit:** `plugins/framework/plugins/server-core/core/resources.ts` (lines ~302, 437, 505 + `timedLoad` helper)
- **Reuse:** `Mcp.tool` (`plugins/infra/plugins/mcp/server`), `implement`/`defineEndpoint`
  (`@plugins/infra/plugins/endpoints/{core,server}`), `Profiling.Section` slot +
  `data-table` primitive, `e2e/screenshot.mjs` as a template.

---

## Verification

1. `./equin build` (regenerates nothing DB-side — no new table; just rebuilds + restarts).
2. `./equin check --plugin-boundaries` — confirm the recorder import edges form no cycle and
   all cross-plugin imports go through barrels.
3. Exercise the app (open a conversation, the tasks pane, etc.) at
   `http://<worktree>.localhost:9000` to generate spans.
4. **Agent surface:** call MCP `get_runtime_profile` → expect JSON listing slowest HTTP routes,
   DB queries, and loaders by max/avg. This is the headline deliverable.
5. **Human surface:** open Debug → Profiling → "Runtime" section; confirm the three sortable
   tables populate and the reset button clears the window.
6. **Frontend harness:** `bun e2e/perf.mjs --url http://<worktree>.localhost:9000/c/<id> --out /tmp/run`
   → confirm stdout summary + `/tmp/run-perf.json` with navigation/resource/web-vitals data, and
   that slow `/api/*` rows are visible.
7. Cross-reference: a route slow in the browser waterfall (step 6) should show matching
   handler/query time in the MCP output (step 4) — that triangulates client vs server vs DB.

## Out of scope / future
- DB persistence + `query_db` access (rejected: write-amplification/recursion).
- Trace-id propagation to correlate a single browser request → handler → exact queries.
- `pool.connect()`/`client.query` direct-path timing and INP (needs interaction simulation).
