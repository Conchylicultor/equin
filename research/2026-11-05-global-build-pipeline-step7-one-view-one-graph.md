# Build pipeline step 7: one file view and one module graph per build

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). Numbers: "Build pipeline: measurements" (`block-9f438022-…`, section "Step 6"). Order of work: "Build pipeline: redesign" (`block-5979c8a6-…`). Prior step: `research/2026-11-04-global-build-pipeline-step6-parallel-cold-records.md`. Task: task-1793834077-yoltiq.

## Context
After step 6, cold codegen alone (CC) is ~12 s on the quiet 6-core VM, and no single part of it is over ~2 s. Warm W0 codegen + migrations is 6.1 s. Step 6's table says ~1.3 s of the cold path is also paid on every warm build: the module graph rebuilt for each evaluation (0.5 + 0.3 s) and the repo snapshot reloaded for each evaluation (0.25 s × 2). Then come the pre-barrel guard (0.25 s), record writes (~0.4 s, cold) and the first import scans (1.4 s, cold).

Reading the code shows these are not separate costs. They come from one structural fact: **the build has no single view of its files.** Each step rebuilds its own:

* **Snapshots.** `loadRepoSnapshot` runs three times in codegen: the build's own (`app-artifacts.ts:438`), then one fresh call in each `evaluate()` (`evaluated-barrels.ts:99`, web and all). Each runs four git commands, `ls-files --others` (an untracked walk of the worktree) included. The fresh calls exist only so that a manifest written mid-build is keyed by its new bytes. But codegen writes every file through one funnel (`writeGenerated`), and `ModuleGraphInput` already has a `written` overlay that no caller sets.
* **Module graphs.** `buildModuleGraph` is a cold BFS on every call. Each call does a `getMany` of the file records per level, a `JSON.parse` of every fact, resolution of every specifier and Tarjan with sha256 Merkle keys. Calls in one cold codegen:
  * facet identities;
  * one per `scanFilesCached` scanner identity (registry, eager tier, icons, data views, portability);
  * `evaluateBarrels` ×2, over two different snapshot objects, so not even the WeakMap memos share;
  * portability, over every server barrel;
  * one per browser-host `absorb` round.
* **Writes.** `putMany` is one SQLite transaction per call. It is called once per BFS level of every graph and once per `scanFilesCached` call (per plugin in the eager-tier scan), so a cold run makes hundreds of tiny transactions. Step 6 measured 18 MB at 0.22 s in 1 transaction and 1.5–3.0 s in 60.
* **Import scans.** The same file is scanned for imports by two implementations: the module graph's (`scanModuleImports`, two `Bun.Transpiler.scanImports` passes) and codegen's (`findImports` over `maskSource`, in `IMPORT_SPECIFIER_SCAN`, the eager tier and portability's `moduleNeeds`).
* **The pre-barrel guard** re-renders and re-formats all 7 pre-barrel manifests that the loop just wrote. The eager-tier one rebuilds a whole registry context to do it (`buildRegistryGenContext(root)` without a memo).

The fix is one view of the files and one module graph per build, shared by every step. That removes the warm-paid costs and most of the cold duplicates.

## Design

### 0. Measure first (locally, then CC on the VM)
* **Sub-spans in `buildModuleGraph`, per call:** store reads, `JSON.parse`, blob lookups, resolution, scans (misses), Merkle (Tarjan + sha256), `putMany`. Also a count of calls and of modules per call. Run in-process, cold and warm, with `measure-build-steps --order pipeline --records`.
* **Per snapshot load:** each git child's time.
* **`putMany`:** the number of calls and of transactions, and the time of each.
* **Import scans:** time for A (the transpiler) and B (`findImports`) over the same files, and whether their specifier sets agree for what B's consumers read. This decides §4.
* Each fix below is done only if its measured share holds. Where the measurement says otherwise, the plan reports why.

### 1. One file view per build: the snapshot plus the build's own writes
* **A view:** the build's snapshot plus a write ledger, in `tooling/core` next to `RepoSnapshot`.
  * Its interface is `RepoSnapshot`'s.
  * `blobOf(rel)` answers from the ledger first (`gitBlobId` of the written bytes), then from the snapshot.
  * A path the ledger creates becomes a member.
  * `written()` hands the overlay to the module graph (`ModuleGraphInput.written`, which already exists).
* **The ledger is filled by the one funnel, `writeGenerated`.** It records every file it writes, or decides not to write because the bytes are equal, into the current view of its root. The view is installed per process, like the record store.
* **Every other codegen write is routed through the funnel or recorded.** Audit them (`config-origin-gen.ts`, package names, docs) with `rg writeFileSync|Bun.write` under codegen and the build's codegen callers.
* **`evaluate()` no longer calls `loadRepoSnapshot`:** it reads the view. `regenerateManifestCodegen` takes the `repo` it already accepts and forwards it. `regen-generated` and `measure-build-steps` install the same view.
* **Loud check that nothing escaped the ledger, at no extra cost:**
  * The frontend stage already takes its own snapshot after codegen (`web-artifacts/core/internal/pipeline.ts:205`).
  * The build compares it with the view for every module the build's module graph keyed. A different blob that the ledger does not explain fails the build, naming the file.
  * Writes by the migration step go through the same ledger, or are excluded by its declared output directory. Which of the two is decided by reading `generateMigration`'s writes.
* **Expected:** −2 snapshot loads, ~0.5 s, warm and cold.

### 2. One module graph per view
* **`moduleIndex(input)`** in plugin-records, memoized per (view, store). It keeps:
  * each module's node (blob, parsed facts, resolved edges), keyed by path and blob;
  * the resolution of each (directory, specifier), dropped when the view's membership changes;
  * Merkle keys per SCC, recomputed only for components whose closure holds a module whose blob changed (a ledger write). If §0 shows that a full Tarjan over the reached set is cheap enough, it is simply recomputed per call.
* **`buildModuleGraph(input, entries)` keeps its signature and its answers.** It extends the index with the modules it has not reached yet, then walks it. Every caller (facet identities, scanner identities, evaluate, portability, the browser host closures) shares one BFS per build instead of 8+.
* **The equivalence gate:** for every caller's entries, `keyOf` and `bundledClosure` are equal between a shared-index run and a fresh `buildModuleGraph` (a test over the repo, plus the existing `closure-equivalence.ts`).
* If sha256 in plain JS (`packages/string-hash`) shows up in §0, the Merkle and record keys take the host's native hasher where one exists. They must produce the same hex, proven by a test.
* **Expected:** ~0.8 s warm and cold, more cold, where each later graph re-parses every record the first one wrote.

### 3. Record writes: one transaction per stage, not per call
* `openRecordStore()` buffers `putMany` in memory. `getMany` answers from the buffer first. `flush()` commits the whole buffer in one transaction.
  * `RecordStore` gains `flush()`; the memory store's is a no-op.
  * The build flushes at the end of each codegen stage and in its `finally`. `measure-build-steps` and `regen-generated` flush at the end.
* A lost buffer (a crash) only means records are computed again: every record is a pure function of its key, so this cannot make a wrong answer.
* Another worktree's concurrent build sees the records one stage later, which is harmless.
* **Expected:** ~0.3 s cold. Step 6 measured ~0.4 s of writes, against 0.22 s for 18 MB in one transaction.

### 4. One import scan per file
* The module graph's file fact (the transpiler scan) becomes the one import fact. `IMPORT_SPECIFIER_SCAN` (the registry's dependsOn and bare specifiers), the eager tier's import reading and portability's `moduleNeeds` read the specifiers from `moduleIndex`'s file facts instead of masking and running `findImports`.
* **Only where the two readings agree for what that consumer needs** (§0's comparison). A consumer that needs type-only imports, for example, keeps its own scan, and the plan reports which one and why.
* If the remaining cold scans are still ≥ 0.5 s, the misses of a BFS level go to the record workers (a record job over chunks of files: `scanModuleImports` is a pure function of the source). On the VM a real build has a 1-unit grant, so only CC `--workers ideal` and the 18-core host benefit.
* **Expected:** 1.4 → ≤ 0.8 s cold.

### 5. The pre-barrel guard reads the ledger
* The guard's question: is every pre-barrel manifest on disk exactly what this pass rendered, before the first barrel import?
* With the view, `writePreBarrelManifest` records each manifest's rendered and formatted bytes in the ledger, even when equal to disk. The guard then checks that every registered manifest has a ledger entry from this pass and that its file still holds those bytes: 7 reads, no render, no format.
* A manifest the loop did not write, or one overwritten since, still throws, with the same message.
* `renderEagerTierManifest` reuses the registry context of the view instead of building a new one.
* **Expected:** ~0.25 s, warm and cold.

## Expected (quiet VM, to be measured)
| | Step 6 after | Step 7 (estimate) |
| --- | --- | --- |
| W0 codegen + migrations | 6.08 s | ~4.5 s |
| CC cold codegen alone (in-process / pooled) | 12.6 / 12.2 s | ~10 s |
| C0 codegen + migrations | 15.7 s | ~13.5 s |

The redesign's ~8 s cold is not reached by this step alone. What remains is evaluating barrels (~2.9 s, inherent), facet extraction (1.9 s), and browser-host coverage's source reads, which are not records today. The next step's candidates come from §0's split.

## Gates
* **Correctness:**
  * `measure-build-steps --dump` is equal between this branch and its base, both cold and `--records` warm.
  * Every `*-in-sync` check, `plugins-doc-in-sync`, `browser-host:contributions-covered` and `config-v2:registrations-paired` passes.
  * A second build writes nothing.
  * The shared-index equivalence test passes (§2).
* **The view:**
  * A test writes a manifest mid-pass and checks that the module graph keys it by the new bytes.
  * A seeded write that goes around the funnel fails the build's end-of-codegen comparison, naming the file.
* **The guard:** a seeded out-of-order barrel import still throws.
* **Warm does not regress:** W0, W1 and W3 are measured against `BUILD_PIPELINE_CC_BASE` = this branch's base.

## Implementation order (one session)
1. §0 measurement, locally.
2. §3 buffered store: small, and independent of the rest.
3. §1 the view, with the ledger and the end-of-codegen comparison.
4. §2 the shared module index, with the equivalence test.
5. §5 the guard on the ledger.
6. §4 scan dedup, as far as §0's comparison allows.
7. VM: `steps-build-pipeline.sh`: CC as alternating in-process and pooled pairs (`BUILD_PIPELINE_CC_BASE` = base, `BUILD_PIPELINE_CC_RUNS=3`), C0, W0, W1, W3.
8. Measurements page ("Step 7" section), the track page's benchmark row, status and checkboxes. Then file the next main task with the page id.

## Critical files
* `plugins/framework/plugins/tooling/core/repo-files.ts`, `types.ts`: the view.
* `plugins/framework/plugins/tooling/plugins/codegen/core/write-generated.ts`, `evaluated-barrels.ts`, `regen-pipeline.ts`, `pre-barrel-guard.ts`, `pre-barrel-manifests.ts`, `plugin-registry-gen.ts`, `eager-tier-gen.ts`, `browser-host-gen.ts`, `scripts/measure-build-steps.ts`.
* `plugins/plugin-meta/plugins/plugin-records/core/internal/module-graph.ts`, `file-scans.ts`, `evaluate.ts`, `store.ts`, `keys.ts`; `cli/internal/sqlite-store.ts`.
* `plugins/plugin-meta/plugins/plugin-tree/core/internal/facet-records.ts`.
* `plugins/framework/plugins/tooling/plugins/boundaries/core/portability.ts`.
* `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts` (install the view, flush the store, the end-of-codegen comparison); `regen-generated/cli/run.ts`; `migrations/cli/drizzle-verdict.ts` (read the view, not a new snapshot).
* Harness: `sidequests/clean-install/steps-build-pipeline.sh`.

## Not the fix
* **Memoizing `loadRepoSnapshot` per process.** A build writes files mid-process, so a memo would key a written manifest by its old bytes. The view is exact because it knows what was written.
* **Keeping a warm store on the VM.** That hides the cold path instead of fixing it.
* **More worker threads for the scans before the duplicates are gone.** That parallelizes work that should not be done at all.
