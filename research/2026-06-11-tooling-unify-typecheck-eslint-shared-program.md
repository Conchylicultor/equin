# Plan: Unify `typescript` + `eslint` into one `type-check` check that builds each TS program once

## Context

During `./equin build` / `./equin check`, **two checks each construct the full
TypeScript program over the repo**:

- **`typescript`** (`.../checks/plugins/typescript/check/index.ts`) — spawns one
  `bun x tsc --noEmit --incremental` subprocess per tsconfig target (from
  `discoverTscTargets`) and reads its semantic diagnostics.
- **`eslint`** (`.../checks/plugins/eslint/check/index.ts`) — spawns N worker subprocesses;
  each, via `parserOptions.projectService: true`, builds its **own** `ts.Program` internally
  (~2.7 GB each) to run the 5 type-aware rules (`no-misused-promises`,
  `switch-exhaustiveness-check`, `no-unnecessary-condition`, `await-thenable`, …).

Type-aware ESLint is **~99% TS-program construction — the same work `tsc` already does** — so
the cold-path program build is paid twice. The eslint workers round-robin `toLint` files
across processes (`shardFiles`), which spreads every tsconfig into every shard and makes
**each worker rebuild ~every program** — the duplication is both *across the two checks* and
*across eslint's own workers*. Commit `231f03be3` parallelized the eslint cold re-lint to
~96 s, but the redundant construction remains.

**Goal:** build each tsconfig's `ts.Program` **once** and drive both consumers off it —
`tsc` semantic diagnostics **and** type-aware lint — removing the duplication at the source
rather than parallelizing around it.

**Linchpin (verified):** typescript-eslint `8.59` still supports
`parserOptions.programs?: ts.Program[]` ("This overrides any program… computed from the
`project` option. All linted files must be part of the provided program(s)." —
`typescript-estree/dist/parser-options.d.ts:174`). So a program we build can be handed to the
parser, which then **builds nothing of its own**.

Decisions taken (with the user): **single combined `type-check` check** (collapse the two
ids), **clean cutover** (no fallback flag, delete the old subprocess paths).

## Why this preserves the recent `projectService` win

`research/2026-06-03-global-tsconfig-tools-eslint-default-project.md` moved ESLint to
`projectService: true` so every file resolves to a *real* tsconfig (orphan build-time files
get `tsconfig.tools.json`; the slow ~1,500-file default-project fallback was deleted).

Switching from `projectService` back to explicit `programs` does **not** undo that, because
our explicit program set is built from the **same tsconfigs** — including `tsconfig.tools.json`
(already a `discoverTscTargets` target). The safety property survives identically: the parser
errors if a linted file is in **no** provided program ("must be part of the provided
program(s)"), the same loud failure `projectService` gives for an unowned file.

## Design

### Per-target worker — program built once, two consumers

Reorganize the work **per tsconfig target** (not per tool). One worker process per target:

```
worker(target):                                       # runs in its own process for multi-core
  parsed   = ts.parseJsonConfigFileContent(tsconfig)  # rootNames + options
  program  = ts.createIncrementalProgram({ rootNames, options: { ...,
                 incremental: true, tsBuildInfoFile: tsBuildInfoPath(root, target.name) } })
  tscDiags = ts.getPreEmitDiagnostics(program.getProgram())   # == the old `typescript` check
  program.emit(undefined, () => {})                   # noEmit, but persists .tsbuildinfo

  filesToLint = toLint ∩ filesOwnedBy(target)         # closure-cache-filtered, deduped (below)
  violations  = filesToLint.map(f =>
                  Linter.verify(read(f), config({ programs: [program.getProgram()] }), f))
  return { target, tscDiags, violations, lintedFiles: filesToLint }
```

`parserOptions.programs: [program.getProgram()]` is the whole point — typescript-eslint reuses
the program. The orchestrator runs all targets via `Promise.all`, then splits results into the
two failure categories and reports both under the one `type-check` check.

### File → program assignment (exact-once lint, type-check-in-all)

A `core/` file is included by **multiple** target programs (e.g. web-core *and* server-core, by
design — different `lib`/`jsx`). The two consumers want opposite things, matching today's
behavior:

- **tsc diagnostics**: keep checking the file in **every** program that includes it (unchanged —
  `tsc` already double-checks `core` under web/server/central).
- **eslint**: lint each file **exactly once**. Assign each `toLint` file to the **first** target
  (deterministic target order) whose program contains it; skip it in the others. Prevents
  duplicate violations and wasted work.

**Program set must cover the full lint universe.** `discoverTscTargets` returns
`{ central-core, cli, server-core, tooling, web-core(app), tools }`. ESLint also lints files
owned by **`web-core/tsconfig.node.json`** (`vite.config.ts`, `vitest.config.ts`) which is *not*
a typescript-check target today (it rides web-core's `tsc -b` during the vite build). The new
check must build a program for **every leaf tsconfig that owns a lintable file** — i.e. a
*superset* of `discoverTscTargets`. Add the node config (and any analogous leaf) to the target
list used by `type-check`. Verification step 3 (below) is the gate that proves coverage is
complete: any uncovered file errors loudly ("must be part of the provided program(s)").

### Warm path — both caches preserved, reused as-is

- **tsc incremental**: `createIncrementalProgram` + `tsBuildInfoPath(root, target.name)` — the
  same `.cache/tsbuildinfo/<target>.tsbuildinfo` (seeded from main into fresh worktrees).
- **eslint per-file closure cache**: reuse `buildImportGraphs` + `computeClosureFingerprints` +
  `openEslintClosureCache` from `eslint/core` **unchanged**. Compute `toLint` exactly as today,
  lint only those files, `cache.record(f, fp)` per file on a passing target. The global
  `~/.singularity/eslint-closure-cache` and cross-worktree PASS sharing are untouched.

The closure cache stays an independent layer applied **before** target grouping — grouping by
target simply replaces `shardFiles`' round-robin. Per-file caching is **not** lost.

### Parallelism tradeoff (flagged honestly)

A `ts.Program` is an in-memory object that cannot cross process boundaries, so the largest
single project (web-core app, ~1,500 files) is built on **one core** and becomes the cold-run
wall-clock floor; the other targets build concurrently on the other cores and fully overlap.
Today the round-robin model builds the web-core program **once per worker** in parallel, so
building it **exactly once** is comparable wall-clock at a fraction of the CPU/RAM — and `tsc`
is folded into the same pass for free. Net cold-run expectation: similar-or-better wall-clock,
roughly halved CPU/memory, with the per-program duplication eliminated. (If web-core's single
program ever dominates, the structural fix is splitting that tsconfig — out of scope here.)

## Changes

### New plugin: `.../checks/plugins/type-check/`
- `check/index.ts` — the `type-check` check: orchestrator (`getRoot`, build target list =
  `discoverTscTargets` ∪ extra leaf configs, compute `toLint` via the closure-cache helpers,
  assign files to programs exact-once, `Promise.all` over per-target workers, split + format the
  two failure categories with the existing hints from both old checks).
- `shared/worker.ts` (or a `bin/` entry spawned via `Bun.spawn`) — the per-target worker:
  `createIncrementalProgram`, `getPreEmitDiagnostics`, emit-for-buildinfo, run `Linter.verify`
  with `programs`. Subprocess so each target's program build uses a separate core.
- `check/CLAUDE.md`.

### Refactor `eslint.config.ts` → expose a reusable rule/plugin config
Today `eslint.config.ts` bakes `parserOptions.projectService` into the exported flat-config
array. Extract the **rules + plugins + per-rule `ignores`** (the contribution-loading logic,
`baseConfigs` rules, `pluginConfigs`, `exemptConfigs`) into a reusable builder importable by the
worker, which composes it with `languageOptions.parserOptions.programs = [program]` per run
(via the `Linter` API, not the `ESLint`/CLI class). The flat-config default export stays for
editor/IDE ESLint, but its parser options switch from `projectService` to consuming the same
builder so the two stay in lockstep. Keep the loud-fail contribution loader (a dropped rule must
still throw).

### Delete the two old checks (clean cutover)
- Delete `.../checks/plugins/typescript/` and `.../checks/plugins/eslint/check/` (keep
  `eslint/core` — the closure-cache + import-graph helpers are reused by `type-check`).
- `./equin build` regenerates `check.generated.ts` (drops `typescript`/`eslint`, adds
  `type-check`) and the plugin docs. **Do not hand-edit the generated registry.**

### Build wiring (`cli/bin/commands/build.ts`)
- The `--skip-checks` fallback runs runtime-entrypoint `tsc` passes directly; leave as-is (it
  already notes the `typescript` check covers entrypoints). When checks run, the new
  `type-check` span replaces the `check:typescript` + `check:eslint` spans in the profiling
  Gantt — no code change beyond the id flowing through `onCheckDone`.

## Critical files

| File | Action |
|---|---|
| `.../checks/plugins/type-check/check/index.ts` | **create** — orchestrator |
| `.../checks/plugins/type-check/shared/worker.ts` | **create** — per-target program build + tsc diags + lint |
| `.../checks/plugins/type-check/check/CLAUDE.md` | **create** |
| `eslint.config.ts` | refactor: extract reusable rule/plugin builder; default export consumes it |
| `.../checks/core/discover.ts` | extend target set to cover all leaf lint-owning tsconfigs (e.g. web-core node config) |
| `.../checks/plugins/eslint/core/*` | **keep** — closure cache + import graph, reused |
| `.../checks/plugins/typescript/` | **delete** |
| `.../checks/plugins/eslint/check/` | **delete** (keep `core/`) |
| `check.generated.ts`, plugin docs | regenerated by `./equin build` |

## Reused, do not reinvent
- `discoverTscTargets`, `tsBuildInfoPath` — `.../checks/core/discover.ts`.
- `buildImportGraphs`, `computeClosureFingerprints`, `openEslintClosureCache` — `eslint/core`.
- Rule set, plugin contributions, `ignores` exemptions, loud-fail loader — `eslint.config.ts`.
- TS APIs: `ts.parseJsonConfigFileContent`, `ts.createIncrementalProgram`,
  `ts.getPreEmitDiagnostics`, `ts.formatDiagnosticsWithColorAndContext`.
- ESLint `Linter` (programmatic `verify`) from the `eslint` package.

## Verification (end-to-end, from the worktree)

1. **Behavioral parity — type errors.** Introduce a deliberate type error in a server file and a
   web file; `./equin check type-check` fails with both, formatted like the old
   `typescript` check. Revert.
2. **Behavioral parity — lint.** Introduce a `no-floating-promises`/`no-misused-promises` and a
   `switch-exhaustiveness-check` violation; `type-check` reports them with the old eslint hint.
   Revert.
3. **Full coverage gate (the load-bearing one).** `./equin check type-check` on a clean
   tree passes with **zero** "file is not part of the provided program(s)" errors — proves the
   program set covers every lintable file (incl. `vite.config.ts`/`vitest.config.ts`, lint
   barrels, `*.config.ts`, scripts). Any miss names the file → add its leaf tsconfig to the
   target set.
4. **Exact-once lint.** A `core/` file with a violation reports it **once**, not once per
   including program.
5. **Warm path.** Re-run with no changes → near-instant (closure cache + tsbuildinfo all hit).
   Touch one server file → only its target rebuilds incrementally and only changed-closure files
   re-lint.
6. **Cold path / the win.** `rm -rf .cache/tsbuildinfo` and clear the closure cache; time
   `./equin check type-check`. Confirm wall-clock is ≤ the old `max(typescript, eslint)`
   and total CPU/RAM is markedly lower (one program per target, no duplication). Capture in the
   build profiling Gantt (`check:type-check` span).
7. **Registry + docs.** `./equin build` regenerates `check.generated.ts` and docs cleanly;
   `./equin check` (all checks) passes, including `plugins-doc-in-sync` and
   `plugins-registry-in-sync`.
8. **IDE parity.** `bunx eslint <one file>` (editor path, still flat-config/projectService-free
   via the shared builder) reports the same violations as the check.

## Risks
- **`programs` is a lower-traffic path than `projectService`.** Type-aware rule results could
  drift (e.g. cross-file type resolution, single-run inference). Mitigation: parity steps 1–2,
  4, 8 diff old vs new on real violations before cutover; clean cutover only after parity holds.
- **Diagnostic/format drift** between `tsc` CLI output and `getPreEmitDiagnostics` +
  `formatDiagnosticsWithColorAndContext`. Mitigation: match the old message/hint shape; step 1.
- **Incremental emit semantics.** `createIncrementalProgram` writes `.tsbuildinfo` only via
  `emit()`; ensure `noEmit` still persists buildinfo (call `emit` with a no-op writeFile) so the
  warm path stays fast. Step 5 is the gate.
- **Memory.** Each worker holds one program (~2.7 GB peak for web-core). `workerCount`-style
  memory bounding still applies — cap concurrent target workers by `os.totalmem()` as the old
  eslint check did, queueing the rest.
