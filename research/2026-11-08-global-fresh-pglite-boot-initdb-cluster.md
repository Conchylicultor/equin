# A fresh PGlite database's boot: what `onReadyBlocking:database` is, and a take that never runs initdb

Track: wiki "Track: apps running in the browser, on fake or local data" (`block-d04c6c0d-…`). Previous step: `2026-11-06-global-change-feed-install-quadratic-catalog.md`.

## Context
After the change-feed install fix, `onReadyBlocking:database` was the biggest stage of a fresh-database boot: every demo snapshot take (re-taken on most server-code commits) and a client-only app's first boot. It had been reported at 1.6 s on a quiet host and 7–22 s on a loaded one, and read as "replaying ~384 migrations".

## 1. The 7–22 s were mostly the scheduling tier, not the work
An agent's shell is darwinbg (`spawn-priority`: every command an agent's CLI runs is demoted). On Apple Silicon that pins it to the efficiency cores. `./equin run` lifts only e2e scripts; `./equin test` and `./equin build` run under a host grant, in the foreground. The same take, measured back to back at load ~8:

| | darwinbg (`./equin run`) | foreground (`./equin test`, the build) |
| --- | --- | --- |
| PGlite start (raw bench) | 1.42 s | 0.47 s |
| 425 migration steps (raw bench) | 1.24 s | 0.27 s |
| `onReadyBlocking:database` in a take | 2.1–3.3 s | 1.02–1.09 s |

So agent-run measurements of this stage read 3–4× slow. The take's boot line now prints the tier it ran in (`boot (foreground): …`), so a number is never read without it.

## 2. The stage, decomposed (foreground, load ~8, 3 takes)

| Piece | Cost |
| --- | --- |
| `driver.ready()` = PGlite's fresh start | **0.48–0.55 s** |
| migration replay (424 steps, ~1,350 statements) | 0.37–0.41 s (0.32–0.35 s in `exec`) |
| derived layer (rollup tables, one trigger install, reconcile, views) | 0.13–0.14 s |
| ledger read/plan, known relations, the rest | ~0.04 s |
| **total** | **1.02–1.09 s** |

* **The migrations are not most of it.** Per statement the replay costs ~0.25 ms of DDL inside WASM; running every step as one `exec` saves only ~15 %. No statement stands out: the largest is 29 ms. Nothing in it is anomalous, and squashing stays ruled out (published migrations are immutable).
* **PGlite's fresh start is the biggest piece, and it is initdb.** PGlite 0.5 runs initdb on every start without a data dir. It creates a second PGlite instance just to run `initdb.wasm`, dumps that instance's data dir and loads it into the main one. Compiling the wasm modules is negligible (15 ms). Loading an already-initialized data dir instead takes 0.09–0.11 s, against 0.55–0.8 s for a fresh start.
* initdb's output is a pure function of the PGlite build. Every take recomputed the same bytes.

## 3. The fix: a take's database opens from an initialized cluster
* **An initialized cluster is a build artifact.** `web-artifacts/bin/pglite-cluster.ts` runs one initdb in a fresh process and writes the data dir gzipped: 4.5 MB, `pglite.pglite-cluster.<hash>/cluster.tar.gz`.
  * It is keyed on what decides its bytes: PGlite's `bun.lock` line (version and integrity), `patches/`, the script's blob and a layout constant.
  * One is written per PGlite build and shared by every take of every checkout. The host-snapshot stage makes it on a miss.
* **The take opens its database from it.**
  * `browser-host.snapshot.ts <out> <cluster>` → `takeHostSnapshot({ cluster })` → host-storage's new `DatabaseStart` arm `{ from: "initialized", dataDir }`.
  * The PGlite driver opens that arm with `loadDataDir` and shifts nothing.
* **The snapshot's address covers the cluster's address.**
* **Correctness.**
  * The database still starts with no app state. The schema layer replays every migration and builds the derived layer exactly as before.
  * Only the cluster under it was computed once instead of per take.
  * The real server's migration path is untouched.

**Results** (foreground; the same tree; alternating fresh-initdb and cluster takes, 3 rounds × 2; load 10–13):

| | fresh initdb (before) | initialized cluster (after) |
| --- | --- | --- |
| PGlite ready | 0.49–0.85 s | 0.12–0.17 s |
| `onReadyBlocking:database` | 1.02–1.61 s (median 1.36) | 0.60–1.19 s (median 0.74) |
| graph stage | 1.72–2.82 s | 1.17–2.24 s |

In this branch's real build (load ~10): take 3.3 s, graph 1.56 s, `onReadyBlocking:database` 0.74 s.

## Found on the way
* **Bun ends a PGlite script mid-initdb.** A fresh PGlite's start awaits work that holds no event-loop handle. In a plain Bun script with nothing else running, the process exits in the middle of initdb with code 0, without its output. And `dumpDataDir()` called before `waitReady` spins at 100 % CPU (4 CPU-minutes until killed). The cluster script holds the loop with a timer, awaits `waitReady`, and the stage checks the file exists. A long-lived host (the take, the worker) never hits it. Filed as a task.

## Next
What is left of the stage is the replay (0.37–0.41 s) and the derived layer (0.13 s). The replay's output is a pure function too: the migration texts, the runner and PGlite. But a migrated baseline needs the runner booted, because its log sink resolves `LogPersistence`, a host service, on first publish. So it can't come from a bare script. It would need a host whose graph is only the `database` closure (a composition codegen derives), keyed on that closure plus the migration files. The change-feed install (0.4–0.9 s) is now about as large as the database stage.
