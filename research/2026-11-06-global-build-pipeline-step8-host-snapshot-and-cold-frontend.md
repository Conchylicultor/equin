# Build pipeline step 8: the host snapshot's address, then the cold frontend

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). Numbers: "Build pipeline: measurements" (`block-9f438022-…`). Task: task-1793970026-sld8vv. Previous step: `2026-11-06-global-build-pipeline-step7-real-world-split-v2.md`.

## Context
After step 7, the two largest items this track still owns:
1. The demo host snapshot (8fb90a3422, 2026-11-06) re-runs its seed in most builds.
2. The cold frontend: 22.7 s with 4 threads, ~30 s of `artifacts:build` in-process on the VM (a real build there gets one thread).

## 1. The host snapshot

### Measured (host, 2026-11-06, build profiles since 8fb90a3422)
* 30 profiled builds ran the `artifacts:host-snapshots` stage. **19 re-took the snapshot, at 7–48 s each** (the host is loaded: 13–48 s is the common range). Main: 2 of 5. Agent worktrees: an edit anywhere in the closure meant a fresh take, each build after each edit (att-…-np2zwl: 3 takes in a row).
* The store holds **19 lumen snapshots taken in one day**.
* What the address covered: the worker's whole artifact closure (298 server plugins + their cores, ~2.7k modules), the builder identity (all of `web-artifacts/core/`), the script's static import closure (**1,275 files in 205 plugins**: the seed statically imports tasks-core, conversations, page, … server barrels), every file of the host plugin (incl. its `CLAUDE.md`, tests and the generated graph listing, which changed in 26 of main's commits in 7 days), the whole `bun.lock` (50 commits / 7 days, nearly all workspace entries), the Bun version.
* So the address moved with almost any server edit. The same all-or-nothing fingerprint the performance instructions reject.

### What the snapshot's output really depends on
The snapshot is DATA: a PGlite data directory plus host-store entries. The worker boots **today's** code over it. That is exactly what every persisted database is: a desktop's, or a browser host's kept storage (`whenOutdated: "keep"`), read by code newer than what wrote it. The boot makes it sound:
* Migrations must equal the bundle's, or the boot fails loudly (`host-storage`).
* Definitions (derived views, change-feed / db-triggers sets) are re-converged at boot by signature, per table.
* Rows written by older code are what any existing database holds; L2 snapshot rows are swept by code digest; rollups reconcile.

So the address = what decides the DATA's validity and content, never the code that wrote it:
* **Bundled data the worker inlines:** the glob files of the worker closure's artifacts (`globFiles`: the migration history and the committed config). The Bun-side script reads exactly these off disk in place of the bundled providers (`bun-host.ts`).
* **The seed's own inputs:** every file of the host plugin (seed, stories, `data/` of any name), excluding nested plugins, test code, the plugin's root docs and `*.generated.ts` (the graph listing — code, not data).
* **The format:** the npm resolutions of `bun.lock` (PGlite's version decides the data dir format), via the type-check pass's existing filter, moved to `infra/deps/npm/core` as `lockfileNpmResolutions` (pure text; each caller hashes); host-storage's `core/` (the file's codec and load — 3 commits in 7 days); a layout constant and the module source the stage writes.
* Dropped: builder identity, server code, the script's static closure, the Bun version, workspace entries.

**The accepted trade:** after a server-code change that alters what the seed writes, the demo ships the older data until the next migration, config, seed or npm change (≈ 5–6 a day on main). That is the same contract every stored database has. The demo e2e (`apps/demo/e2e/snapshot.ts`) and the lumen boot test (current code, seeded in-process) still cover today's write paths.

**Residual risks named by the review (accepted):** a store owner's value format or `shiftTime` changing without a seed/migration change (the same contract as a kept IndexedDB store across builds, which those owners already honour); the migration hash algorithm changing (it would also break every database's applied-migrations table, so it cannot change silently).

**Frequency, from main's last 7 days:** migrations 14 commits, config 20, lumen non-generated files ~8, npm resolutions rare. Agent worktrees almost never touch these, so they hit the snapshot main's build took.

### The seed's own cold cost (~7–8 s on the VM)
* VM CPU profile of the snapshot process (step 7's C0): 7.96 s, of which ~5.2 s is PGlite executing SQL and ~1 s PGlite start-up.
* Host boot report: the `graph` stage (load of 298 plugins from source, then the database barrier: **384 migrations, 2.3 MB of SQL**) and change-feed's trigger install (`onReadyBlocking:network.live.change-feed`) dominate; the seed itself is ~1.5 s.
* Both are structural costs of booting a fresh database, which every fresh browser host without a snapshot also pays. task-1793932779-i11s7u owns the change-feed install; replaying 384 migrations on a fresh database is a migration-squash question. Not fixed here: with the new address the take runs a few times a day, not per build.
* Added: the snapshot script prints its boot report (stages + slowest hooks), so a take's cost is split in every build log.

## 2. The cold frontend
Babel + React Compiler is ~95 % of an artifact's CPU (step 3b). Split again (host, 300-file stride sample of shipped `web/**/*.tsx`, CPU time):

| Pass | CPU |
| --- | --- |
| Babel parse only | 1.1 s |
| Babel transform, no plugin (parse + generate + map) | 1.4–1.9 s |
| **Babel + React Compiler (current)** | **9.3–14.8 s** |

* The React Compiler pass is ~85–90 % of Babel's cost; Babel's own parse/generate/maps are ~10 %. Same in Node 25 and Bun 1.4 (12.4–13.0 vs 14.8 s): not a runtime issue.
* Inside the compiler (Node CPU profile): `compileFn` ~63 % of a transform, Babel's per-call `loadFullConfig` ~8 %, Babel traverse/scope the rest.
* It changed 285 of 300 sampled files: it does real work on nearly every file it is given.
* babel-plugin-react-compiler 1.0.0 is the newest stable; no native compiler in oxc-transform / rolldown yet.

Next (this session, by measured size): a CPU profile of a whole cold in-process frontend to split `artifacts:build` into RC, Babel, vite/Rolldown per-run setup and post-build steps, and by artifact kind (does RC run on worker-only `server` artifacts for nothing?). Then fix the largest structural part. Outcome below.

## Gates
* Unit: `host-snapshots.test.ts` — the address moves with a migration, a seed file, a data file, an npm resolution; not with server code, a workspace entry, tests, docs, a generated listing, a nested plugin. `lint-cache.test.ts` still green.
* A deployed build of this worktree takes or reuses the snapshot; the demo boots on it (`apps/demo/e2e/snapshot.ts`).
* `./equin check`.
* VM (`steps-build-pipeline.sh`, before = main, after = branch, alternating): W0, W1, W4 (server body edit in the host graph: must no longer re-take), W3, CF, C0.

## Critical files
* `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/host-snapshots.ts` (+ test), `pipeline.ts`, `expected.ts`
* `plugins/infra/plugins/deps/plugins/npm/core/internal/lockfile-resolutions.ts` (moved from type-check `shared/lockfile.ts`)
* `plugins/apps/plugins/website/plugins/demos/plugins/lumen/bin/browser-host.snapshot.ts` (boot report)
* `plugins/framework/plugins/tooling/plugins/web-artifacts/CLAUDE.md`, `framework/browser-server/host-storage/CLAUDE.md`, lumen `CLAUDE.md`

## Not the fix
* Taking the snapshot lazily (on first demo visit, or only at release): the worktree serves the demo, and it moves the cost, not the cause.
* A per-file Babel output cache to hide the React Compiler's cold cost.

## Outcome (2026-11-06)
Landed: §1 (the snapshot keyed on its data) and the boot split in every take's log. §2 measured, not changed: the largest part has no fix this track can make yet (below). Item 3 (one file view per build) not started.

**Quiet VM** (`steps-build-pipeline.sh` W0/W4/CF; before = main `e81a6dc95a`, after = the same plus this branch, run one after the other; seconds):

| Scenario | Before | After |
| --- | --- | --- |
| W4 server edit in the demo graph, whole build (3 runs) | 22.1 / 20.4 / 20.6 | 14.7 / 13.2 / 14.0 |
| … `artifacts:host-snapshots` | 8.26 / 8.29 / 8.22 | 0.01 / 0.01 / 0.01 |
| W0 warm, nothing changed (3 runs) | 10.4 / 9.5 / 9.9 | 10.0 / 9.9 / 9.7 |
| CF cold frontend, in-process (3 runs) | 48.3 / 45.7 / 42.6 | 46.4 / 45.0 / 42.2 |
| … `artifacts:build` / `host-snapshots` | 30.0–33.6 / 6.3–7.2 | 29.5–31.9 / 6.5–7.4 |

* The host was heavily loaded during both runs (load 60–85 on 18 cores); the VM shares it. Same-scenario pairs ran ~1 h apart.
* The after-VM ran the branch before two review fixes (host-storage's `core/` and root-docs-only in the address); neither touches what W4 edits.
* Cold still takes the snapshot once (CF ~7 s); that is its own cost, split below.

**One take, split** (the build log line the script now prints; this worktree's build on the loaded host): graph 13.0 s, of which change-feed's trigger install 9.2 s and migrations 3.1 s; seed 0.9 s. task-1793932779-i11s7u owns the install.

**Cold frontend, split again:**
* React Compiler ≈ 85–90 % of Babel's cost per module; Babel's own parse / generate / maps ≈ 10 %. Same on Node and Bun.
* Stripping TypeScript before the compiler (oxc, JSX preserved): no change (9.0 vs 9.2 s CPU for 300 files).
* Babel's per-call config load (~8 % in a profile): within the host's noise when pre-created; not pursued.
* The compiler applies to ~3,245 web modules and changes 95 % of them; it does not run on `server` / `bin` / `core` modules (none matches its `appliesTo`).
* Per-run vite setup is ~4–5 ms an artifact (3b's batching, −27 %): the only part this track can still cut without a native compiler.
* A real build on the 12 GB VM gets one thread (`cpuBudget().B = 1`, its RAM ceiling): the adaptive scheduler track's, and the biggest lever on the real cold number (in-process 30 s of `artifacts:build` vs ~19 s on 4 threads).

**Next, by measured size:**
1. Cold frontend: batching (multi-entry runs per worker, owner routing for audits / externals / CSS), or a native React Compiler once oxc / rolldown ships it (not in oxc-transform 0.157 / rolldown 1.3.0). The 1-unit grant on 12 GB hosts goes to the adaptive scheduler track.
2. The snapshot's cold take (~7 s VM, 13 s loaded host): change-feed's install (task-1793932779-i11s7u) and replaying 384 migrations on a fresh database.
3. One file view per build (v1 §1 of step 7).
