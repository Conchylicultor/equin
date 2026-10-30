# Portable retention sweeps and warm-ups, run on every host

Track: wiki subtrack "portable server code (server/ vs machine/)" (block-323b766d-7ddf-4555-820a-80d82d6737f3), item 2 of "[Framework] Adding an app to the demo is (almost) no manual work".

## Context

Two primitives live in barrels the browser host cannot load:
- `defineRetention` (`plugins/infra/plugins/retention`): "delete rows of this table older than N days, nightly".
- `defineWarmup` (`plugins/infra/plugins/warmup`): "after boot, run this catch-up step".

So a portable plugin that only wants to declare one has to grow a `machine/` half. Eleven `machine/` halves hold nothing else, and the Pages splits (agent-origin, history engine, content search) existed only for this. Every app joining the demo repeats that hand work.

**In both cases the declaration is portable; one import is not.**
- Retention: `retention/server/internal/growth-bounds.ts:1` imports `getFileSinks` from `file-sink/core` (`node:fs`), only to merge file bounds into `getGrowthBounds()`. `getGrowthBounds()` has zero callers. Everything else retention imports (db, change-feed, jobs) is already portable.
- Warm-up: `warmup/server/internal/executor.ts` (`drainWarmups`) imports `withHeavyReadSlot` (`host-read-pool` → `host-admission`, `bun:ffi` flock). `defineWarmup`, the registry and `runs.ts` are portable.

**Decision (with the user): both run on EVERY host.** The browser host will run real persistent apps (IndexedDB, used for days). Such an app needs:
- its tables pruned, the same as the desktop;
- its catch-up backfills run, e.g. a plugin added to an existing database needs its search backfill.

"Machine-only runners", as the list item worded it, would be wrong for that model.

**Found on the way:** `isMain()` is false in the browser (lumen declares its composition name as the namespace). If warm-ups were simply drained there, every `scope: "host"` warm-up would be skipped silently. The answer must come from the host, not from `isMain`.

## Design

### 1. Retention becomes portable (no new concept)

- **`growth-bounds.ts`**
  - Drop the file-sink import, the `rotate` arm and the `file:` half of `SinkKey`.
  - Rename `getGrowthBounds()` → `getTableGrowthBounds(): ReadonlyMap<string, TableGrowthBound>`. The rename turns the narrowed meaning into a compile error rather than a silent change.
  - The future undeclared-growth monitor is machine-only (it reads `pg_stat_user_tables` and the logs dir). It joins this map with `getFileSinks()` itself.
- **`retention/server/index.ts`:** `portable: true`. Update the description, `CLAUDE.md`, `growth-bounds.test.ts`, and the `rotate` comment in `file-sink/core/internal/types.ts`.
- **The sweep itself is unchanged.**
  - It is a `defineJob` schedule.
  - The desktop's graphile provider already gates `!isMain && !perWorktree` (`jobs/machine/internal/worker.ts:~252`).
  - The browser's in-process queue arms every schedule, which is right for a host with one backend.

### 2. Warm-ups drain through a framework phase, so no host root names them

Today's drain is bolted onto `bin/index.ts` (desktop serve) only. Instead:

- **New lifecycle hook and phase in `server-core`:**
  - Add `onSettled?` to `ServerPluginDefinition` (`core/types.ts`).
  - Add `runSettledPhase(ordered)` to `core/boot-stages.ts`. It runs hooks in parallel, error policy like `runAllReadyPhase`.
  - Only serving hosts call it, and exec has no path to it. This makes the "exec never runs warm-ups" property structural rather than the "load-bearing accident" `server-core/CLAUDE.md` describes.
- **Desktop serve (`bin/index.ts`):**
  - Delete the `drainWarmups` block and its import.
  - After `runPostReadyPhases`, install the signal handlers and the orphan poll first, then `await runSettledPhase(ordered)`.
  - Intended behaviour change: SIGTERM during the drain now shuts down.
- **Browser (`core/browser-host.ts`):**
  - After the seed and the request handler, start `runSettledPhase(ordered)` without blocking readiness.
  - Attach a loud `.catch` inside `bootBrowserHost`, so no entry can forget it.
  - Expose the promise as `BrowserHost.settled`, so tests can await it.
- **Profiler phase ids:**
  - `"drainWarmups"` → `"settled"` / `"onSettled"`. The framework owns the `settled` span, so boot-complete no longer depends on warmup being in the graph.
  - Update the readers: `debug/boot-monitor` (`monitor-job.ts`, `core/config.ts`), `debug/boot-budget` `monitor-job.ts`, `debug/trace/boot` `boot-lane.tsx`, and `debug/profiling/boot` (resources, served value, web section).
- **`warmup/server`:**
  - `onSettled: drainWarmups`, `portable: true`.
  - Stop exporting `drainWarmups`, so no root can call it again.
  - Document on the `onSettled` type that new post-serving work should be a `defineWarmup`.

### 3. Per-host admission: one host service, `warmup.host`

- **Service:** `warmup/server/internal/host.ts` declares `WarmupHost = defineHostService<{ runs(scope): boolean; withSlot<T>(fn): Promise<T> }>("warmup.host")`. The executor's `isMain` dependency becomes `runs(scope)`, and it drops its `runtime-identity` and `host-read-pool` imports.
- **Desktop provider:** new `warmup/machine/index.ts`, with `runs: s => s === "worktree" || isMain()` and `withSlot: withHeavyReadSlot`. That keeps the AsyncLocalStorage reentrancy corpus-index relies on.
- **Browser provider:** new portable `warmup/plugins/sole-host/server`, with `runs: () => true` and `withSlot: fn => fn()`.
  - Add `"!infra.warmup.sole-host.**"` to base-exclusions in `config/plugin-meta/composition/compositions.origin.jsonc`. The browser-host codegen then picks it by rule.
  - This mirrors how `jobs.queue` already handles `perWorktree`.
- **`background-arm`:** `runsHere` reads `WarmupHost.get().runs(scope)`, so the catalog and the executor give one answer.

### 4. Fold the halves that existed only for these

For each plugin below:
- move `machine/internal/X.ts` → `server/internal/X.ts`;
- make imports of its own barrel relative;
- add the token to `server/index.ts`'s `register: [...]` (for `markCascadeBounded`, a side-effect import);
- delete `machine/`;
- fix the plugin's `CLAUDE.md`.

All target `server/` barrels already declare `portable: true`.

Plugins whose whole `machine/` half goes away:
- `apps-core/plugins/app-usage`: retention
- `primitives/plugins/usage-rank`: retention
- `history/plugins/engine`: retention and its test
- `infra/plugins/trash`: purge. Its `beforeDelete` reads trash sources, which all register in `server/`.
- `apps/plugins/pages/plugins/agent-origin`: sweep
- `page/plugins/annotations/plugins/instructions`: retention
- `page/plugins/annotations/plugins/todo/plugins/task-link`: cascade bound
- `page/plugins/annotations/plugins/agent-notes/plugins/authorship`: cascade bound
- `apps/plugins/pages/plugins/content-search`: backfill warm-up
- `tasks/plugins/auto-start`: dropped-sweep warm-up, scope host. In the browser it now runs via sole-host.
- `page/plugins/links`: backfill job and warm-up

Plugins that move only their `retention.ts` and keep the rest of `machine/`:
- `conversations/plugins/question-relay`
- `conversations/plugins/turn-ledger`

Stay machine, because they really need the computer:
- `prototypes/state` legacy-trash (`renameSync`)
- `tasks` auto-start-reconcile (launching)
- the task-title, auto-icon and conversations/usage backfills, if the check below confirms they reach a platform API. If it doesn't, fold them too.

Every test that hand-lists host providers adds sole-host once its closure reaches warmup: the `pages/fixtures` write-page-tree test, the `prototypes/fixtures` write test, `task-category` portable-boot and the `agent-access` page-tools test. The two that boot through `bootBrowserHost` await `host.settled` before they write or settle.

### 5. Enforcement (so nobody splits again)

- **Structural.** No composition root names warmup. Exec cannot reach `runSettledPhase`. Host scope is answered by the booted provider (no `if (browser)`).
- **Existing checks now cover the new code.**
  - `boundaries:portable-closure` covers `retention/server`, `warmup/server`, sole-host and every folded barrel.
  - `host-services:provider-placement` and the boot-time `assertHostServices` cover `warmup.host`.
- **New check, `boundaries:machine-portable-declaration`**, beside `portable-closure.ts`, reusing its `importClosure` and offender logic.
  - It looks at every non-test `machine/**` module that imports `defineRetention`, `markCascadeBounded` or `defineWarmup`.
  - If that module's closure reaches no platform API, the check fails: "declares a portable retention / warm-up; it runs on every host — move it to server/".
  - It works per declaring module, so mixed halves are caught too.
  - The escape hatch is a `sanctioned` exempt with a reason; expected count zero.
  - It must land with zero offenders.

### Follow-ups (not this session)

- **Missed nightly ticks.**
  - The desktop uses `backfillPeriod: 0`, and the in-process queue has nothing durable. A browser tab is almost never open at 04:00 UTC, so a persistent browser app would rarely sweep.
  - Proposed: `ScheduleSpec.catchUp`, set by `defineRetention`. Graphile would map it to a one-period `backfillPeriod`; the in-process queue would run it once at install.
  - This is required before browser hosts are called persistent apps. The next task should be filed with this in its context.
- A durable (IndexedDB) browser job queue.
- One `host.role` service, merging warm-up scope, in-process `perWorktree` and file-watcher `mainOnly`.
- A plugin removed from a persistent composition: its trash rows make the nightly purge throw on an unregistered source.

Existing warm-ups in barrels that are not portable today (automations, corpus-index, places seed, sonata folders, reports engine, …) will start running in the browser the moment their barrel turns portable. `warmup/CLAUDE.md` says so.

## Verification

- **Build and checks**
  - `./equin build`: sole-host appears in the browser host providers; registries are regenerated.
  - `./equin check`: portable-closure, provider-placement, the new check (zero offenders; temporarily un-fold one to see it fire), browser-host coverage, type-check.
  - `rg drainWarmups plugins` finds only `warmup/server` internals, and server-core names no warmup.
- **Unit tests** (`./equin test …`)
  - `drain.test.ts`: the `runs` gate.
  - `growth-bounds.test.ts`: tables only.
  - The moved history `retention.test.ts`.
  - A new boot-stages test: `onSettled` runs after `onAllReady`, and a load-bearing throw rejects.
- **Browser host under Bun** (the portable-boot / fixtures tests), after awaiting `host.settled`:
  - `pages.search.backfill`, `tasks.auto-start-dropped-sweep` and the links backfill each have outcome `succeeded`; host scope is not skipped.
  - `listRegisteredJobs()` holds every folded `retention.<table>`.
  - One sweep run against PGlite deletes old rows.
- **Demo e2e:** no-leak, prototypes-in-demo and app-switch stay green. Measure the worker bundle size and worker-ready time before and after; ready time must not grow, since warm-ups no longer block readiness.
- **Desktop**
  - Boot profile shows a `settled` phase with `warmup:<name>` spans.
  - Background activity lists the folded jobs and warm-ups under the plugin.
  - On a non-main worktree, host-scoped warm-ups are skipped.
  - An `exec` child has no `settled` span.
- **Track:** update the wiki status and tasks, then file the next task (missed-tick catch-up) with the page id.
