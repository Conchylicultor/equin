# Type-check: why global changes and cold runs check the whole repo (investigation + direction)

Task: task-1792678233-vavkyr ("[Discuss]" item of the track *Build and push speed*, wiki
block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851; design sub-page block-a9e68ab6-…, after "Step 3b result").
Status: investigation done. **Decided with the user (2026-10-22): Part A, then Part B; A1 as a typed
`window` accessor (no augmentation), real augmentations in declaration-only files, enforced by a check.**

## Context

Since Rung 2 steps 3 and 3b, a type-check run costs what changed: a file's result key is
`R = H(global, path, version, M of each name it uses)`. One input, `global`, is all-or-nothing
(`shared/name-run.ts` ~L454):

```
global = H(engine, version of every global source file, version of every repo .d.ts root)
engine = H(TS version, compiler options, lockfileLintDigest(bun.lock), patches/, every shared/*.ts but worker/full-check)   (shared/tsc-engine.ts)
```

When `global` moves, no stored variant matches (`variants.filter(v => v.global === global)`), the
walk falls back to full, every file goes into program 1, and you get one whole-repo program. Typed lint is
keyed on R, so every typed part re-lints too. An empty store gives the same result.

## Measured

### Cost of one whole-program run (fleet logs, `~/.singularity/worktrees/*/check-*.log`)

188 worker runs since step 3 landed (2026-10-21 17:45 → 2026-10-22 16:30):

| | Runs | Worker CPU | Peak RSS |
| --- | --- | --- | --- |
| Whole-program (≥ 50 % of files checked) | **18** | 115–572 s, median ~255 s: **tsc 95–260 s + lint 0–306 s** | **18–30 GB** |
| All other runs | 170 | median 14 s | 1–6 GB |

**The 18 whole-program runs used 58 % of all type-check CPU.** Lint was more than half of the cost
in most of them, because a moved R re-runs every typed lint part. 10 of the 18 ran in the two
worktrees developing the type-check engine itself, where every engine edit moves `global`. 4 ran
within 15 min of step 3 landing, in different worktrees.

### How often `global` moves on main (948 commits, 30 days; script: diff of each commit against the inputs above)

**42 of 948 commits (4.4 %)** moved the global hash:

| Trigger | Commits | Can any file observe it? |
| --- | --- | --- |
| npm lockfile resolutions | 16 | **Mostly no.** A package added or removed (xterm, chevrotain, sharp, iconify, frimousse, pg-client…) or a leaf package bumped (base-ui, testing-library, @types/pg, @types/google.maps). Truly global, so seen by every file: `@types/bun` ×2, `@types/react` ×1 (in `types` / JSX). |
| A global source file, **body only** (its `declare global`/`declare module` block is unchanged) | 10 | **No.** For example `cold-start.ts` (1,128 lines) holds a 4-line `Window` augmentation. |
| A repo `.d.ts` added, removed or edited | 7 | **Mostly no.** These declare ambient modules (`browser-host.d.ts`, `icon-sets.d.ts`, `seti-file.d.ts`, `google-maps-env.d.ts`); only the files that import that module see them. |
| A global source file, **surface** changed | 5 | Yes. |
| Engine code (`type-check/shared/*.ts`) | 5 | No for the types; yes for the stored records. |
| tsconfig | 3 | Yes. |

**Roughly 27–30 of the 42 change nothing that most files can see.** About 12–15 are truly global:
the 5 surface edits, 3 global `@types` bumps, 3 tsconfig edits, and the ~5 engine-code edits for tsc
results only.

### Why each case currently has to be whole-program

1. **Global files.** A file sees a `declare global` or a module augmentation without naming the file,
   so name-use edges cannot reach it. Today the hash folds the file's **version**, the blob sha. So
   any edit to the file, including its body, is treated as a change to its surface. 13 of the 16
   global files are ordinary modules (e2e scripts, `web/internal`) with a small `interface Window {…}`
   block. The fix is only sound at the surface level: an augmentation of a widely used type
   (`Window`, react-query `Register`, bun `Serve`) changes the types of files that never mention it,
   so "the files that mention the changed member" is unsound.
2. **Repo `.d.ts`.** Every `.d.ts` root is folded as global. Only a script or a `declare global` is
   truly global. A `declare module "x"` ambient module is seen only by the files that import `"x"`.
3. **npm.** Every resolution into `node_modules` is recorded as `<dep>` (`name-resolve.ts` L190), and
   the whole lockfile digest stands in for all of them. So adding a package nobody imports yet
   re-checks the repo.
4. **Engine code.** The hash covers every `shared/*.ts`, including the walk, run-base and key
   plumbing. If the key formula changes, the keys change and the results invalidate on their own, so
   those files do not need hashing. Only what *produces* a stored result (diagnostics, the `.d.ts`,
   records, canonical form) has to invalidate the store. Typed lint does not depend on any of it, but
   it is keyed on R and re-runs anyway.
5. **Cold.** Every file has to be checked once. This is inherent in the CPU (~100–260 s tsc). It is
   **not** inherent in the 26–30 GB peak or in the single process: Phase A measured the same work in
   dependency-ordered batches against served `.d.ts` at **3.4–3.8 GB per process, about the same
   CPU** (batch 32: 294 CPU-s), and it can run P processes wide.

## Proposed direction (two parts, one task each)

### Part A: move `global` only when something every file can see moved (frequency 42 → ~12–15 per 30 days)

Each trigger is keyed at its true granularity, using the machinery that already exists:

- **A1. Global surface, not the global file.** The fix that makes the wrong state impossible to write
  (rung 1): global declarations live only in **declaration-only files**. A check enforces that a file
  with `declare global` or an augmentation declares nothing else, so a body edit cannot move
  `global`. Most of the 10 `Window` probes in e2e and web files would move into their plugin's
  `*.globals.d.ts`, or better, go away through a typed `window` accessor in `e2e-harness` with no
  augmentation at all. What remains is ~6 tiny files, and an edit to one is a real surface change.
- **A2. A repo `.d.ts` is global only if `isGlobalFile` says so** (script or `declare global`). An
  ambient-module `.d.ts` is an ordinary owner: the files that resolve `"x"` to it record it as a
  target, as they do any repo file.
- **A3. npm per package.** Record a dependency target as `<dep:pkg@version>`, the resolved package
  version from the lock, instead of `<dep>`, and fold it into R like a repo file's version. Only
  packages that are global stay in `global`: the tsconfig `types`, the TS lib, and any package whose
  declarations `isGlobalFile` flags. Adding or bumping a leaf package then re-checks only its
  importers.
- **A4. Engine code = what produces results.** Fold the import closure of the result producer
  (`name-check`, `name-records`, canonical form, emit options) through `framework/tooling/import-closure`
  instead of the whole directory listing. Typed lint gets its own key (the file text, M of the names
  it uses, and the *type environment* hash = TS version, options, global surface and global packages),
  without the tsc engine code. An engine-only edit then re-checks tsc, not lint.

Soundness gate for each item: the existing dual-mode backstop and `walk-replay` over the same 31
main trees, plus a replay of the 42 trigger commits checking that each non-global one now re-checks
only its affected set, with 0 diagnostic divergences against a fresh whole program.

### Part B: make what remains global or cold bounded and shared

- **B1. Batched whole check.** When the walk has no valid results (global moved, or the store is
  empty), check the files in dependency order over file-level SCCs. The SCCs are small: the largest
  is 174 files, the exhibits. Batches of about K files run in a pool of P processes, and each batch
  is served its predecessors' just-emitted `.d.ts` from the store. This is the same
  `runProgram(sources, contractOf)` that program 1 and program 2 already use. Expected: about the
  same CPU, peak **26–30 GB → ~4 GB per process**, wall time ÷ P. Host admission sizes P by memory.
- **B2. Single-flight per (global, tree).** Concurrent worktrees that reach the same new `global`
  wait for one producer through `packages/single-flight` instead of each paying the cold check. The
  4 runs within 15 min of step 3 landing suggest this happens. To confirm first, log the global hash
  in the walk line.
- Not proposed: name-level tracking of global members (`Window.__x` as a name). It is sound only with
  structural reasoning about augmented library types, and after A1 it would cover ~5 commits a month.

### Expected outcome

- Main: ~42 → ~12–15 whole-repo checks per 30 days. Each one costs the same CPU as today at
  ~4 GB instead of 26–30 GB, and is paid once per host.
- Dev worktrees on the engine: an edit outside the producer closure costs an ordinary run.
- Measured before and after on: the 42 trigger commits replayed, a cold run (CPU, peak, wall), and an
  augmentation edit.

## Files that would change

- `type-check/shared/name-run.ts`: global hash inputs and the batched full path (B1).
- `type-check/shared/tsc-engine.ts`: engine = producer closure; split out a type-environment hash.
- `type-check/shared/name-resolve.ts`: `<dep:pkg@version>` targets.
- `type-check/shared/name-check.ts`: `isGlobalFile` used for `.d.ts` roots too.
- `type-check/shared/lint-decisions.ts`, `keys.ts`: typed lint key.
- A new check (A1) in `type-check/check/`, and the moves of the ~13 `declare global` blocks
  (e2e-harness helper for `Window` probes).

## Verification

- `./singularity test plugins/framework/plugins/tooling/plugins/checks/plugins/type-check`. New
  cases: an ambient `.d.ts` edit re-checks only its importers, a leaf package bump re-checks only its
  importers, an `@types/bun` bump is global, and an engine-plumbing edit keeps every key.
- `scripts/walk-replay.ts` and `scripts/dual-check.ts` over the 31 main trees and the 42 trigger
  commits: 0 divergences, 0 misses.
- A benchmark table on the track sub-page, before → after (isolated `SINGULARITY_DIR`): cold,
  augmentation edit, leaf npm add, `.d.ts` add, engine-plumbing edit.

## Result, Part A (2026-10-22, att-1792679089-ppcuql)

Built: A1, A2, A4, plus one finding of the benchmark (lint engine). **A3 (npm per package) deferred**,
measured: with a sound "global package" rule (any package whose declarations hold a `declare global`
or an augmentation — 80 packages — plus its dependency closure), only 6 of the 16 npm commits become
scoped; the closure is wide (base-ui, mcp-sdk, the esbuild/vite tree). Not worth its soundness risk now.

- **A4** — `tscEngineFp` folds `producerSources()` (the import closure of `name-check`, `name-store`,
  `emit-options` inside `shared/`), not every `shared/*.ts`. The walk code (`engineSources()`) keys only
  the walk-base store's namespace: other walk code → base not found → full walk, nothing re-checked.
  Lint's typed engine is the producer too.
- **A2** — `declScope` reads each repo `.d.ts` root's reach from syntax (global / ambient / module),
  asserted against the checker in every program. Only global ones are in the global hash; an ambient
  one is a use of each file whose specifiers match its module names (`ambientUses`); adding or dropping
  an ambient name walks every file (folded into the walk base's hash).
- **A1** — no `.ts` source declares globals: 13 `declare global { interface Window … }` blocks became
  casts (`window as Window & {…}`, or a `…Window` type in render-profiler's / live-state-churn's `core/`,
  which also removed a duplicated contract); react-query `Register` and `bun:jsc` moved to
  declaration-only `.d.ts`. Enforced by the `type-check/no-global-declaration-in-source` lint.
- **Lint engine** — no longer folds every repo `.d.ts` (a `.d.ts` edit re-linted all 105 groups on every
  file): syntactic rules read the file's own text, typed parts are keyed on R, which holds every `.d.ts`
  the file sees.

Tests: 95 in the plugin (4 new in `name-run.test.ts`, 1 in `walk-incremental.test.ts`), all pass.

| Scenario (worker, `check type-check --jobs 1`, one sample) | Before | After | Files checked |
| --- | --- | --- | --- |
| Body edit of a file that held `declare global` (`cold-start.ts`) | whole repo: 213–327 CPU-s, 27–30 GB | **3.7 CPU-s, 0.80 GB** | 0 (lint 1) |
| Body edit (`iframe-api.ts`, held `declare global`) | whole repo | **2.5 CPU-s, 0.54 GB** | 1 |
| Ambient `.d.ts` edit (`browser-host.d.ts`) | whole repo | **2.4 CPU-s, 0.51 GB** | 1 |
| Module `.d.ts` edit (`seti-file.d.ts`) | whole repo | **2.5 CPU-s, 0.52 GB** | 2 |
| Walk-code edit (`name-walk.ts`) | whole repo | **8.0 CPU-s, 1.7 GB** (full walk) | 1 |
| Unchanged tree | — | 0.7 CPU-s, 0.28 GB | 0 |
| Global change (producer edit, cold) — unchanged by design | 261–327 CPU-s, 27–30 GB | same | all |

"Before" is the whole-program cost measured in this session's cold/global runs (the same scenarios
moved the global hash before this change: their file was global, or the `.d.ts` was, or the code was
engine). Re-classified on main's 30 days: of the 42 commits that moved the global hash, **~15 no
longer do** (10 body edits of files holding `declare global`; ~5 of 7 `.d.ts` adds/edits — ambient or
module ones). ~27 remain: npm 16 (A3, deferred), 5 global-surface edits (now in `.d.ts`), 3 tsconfig, and
the 5 engine commits — each of those touched producer files (`name-check`, `name-store`, …), so A4 does
not avoid them on main. A4's gain is walk-only edits, which is what the type-check engine's own dev
worktrees iterate on (10 of yesterday's 18 fleet whole-program runs were in those two worktrees).
Each remaining one also no longer re-lints every syntactic group when it is a `.d.ts` edit.

Next: Part B — the whole-repo check that remains (global change, cold) in bounded, dependency-ordered
batches (peak ~4 GB per process instead of 26–30 GB) and single-flight per global hash.
