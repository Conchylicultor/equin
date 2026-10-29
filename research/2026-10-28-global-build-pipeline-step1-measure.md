# Build pipeline track, step 1: measure the non-check build steps, cold and warm

Track page: block-3e7bbe1c-c0b9-481d-a2c1-20b125fcfe1d ("Track: build pipeline"). Task: task-1793147612-h5zms6.

## Context

A typical agent build compiles 1 web artifact (~3 s), but its codegen, migration generation and docs take a median 64.5 s (p90 172 s), and its frontend steps add more. The track's baseline comes from 237 profiles taken on a loaded host. The build that just ran on this host spent 29 min held on host duress (load 25 on 18 cores). So the baseline can't separate a step's own cost from contention, and it doesn't say *what* each step spends. Step 1 measures each non-check step cold and warm on a quiet host, breaks each one down, and writes the redesign as a sub-page. It speeds nothing up.

## What the code does today (from exploration)

**Codegen** (`codegen/core/regen-pipeline.ts`, called from `cli/plugins/build/cli/internal/app-artifacts.ts`). There is no on-disk cache. Every memo lives in one process:
* `plugin package names` pays the first `buildBarrelFreeTree` (a faceted walk of every plugin, plus `git ls-files`). The name sync itself is cheap.
* `plugin registry` and `eager-tier` reuse that tree. The pre-barrel `eagerTier` builds a second, un-memoized registry context. `composition registry` builds another un-memoized faceted tree when a composition is named.
* `slot declaration guard` pays the first `importBarrel` of every web barrel. The imports go through a serial lane (`createSemaphore(1)`).
* `generate plugin docs` runs `buildEnrichedTree`: server, machine and central barrel imports, a second faceted extraction, then one render per plugin. `writeGenerated` renders and prettier-formats every generated file, even when nothing gets written.
* `generate migrations`:
  * runs git calls for the published origins;
  * spawns a probe that `require()`s every schema file;
  * spawns drizzle-kit on every build.

**Frontend** (`web-artifacts/core/internal/pipeline.ts`):
* `detect` stats every plugin file against a per-worktree mtime fingerprint. Without one, it re-reads every file. It also reads all of `WA/core` (the builder identity), the full content of every browser-host input, and stats every store entry for pruning.
* `css-key` hashes every tracked and untracked repo file into one global key. So does the browser host's input list (2,739 modules, serial).
* `compose` lexes every staged module (`staged-verify.ts`).
* The stores sit under `<dataRoot>/cache/web-artifacts/` and are shared across worktrees. The fingerprints and vendor resolutions are per worktree.

**Profiles**:
* `~/.equin/worktrees/<ns>/build-profile-<id>.json` holds `{spans:[{id,phase,label,startMs,durationMs,maxRssBytes?}]}`. Match on the span `id`.
* `~/.equin/logs/build-progress/` covers a build that died.

## Approach

### 1. Where: a quiet host
* The default is the cold-start track's Tart VM (6 cores / 12 GB, `sidequests/clean-install/run.sh`). It is the same machine the track's exit criteria name.
* Alongside each run, record the host's load average and the VM's CPU-seconds. A loaded host still slows the VM, so the CPU-seconds give a load-insensitive second number.
* The user picked the VM only (2026-10-28). There will be no quiet-window series on this Mac.

### 2. Scenarios
Each scenario runs 3 times and reports the median, as wall time and CPU-seconds.

| # | Scenario | How |
|---|---|---|
| C0 | Cold: every store empty, no Bun transpile cache, fresh process | fresh install in the VM, then `EQUIN_DIR` scratch plus `BUN_RUNTIME_TRANSPILER_CACHE_PATH` scratch, then `./equin build --hermetic --composition <main>` |
| C1 | Cold except the OS file cache | C0 run a second time with the stores wiped again |
| W0 | Warm, no change since the last build | the same build again |
| W1 | One plugin body edited (`web/` file of a leaf plugin) | a one-line edit, then build |
| W2 | One schema file edited (adds a column) | build: migrations, docs |
| W3 | Fresh worktree from main, another worktree already built | `git worktree add`, then build (shared stores warm, per-worktree fingerprints empty) |

Agent builds run with `--skip-checks` where possible (checks are the sibling track's), and are confirmed against a full build once.

### 3. The breakdown: what each step spends
* **Span timing.** Use the build's own profile.
* **CPU profile of the build process.** Run `bun --cpu-prof-md` (Bun 1.4.4 has it) through `BUN_OPTIONS`, or a wrapper if `./equin` drops it. A throwaway aggregator in `/tmp` buckets self-time per span window into:
  * module parse and transpile;
  * barrel module evaluation;
  * fs and stat;
  * git (spawned);
  * prettier (worker);
  * facet extraction;
  * render.
* **Child processes.** Spans and `/usr/bin/time -l` cover drizzle-kit, the schema probe, the vite and esbuild workers, and Tailwind.
* **Per-step isolation.** For the four biggest codegen steps, a `./equin run` script calls the exported `regenerateRegistryCodegen` / `regenerateManifestCodegen` with an `onStep` timer, plus `generateMigration`. The order varies: docs run alone, then the guard alone, so each step's shared cost (tree walk, barrel imports) is attributed instead of landing on whoever runs first. It follows the existing pattern `codegen/scripts/measure-browser-host-guard.ts`.
  * New file: `plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-build-steps.ts`. It is measurement tooling and is kept for step 3's before/after.
* **Counts that turn time into rate × cost:**
  * plugins walked;
  * barrels imported, and modules evaluated;
  * files stat'd and read;
  * generated files rendered vs written;
  * git calls;
  * drizzle-kit runs that produced no migration.
* **Steps' own wasted work.** Count the no-op outcomes: drizzle-kit with no diff, docs rendered byte-identical, the Tailwind pass on an unchanged class set, the browser host rebuilt for an edit outside its graph.

### 4. Sharing across worktrees
For every step, record whether its result could be reused by another worktree on the same content, and what key it would need (per plugin, per file, global).

### 5. Write-up (wiki, per the track instructions)
* **New agent sub-page under the track: "Build pipeline: measurements".**
  * Method.
  * The per-step cold / warm table (wall + CPU-s).
  * The breakdown per step, traced to its origin per the perf skill: rate × cost, and why each step runs at all on a warm build.
  * The hypotheses discarded.
* **New agent sub-page: "Build pipeline: redesign".**
  * Per-plugin records keyed by each plugin's own files plus the extractor version, held in a shared store.
  * Global generators that combine records.
  * A migrations skip keyed on schema inputs.
  * Changed-artifact detection from git and per-file keys.
  * Per-artifact CSS.
  * A browser host built from the per-plugin artifacts.
  * For each change: its expected per-change cost, its cross-worktree sharing, its cold-case gain (estimated from the measured breakdown), and the absence of any global fingerprint.
* **Track page edits.**
  * Status and next step.
  * The overview checkboxes: tick Measure.
  * The baseline section: add the quiet cold/warm columns.
  * Links to the sub-pages.
* **Next task.** File the next main task (step 2 implementation), with the page id, per the track instructions. Only one.

## Files
* New: `plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-build-steps.ts`.
* New: `sidequests/clean-install/steps-build-pipeline.sh`. It holds the VM scenarios C0 to W3 and dumps each build's profile, the CPU-profile markdown and the time -l lines into the run log.
* Throwaway analysis scripts in `/tmp/bp-scan/`, not committed.
* No change to the build itself.

## Verification
* Every number on the page traces to a run directory, either `~/.equin-clean-install/<vm-run>` or the scratch data root, and the page names it.
* Sum check: on each run, the per-step spans add up to the codegen and frontend phase walls within 5 %.
* The CPU-profile buckets cover at least 85 % of each step's CPU.
* `./equin check` passes on the two new files, then `./equin build`.
