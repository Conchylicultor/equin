# Rung 2 — per-plugin type-check units against contracts: investigation plan

**Date:** 2026-10-16 · **Category:** global (checks infra) · **Task:** task-1792110325-3ypp19
**Track:** "Track: build and push speed" (`block-e5afc5b1-15f2-4614-a49a-c7b4e6fe1851`), section "Rung 2".
**Deliverable:** a design sub-page of the track (wiki, multi-session design per the Track
Instructions) + track page update + the next main task. This file is the plan for getting there;
the measurements and design live on the wiki page.

## Context

Every build/check/push runs one worker that loads the whole repo's TS program (~11.8k plugin
`.ts(x)` files) for a change of a few files, once per agent: 3–17 GB, 40–800 CPU-s. On 2026-10-15,
181 worker runs did 15 CPU-h and waited 30.8 h for a slot. Every fix so far (lane cap, foreground
holders, lint cache per group, real signatures) is a constant factor; busy = agents × whole-repo
work ÷ slots, so the queue returns as repo or fleet grows. Rung 2: each plugin is a unit checked
from its own source + the `.d.ts` contracts of what it imports, results content-addressed and
shared host-wide, so cost follows the change.

What is already known and will NOT be re-derived (only re-validated where noted):
- The plugin graph is a DAG (1,653 plugin × runtime projects, zero cycles; folder cuts are cyclic) —
  `research/2026-09-09-global-type-check-zone-cut.md`.
- Fixed type-environment cost per TS project: 3.1 CPU-s (DOM) / 4.4 CPU-s (bun), one-file project,
  fresh process. That killed "per-plugin isolated builds" when EVERY project ran on every change.
- Real signatures already exist (worker emits declarations to a null writer); the codebase is
  declaration-emit clean (TS2742 fixed) — the worker treats declaration diagnostics as errors.
- One environment for the whole repo (`es2023.full` + node + bun types); runtime isolation is
  `plugin-boundaries`' job, so a unit can be a whole plugin, not plugin × runtime.
- Identical-tree floor ≈ 38–45 CPU-s / 2.7–3.2 GB; lint costs ~154 CPU-s per ~900 files
  (`research/2026-10-15-global-lint-cache-per-contribution.md`).

## Phase 0 — re-validate: is whole-program loading still the dominant cost? (gate)

The worker logs only total `cpu` / `maxRSS`. Before designing around tsc, split recent real runs
into **floor (parse+bind of the whole program) / re-check / declaration emit / lint**, since lint
may now dominate (154 CPU-s per 900 files vs 34 s warm tsc).
- Data: `~/.singularity/check-progress.jsonl*`, op log, worker cost lines since 10-15 14:50Z;
  per run: CPU, files linted, lane, wait. Rate × cost by run kind (fresh worktree / warm / rule edit).
- Harness (scratch, not shipped): a copy of `shared/worker.ts`'s pipeline with `performance.now()` +
  `process.cpuUsage()` per phase and `ts.performance` counters (Parse/Bind/Check/Emit), replayed on
  3–4 representative trees (identical, body edit in a hub, API edit in a hub, 80-file lint).
- Gate: if lint, not the program, is most of the CPU, rung 2 must cover lint first-class (it is
  in scope either way, but the design priority flips).

## Measurements (each answers one unknown from the track page)

All scripts under `.check-scratch/rung2/` (gitignored, outside type-check's walk), run with
`./singularity run`, single process at a time, interleaved A/B, CPU-s reported over wall (fleet load
noise). Results tables go straight to the wiki page.

**M1 — isolatedDeclarations debt.** Run the repo program with `isolatedDeclarations: true,
declaration: true, emitDeclarationOnly` to a scratch outDir. Count TS9xxx diagnostics by code, by
plugin, by folder kind. Then the number that actually matters: only a unit's **contract surface**
needs isolated declarations — files reachable from its barrels' exports (`<runtime>/index.ts`,
`<runtime>/testing/index.ts`), not plugin-internal files. Count errors inside that surface
(walk exports from barrels with `check/import-graph.ts`). Also: share auto-fixable by TS's
`fixMissingTypeAnnotationOnExports` codefix (dry run, count only), and whether an
`isolatedDeclarations` lint/tsc gate can be enabled per-surface only.
Fallback if the debt is large: contracts emitted by the checker in DAG order (project-references
style) — measure that cost too, it is the alternative's price.

**M2 — fixed per-unit environment cost, and whether it is shared.** Experiments, one process:
1. One-file program, full env, fresh process (re-validate 3.1–4.4 CPU-s), with `ts.performance`
   phase split.
2. 50 sequential unit programs in ONE process sharing a SourceFile cache for lib + `@types` +
   `node_modules` `.d.ts` (custom `CompilerHost.getSourceFile` cache / `DocumentRegistry`): marginal
   CPU and RSS per unit. Separates parse (shareable), bind (stored on SourceFiles, reusable),
   checker global merge (`initializeTypeChecker`, per program — the likely irreducible part).
3. Same with `oldProgram` reuse. Result: per-unit floor shared vs unshared.

**M3 — unit sizes and hubs.** From the import graph, per plugin unit: own files/LOC, direct
deps, **transitive contract closure** (the `.d.ts` files tsc will load when checking it), fan-in.
Distributions, top 20 by each. Hubs: generated registries (`web.generated.ts`,
`plugins-active`, `*.composition.*.generated.ts`) import every plugin — measure their contract
closure and their own check cost; candidates: a dedicated registry unit whose contract is tiny.
Census of cross-unit hazards: `declare global` / `declare module` augmentations (16 files),
ambient `.d.ts`, `/// <reference>`, imports that bypass barrels (shouldn't exist — confirm),
intra-plugin runtime cycles (e.g. core ↔ data-dirs).

**M4 — commit replay: what would rung 2 have cost?** Last 30 days of main (+ a sample of agent
branch diffs, the case that actually pays). Per commit: changed files → changed units → contract
changed? (per-file `ts.transpileDeclaration` before/after, ms each; exact for isolated-clean files,
a syntax proxy otherwise) → affected set = changed units + direct importers of changed contracts,
stopping where an importer's own contract is unchanged. Cost model calibrated by M2/M3 (env floor +
own files + contract files), validated by actually checking 5–10 sampled affected sets with a
prototype unit checker and comparing to today's worker CPU on the same commits. Output: per-commit
CPU distribution today vs rung 2, and the fraction of commits that re-check a hub's world.

**M5 — type-aware lint on the same units.** (a) Which of our ~250 rules use type information
(`parserServices` / `getTypeChecker`) and which follow a symbol's declaration into another file's
source (those break against `.d.ts`). (b) Lint 3–5 units with the unit program
(source + deps' contracts) vs today's whole program; diff messages. (c) How the lint result key
changes: unit inputs instead of closure fingerprint.

**M6 — rung 1 (shared warm checker) on the way?** From Phase 0: runs/day × floor = what a warm
service saves today, vs rung 2's saving from M4. Decide between: skip it; or build it only as the
*unit-checking host* (long-lived process holding the shared env from M2, checking units on
request) — the version that composes with rung 2 rather than competing with it.

**M7 — TypeScript 7.1.** Web search for status as of Oct 2026 (tsgo release, `--build`/project
references, `isolatedDeclarations`, declaration emit, the programmatic API, typescript-eslint
support). If `@typescript/native-preview` is usable: whole-program cold/warm CPU + RSS on this repo,
and the M2 per-unit fixed cost under tsgo. Question answered: does a 10× faster whole program make
rung 2 unnecessary at today's size (and until what size × fleet), or does it just shrink the
per-unit floor so rung 2 gets cheaper?

## The design (wiki sub-page), sections

1. Problem + measured baseline (Phase 0), the scaling law.
2. Unit definition (plugin; tests, testing barrels, generated registries placement).
3. Contracts: production (isolatedDeclarations transpile, per file, parallel, content-addressed),
   enforcement (which files must be isolated-clean, how it is checked), migration of the M1 debt.
4. Unit check: inputs, key (own sources + dep contracts + env fingerprint + checker version),
   host-global content-addressed store (reuse `check/pass-set.ts` / `programPassDir` pattern),
   shared env (M2), scheduling across units and host admission (memory per unit is small).
5. Lint on units (M5), and how the per-group lint cache re-keys.
6. Correctness: what the whole program catches that units do not (augmentations, ambient types,
   registries), and the backstop (dual-run comparison during migration; a whole-program run kept
   where, if anywhere).
7. Expected cost per change (M4 tables), memory per check, and the cold path.
8. Rung 1 and TS 7.1 positions (M6, M7).
9. Implementation steps as a linear sequence; the first one becomes the next main task.
10. Discarded hypotheses, each with the gate that killed it.

## Track page update

Status bullets (Rung 2 result + next step), Overview `[Rung 2]` item with nested sub-items, and the
"Rung 2" investigation section shortened to a summary + link to the design sub-page; supersede
"Later: per-plugin isolated builds" / reposition "Later: shared warm type-check service" per M6.
Then `add_task` ONE main task (the first implementation step), giving the track page id and the
design page id. No code ships in this task; nothing is built or pushed.

## Verification

- Every number on the design page names its method and the host load; A/B runs interleaved.
- M4's model is checked against prototype-measured unit checks on sampled commits; disagreement > 2×
  means the model is wrong and is reported as such.
- The design page is re-read through `read_page` after writing; the track page keeps the required
  header shape (goal, exit criteria, status/next, nested checkboxes, links).
