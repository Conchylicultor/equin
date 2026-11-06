# Build pipeline step 9: a fresh-database boot that costs a boot, and a snapshot keyed on the code it runs

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). Numbers: "Build pipeline: measurements" (`block-9f438022-…`). Task: task-1793985491-3r9po8. Previous step: `2026-11-06-global-build-pipeline-step8-host-snapshot-and-cold-frontend.md`. Supersedes task-1793932779-i11s7u (track "apps running in the browser", `block-d04c6c0d-…`: "installing the change feed's triggers on a fresh PGlite takes about 22 s").

## Context
Step 8 keyed the demo's host snapshot on its DATA only, so a server change that alters what the seed writes was not picked up until the next migration / config / seed / npm change. The user decided (2026-11-06) that the snapshot must be always correct AND cheap. A re-take was expensive not because of the seed (0.5–0.9 s) but because of booting the demo's graph on a fresh PGlite database: 7.7–13 s on the loaded host, of which change-feed's trigger install 5.6–9.2 s and migrations 1.7–3.1 s.

Goal:
1. Find out why a fresh-database boot is slow and fix the cause (it benefits every fresh PGlite boot: a client-only app, a visitor's first /demo without a snapshot, the boot test).
2. Key the snapshot on exactly what its output is a function of: the code the take runs (module-graph Merkle key) plus the data it reads off disk, so a server change that can affect it re-takes it, cheaply, and nothing else does.

## 1. Why the fresh boot is slow — measured top-down

### The take, split by SQL statement (host, loaded)
A scratch wrapper around PGlite's `execProtocolRawSync` (the synchronous WASM execution of each protocol message) grouped every message of one take by statement shape:

| Statement | Messages | Time |
| --- | --- | --- |
| db-triggers `readCatalog`: stamped functions (`obj_description` over every `pg_proc` row) | 1,188 | 9.3 s |
| db-triggers `readCatalog`: triggers (`obj_description` per trigger in the WHERE) | 1,188 | 4.5 s |
| … every other statement (migrations, seed, …) | ~21k | ~6 s |
| **Total SQL in one take** | 23,269 | **20.0 s** |

* **70 % of the take's SQL was the trigger installer re-reading the whole catalog once per table.** With `commit: "per-table"` (the change feed's ~196 tables), each table's transaction re-planned under its advisory lock with a full `readCatalog` (`lockAndPlan`), so the install was O(tables × catalog).
* Each full read was itself expensive: `obj_description(oid, 'pg_proc')` is a query per row, and the stamped-functions filter ran it over every function in the database (~3,000 built-ins in PGlite; on the cluster too).
* It is not PGlite per-commit sync (in memory: nothing to sync), not the DDL (CREATE TRIGGER / COMMENT ≈ 0.2 s together).

### The fix (db-triggers `install.ts`)
* A per-table step re-plans from **that table's triggers only** (`readTableCatalog`, `tgrelid = to_regclass(…)`): its slice of the plan (creates, restamps, drops) reads no function row — a trigger is owned through the function NAME it calls — so the slice equals the one planned over the whole catalog.
* Every comment is read by **joining `pg_description`**, never with `obj_description()` per row; the stamped functions are found from `pg_description` (a few rows), not by scanning `pg_proc`.
* No cache, no skip: the same protocol (stamps, ownership, advisory locks, per-table transactions, the final full assert), at O(changed tables) + O(stamped objects).
* Effect on the desktop: the boot schema layer's one full read and every backend's steady-state change-feed check get the cheaper read too.

**Result (same host, loaded, one take): total SQL 20.0 → 4.5 s; the two catalog reads 13.8 → 0.7 s.**

### What remains of a take
Measured on the quiet VM (Outcome, below). The host's load (25–50 on 18 cores) makes wall times and CPU profiles of a take there unreadable: one profiled take ran 50–80 s.

## 2. The snapshot's address = the code the take runs + the data it reads

**Landed in parallel by another task, e24e98c680** (`research/2026-11-06-global-host-snapshot-address-covers-what-runs.md`). This branch had implemented the same design, and on rebase it took main's version. That version also keys the `patches/` bun applies, the Bun version, and refuses an import the graph cannot resolve. The design:
* **code**: the Merkle key of `bin/browser-host.snapshot.ts` in the plugin-records module graph — its blob and the keys of everything it can load, static AND dynamic. That is the seed, the boot, the snapshot codec (host-storage `core/`), and, through the generated listing's `() => import(...)` loaders, every server barrel of the host graph. O(changes): each module's imports are a record under its blob, so a warm build reads no source.
* **data read off disk**: the worker closure's glob files (migrations, committed config) and the host plugin's own data files (`data/`, any non-module file). Portable server code reads no disk, so these are all of it.
* **npm**: `lockfileNpmResolutions` (workspace entries excluded), plus `patches/`.

The trade, reversed from step 8: an edit to any server module the take loads re-takes the snapshot — exactly the edits that can change what it writes. Part 1 is what makes that affordable. The VM's W0 / W4 numbers below were measured with this branch's key, which differs from main's only by the Bun version and `patches/` (constant across those runs).

## Gates
* DB: db-triggers' and change-feed's suites (`db-triggers-install.test.ts`, `rollup-oracle.test.ts`, `triggers.test.ts`, `routed-trigger.test.ts`, `change-feed/**`, `pglite/**`) green.
* A deployed build takes the snapshot; the demo boots on it.
* VM (`steps-build-pipeline.sh`): the take before/after alternating (old installer vs new, same tree), its boot split; W0 (no re-take), W4 (server edit in the graph: re-takes, at its new cost).

## Not the fix
* Skipping the install on a fresh database, or caching the catalog across tables: the per-table re-plan exists for racing installers; reading the right slice keeps it and costs O(1) per table.
* Squashing migrations: measured, not the cost. Reading and hashing the 384 files takes 6 ms, and the whole schema layer ~0.25 s on the VM.
* Taking the snapshot lazily or only at release.

## Outcome (2026-11-06)
Landed: part 1 here; part 2 by e24e98c680 in parallel (same design). Quiet 6-core VM (`steps-build-pipeline.sh` steps baseline, install, lib, W0, W4, RUN; the RUN step alternated the take with HEAD~1's installer and this one in the same tree, 4 pairs).

**The take, before → after (the same tree, only the installer swapped; seconds):**

| Run | Before: take / graph / change-feed hook / database hook | After: take / graph / change-feed hook / database hook |
| --- | --- | --- |
| 1 | 8.97 / 5.91 / 4.42 / 1.10 | 3.10 / 1.77 / 0.47 / 1.09 |
| 2 | 7.14 / 5.93 / 4.53 / 1.23 | 2.98 / 1.81 / 0.56 / 1.09 |
| 3 | 6.49 / 5.32 / 4.11 / 1.06 | 2.86 / 1.66 / 0.47 / 1.02 |
| 4 | 6.54 / 5.35 / 4.12 / 1.08 | 2.92 / 1.77 / 0.51 / 1.08 |

* Fresh-DB boot (the graph stage): **5.3–5.9 → 1.7–1.8 s.** Change-feed's install: **4.1–4.5 → 0.47–0.56 s.**
* SQL inside one take: **4.25 → 0.97 s** (catalog reads 3.38 → 0.14 s).
* Whole take, process included: **6.5–9.0 → 2.9–3.1 s.**

**In real builds:**
* The install's cold build took it in 4.8 s (graph 3.3 s).
* W4, a server edit in the demo graph, now re-takes it, as it should. Take 3.6–4.4 s; the stage 3.7–4.6 s; whole build 18.3–19.9 s. Step 8 got 14.0 s here by NOT re-taking, which shipped stale data. Before step 8, a re-take was 8.2 s and the build 20.6 s.
* W0, nothing changed: no re-take. The stage costs 0.07–0.25 s, the module graph included. Whole build 10.3–10.8 s (step 8: 9.7–10.0).
* Host, loaded: the take in this worktree's build was 4.5 s (13 s in step 8). The next build changed only a test and docs: no re-take, stage 0.09 s.
* `apps/demo/e2e/snapshot.ts`: all 28 checks pass on the new snapshot.

**What the remaining ~2.9 s is (VM, measured piece by piece):**

| Piece | Cost |
| --- | --- |
| PGlite start-up, the first instance in a process (WASM compile + its data bundle) | 0.83 s (0.4 s for a second one) |
| change-feed install (~196 tables, one transaction each) | 0.5 s |
| the seed | 0.4 s |
| the schema layer (384 migrations, derived layer) | ~0.25 s |
| config_v2's boot | ~0.2 s |
| dump + gzip of the data dir | 0.13 s |
| encode | ~0.08 s |
| the rest: Bun start, loading ~300 plugins from source | ~0.5 s |

No single part is over 1 s. The target, ~1–2 s, is not met. The next levers are PGlite's first start, which every fresh host pays (it could reuse a compiled module), and the per-table install on a database nobody else is connected to.
