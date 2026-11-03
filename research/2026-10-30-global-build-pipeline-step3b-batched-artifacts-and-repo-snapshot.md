# Build pipeline step 3b: batched artifact builds (cold), then the repo snapshot

Track: wiki "Track: build pipeline (codegen, migrations, frontend)" (`block-3e7bbe1c-…`). This step implements redesign item 9 (cold web artifacts), generically, for the worker artifacts and the page artifacts. Then it implements item 3 (the repo snapshot). Sub-pages: "Build pipeline: measurements" (`block-9f438022-…`) and "Build pipeline: redesign" (`block-5979c8a6-…`).

## Context
* **Step 3a's exit gate is "cold must not regress", and it does not hold yet.** The frontend median went 49.2 → 58.6 s on the quiet VM.
* **Re-reading 3a's cold logs (`~/.equin-clean-install/si-clean-bp3a-{base,after}`) changes the diagnosis.** The worker artifacts are not the main cause. After 3a, a cold frontend splits like this:

  | Stage | Cold (3 runs) | Notes |
  | --- | --- | --- |
  | `artifacts:build` | 44.4 / 46.1 / 35.6 s | 1,659 page artifacts, one vite run each, gate = 3 on 6 cores |
  | `artifacts:browser-hosts` | 3.8 / 4.3 / 3.1 s | 243 worker artifacts, one vite run each, found wave by wave |
  | `artifacts:vendors` | 3.3 / 3.5 / 3.1 s | resolve takes 0.13 s; the rest is placing PGlite's 16 MB of package assets (precompress, once per PGlite version) |
  | `artifacts:worker-link` | 1.7 / 1.9 / 1.5 s | 493 linked entries |
  | `artifacts:compose` | 4.2 / 4.2 / 3.9 s | |
  | `css-key` + `css` | 0.3 s | |

  * The base run has no stage lines (they were added in 3a), so the per-stage regression cannot be read off directly.
  * Two of the after runs are 48.4 s and 58–61 s. The spread is mostly in `artifacts:build`, which competes with the cold type-check (183–219 s) that the hermetic build runs **in parallel**. The cold metric is therefore dominated by CPU contention, not by the pipeline.
* **The biggest cold cost is the page: 1,659 separate vite runs, \~40 s.** This is redesign item 9. The worker artifacts use the same builder and the same shape (3–4 s).
* **User direction (2026-10-30): the most impactful thing first, built generically so other parts can reuse it.** So the work is one batched builder, applied to every artifact kind, followed by the repo snapshot.

## Phase 0: measure what one artifact build costs (decides the design)
* **New VM scenario `CF`** in `sidequests/clean-install/steps-build-pipeline.sh`: the C0/C1 hermetic cold build with `--skip-checks` (hermetic accepts it, `build/cli/internal/hermetic-build.ts:117`), 3 runs.
  * It measures the frontend without the parallel type-check, so the before/after is not CPU-contention noise.
  * C0/C1 stay as they are, as the "real cold" number.
* **CPU profile of one CF build's `artifacts:build`** (Bun `--cpu-prof-md` is already wired). Split the per-artifact cost into:
  1. vite and config setup per run (`viteBuild` entry, plugin construction, `import("vite")` once);
  2. transform: oxc for TS, and **Babel through `@vitejs/plugin-react` with the React Compiler** (JS, single-threaded on the main thread);
  3. Rolldown bundle and minify (native, multithreaded);
  4. post-build work: `assertWorkersSelfContained`, `parseEmittedImports`, `artifactSourcemaps`, `tailwindCandidatesOf`, `listOwnFiles` (a second walk), and `publishArtifact` (precompress).
* **Decision rule.**
  * If (1) dominates, batching is the lever (the spike's 16 ms/entry vs \~70 ms/artifact observed suggests it does).
  * If (2) dominates, batching alone will not help. The lever is then Babel off the main thread (transform in worker threads), or narrowing the React Compiler to `.tsx` files that contain components. The batched builder still lands, because it removes (1), and the transform lever gets its own sub-step.
  * If (4) dominates, fix those directly: a single pass over the emitted files, and no Tailwind scan for worker-only kinds.
* Record the split on the measurements sub-page before writing code.

## Part A: one batched artifact builder (generic, every kind)

### A1. `buildArtifactBatch(targets, ctx)` (`web-artifacts/core/internal/vite-builder.ts`)
* **One vite/Rolldown invocation builds N targets.**
  * `lib.entry` (or `rolldownOptions.input`) maps each target's entry (and its co-entries) to `<dirName>/index.js` / `<dirName>/<folder>.js`.
  * `preserveEntrySignatures: "strict"`, the same `define`, minify and sourcemaps as today.
  * The outputs are split back into each target's own tmp dir and published as separate content-addressed artifacts, as now.
* **Per-target rules become per-module rules, resolved by owner.** Every module that is not external belongs to exactly one target: the one whose hashed roots contain it.
  * A batch owner map `file → target` replaces the per-run closures for `makeArtifactExternal`, `ownFolderBarrelPlugin`, `createInlineAudit` (one audit per target, fed by owner) and `chunkCssPlugin` (keyed by the chunk's entry target).
  * A module reached from a target that does not own it fails the inline audit, exactly as today.
* **Disjointness, asserted per batch.** No emitted chunk may be imported by two targets' outputs. Rolldown runtime helpers are included in this.
  * The batch is partitioned so it holds at most one target per (plugin, kind). A plugin's `web` and `core` never share a batch, because both can inline its `shared/`. This makes the property structural rather than lucky.
  * A violation throws and names both targets. There is no silent fallback.
* **Nested worker builds** (`new SharedWorker(new URL(…))`) keep vite's own worker pass, audited against the owning target.
* **The post-build steps run once over the batch's output,** then per target: emitted-imports parse, sourcemap check, and candidates (skipped for `WORKER_ONLY_KINDS`, which contribute none, `core/constants.ts:88`).
* **A failure names the target.** The Rolldown error carries the module path, and the owner map turns it into the target's `dirName`.
* `buildArtifact(target, ctx)` becomes `buildArtifactBatch([target], ctx)`, so there is one code path. A warm build with one stale artifact is a batch of one, at today's cost.

### A2. Batching in the pipeline (`pipeline.ts`, `plan.ts`)
* **`ensure` becomes `ensureMany(targets)`.** Each wave (`webTargets`, each `resolveBarrelClosure` wave, the host closure waves) hands all its stale targets to the scheduler at once.
* **The scheduler** (a small generic `createBatchScheduler({ partition, maxBatch, concurrency })` in `web-artifacts/core/internal/`) splits a wave into disjoint batches of up to `maxBatch` entries and runs `concurrency` of them at a time. This is the reusable piece: any later builder (registry, vendors, frames SW) plugs in its own partition and build function.
  * `maxBatch` and `concurrency` are set from Phase 0. A native-dominated cost wants a few large batches; a Babel-dominated one wants batches spread over worker threads.
* **Fewer waves for the worker closure.** `planHostClosure` seeds wave 1 with every member of the host's generated `hostEntries` (codegen's coverage-guarded list), instead of waiting for the entry artifact's emitted dynamic imports. Discovery stays as the check: an emitted spec outside the planned set is planned in the next wave, as today.
* The reused path (`touchArtifact`, `readArtifactMeta`) is unchanged.

### A3. The smaller cold stages, measured after A1–A2
* `artifacts:compose` at 4 s cold, and `worker-link` at 1.7 s: profile them in the same CF run, and fix whatever is O(N) work done serially. There is no design until the numbers are in.
* `artifacts:vendors` package assets (3 s once per PGlite version) are a legitimate cold cost, and are left alone.

### A gates
* **CF (cold, no checks): the frontend must beat 3a's base.** Target: `artifacts:build` from \~40 s toward the spike's rate. This is the exit criterion's "cold 3×" lever for the frontend.
* **C0/C1 (cold, with checks) must not regress against the 3a base** (49.2 s median).
* **Warm W0 / W1 / W4 must not regress.** W4 still rebuilds exactly one `server` artifact.
* **Byte-level equivalence.** For a sample of 30 artifacts across kinds (with co-entries, workers, CSS chunks), batched and single builds must give the same export names, the same import specifiers, the inline audit passing and `scanStagedModules` passing. `BUILDER_VERSION` is bumped, so every store entry is rebuilt once.

## Part B: the repo snapshot (redesign item 3), generic
### Model
* **`loadRepoSnapshot(root)`** in `plugins/framework/plugins/tooling/core/repo-files.ts` extends the existing `RepoFiles` (`loadRepoFiles` / `repoFilesOver`: `all`, `has`, `under`, `glob`, `read`) with:
  * `blobOf(path)`: for tracked clean files, the blob id from `git ls-files -s -z`; for dirty and untracked files, the blob id hashed once (`git hash-object --stdin-paths`, one child). The dirty set comes from `git status --porcelain=v1 -z` (the parsing in `main-tree-guard.ts:117` is reused);
  * `dirs()`: the directory set derived from the path list, so no consumer runs `readdir` to find plugin dirs.
* **It is taken once per pass and handed around, never a module memo** (the `repo-files.ts` rule). It is refreshed after the codegen writers, a `git status`-only refresh that is O(changes) thanks to git's stat cache.

### Consumers, in order of measured walk cost
1. **The plugin tree** (`plugin-meta/plugins/plugin-tree/core/internal/plugin-tree.ts`): `findAllPluginDirs` and `hasPluginContent` from `snapshot.dirs()` / `under()`; `fs-snapshot.ts`'s directory walk from the path list (it already filters by `loadRepoFiles`); the per-node `existsSync` barrel probes from `has()`. That removes up to 3 walks per tree build, times 2 trees.
2. **`ensureDeps`** (`cli/plugins/bootstrap/cli/ensure-deps.ts:250`): the `package.json` set from the snapshot instead of the `readdirSync` recursion. It runs up to 2× per build. The signature keeps stat-ing the files (it must see an edit made after install), but only for those files. The provision inputs keep their own read.
3. **Web-artifacts own files** (`own-files.ts` `listOwnFiles` / `ownHashFor`): the file list from `snapshot.under(root)`, and the hash from blob ids (no stat-and-hash, and the per-worktree mtime `FingerprintCache` goes away). A fresh worktree then knows every address at once.
   * **Prerequisite, checked first:** today the walk hashes gitignored files inside hashed roots (codegen's `*.generated.ts`), and the snapshot would drop them. List which gitignored files sit inside hashed roots. Either the codegen writer reports what it wrote into the snapshot, or those files are named explicitly. Never a silent change of what an address covers.
4. **The checks' tree hash** (`checks/core/tree-hash.ts`, task-1793226360-6doqmm): left to that task. The snapshot's blob map is the input it would hash, and the checks run in a child process, so they would need it passed as a file. Out of scope here; noted on the track.

### B gates
* W0 and W3 codegen + frontend must drop by the walk cost (the step 1 breakdown puts \~4.5 s of main-thread `readdir` in a warm build). Recount `getdirentries` / `access` with `fs_usage` on one W0 run: target a 10× reduction.
* Docs, registries and artifact addresses must be byte-identical to before on the main composition. The address format change in B3 is the one intended exception, with a `BUILDER_VERSION` bump.

## Order and session plan
1. Phase 0 (CF scenario plus profile) on the base. Write it on the measurements page.
2. A1 + A2, with tests, then a VM run (CF, C0/C1, W0, W1, W4) and the benchmark on the page.
3. A3, if the CF profile shows compose or the link stage as O(N) serial work.
4. Part B in the same session if time allows (the track prefers fewer sessions). Otherwise file it as the next main task with the page id.

## Critical files
* `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/`:
  * `vite-builder.ts` (batch builder);
  * `pipeline.ts` (`ensureMany`);
  * `plan.ts` (`resolveBarrelClosure`, `planHostClosure` seeding);
  * `inline-audit.ts` (owner-fed audits);
  * `own-files.ts` (B3);
  * new `batch-scheduler.ts`.
* `web-artifacts/scripts/spike-multi-entry.ts`: reused for the equivalence sample.
* `plugins/framework/plugins/tooling/core/repo-files.ts` (snapshot).
* `plugin-meta/plugins/plugin-tree/core/internal/{plugin-tree,fs-snapshot}.ts`.
* `cli/plugins/bootstrap/cli/ensure-deps.ts`.
* `cli/plugins/build/cli/internal/app-artifacts.ts`: takes the snapshot and passes it to the stages.
* `sidequests/clean-install/steps-build-pipeline.sh` (CF scenario).
* `web-artifacts/CLAUDE.md`: the batch builder invariant (one owner per module, disjoint batches).

## Verification
* `./equin test plugins/framework/plugins/tooling/plugins/web-artifacts`. New tests:
  * the batch splits outputs per target;
  * a shared chunk throws and names both targets;
  * the owner-fed inline audit rejects a foreign module;
  * the partition never puts two targets of one plugin in a batch;
  * the error names the target.
* `./equin test plugins/plugin-meta/plugins/plugin-tree` and the `repo-files` tests (snapshot: dirty, untracked, deleted, symlink mode 120000 excluded).
* `./equin build`, then:
  * the app with the `browser_*` tools (agent manager, pages, the lumen demo: reads answer, no console errors);
  * `./equin check`;
  * a hermetic build of the main composition with no symlinks in the materialized dist.
* The VM before/after table on the track page, then file the next main task.
