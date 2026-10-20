# Demo browser-host boot timing

## Context

`/demo` (and the agent-manager demo exhibit) mounts `<DemoScope>`, which starts the scenario's
browser host: a Web Worker that loads the portable server graph (72 plugins now), runs its
migrations on PGlite, seeds the stories and posts `ready`. Nothing records how long that takes:
the 0.9–1.6 s figure in `research/2026-10-19-global-browser-worker-host-on-pglite.md` was read by
hand off the worker console, and the 53 → 72 plugin step (`2026-10-20-global-demo-stubs-to-worker.md`)
could not be measured for the subtrack page.

Outcome: every host boot writes one line to a persisted log (and the page console) that says how
long the user waited and where the worker spent it, so anyone (agent or user) reads the number with
`tail` after opening `/demo`.

## Design

The worker already measures most of it: server-core's profiler (`core/profiler.ts`) records a span
per `register` / `onReadyBlocking` hook in every boot mode, `browser` included. What is missing is
(1) a whole-boot measurement split into stages, (2) carrying it out of the worker, (3) writing it
somewhere persistent.

1. **`bootBrowserHost` reports its boot** (`server-core/core/browser-host.ts`). `BrowserHost` gains
   a required `boot: BrowserHostBoot`:
   ```ts
   { plugins: number;                         // nodes the graph booted
     stages: { name: string; ms: number }[];  // "graph" (load → ready barrier), "seed"
     slowest: { label: string; ms: number }[] } // top 5 profiler spans (getProfilingData)
   ```
   Stages are timed with `performance.now()` around `bootPluginGraph` and `seed`.

2. **The port carries it** (`browser-server/core/internal/port.ts`). `PortServer` gains a required
   `boot: HostBoot` (same shape, declared structurally in browser-server — server-core cannot be
   imported from here without a cycle through `infra/endpoints`, and the demo's `bin/browser-host.ts`
   passes `host.boot` through, so tsc checks the two agree). `serveOverPort` adds `readyAtMs`
   — the worker's `performance.now()` when it posts `ready`, i.e. ms since the worker was created
   (a dedicated worker's `timeOrigin`), covering bundle fetch + evaluation too — to the `ready`
   frame; `portBrowserServer` resolves with it. Required, not optional: a host that boots without
   saying how long it took has no spelling.

3. **The scope logs it** (`demo/scope/web/components/demo-scope.tsx`). `startScopeServer` takes
   `performance.now()` before `host()` and, on ready, emits one line via
   `clientLog("demo-host-boot", …)` (`primitives/log-channels/web` — a module-level POST to the
   real backend, not through the scope's transport) and `console.info`:
   ```
   agent-manager: ready in 2140 ms (worker ready at 2050 ms: graph 1500 ms, seed 310 ms; 72 plugins) — slowest: onReadyBlocking:database/migrations 820 ms, …
   ```
   Persisted at `~/.singularity/worktrees/<wt>/logs/demo-host-boot.jsonl`, listed in Debug → Logs.

## Files

- `plugins/framework/plugins/server-core/core/browser-host.ts` — time stages, `boot` on `BrowserHost`.
- `plugins/framework/plugins/browser-server/core/internal/port.ts` (+ `index.ts` type export, `port.test.ts`).
- `plugins/apps/plugins/agent-manager/plugins/demo/bin/browser-host.ts` — pass `host.boot`.
- `plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web/components/demo-scope.tsx` — log.
- The scope's `CLAUDE.md` — one bullet: where the boot line is.

## Verification

- `./singularity test plugins/framework/plugins/browser-server` (port round trip asserts `boot` and
  `readyAtMs` cross the port), the demo-scope jsdom tests.
- `./singularity build`, open `/demo` with `browser_navigate`, then
  `tail ~/.singularity/worktrees/<wt>/logs/demo-host-boot.jsonl` shows the line; report the
  measured 72-plugin boot time.
