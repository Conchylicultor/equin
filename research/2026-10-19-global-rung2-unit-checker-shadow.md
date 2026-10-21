# Rung 2 step 2: the unit checker, in shadow mode

Task: task-1792312301-fcfodz (att-1792413968-s2bio1). Track: "Track: build and push speed"
(wiki block-e5afc5b1-…). Design: its sub-page "Rung 2 design" (block-a9e68ab6-…), sections
"Design", "Open before implementation", "Step 1b result", "Step 1c result".
Previous step: research/2026-10-18-global-tsc-recheck-follows-contracts.md.

## Context

Today one worker loads the whole repo (~12k files) as one TypeScript program. Since step 1c it
re-checks only the files whose key moved, from a host-wide store. Three costs are still a function
of the repo, not of the change:

- every run parses and binds every file (6–8 CPU-s, ~3.7 GB);
- a wide change peaks at 9–13 GB in one process, and runs on one core;
- import cycles through the build-time registries are re-checked whole (up to 174 files).

Rung 2 checks each **unit** (a plugin's barrel folder, ~3,700 of them, no cycles) from its own
sources plus the `.d.ts` **contracts** of the units it imports, in a pool of small processes. Step 2
builds that checker and runs it **in shadow**: beside the current worker, never deciding a verdict.
It logs where the two disagree and what the units would have cost. Step 3 switches over.

**Decided with the user:** shadow runs only on request. That is an env flag for one check run, the
daily backstop on main, and a replay script. The fleet pays nothing by default. Everything shadow
adds is removed when units become the default (the cleanup list below goes on the track page).

**The baseline moved.** The design page's model (median 106 → 14 CPU-s) was made against the
pre-1c worker. Step 1c already brings a hub API change to ~34 CPU-s in one program. Units checked
one program each would cost ~1,078 × 0.375 ≈ 400 CPU-s there, the per-program fixed cost
dominating. So this plan separates the **key** granularity (one unit) from the **program**
granularity (a batch of ready units sharing one program and one checker). Step 2 measures both
against step 1c, not against the old numbers.

## Phase A: answer the open questions first (measure, then write them on the page)

A manual probe, `type-check/scripts/unit-probe.ts`, reuses the Phase B modules as they are built.
Each answer, with its method, goes on the design page **before** Phase B is wired into anything.

1. **The cost of computing keys.** A unit key is a read-set key (below). Warm lookup is the
   recorded read-set re-verified: own file versions, dependency contract hashes, `node_modules` /
   lib declaration versions, and every recorded module resolution re-resolved with
   `ts.resolveModuleName` and a shared `ModuleResolutionCache`. Measure all 3,700 keys on an
   unchanged tree, and after a commit. Gate: under ~2 CPU-s, well under the 6–8 s parse floor it
   replaces. If resolution re-verification dominates, measure keying resolutions on the
   directory listings they probed instead.
2. **Store size and eviction.** Bytes per entry (diagnostics, read-set, contract) and per full
   tree version. Growth per commit over the 31 replayed main commits. Contracts stored
   content-addressed in their own store (dedup: early cutoff means most re-checks emit the same
   text), and read-sets as lists of hashes. Pick age and count bounds from the numbers, as
   `file-results-store.ts` does.
3. **Process memory.** Peak RSS of one pool process checking all units, with the shared
   environment cache (lib, `@types`, `node_modules`, contracts) unbounded, then LRU-bounded by
   bytes (0.5 / 1 / 2 GB), and the CPU each bound costs in re-parsing. Compare against assigning
   units to processes by area of the graph (top-level umbrella). Pick one.
4. **Granularity.** Per-program fixed cost vs batching. Check the 1,078 `web-sdk#core` importers,
   and a small change (~20 units), at batch sizes 1 / 8 / 32 / 128 ready units per program.
   Report CPU, peak and wall at the pool size. Units in one batch still see each other only as
   contracts, so a unit's result does not depend on its batch (asserted by test). Merging
   single-file units is measured only if batching leaves the fixed cost dominant.

## Phase B: build the shadow checker

New files go flat in `type-check/shared/` and `check/` (`selfSourceHash` covers only top-level
files).

- `shared/units.ts`: `unitOf(repoPath)`, a pure function of the path: plugin × barrel or leaf
  folder (the vocabulary in `plugins/framework/plugins/plugin-id/core`), plugin-root files, and
  `#test` for `*.test.ts(x)` / `__tests__/`. Gitignored generated files belong to their host
  folder's unit.
- `shared/unit-host.ts`: the `CompilerHost` of a batch program. It serves the batch's own
  sources. A resolution into another unit (or into another batch member) is redirected to that
  unit's contract, served as a virtual `.d.ts` beside its source path, so the contract's own
  imports resolve from the source location (the prototype's fix for plugin-local
  `node_modules`). Global files (`declare global`, scripts, module augmentations) and ambient
  `.d.ts` go into every program, as the root tsconfig does now. The shared `SourceFile` cache is
  bounded per Phase A.3. Every loaded file and resolution is recorded.
- `shared/unit-check.ts`: checks a batch, and per file reuses `checkFile` and
  `canonicalDeclarations` from `shared/keyed-check.ts`, so a signature means the same thing in
  both checkers. It returns per unit: the files' results, the contract text, and the read-set.
- `shared/unit-store.ts`: three `pass-set` stores: unit results by key, contracts by hash, and a
  head index (unit → its last few read-sets, most recently used first, like the lint entries).
  New data dirs: `type-check-unit-results`, `type-check-unit-contracts`.
- Key: `H(unit engine fp, unit id, own (path, version), sorted read-set (path, shape) +
  resolutions)`. Shape is a contract hash for a repo file, a version for a declaration input.
  Early cutoff: a re-checked unit whose contract hash is unchanged leaves its importers' keys
  unchanged. The unit engine fp is `tscEngineFp` plus the unit sources.
- `shared/unit-worker.ts`: a pool process entry, JSON lines over stdio (batch in, results out).
  It keeps its environment warm across batches. A batch member that needs a contract that is
  not ready is returned as `needs <unit>`, never guessed.
- `check/unit-shadow.ts`: the scheduler. A DFS over the unit DAG (from prepare's import graph,
  corrected by recorded read-sets) resolves keys bottom-up. Ready misses go out in batches to
  `P` processes, sized from the grant the check already holds. It runs after the whole-program
  worker returns and has released its slot, so the shadow never holds a worker slot.
- Comparison: when shadow is on, the worker job asks for its per-file results (diagnostics and
  signature), and the shadow compares them per file. It reuses `TscDivergence` with a `source:
  "units"` arm. Divergences are logged, and filed as `type-check-divergence` reports by the
  backstop.
- One transcript line per shadow run: `type-check: units (shadow): H of U units hit, C checked
  in B batches on P processes; keys Xs, cpu Ys, peak Z GB; D divergences`. It never changes the
  verdict. A crash in the shadow is reported loudly in the transcript and fails nothing.
- Activation: `SINGULARITY_TYPE_CHECK_UNITS=shadow` on a check run; the `backstop` job runs
  shadow daily on main; `scripts/unit-shadow.ts <checkout>` runs it by hand (the dual-check
  pattern).

Every file is under `plugins/framework/` (the type-check check). Approving this plan approves
editing there.

## Phase C: before/after benchmark (the design page's "Step 2 result")

Method as in step 1c: separate `SINGULARITY_DIR` per side, warmed on the base tree and
snapshotted, one patch per scenario, one sample each, CPU from the cost lines.

- **Before:** the step 1c worker.
- **After:** the unit checker's would-have-cost from the same run. Same 14 scenarios, plus cold
  (empty stores) and identical tree.
- Columns: CPU, peak per process, wall at the pool size, units checked, batches.
- Correctness: shadow over the 31 replayed main commits (48d95e56d9 → 4e1e2c0e65). Gate: 0
  divergences before step 3.
- Re-check the design page's M4 table against the real numbers, as its last open item asks.

Then update the track page:

- status and checklist (step 2);
- the cleanup item below;
- file the step 3 task (one task only), with the page id.

## Cleanup once units are the default (step 3; goes on the track page now)

- Remove the `SINGULARITY_TYPE_CHECK_UNITS` flag, the shadow scheduler mode, the worker's
  per-file results field, and the `source: "units"` comparison arm.
- Retire the whole-program worker and step 1c's keyed check from the check path. The backstop
  keeps one whole-program run as its oracle, and nothing else.
- Retire `scripts/unit-probe.ts`, and `unit-shadow.ts` if the backstop covers it.
- Retire the stores and data dirs only the whole-program path uses (`type-check-file-results`,
  program manifest / pass records if units replace the program key), declared as retired the way
  `retiredLintResultsDir` is.

## Verification

- Unit tests (`./singularity test plugins/framework/plugins/tooling/plugins/checks/plugins/type-check`):
  - `unitOf` over the folder vocabulary;
  - the unit checker equals `keyedCheck` on `keyed-check.test.ts`'s fixtures (body edit, API
    change three contracts deep, cycle, augmentation, shadowing file, import that starts
    resolving, store warmed on another tree);
  - a unit's result is independent of its batch;
  - the read-set key moves on each of those cases, and only those.
- Phase A answers and Phase C table on the design page, the replay at 0 divergences.
- `./singularity check` and `./singularity build` green, with shadow off (default) and with the
  flag on.
