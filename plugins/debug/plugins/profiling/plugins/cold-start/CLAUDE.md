# cold-start

The cold-start benchmark: how long a page takes to show data when its worktree's
server was stopped (idle sweep), split into where the time goes. Plan:
[`research/2026-10-10-global-cold-start-benchmark-priority-ready-path.md`](../../../../../../research/2026-10-10-global-cold-start-benchmark-priority-ready-path.md) §1.

```bash
./singularity build      # the script drives the deploy this checkout published
./singularity run plugins/debug/plugins/profiling/plugins/cold-start/e2e/cold-start.ts \
  [--iterations 5] [--path /agents] [--busy N] [--out /tmp/cold-start.json] [--timeout 120000] [--code-cache]
```

- `--busy N` spawns N CPU-spinning children at background priority
  (`spawn-priority`'s `backgroundArgv`, as agent builds run) for the whole run,
  killed on every exit path.
- `--no-stop` is a **warm** run: no stop, so the server is already up. Only the
  browser rows describe this load; the server and gateway rows come from the
  running process's earlier boot and print with no timeline offset. For checking
  the script, not for numbers.
- `--code-cache` is a **DIAGNOSTIC, never the headline, and never counts for the
  exit criteria**: one browser context whose HTTP cache a first load fills with
  the app's code; each iteration still stops the server, opens a new page and
  clears every browser-side store but the HTTP cache (cookies, localStorage,
  IndexedDB, service workers, Cache Storage — CDP `Storage.clearDataForOrigin`,
  asserted empty), so no data comes from a browser copy. It answers "how much of
  the browser track is download?"; the empty-cache run stays the number, since a
  cache must never hide a structural cost. Header and SUMMARY say
  `DIAGNOSTIC: code cached`.
  Its context is the script's own, not a harness session: any Playwright route
  disables the HTTP cache, and the harness routes every session (to strip its
  agent-provenance headers from other origins — the app requests Google Fonts).
  So it sends no provenance headers at all: its requests are unmarked agent
  traffic, which for a page load is telemetry (app usage, log beacons).

## Per iteration

1. `POST /gateway/worktrees/<ns>/stop` (gateway API, reached through the target
   origin) — asserts the returned status is `idle`. The machine's gateway is
   built from main's Go source; one that predates the route answers 404 and the
   script stops with that diagnosis.
2. A fresh browser context (own cache, cookies, sockets — so asset bytes are
   downloaded cold too), `page.goto(<path>)`.
3. Waits for the `boot:route-content-commit` User Timing mark (a buffered
   `PerformanceObserver`, no polling), up to `--timeout`. An iteration that runs
   out is FAILED but keeps and prints everything it reached (boot marks,
   navigation timing, and the server profile when the server is up — checked
   with `GET /gateway/worktrees` first, so the read never boots it).
4. Reads every `boot:*` mark / measure plus Navigation and Paint Timing, closes
   the context (an open page's socket would respawn the server), then
   `GET /api/debug/profiling/boot` for the server spans and the gateway report.
5. Asserts the gateway report is present and the server process started after
   the stop (the boot measured is the one this load caused).

## The numbers

Zero is the page request: the page's `performance.timeOrigin` (navigation
start). Every row has a duration and the offset where it ends.

| Row | Source |
| --- | --- |
| **TOTAL page request → route content commit** (headline) | the `route-content-commit` boot instant (web-core's boot sequence): the commit that appends the active app's priority deferred batch, or the first-data commit when that app has no deferred content — the first screen a person sees with data |
| TOTAL page request → first data commit | the `first-data-commit` boot instant (infra/boot-snapshot): the first React commit after the boot snapshot is hydrated — chrome and eager panes reading real data, deferred route content (e.g. the `/agents` welcome pane) possibly still loading |
| page request → first request reached the gateway | gateway report `spawnRequestedAt` − page `timeOrigin`: how long the page took to send the request that woke the server (cold runs only) |
| gateway spawn requested → ready observed (+ spawned split, spawned → server process start = exec + Bun runtime start) | the gateway's report (`spawnRequestedAt`, `spawnedAt`, `readyObservedAt`) POSTed to `/api/boot/gateway-report` (debug/boot-monitor), returned as `gateway` by the profiling endpoint |
| server process start → first register (code loading) | `bootStartOffsetMs` + the earliest `register` span's offset |
| server register | first `register` start → last `register` end |
| server awaitPgReady / runMigrations / routePopulation / socketBind | the framework's phase spans |
| server onReadyBlocking (all) + one row per plugin | the `onReadyBlocking` spans (per-plugin hooks run in parallel waves) |
| server ready | process start → `onReadyBlocking` end |
| document first byte / DOMContentLoaded / first contentful paint | Navigation and Paint Timing |
| client load-plugins / boot-tasks / boot-snapshot | the boot-trace spans of the same ids (boot-snapshot = the snapshot request, fetch start → response parsed) |
| client set-state | App's first real render is scheduled |
| boot snapshot entries | the `res:<key>` measures: `detail` is the server's `source` (`memory` / `persisted` / `loader`), `workMs` its work |

Printed per row: min / median / p95 over the iterations and the median end
offset; then the snapshot entry counts by source and the heaviest keys, the
count of 429 responses by path (the log-channels beacon shedding under host
duress — expected under load, counted, never a failure), the host load average
(1/5/15 min) at start and end, and one `SUMMARY` line. The `n` column is how
many iterations reached that row.
Then the **browser track** (`e2e/browser-track.ts`), in every run, median
(min–max) per scalar and ranked lists by median:

- **A, before DOMContentLoaded** — requests, transfer / decoded KB by kind
  (document incl. its inline import map, entry JS, plugin artifacts, vendor JS,
  CSS, fonts, sprites, api), the largest files, network busy time (union of
  fetch intervals) vs main-thread long tasks.
- **B, during the eager `load-plugins` span** — plugin modules imported, JS
  artifacts in hand (already preloaded vs fetched during the span), network
  busy vs long tasks in the span, the 15 slowest plugin imports (per-plugin
  `boot-plugin:<path>` measures from boot-trace's `traceBootPluginLoad`, which
  web-core wraps every plugin loader in) and the 15 largest plugins / vendor
  files by decoded bytes.
- **C, tiers** — eager / priority (active app) / deferred plugins imported,
  and how many resolved before first data / route content / after it. The
  script waits for the `deferred-load-complete` mark (within `--timeout`) so
  the counts are whole.

The page gets an init script first: a Resource Timing buffer of 100 000 (the
default 250 drops most artifacts) and a buffered `longtask` observer.

`--out` writes every iteration's raw entries, server profile and derived phases
as JSON.

## Clock caveat

Three processes, one host wall clock: the page's `timeOrigin`, the server's
`processStartedAt` (Bun's `performance.timeOrigin`) and the gateway's stamps
(Go `time.Now()`) are all epoch ms on this machine, so cross-process offsets
carry only the drift between each runtime's monotonic clock and the wall clock
(normally ≤ a few ms). Server span offsets count from the profiler's boot start;
`bootStartOffsetMs` (server-core's `getProfilingData()`) places them exactly.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Cold-start benchmark: stops the worktree's server, loads a page in a fresh browser and splits page request → first screen with data across the gateway, the server's boot phases and the browser's boot trace.

<!-- AUTOGENERATED:END -->
