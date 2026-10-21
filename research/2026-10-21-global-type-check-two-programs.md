# Rung 2 step 3: type-check runs two programs sized by changed names

Task: task-1792312301-fcfodz (att-1792413968-s2bio1). Track: "Track: build and push speed"
(block-e5afc5b1-…). Design page block-a9e68ab6-…, sections "Step 2, Phase A" and "Phase A2".
Previous plans: research/2026-10-19-global-rung2-unit-checker-shadow.md (units, dropped) and
…-v2.md (the two-program prototype).

## Context

Step 1c loads all ~12k files into one program on every run. It re-checks only the files whose
key moved. The Phase A2 prototype loads only what a run checks:

1. **Program 1:** the files with no valid record, against their imports' stored `.d.ts`. Diff
   their exports name by name.
2. **The affected set:** the closure over stored name-use and inference edges, computed with no
   TypeScript.
3. **Program 2:** the affected set, against stored `.d.ts`.

Measured against step 1c with tsc only, over 30 replayed commits:

- CPU: 2,333 → 795 CPU-s (−66 %);
- median peak: 5.3 → 1.7 GB;
- 0 misses and 0 diagnostic divergences.

Decided with the user: make it the type-check, in this session, with:

- type-aware lint;
- the resolution-key fix;
- the generated-file check;
- the daily dual-mode backstop on main as the oracle;
- a benchmark with separate stores per side.

## Design constraints

- **Store: host-wide, content-addressed, per file. No per-run or per-worktree state file**
  (O(changes) writes; no all-or-nothing invalidation). A fresh worktree on a main tree must be
  warm from entries main's build wrote.
  - Per (path, version): raw and canonical `.d.ts`, per-name hashes, name-use and inference
    edges, and recorded resolutions.
  - Results keyed on the file's text plus the hashes of the names its result depends on: its
    uses, closed over meaning, as the prototype's closure does.
  - A file with no valid result is checked.
  - Bounds as in `file-results-store.ts`.
- **Program 1 / program 2** exactly as prototyped. Changed global files (`declare global`,
  augmentations, global `.d.ts`) and any repo `.d.ts` → one whole program, as today.
- **Lint:**
  - Syntactic lint is unchanged.
  - Type-aware lint runs on the files whose typed key moved, inside the program that holds them
    as source.
  - The typed key moves to the same name-level key as the check, replacing the step 1b/1c type
    fingerprint.
  - A file whose typed key moved but which needs no re-check joins program 2 as source.
  - Directive files keep their whole-file rule.
- **Resolutions:** keyed on the directory listings they probed, not re-resolved every run.
- **Generated files:** `custom-utilities.generated.ts` becomes `isolatedDeclarations`-clean,
  plus a check that every `*.generated.ts` is. Implement this only if the two-program design
  depends on syntax contracts. Otherwise report why it is not needed.
- **Backstop:**
  - `type-check/backstop` runs the new check beside a fresh whole program daily on main and
    files `type-check-divergence` reports, as now.
  - Its whole-program run overwrites the store on divergence.
  - `scripts/dual-check.ts` runs the same comparison by hand.
- **Same check surface:** verdict, diagnostics format, transcript and cost lines
  (`phaseCpuSeconds`), and the worker slot and grant. The cost line names the program sizes:
  sources and `.d.ts` per program, and files checked and linted.

## Cleanup in the same change (the track page's step 3 list)

- Retire the whole-program build and step 1c's `keyedCheck` from the check path. The backstop
  keeps one whole-program run as its oracle.
- Delete the unit code: `shared/units.ts`, `unit-graph.ts`, `unit-check.ts` and their tests.
  Delete `scripts/unit-probe.ts`, keeping whatever the backstop or dual-check needs under the
  final module names.
- Declare stores only the old path used as retired (the `retiredLintResultsDir` pattern):
  `type-check-file-results`, the program manifest and pass records, if unused.
- Update `type-check/CLAUDE.md` and keep the `exempt/` entries accurate.

## Verification

- Tests (`./singularity test plugins/framework/plugins/tooling/plugins/checks/plugins/type-check`):
  `keyed-check.test.ts`'s fixtures ported to the new check, the closure fixtures, warm from
  another tree's entries, and directive files.
- `./singularity check` and `./singularity build` green.
- Benchmark: before = the merge-base (step 1c, lint included), after = this branch. Each side
  has its own `SINGULARITY_DIR`, warmed and snapshotted. Measured with `./singularity check
  type-check --jobs 1`:
  - the 14 step 1c scenarios;
  - the unchanged tree;
  - cold.

  Columns: CPU, peak, wall, files checked and linted.
- Replay of the 30 commits in dual mode: 0 diagnostic divergences.
- Results go on the design page ("Step 3 result") and the track page.
