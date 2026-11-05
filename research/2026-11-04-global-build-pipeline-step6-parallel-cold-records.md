# Build pipeline step 6: cold records made in parallel

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`), the open half of redesign item 2 ("cold extraction in parallel across cores"), in "Build pipeline: redesign" (`block-5979c8a6-…`). Prior step: `research/2026-11-04-global-build-pipeline-step5-migrations-verdict-and-cold-records.md`. Task: task-1793816091-a2a59s.

## Context
Cold codegen means an empty record store: a new machine, or an edit to facet or evaluator code, which re-extracts every plugin. Alone on the quiet 6-core VM (CC: `measure-build-steps.ts --order pipeline`, empty data root and transpiler cache) it takes ~11.5 s:

| Cold step (step 5 after) | wall / CPU s | What runs, all on the main JS thread |
| --- | --- | --- |
| `slotDeclarations` | 2.64 / 2.8 | `evaluateWebBarrels`: imports ~1,100 web barrels (~7.5k modules), serializes each, records every loaded module's created slots |
| `pluginDocs` | 2.29 / 2.8 | `evaluateAllBarrels`: server, machine and central barrels (~3.5k more modules), then `resolveDeclarationDependent`'s live pass, which re-serializes every barrel twice for its guard |
| `packageNames` | 2.53 / 4.5 | `extractFacetRecords`: 11 facets × ~1,640 plugins, one plugin after another |
| `browserHostInfer` + coverage | 1.49 / 2.9 | module graph and file scans for the browser host |
| `pluginRegistry` + `eagerTier` | 1.38 / 1.9 | the first `buildModuleGraph` misses: two `Bun.Transpiler.scanImports` per module, ~11k modules |
| rest | ~1.2 | registries, formatter, exempt ids |

The redesign estimated ~8 s for cold codegen, from parallel extraction across cores. Cold C0 codegen + migrations is 15.7 s today.

Each record is already a pure function of its key (step 4): a facet record of the plugin's own files, an evaluated record of the barrel's import closure, a file fact of one blob. So the work can be split across threads with no change to what a record means. Two parts need design:

* **Barrel evaluation is not plugin-local.** A slot's identity is (creating module, ordinal), which is the same in every realm, so a barrel's record does not depend on which thread made it. The exception is the declaration-dependent barrels: reorder's config registrations and pane's header titles. They read `getCreatedSlots()` and `headerSlots`, which are realm-wide registries of every slot created. Today they get one live declaration pass over every barrel in one realm.
* **The two evaluation waves are ordered by generated files.** The web wave runs after the pre-barrel manifests are written. The server/machine/central wave runs after the post-web manifests. A worker that kept modules from the web wave could evaluate a stale manifest in the server wave.

## Design

### 0. Measure before fixing (local, then the VM)
* Sub-spans inside the two evaluation steps: module load (transpile and evaluate), `serializeBarrel`, `moduleEvaluation`, the dependent pass and its guard's re-serialization. Inside the module graph's misses: read vs scan.
* **Spike: barrel evaluation in worker threads.**
  * Does `registerBarrelStubs`' `Bun.plugin` and the `globalThis` patching work per worker? If it does not, use child processes instead.
  * Time to load a partition of web barrels with 1 to 6 workers, and how many modules are loaded twice across partitions.
  * Peak memory.
* **The dependent pass's realm size:** `staticClosureOf(slot-creating modules ∪ dependent barrels)`, computed from the graph. This decides §3.
* Nothing is fixed before its share is measured. The order below assumes the step 5 split holds.

### 1. One worker pool for record misses, injected like the store
* Same shape as the store (`installRecordStore` / `openRecordStore`) and the artifact builder (`ArtifactBuilder` in `core/`, `createPooledArtifactBuilder` in `cli/`, worker in `bin/`):
  * `plugin-records/core` declares a `RecordWorkers` interface and `installRecordWorkers` / `currentRecordWorkers`.
  * The build CLI and `measure-build-steps.ts` install a `packages/thread-pool` implementation. Its worker entry is a `bin/` module that answers one request kind per record family.
  * Without an installed pool (checks, tests), misses run in-process, exactly as today: one code path for what a record holds.
* **Requests carry data, not handles.** A worker gets the snapshot as its plain file list and blob ids (a structured clone, a few ms), opens the shared SQLite store itself (WAL, as concurrent worktrees already do), writes its records and returns their keys and texts. The main process parses every record from its text, as it does today, so a pooled record and an in-process one cannot differ.
* **Used only above a threshold** of misses. W0, W1 and W3 miss a handful, so they never start a worker, and warm builds cannot regress. Below the threshold the cost is a worker's JIT warm-up; the threshold comes from the measurement.
* **Size:** about ⅔ of the cores (`idealArtifactBuildThreads`' rule), clamped to the build's host grant like the artifact pool. Codegen runs before the frontend, so the two pools never overlap.

### 2. Facet extraction in parallel
* In `extractFacetRecords`, the missed plugins are split into contiguous chunks of the sorted list, so neighbouring plugins share directory reads.
* Each worker builds the strict `FsSnapshot` of its own chunk and runs `facet.extract`. The guard for a read outside the key stays per worker.
* `extractBatch` (cross-refs' token scan) runs per chunk if it is separable per plugin, which is to be confirmed in the code. Otherwise it stays in the main process over the returned data.
* Expected: ~2.5 → ~1 s.

### 3. Barrel evaluation in parallel
* **Per wave, a fresh set of workers.** They are closed when the wave ends, so no worker carries a module whose blob a later phase rewrote. The JIT warm-up is paid twice; the measurement says whether a check on the module blobs could keep the workers instead.
* **Partitioning.** Missed barrels are grouped to limit duplicate loads. Barrels with a large shared closure (ui-kit, web-sdk) go to the same worker, using a greedy split over the module graph's closures. Each worker imports its barrels with the stubs, serializes them, and makes the module records of its closure. The main process merges them; a module record made twice is identical under the same key, and is kept once.
* **The declaration-dependent pass, without a full realm.** Today it imports every barrel into one realm. In this step it runs in one worker that imports only:
  * the modules whose records list created slots, so `getCreatedSlots()` and pane's `headerSlots` are complete;
  * the dependent barrels themselves.
  * It maps each record identity (`module#ordinal`) to the live slot of that realm through `moduleEvaluation`. It then runs `declarePluginSlots` over every barrel's declared sources, revived from the records with live slots in place of the stand-ins, and serializes the dependents.
  * If the measured closure of that set is close to the whole repo, the fallback is today's pass in one worker, overlapped with the other waves. The plan then reports that the dependents set the bound.
* **The guard "a barrel not marked dependent changed across a pass"** needs every barrel live, so it cannot run in this reduced realm. It moves to the check process, which already evaluates live (`declareSlotsFromBarrels`) for the in-sync checks, and stays loud there. It runs in-process when no pool is installed.
* Expected: ~5 s → ~2–2.5 s (the duplicate loads across workers and two warm-ups are the cost).

### 4. File facts in parallel
* `buildModuleGraph`'s misses are batched: one BFS level of unscanned modules at a time goes to the pool (`scanModuleImports` is a pure function of the source). Same for `scanFilesCached` misses above the threshold.
* Only if §0 attributes at least ~0.5 s to the scans. Expected: ~1 → ~0.4 s.

## Expected (quiet VM, to be measured)
| | Today | After |
| --- | --- | --- |
| CC cold codegen alone | 11.5 s | ~7.5–8 s |
| C0 codegen + migrations | 15.7 s | ~12 s |
| W0 / W1 / W3 | 5.4 / 5.8 / 7.8 s | unchanged (no worker started) |

## Gates
* **Correctness:** a pooled cold run's `--dump` equals a serial in-memory run's (every facet, barrel-free and enriched). Every `*-in-sync` check, `plugins-doc-in-sync`, `browser-host:contributions-covered` and `config-v2:registrations-paired` pass on a build whose records were all made by the pool. A second build writes nothing.
* **The dependent pass:** its serialized dependents equal the full-realm pass's on the repo. A seeded new reorderable slot and a seeded new shared pane header each change exactly their dependents.
* **Warm must not regress:** W0, W1 and W3 within noise of step 5 after, with 0 workers started (logged).
* **Cold:** CC and C0 improve against `BUILD_PIPELINE_CC_BASE` = this branch's base.

## Implementation order (one session)
1. Measure (§0), locally and with a spike on the VM.
2. The pool and the injection (§1), with tests: a request round-trip, the in-process fallback, a worker crash failing loudly.
3. Facets (§2). Gate: the dump is equal.
4. Barrels (§3): partitions, then the reduced dependent pass, then the guard moved to checks. Gate: dump, in-sync checks, the seeded dependents.
5. File facts (§4), if measured worth it.
6. VM: `steps-build-pipeline.sh` with CC (`BUILD_PIPELINE_CC_BASE` = base), C0, W0, W1, W3. Then the measurements page ("Step 6" section), the track page's benchmark row, status and checkboxes, and the next main task filed with the page id.

## Critical files
* `plugins/plugin-meta/plugins/plugin-tree/core/internal/facet-records.ts`, `fs-snapshot.ts`.
* `plugins/plugin-meta/plugins/plugin-records/core/internal/{evaluate,module-graph,file-scans,store}.ts`, `core/index.ts`. New: the `RecordWorkers` interface (`core/`), the pooled implementation (`cli/`) and the worker entry (`bin/`; it may live in codegen if it must reach both plugin-tree and plugin-records).
* `plugins/framework/plugins/tooling/plugins/codegen/core/evaluated-barrels.ts`, `slot-declaration-guard.ts`, `scripts/measure-build-steps.ts`.
* `plugins/framework/plugins/slot-declaration/core/declaration.ts` (`moduleEvaluation`, `declarePluginSlots`).
* The build CLI's codegen entry (`plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`), to install the pool.
* Reuse: `createThreadPool` / `serveThreadPool` (`packages/thread-pool`), the `idealArtifactBuildThreads` sizing rule and the grant clamp (`web-artifacts/cli/internal/pooled-builder.ts`), `registerBarrelStubs` / `importBarrel` (`plugin-meta/barrel-import`), `openRecordStore`.
* Harness: `sidequests/clean-install/steps-build-pipeline.sh` (CC already exists; add a pooled vs in-process label).

## Not the fix
* Keeping a warm record store on the VM, or seeding new machines with one. That hides the cold path instead of making it fast.
* A bigger batch size or more threads without the duplicate-load measurement. Past ~4 workers, the artifact pool measured slower, because each worker pays its own warm-up.

## Outcome (2026-11-05)

**Kept: facet extraction on worker threads.** **Reverted after measuring: barrel evaluation on worker threads.**

### What was built
* `plugin-records/core/internal/workers.ts`: record jobs.
  * `defineRecordJob(import.meta.url, name, run)`: a worker imports the defining module and runs the same function.
  * `installRecordWorkers` and `runRecordJobs`: in-process without a pool, or with fewer than two requests.
* `cli/`'s `createPooledRecordWorkers` (on `packages/thread-pool`, about ⅔ of the cores) and the worker entry `bin/record-worker.ts`.
  * Workers return records and never write the store, so a pooled run and an in-process one store the same rows in whatever store the process installed.
* `plugin-tree/core/internal/facet-records.ts`: the missed plugins go in contiguous chunks, at least 64 plugins per worker.
  * Each chunk carries its own strict snapshot, plain data.
  * The worker runs every facet's `extract` and then each batch facet over its chunk (`cross-refs`' token scan is per plugin).
* The build installs the pool in stage 1, sized `min(idealRecordWorkerThreads(), grant.units)`, and closes it at the end of stage 2 (`app-artifacts.ts`).
* `measure-build-steps.ts --workers <n|ideal>`; the harness's CC step now compares `--records` in-process with `--workers ideal`.

### Correctness
* A cold pooled run's `--dump` (every facet, barrel-free and enriched tree) equals a serial in-memory run's, byte for byte.
* A serial run after a pooled one writes no tracked file.
* Unit tests cover the jobs, the in-process fallback, a real pooled round trip, and a failing job.

### Measurements (quiet 6-core VM, cold codegen alone, `--records`, empty data root and transpiler cache, 3 alternating pairs, wall s)

| | In-process | Workers (4) |
| --- | --- | --- |
| `packageNames` (facet extraction) | 3.06 / 2.74 / 2.57 | 1.87 / 1.91 / 1.85 (CPU 5.2 → 6.8 s) |
| `slotDeclarations` | 2.66 / 2.86 / 2.96 | unchanged (in-process) |
| `pluginDocs` | 2.51 / 2.72 / 2.63 | unchanged (in-process) |
| Codegen total | 12.81 / 12.59 / 13.62 | 12.98 / 12.24 / 11.22 |

Facet extraction is 0.9 s (32 %) faster. Cold codegen as a whole moves 12.8 → 12.2 s (medians), within the VM's run-to-run noise. The redesign's ~8 s is not reached.

### Why barrel evaluation stays serial (measured, then reverted)
* **Splitting the barrels loads their shared closure in every worker.** The web barrels' closure is 7,013 modules. Split into 2 / 4 / 6 contiguous groups, the groups load 9.9k / 14.7k / 18.8k modules (interleaved, 4 groups: 18.1k).
* **Importing all 1,140 web barrels is cheap:** 1.55 s on one worker, 1.07 s on 2, 1.00 s on 4, 1.14 s on 6.
* **The parallel part was small to begin with.** In the cold `slotDeclarations` step (2.8–3.2 s in-process), importing the barrels is 1.85 s. The rest is the step's own bookkeeping: the module graph 0.5 s, a second repo snapshot 0.25 s, the pre-barrel guard 0.25 s, writing the barrel records 0.2 s. On 4 workers the imports took 0.95 s, so the step saved ~0.4 s.
* **The declaration-dependent pass costs that back.** Reorder and pane fill their contributions from every slot created in the realm. In-process, every barrel is already loaded and the pass costs 0.11 s. On the pool it needs a realm of its own that loads every slot-creating module (closure 3.6k of 10.4k modules): 0.53 s. `pluginDocs` went 2.6 → 2.9 s.
* **Net: about zero, with a second declaration path** (its own evaluation order) to keep in step. Reverted. The plugin-records CLAUDE.md records why.

### In a real build on this VM the pool is one thread
`cpuBudget()` on the 12 GB VM is `B = 1`, its RAM ceiling: 12 GB × 0.5 / 3.6 GB per unit. So a build's grant is 1 unit, and both the record pool and the artifact pool run one thread.
* C0 (hermetic, both VMs): "Generating plugin registry" → "Running checks" was 21.3 s after, against 21.0 s before. The same path, measured at the same time on two VMs, so contended.
* On the 18-core / 36 GB host, `B = 9` (background window 6), so a build there gets the workers.

### Warm builds: no regression (no worker starts)
W0 codegen + migrations window, medians: 6.10 → 6.08 s. W1 and W3 swung both ways run to run on two concurrent VMs (W1 8.2 → 9.7, W3 9.9 → 11.0, single build each; the code path is the same in-process one).

### What cold codegen still spends (≈ 12 s), for the next step
| Where | s | Note |
| --- | --- | --- |
| Web barrel imports | ~1.9 | inherent cost of evaluating ~7k modules |
| Server / machine / central barrel imports | ~1.0 | |
| Facet extraction | ~1.9 | now on workers |
| Browser host inference + coverage | ~1.5 | |
| First import scans (pluginRegistry, eagerTier) | ~1.4 | two transpiler scans per module, ~11k modules |
| Module graph rebuilt per evaluation | 0.5 + 0.3 | also paid warm |
| Repo snapshot reloaded per evaluation | 0.25 × 2 | also paid warm |
| Pre-barrel freshness guard | 0.25 | |
| Record writes | ~0.4 | SQLite commit cost grows with the number of transactions: 18 MB in 1 transaction 0.22 s, in 60 transactions 1.5–3.0 s; `wal_autocheckpoint = 10000` brings 60 transactions to 0.7 s |
| Docs render + write, registries, the rest | ~1.5 | |

No single part dominates. The levers left are each under 1 s: the repeated graph and snapshot loads (warm too), batched record writes, and parallel import scans.
