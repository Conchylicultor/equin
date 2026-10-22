# Type-check: make the per-run cost follow the change (prepare, finalize, the walk)

Task: task-1792586960-mq65k7 (att-1792597300-4djelw). Track: "Track: build and push speed"
(block-e5afc5b1-…), design sub-page "Rung 2 design" (block-a9e68ab6-…), section "Step 3 result".

## Context

After Rung 2 step 3, tsc work follows the change, but on an UNCHANGED tree the check still costs
~19 CPU-s end to end, of which the worker is ~3. Everything else is O(repo) every run. The
outer read-set replay skips a no-op tree entirely, so the case that pays this is the common
one: a small edit, which re-runs the check, which re-reads the whole repo before doing the
small piece of work the edit needs.

### Measured (2026-10-21, this host, 12,602 source files / 19,331 repo files, warm stores)

Instrumented `openPreparation` (per-phase wall + process CPU), `./singularity check type-check
--jobs 1 --no-cache`, plus a standalone run of `openPreparation` in a fresh process. Host load
7–22, so the numbers are rough. CPU-s:

| Part | CPU-s | What it does | Grows with |
| --- | --- | --- | --- |
| CLI floor (a trivial check) | ~2.0 | process start, runner | – |
| prepare: import graph | 3.0–3.1 | reads every lintable file, `findImports` + `maskSource`, up to 5 `existsSync` per specifier, only to compute the lint ENGINE and CONTRIBUTION closures | repo |
| prepare: lint store reads | 2.2–3.8 | one JSON file per (file, content hash), zod-parsed, ×12.6k | repo |
| prepare: content hashes | 1.0–1.1 | re-reads every file, sha256 = "version", directive scan | repo |
| prepare: type-aware groups | 1.1–1.4 | loads every lint contribution + eslint plugins to learn which groups hold a type-aware rule | rules |
| prepare: tsconfig roots | 0.9–1.0 | `parseJsonConfigFileContent` walks the filesystem (coverage gate) | repo |
| plan transfer | ~0.5 | the plan is 10.8 MB (a job + a version per file): structured clone to the thread, JSON to the worker | repo |
| finalize | 0.5–1.4 | records, then the verdict over every file | repo |
| worker | 2.4–3.4 | its own tsconfig walk (~0.9), 12.6k name-record reads (1.5–2.2), walk over every file (0.9–1.2), resolution re-validation (0.1–0.5) | repo |

Total ≈ 19 CPU-s, of which ~2 are the CLI and ~0 are actual work for the change.

**A bug found on the way.** `shared/name-resolve.ts` keys a probed directory on its full
`readdir` listing. The repo ROOT holds transient gitignored entries (`.install.lock`,
`.merge_file_*`, `.check-*`), and lookups reach the root, so after unrelated `./singularity`
commands **~6,000 files' resolution keys move** ("5981 re-keyed"): 3 s of listings, 1.6 s of
rewrites, and the worker goes from 3.4 to 11–15 CPU-s. It is also an impurity: the check is
`inputKeyed`, so its verdict must be a function of the tree its key hashes.

### Two facts the design must respect

- Some program roots have no git blob: the gitignored `*.composition.*.generated.ts`
  registries sit under `include` (`tsconfig.json`), and tsc reads them from disk. The check's
  input is the **snapshot plus an overlay**: the gitignored files inside `include`,
  enumerated by one `git ls-files -o -i --exclude-standard` over the include pathspecs and
  hashed with `git hash-object`. The overlay keeps today's behaviour, so the
  registries are still checked. Resolution and the program host answer in-repo existence
  questions from snapshot ∪ overlay, so tsc and the keys read the same inputs.
- The runner computes a tree hash and a `TreeSnapshot` (`git ls-tree -r`: every path's blob
  sha) only when caching is on. A tree hash is a fact, not a cache: type-check gets it on every
  run, `--no-cache` included.

## Approach: three stages, each measured alone

### Stage A — no O(repo) reads or hashing of files (no new state)

1. **One reading of the tree, from git.** `CheckContext` gains `snapshot()` (`tooling/core`
   types, wired in `checks/core/runner.ts`, computed under `--no-cache` too).
   `readTreeListing` becomes `{ root, treeHash, files: snapshot.paths() }` plus the overlay.
   The preparation thread gets the tree hash and loads the snapshot itself instead of having
   a 12k-path listing and a 12k-version map structured-cloned into it.
2. **A file's version is its git blob sha.** git's index stat cache makes that O(changes).
   `computeContentHashes` is deleted. The lint store moves to `type-check-lint-results-v3`, and the
   name store's format bumps, because both are keyed on the version. That costs one cold run per
   host. The directive flag is stored in the lint entry; only a file with no entry is read, and
   such a file is linted anyway. The worker's `versionOf` stops hashing.
3. **Program roots without a filesystem walk.** The coverage gate (`parseProgramRoots`) and the
   worker's `parseJsonConfigFileContent` get a `ParseConfigHost` whose `readDirectory` answers
   from snapshot ∪ overlay (`ts.matchFiles` over `snapshot.members`).
4. **Resolutions keyed on the git listing.** `ProbeFs.listing(dir)` = `snapshot.members(dir)` ∪
   overlay. The program host (`name-host.ts`) and `RecordingResolver` answer in-repo
   `fileExists` / `directoryExists` from the same view, while `node_modules` stays on `ts.sys`
   (pinned by the lockfile, which is in the engine). This fixes the 6k re-key and the
   impurity.
5. **Lint fingerprints without the whole-repo import graph.** `computeLintGroups` walks the
   closures of `LINT_CONFIG_SOURCE` and the ~100 `lint/index.ts` entries only, resolving against
   the snapshot (no `existsSync`) and hashing members by blob sha with no read. A per-group
   closure record (members + probes, host-wide, keyed by entry) is validated in memory
   against the snapshot, so only a group whose files changed re-parses. `buildImportGraphs`
   leaves the check.
6. **`typeAwareLintGroups` keyed on what it is a function of**: the groups' fingerprints and the
   typed engine. It is stored in the contracts store and loads the contributions only when one
   moved.

Expected: prepare ~10 → ~2.5 CPU-s, worker −0.9, and no re-key spike. What is still O(repo):
the 12.6k lint-entry reads, the 12.6k name-record reads, the walk, and the finalize verdict.

### Stage B — a run base: the state a run ended in, content-addressed

The remaining O(repo) is "re-verify every file's stored state every run". A **run base**
records the complete per-file state a completed run ended in, so the next run reads only
what changed since then. A base is a function of its tree and its global inputs, not of any
worktree, so it stays content-addressed and host-wide:

- **Root**, key H(format, tree hash, engine): the global inputs it is valid under (`global`,
  every lint group fp, typed fps, the type-aware set, the overlay), plus a map of shard id → shard
  content hash. A shard is the files of one leaf plugin (~1,475 plugins, ~8.5 source files and
  ~15 KB each). The root is ~100 KB.
- **Shard**, key = its content hash: per file its version, directive flag, the lint keys valid,
  non-empty raw messages, R, the chosen variant (r, contract hash, signature, non-empty
  diagnostics, names, star), its resolution dirs, and INCOMING reverse edges (read-set
  readers, d∪i dependents) held in the target's shard. A run rewrites only the shards whose
  state changed, plus the root. Unchanged shards are shared across trees and worktrees.
- **Choosing a base:** a per-worktree "last tree" hint, then `HEAD^{tree}`, then
  `merge-base(HEAD, main)^{tree}`. A hint is never trusted for correctness: the first one
  with a stored root wins. `git diff-tree -r --name-status <base> <T>` gives the changed set C
  in O(changes), since git prunes equal subtrees. The overlay is compared by hash.
- **Prepare** sends lint jobs only for C. Every file also goes when a syntactic group fp moved,
  but only for that group, and directive files whole when any fp moved. Unchanged files carry
  their base state.
- **Worker:** with no incremental walk yet, it still walks every file and returns typed lint
  work only where R ≠ R_base.
- **Finalize:** the verdict is the base's messages, patched with fresh ones, under the current
  exemptions. Only the shards holding messages are read, and the root lists them. Then the
  changed shards and the root are written.
- **No base is written** when the worker crashed. After a prediction miss, the cold whole run's
  state is correct and is written. In dual mode the base is written only from the cold rewrite.

Expected: lint reads, finalize and the plan transfer drop to O(changes).

### Stage C — the incremental walk (worker)

- `runNameCheck` takes the base and C. The dirty set D₀ is C, plus files whose resolution dirs
  gained or lost entries in C (reverse index dir → files), plus files whose `res.files` are in C.
- D₀ is expanded to **whole components**, using each file's component id and topological rank
  from the base. A fresh edge F→G with `rank(G) ≥ rank(F)` can close a new cycle: pull in
  everything between them, or fall back to the full walk.
- `phase0` / `phase1` run over D. Every other file is a **fixed** pseudo-file whose
  `Meanings.of` returns its base M.
- **Expansion:** after each phase, every name whose M differs from the base (⊥ counts as
  different) adds its readers, from the reverse read-set, together with their components, to
  D. This repeats to a fixpoint with early cutoff, so a body edit stops at once. Program 2 is
  sized afterwards, exactly as now.
- The **read-set** of a file is every owner its key consulted, recorded by instrumenting
  `Meanings.of` / `whole`. It covers star re-exports, which a uses-only reverse index would
  miss.
- A seeded variant that was evicted from the store, or whose contract is gone, demotes the
  file to program 1. `readContract` stops throwing for that case.
- The **full walk** stays as the no-base path, the fallback for a `global` change, a rank
  violation or a missing shard, the `dual` oracle, and the backstop.

Expected: the walk's 12.6k reads and the walk become O(|D| + frontier).

## Critical files

- `type-check/check/{index,prepare,fingerprint,lint-groups,lint-results,import-graph}.ts`
  (import-graph leaves the check path)
- `type-check/shared/{worker,name-run,name-walk,name-store,name-resolve,name-host}.ts`, and a
  new `shared/run-base.ts` (root and shards over `pass-set`)
- `checks/core/runner.ts`, `tooling/core/types.ts` (`ctx.snapshot()`), `checks/core/read-set.ts`
  (`TreeSnapshot`: reuse `paths`, `members`, `blobSha`, `exists`)
- `lint/core/build-lint-config.ts` (`typeAwareLintGroups` stays; only its caller memoizes)
- `type-check/data-dirs` (the v3 lint dir, the base dirs; the old ones declared retired)

## Verification

- Unit tests: the overlay and a gitignored shadow file; resolution keys unmoved by a transient
  root file; lint closures from the snapshot equal today's `computeLintGroups`; a base round
  trip; incremental vs full walk on star re-exports, a cycle created by an added edge, an
  evicted variant, a `global` flip, and a crashed run writing no base.
- **Oracle replay** (extend `scripts/dual-check.ts`): main 48d95e56d9 → 4e1e2c0e65, plus a
  dirty edit, an add/remove, a new cycle and a transient root file. Every step compares the
  incremental and full paths on every file's diagnostics, signature, contract hash and R, the
  checked set, and the lint verdict. The target is 0 divergences.
- **Benchmark**, as in "Step 3 result": before = main (d65359c3b3), after = this branch, a
  separate `SINGULARITY_DIR` per side, each scenario on a store restored from that side's cold
  run, `./singularity check type-check --jobs 1` with the check cache deleted. Measured after
  each stage: the unchanged tree, a root-touching command, a hub body edit, hub and leaf
  type edits, the reverts (a976, 9424, 5d08, b77b, 497c, 3967), a syntactic and a type-aware
  rule edit, the augmentation, and cold. Reported: end-to-end CPU-s, peak, wall, and the
  prepare / worker / finalize split.
- `./singularity check` (all) and `./singularity build` green; the result goes on the design
  page and the track page.
