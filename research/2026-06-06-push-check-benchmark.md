# Push ESLint Affected-Set Benchmark

**Date:** 2026-06-06  
**Branch:** `claude-web/att-1780674708-4fqx`  
**Machine:** macOS 25.4.0, Apple Silicon (multiple cores — each ESLint process is single-threaded)  
**Methodology:** All durations are wall-clock milliseconds from a single run each (or multiple runs where noted), measured with `performance.now()` wrapped around the exact CLI invocation. The machine had 1–2 other concurrent ESLint processes running for some measurements (noted where relevant).

---

## What changed

`./equin push` previously ran `eslint .` over the whole repo (~2 343 lintable `.ts/.tsx` files). The new approach on push:

1. Calls `computeAffectedFiles(root)` from the new `plugins/framework/plugins/cli/bin/eslint-affected.ts` module — builds a reverse import graph over all linted files, then BFS-expands the set of changed `.ts/.tsx` files to include every file that transitively imports them.
2. Runs `bun x eslint <affected_files…> --quiet` **without** `--cache` (so type-aware cross-file violations in unchanged-but-dependent files are freshly re-evaluated).
3. Falls back to full `eslint .` when correctness requires it: lint config / tsconfig / deps / ambient `.d.ts` changed, or on `--from-main`.

---

## A. Before — full-repo lint

### File count

| Set | Count |
|---|---|
| Total lintable `.ts/.tsx` files | **2 343** |
| Reverse-graph nodes (files with at least one importer) | 1 946 |

### Cold full lint (first-push-in-worktree cost)

When ESLint's content cache is absent or stale (which happens on every fresh worktree because `main`'s `eslint.config.ts` moves over time and `bustCacheIfStale()` deletes the cache when the config is newer), push pays a full cold lint.

| Run | Conditions | Duration | Exit code |
|---|---|---|---|
| Cold full lint run 1 | Concurrent with 2 other full-repo ESLint processes (each on its own core) | **903 s** (15 m 3 s) | 0 |
| Cold full lint run 2 (temp cache `/tmp/eslint-bench/full-cold`) | Concurrent with 1 other full-repo ESLint process (each on its own core) | **706 s** (11 m 46 s) | 0 |
| Cold full lint (design doc, previously measured in isolation) | Single process, earlier file count (~2 256 files) | **~591 s** | 0 |

> **Note on measured vs doc-stated times:** ESLint is single-threaded; each process gets its own physical core on a multi-core machine. The concurrent processes do not directly slow each other via CPU — instead, increased memory pressure and macOS scheduling introduce variance. The doc-stated 591 s was measured in isolation with a slightly smaller file count (~2 256 vs 2 343 today). The measured 706–903 s range reflects today's file count plus environment noise. The **best single-run cold full lint measured today is 706 s** (run 2, with 1 concurrent lint); the realistic isolated baseline for 2 343 files on this machine is approximately **600–700 s**.

### Warm full lint (same worktree, content cache fresh — but unsound)

The `--cache --cache-strategy content` cache keys each file on its own content. After a cold run re-populates the cache, subsequent runs return almost instantly — **but this is not sound** for push: a change in file A can make an unchanged file B violate a type-aware rule (e.g., `no-floating-promises` if A's return type changes). ESLint's cache returns B's stale result without re-evaluating it. The warm fast path therefore allows type-aware cross-file violations to slip through to `main`. This is precisely the gap the affected-set approach closes.

| Run | Duration |
|---|---|
| Warm full (run 1, after cold re-populated cache) | 1 260 ms |
| Warm full (run 2) | 1 254 ms |
| Warm full (run 3) | 1 160 ms |
| **Average** | **~1 225 ms** |

---

## B. After — affected-set lint

### Graph build overhead (paid once per push)

`buildReverseImportGraph(root)` regex-parses every linted `.ts/.tsx` file and builds a reverse adjacency map (importee → set of importers). It is self-contained (only `fs`/`path` + `Bun.spawn` for git).

| Run | Nodes | Duration |
|---|---|---|
| 1 | 1 946 | 988 ms |
| 2 | 1 946 | 729 ms |
| 3 | 1 946 | 709 ms |
| 4 | 1 946 | 423 ms |
| 5 | 1 946 | 364 ms |
| 6 | 1 946 | 372 ms |
| **Median** | | **~550 ms** |
| **Average** | | **~598 ms** |

> First run is slower (module load + OS file-cache cold); subsequent runs settle around 350–430 ms.

`computeAffectedFiles(root)` (graph build + git diff + BFS, the full push overhead):

| Run | Affected files | Duration |
|---|---|---|
| 1 | 5 | 800 ms |
| 2 | 5 | 824 ms |
| 3 | 5 | 826 ms |
| **Average** | | **~817 ms** |

### Affected-set lint scenarios

For each scenario: the "seed" file is simulated as changed; the affected set is the seed ∪ all transitive importers (BFS). ESLint is run fresh (no `--cache`) on the resulting file list.

#### Scenario 1 — Actual branch (this PR): 3 files changed, 5 in affected set

Seed: 3 modified `.ts` files on this branch (`build.ts`, `push.ts`, `eslint/check/index.ts`)  
Affected set: 5 files (seeds + `cli/bin/index.ts` + `eslint-affected.ts`)

| Run | Files | Duration |
|---|---|---|
| 1 | 5 | 4 369 ms |
| 2 | 5 | 2 786 ms |
| 3 | 5 | 1 885 ms |
| **Median** | | **~2 786 ms** |

#### Scenario 2 — Leaf change (low fan-in): `define-token-group.ts` (1 direct importer)

| Set | Count |
|---|---|
| Direct importers | 1 |
| Affected set (BFS) | **111 files** |

| Run | Files | Duration |
|---|---|---|
| 1 | 111 | 12 790 ms |
| 2 | 111 | 11 743 ms |
| **Average** | | **~12 267 ms** |

#### Scenario 3 — Medium change: `conversations/core/index.ts` (15 direct importers)

| Set | Count |
|---|---|
| Direct importers | 15 |
| Affected set (BFS) | **363 files** |

| Run | Files | Duration |
|---|---|---|
| 1 | 363 | 21 529 ms |
| 2 | 363 | 14 918 ms |
| 3 | 363 | 10 601 ms |
| **Best** | | **10 601 ms** |
| **Average** | | **~15 683 ms** |

> Run 1 had significant CPU contention (concurrent full lint in progress); runs 2–3 are more representative.

#### Scenario 4 — High fan-in (worst case): `web-sdk/core/index.ts` (391 direct importers)

| Set | Count |
|---|---|
| Direct importers | 391 |
| Affected set (BFS) | **1 445 files** (62% of all lintable files) |

| Run | Files | Duration |
|---|---|---|
| 1 (concurrent with other lints) | 1 445 | 365 611 ms (6 m 5 s) |

> This is the worst case: touching the most-imported barrel in the repo forces re-linting 62% of all files. By design, this is correct — those files could be type-affected. At 6+ minutes it is slower than a warm full lint but faster than a cold full lint.

---

## C. Force-full case

When `computeAffectedFiles` returns `null`, push falls back to the full `eslint .` path. This triggers when any changed file is:
- `eslint.config.ts`
- Under any `plugins/**/lint/` directory (a contributed lint rule changed)
- Any `tsconfig*.json` (type-checking semantics changed)
- Root `package.json` or `bun.lock`/`bun.lockb` (dependency change)
- Ends in `.d.ts` (ambient declarations can affect any file)

In these cases the push cost equals the cold full lint (A.1 above). No separate timing needed — same command, same file count.

---

## Summary table

| Scenario | Files linted | Duration | vs cold full (706 s best-run) | vs warm full (1.2 s, unsound) |
|---|---|---|---|---|
| **Cold full lint** (current push, typical first-push) | 2 343 | **706–903 s** (best: 706 s) | baseline | ~575× slower |
| Warm full lint (unsound — misses cross-file violations) | 2 343 | ~1.2 s | ~590× faster | baseline |
| **Affected: this branch** (3 files changed → 5 affected) | 5 | **~2.8 s** | **~250× faster** | 2.3× slower |
| **Affected: leaf change** (111 files) | 111 | **~12 s** | **~59× faster** | 10× slower |
| **Affected: medium change** (363 files) | 363 | **~11–15 s** | **~47–64× faster** | 9–12× slower |
| **Affected: high fan-in** (1 445 files — worst case) | 1 445 | **~366 s** | **~1.9× faster** | ~300× slower |
| Force-full fallback (config/tsconfig/deps changed) | 2 343 | 706–903 s | same | — |

---

## Headline

**First-push cold lint: 706–903 s (best-isolated: ~591 s) → typical affected-set push: 3–15 s. A ~50–250× speedup for the common case.**

The graph build adds ~600 ms of fixed overhead to every push. For a typical small change (leaf or near-leaf edit), the total push lint cost drops from ~10 minutes to under 15 seconds. For a genuinely wide change (web-sdk core barrel), the affected set covers 62% of files and takes ~6 minutes — still correct, and only marginally slower than a cold full lint.

---

## Caveats

1. **High fan-in worst case.** Changing a load-bearing universal barrel (e.g. `web-sdk/core/index.ts`, imported by 391 files) produces an affected set of 1 445 files and takes roughly the same time as a cold full lint. This is by design: those files genuinely could be type-affected. The optimization only helps when the blast radius is smaller than the full repo.

2. **Graph-build overhead (~600 ms).** Every push pays this regardless of outcome. For a force-full case (config/tsconfig changed), push pays the graph build cost and then the full lint cost. This is negligible compared to the lint itself.

3. **Lint cost only — tsc is unchanged.** This benchmark measures ESLint only. The `typescript` check already runs incrementally via `tsc --incremental --tsBuildInfoFile` seeded from `main` and is not affected by this change.

4. **Environment noise.** Several measurements ran concurrently with 1–2 other full ESLint processes from other worktrees. Figures marked "concurrent" should be read as upper bounds; the isolated cold full figure (591 s from the design doc) is the cleaner reference.

5. **Single run each.** No statistical averaging for most scenarios (1–3 runs each). Wall-clock measurements on the dev machine; results will vary with thermal state, other processes, and file-system cache warmth.

6. **Warm full lint is fast but unsound.** The warm content-cache returns 1.2 s — faster than any affected-set scenario. But it is not sound for push: unchanged dependents get stale cached results and type-aware violations (floating promises, misused promises, exhaustiveness) can slip through. The affected-set approach is the only option that is both fast **and** sound for push.
