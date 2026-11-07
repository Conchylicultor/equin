# Build pipeline step 13 (closing): the last whole-set reads of a no-change build

Track: wiki "Track: build pipeline" (`block-3e7bbe1c-…`). Numbers: "Build pipeline: measurements" (`block-9f438022-…`). Previous step: `2026-11-06-global-build-pipeline-step12-no-change-whole-set-work.md`. Task: the track's closing step.

## Context
After step 12 a no-change build (W0) is 6.2 s on the quiet VM, and the exit criterion "a change costs what it touches, no whole-set work" still fails on four items (step 12's caveats): browser-host coverage reads and masks every scoped source each build (0.7 s VM), the backend keep-check stats every server file (0.73 s VM), ~70k record keys read one by one, and the staged-module scan re-reads every staged module (~0.2 s). Out of scope: the filesystem change signal (pending user decision), `tsc:repo`, native React Compiler.

## 1. Measured first (host, this worktree, W0 `--skip-checks`, load ~3)
Five W0 builds, 6.4–6.9 s wall. Spans: `browserHostCoverage` 0.42–0.46 s (+ infer 0.23), `adoptDeploy` **bimodal 0.15 / 0.60 s**, `pluginDocs` 0.57–0.63, `artifacts:compose` 0.41–0.46, `packageNames` 0.33–0.35, `tsc:repo` 1.3–1.4 (critical path, not this track's).

**Keep-check (`adoptDeploy`).** The backend's own runtime profile: the adopt route is 145 ms self in the fast mode, ~520 ms in the slow one (the slow one is other backend work interleaving with the walk's 5,371 macrotask yields: the walk is one file at a time). A script timing the same walk (`closureChangedSince` over the backend entry, warm: every file's facts memoized): 330–350 ms. Split:

| part | ms |
| --- | --- |
| 5,371 `stat`s awaited one at a time | 128 |
| the same, 64 at a time | **14** |
| 5,371 macrotask yields | 7 |
| `Bun.resolveSync` × 18,759 imports (14,025 distinct (dir, specifier)) | 60 |

So the walk's cost is serialization, not the stats: the O(closure) stat floor is ~14 ms and only a change signal removes it (the pending decision). The build's repo view cannot replace it: the judge rests on inode change times since the process started (a revert or a lazily loaded module edited and restored must still count), which git's content view does not see.

**Record reads.** Traced every `getMany` of one W0 build: **431 ms of SQLite time** over 83k keys asked of SQLite: facets 18,678 keys (108 ms), module-graph file facts 10,747 (79), the registry import scan 8,722 (60), icons 12,758 (43), eager tier 7,997 (39), web/server evaluations 7,112 + 3,477 module + 1,847 evaluated (49), data views 4,891 (21), portability 4,627 (16). A lookup is a random B-tree probe of `keys` plus one of `vals` (~22 µs per key on the 1 GB store, measured: 20k random facet keys 450 ms, keys alone 147 ms). Material: the biggest item left.

**Coverage.** CPU profile of the build: `endpointExports` ~235 ms, `parseShape` ~140, `serveWrappers` ~100, plus reading every scoped source and every backend source (the serving-wrapper fixpoint reads all ~5k backend files).

**Staged scan.** compose 0.41–0.46 s on the host; the scan's read + lex was ~0.2 s on the VM (step 12). Decided last, only if cheap.

Seen, not this track's: the prerequisite doctor (~0.2 s, `assertPrerequisites`), `tsc:repo`.

## 2. Fixes, by size

### a. Grouped record reads (records)
A **group record**: one record holding the values of a fixed set of member records, keyed by the member keys alone (`recordKey("group", table, …sorted member keys)`), stored in a new `group` table. `readGrouped(store, table, groups)` (plugin-records `core`) answers every member it can: a group's one record where it exists, else its members one by one — and when every member of a group was found, it writes the group record. A group record is a pure function of its key like any record (its key IS its members' keys, each the full identity of its value), so it never goes stale, and a change re-keys only the groups holding a changed member: per plugin, never all-or-nothing.

Callers group by plugin:
* facet records (`facetRecordTexts`): one group per plugin node (its ~11 facet keys): 18.7k → ~1.7k lookups;
* file scans (`scanFilesCached`): one group per owning plugin of the files passed (~40k → ~2–3k);
* module-graph file facts (`walkLevels`): one group per (level, plugin) — deterministic for a given snapshot and entries, so a no-change build hits.

Evaluations (~12k keys, ~50 ms) stay per key.

### b. The keep-check walks a level at a time
`walkClosure` (source-digest `shared/digest.ts`, the one walk the digest and `closureChangedSince` share) visits a frontier at a time: facts (stat, memo, read) for up to 64 files at once, package checks of a batch at once, one macrotask yield per batch, not per file. Same visits, same resolution, same refusals; a changed file still fails the walk (which one is named when several changed is no longer the DFS-first, any is a restart). Expected: the walk ~0.33 → ~0.1 s in a script, the backend's 0.15 → well under, and the slow mode's interleaving gone with the 5,371 yields.

### c. Coverage facts as file records
`browser-host-coverage.scan.ts`: one file record per scanned source (keyed by its blob, path and the scan's code) holding everything the coverage reads of ONE file — raw imports and export clauses (specifiers unresolved), locals and local export aliases, page-bound, the scope-fetcher line, its descriptors (`buildDescriptorIndex`) and endpoints (`endpointExports`), the second-use line of each local declaration, raw `/api/` prefixes with lines, the register markers present, each top-level function's first parameter and the callee names it passes that parameter to first, register/wrapper call sites (name, args text, line), its bindings (`parseFileBindings`), and its `httpRoutes` entries (or the error naming why they cannot be read). Resolution against the file set (`resolveModule`), re-export resolution, the wrapper fixpoint, `registerCallTarget` over the descriptor indexes and the verdict stay in `resolveHostCoverage`, over the facts. `SourceScans.read` returns a module over facts read through `scanFilesCached` (grouped by plugin, (a)). Same verdict, same `hostReads` (the generated files must be byte-identical), same error texts; `browser-host-coverage.test.ts` pins it.

### d. Staged scan (only if cheap)
A per-store-entry surface record (exports, import edges of each staged module, keyed by the entry's address) would make it O(new entries). Decided after (a)–(c), by measured size.

## Verification
* Tests: `./equin test` on `packages/source-digest`, `plugin-meta/plugin-records`, `plugin-meta/plugin-tree/faceted`, `framework/tooling/codegen`.
* A build regenerates byte-identical generated files and docs; `./equin check` passes (`plugins-registry-in-sync`, `browser-host:contributions-covered`, `plugin-records:scan-key-width`).
* Host: the same `getMany` trace (keys asked of SQLite, SQLite ms) and spans before/after.
* Quiet VM, base `927a4813e1` and the branch in two worktrees of one VM, alternating: W0 with and without checks, W1, W3; CC and C1 must not regress.

## Critical files
* `plugins/plugin-meta/plugins/plugin-records/core/internal/{store,file-scans,module-graph}.ts` (+ a `grouped.ts`)
* `plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core/internal/facet-records.ts`
* `plugins/packages/plugins/source-digest/shared/digest.ts`
* `plugins/framework/plugins/tooling/plugins/codegen/core/browser-host-coverage.ts` (+ `browser-host-coverage.scan.ts`)

## Outcome (2026-11-07)
Landed (a), (b), (c). (d) declined, measured: the staged scan is ~0.3 s of `artifacts:compose`, and compose runs beside `tsc:repo` (1.4 s), which ends later in every no-change build — off the critical path, so a per-entry record would buy no wall time.

### What changed
* `plugin-records`: `readGrouped` + the `group` table (a group of one member is read as that member); used by facet records (per plugin), file scans (per owning plugin), module-graph levels (per level and plugin) and evaluation module records (per plugin). Evaluated records (one per barrel) stay per key. A group hit refreshes no member row's last-read day, so a plugin quiet for over 7 days recomputes its own members on its next change — bounded by that plugin.
* `source-digest` `walkClosure`: a level at a time, 64 files at once, one yield per batch.
* `codegen` coverage: `browser-host-coverage.scan.ts` (a `FileScan`), the guard over facts; files asked in batches (`readMany`); a serving wrapper's call sites read off the source of the few files calling one. The sanctioned `marker-scan-safety` exemption moved to the scan module (the raw `/api/` scan lives there now). Its line lookup is a per-file line table: `lineAt` per import and call made a first cold scan 8.7 s.

### Measured
**Host (W0, load ~3):** record reads' SQLite time 431 ms / 83k keys → ~150–280 ms / 30–45k (the coverage's own records included); `browserHostCoverage` 0.43 → 0.19–0.20 s; `adoptDeploy` 0.15 / 0.60 → 0.05–0.22 s; the keep-check walk in a script 330–350 → 123–127 ms.

**Quiet VM (6 cores / 12 GB), base `927a4813e1` and the branch in two worktrees of ONE VM, alternating (s):**

| | Base | Branch |
| --- | --- | --- |
| W0 full build with checks | 6.24 / 6.26 / 6.29 | **5.25 / 5.31 / 5.31** |
| W0 `--skip-checks` | 6.34 / 6.38 / 6.39 | **5.45 / 5.45 / 5.62** |
| … codegen + migrations (`packageNames` → `formatSources`) | 3.09–3.14 | **2.64–2.67** |
| … browser-host infer + coverage | 0.72–0.74 | **0.45–0.47** |
| … `adoptDeploy` | 0.72–0.75 | **0.23–0.25** (one 0.45) |
| … `packageNames` / `pluginDocs` / compose / frontend | 0.34–0.35 / 0.62–0.64 / 0.32–0.47 / 0.85–0.97 | 0.28 / 0.63–0.64 / 0.33–0.47 / 0.86–1.02 |
| W1 (web edit) whole | 8.76 / 8.93 / 9.34 | **7.17 / 7.24 / 7.57** |
| … codegen + migrations | 3.44–3.65 | **2.98–3.12** |
| W3 fresh worktree whole | 21.3 / 24.0 | 20.9 / 21.5 (`tsc:repo` 8.7–10.4 and the backend's first boot 6.1–6.6: other tracks) |
| … codegen + migrations | 3.97 / 4.61 | 3.90 / 3.76 |
| C1 cold hermetic, 1 pair (branch first) | 260.6 | 272.2 |
| … registry → frontend start / web artifacts / `tsc repo` | 13.1 / 34.7 / 247.3 | 13.3 / 36.2 / 258.7 |

* W1's `tsc:repo` (3.4–3.8 → 1.7–1.9 s) and frontend (2.0–2.2 → 1.2–1.3 s) also fell; this change does not touch them, and it is not attributed here.
* C1's difference is its cold `tsc repo` pass (another track's; ±5–12 s run to run in steps 11–12); its codegen and artifacts are equal.
* **CC (cold codegen alone, empty data root):** whole 14.7 / 9.9 (base, in-memory store) vs 13.7 / 11.5 (`--records`) and 10.0 / 9.6 (pooled) — within the step's run-to-run spread. Its one attributable part: the coverage guard cold **0.41–0.54 → 0.83–0.89 s** (every backend file is now masked once for its record, the old guard masked only files naming a marker). Paid once per host per version of the scan's code closure (the store is shared by every checkout); the guard's no-change cost fell 0.72–0.74 → 0.45–0.47 s (with inference) on every build.

Review (sonnet): no correctness finding. Applied: a group of one member reads as that member (no group row), `secondUseLines` read with `Object.hasOwn`. Documented, not changed: a group hit refreshes no member's last-read day (the cost of a change stays its plugin). Not applicable: the check pass's file set has blob ids (`repo-set.ts` forwards `blobOf`), so checks read the coverage records too.
