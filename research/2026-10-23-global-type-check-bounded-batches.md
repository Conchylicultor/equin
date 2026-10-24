# Type-check Part B: no program holds more than K files

Status: built 2026-10-24 — the plan below as first written; what changed and the measurements are in "Result" at the end. Track "Track: build and push speed" (`block-e5afc5b1-…`), sub-page "Rung 2 design"
(`block-a9e68ab6-…`), Part B of `research/2026-10-22-global-type-check-global-and-cold.md`.

## Context

After step 3c, a global change (producer engine, a global `.d.ts`, tsconfig, an npm resolution) or an
empty store still misses every result key. Program 1 then holds every one of the ~12.7k files: one process
uses 213–327 CPU-s, peaks at 27–30 GB, and runs single-threaded. It also does a full typed re-lint in the
same program. About 27 of 948 main commits in 30 days still move the global hash. A prediction miss in
`whole` mode, and the `dual` oracle, take the same path.

Checking every file once costs a fixed amount of CPU. The peak and the single process do not have to be
that way: they come from the program's **size**, which nothing bounds. Phase A measured the same work in
dependency-ordered batches against served `.d.ts` at 3.4–3.8 GB per process, at about the same CPU
(batch 32: 294 CPU-s). The same `.d.ts` serving is how program 2 and incremental program 1 already run,
and the dual replay holds them to 0 divergences.

**The invariant to build (rung 1, inexpressible):** no program holds more than `K` source files. A set
`S` to check with `|S| ≤ K` is one program in-process, as today. A larger `S` is checked in
dependency-ordered batches of at most `K`. Each batch is served the `.d.ts` that earlier batches just
produced. Up to `P` batch processes run at once. This is not a special "cold mode": program 1 and program
2 both go through it, so a cold run, a global change, a big rebase and the miss fallback are all bounded
the same way.

## Design

### 1. `checkSet` replaces the direct `runProgram` calls (`shared/name-run.ts`)

`walkAndCheck`'s program 1 and program 2 call one function, `checkSet(S, check, contractOf, lintPlan)`.
It returns `{ checked: Map<path, CheckedFile>, served, programDiagnostics, stats, lint }`, which is
today's `ProgramRun` minus the live `program`.

- `|S| ≤ K`: `runProgram` in-process, with lint in it as today. Behaviour and cost are unchanged for every
  incremental run.
- `|S| > K`: run the batch scheduler (§2). `served` is the union over batches. A file of an earlier batch
  is served its **fresh** contract, so its entry in `served` is the fresh hash.

Why the walk needs no change: in `phase1` a `first` file is in the `confirmed` state, and a served
contract is stale only for a `second` or a mismatched `valid` file (`name-walk.ts` ~L660). In
`predictBottom`, a `first` owner's previous record is its fresh one (`prevOf`). So when a batch reads an
earlier batch's fresh `.d.ts`, the walk sees it the same way as a read of program-1 source. If such a file
then goes to program 2, its readers become stale-read and join program 2 too. That is already the
behaviour. A cold run still has no program 2, so it still cannot miss.

### 2. The batch scheduler (new `shared/batch-plan.ts` + `shared/batch-run.ts`)

- **Graph:** the repo-import edges of each file in `S`: `imports` + `res.targets` from its store entry.
  An entry is per text and does not depend on `global`, so after a global change every unchanged file
  already has one. A file with no entry (empty store, new text) is parsed (`fileImports`) and resolved
  (`RecordingResolver`), and that work is kept for its record. Only edges inside `S` matter; anything
  outside `S` is served, as it is today.
- **Environment first:** the global source files and the repo sources that the `.d.ts` roots import
  (`config_v2`'s `composition-config-layer.d.ts`) are in every program. Their import closure is therefore
  a predecessor of every batch.
- **SCCs** over the file graph. A batch never splits one (largest measured: 174 files, the exhibits).
  `K` ≥ the largest SCC is asserted.
- **Ready queue:** an SCC is ready once all its predecessors are done. When a process slot is free, take
  up to `min(K, ⌈ready/P⌉)` files of ready SCCs (Phase A Q4's fair share), longest remaining path first,
  so the 32-level critical path starts early.
- **Loud on a missing edge:** `contractOf` for a file in `S` that is not done throws, naming the file and
  its reader. A batch never falls back to a stale variant (rung 4).
- **Per batch:** after each batch, `programDiagnostics` must be equal across batches (asserted). They are
  program-level diagnostics, so they depend only on options and roots.

### 3. Batch processes (new `shared/batch-worker.ts`), one process per batch

The coordinator is the existing worker process, now ~1 GB, since it holds records and no program. It
spawns each batch through `spawnCaptured` (`infra/spawn`), the same job-file in / JSON stdout pattern
the parent uses for the worker today. A process exit is the push signal that frees a slot. No IPC
primitive is needed, and none is added.

A batch job holds: the tree (`TypeCheckTree`, as the worker job has it), the options, the batch's files,
and `contracts: path → hash` for every file it may load as a `.d.ts`. Contracts are read from the
host-wide `type-check-contracts` store. The coordinator writes each batch's fresh contracts to that
store before it dispatches any dependant. They are content-addressed, so a write is never wrong, and the
age bound reclaims an unused one. The process runs `runProgram` and then lints its files inside that
program. It returns `CheckedFile` per file (already plain data), `served`, its stats, and its lint
output.

**Lint moves into the batch with its file.** Each batch file's stale syntactic groups and its typed
parts run in the batch process: the program's parse is there, and lint is more than half of a cold
run's CPU (fleet: tsc 95–260 + lint 0–306 CPU-s), so it needs the width. A typed part's decision needs
the file's R, and R is known only after `finalKeys`. So the batch runs each typed part the job names and
returns its messages **undecided**. The coordinator then sets each one to `ran` / `cached` with the key it
computes (`typedResultKey(fp, R)` against `known`), the same `TypedPartOutcome` as today. A typed lint
result depends only on its key, so running it early and deciding later gives the same outcome. The only
extra cost is a part whose key turns out to be known. On this path that is ~never, because every R moved.
The lint runner in `worker.ts` (`lintRunner`) is moved into a module that both the worker and the batch
worker import, so a second copy of it cannot drift.

**Why one process per batch and not a long-lived pool:** a pool needs a push channel between processes.
`infra/spawn` forbids piped stdio (the bun wedge), so that channel would be a new socket primitive. A
process per batch pays its start-up each time: environment load ~3–5 CPU-s (Phase A) plus loading the
lint config. With `K` ≈ 1,000, that is ~13 batches × ~5–8 s ≈ +65–100 CPU-s. **Gate:** if the measured
fixed cost is over 15 % of a cold run at the chosen `K`, stop and come back with the socket pool as a
`packages/` primitive.

### 4. Width and admission

- `P_MAX = 3`. Three batch processes at ~4 GB each fit inside the 7–14 GB envelope that the
  `type-check-worker` host pool (size 2) was sized for. The pool stays the host's memory bound, and
  nothing in host-admission changes.
- `worker-weight.ts`: add `TYPE_CHECK_BATCH_PEAK_BYTES` (measured in step 0) and its derived units.
  `spawnTypeCheckWorker` picks `width = clamp(⌊grant.units / batchUnits⌋, 1, P_MAX)`, spends
  `width × batchUnits` through `grant.run`, and passes `width` in the job. A 1-unit grant then still
  runs, one batch at a time, at ~4 GB instead of 27 GB.
- An incremental run (`|S| ≤ K`) spawns nothing extra. It keeps today's 2-unit worker weight.

### 5. B2, single-flight per global hash: log first, decide on data

The global hash is not logged, so the claim that "4 whole-program runs in 15 min" were the same hash is
unconfirmed. This task adds `global=<hash12>` and `batches=<n> width=<p>` to the walk line in the
transcript. Single-flight is decided from a week of fleet logs, in the next track task. With B1, a
duplicate run costs CPU but no longer ~27 GB per worktree.

### Not changed

- `full-check.ts`, the dual oracle's fresh whole program, stays whole: being whole is what makes it an
  oracle. It runs daily on main only.
- Keys, the store format, the walk, prediction: none change. Batching changes which program a file is
  checked in, and nothing about what it is checked against or keyed on.

## Steps (one session)

0. **Measure to pick `K`** (before any wiring): on an empty isolated store, `batch-run` over the real tree
   at `K` ∈ {500, 1000, 2000}, `P` = 1 and 3. Per batch: peak RSS, CPU, fixed cost (spawn → program
   built, lint config loaded). Total CPU and wall. Pick the smallest `K` with fixed cost ≤ 15 %. The
   SCC sizes and critical path come from the same run.
1. `batch-plan.ts` (graph, SCCs, environment closure, ready queue). Unit tests on fixtures.
2. `batch-worker.ts`, plus the lint runner moved out of `worker.ts`. `checkSet` in `name-run.ts`, with
   undecided typed parts decided after `finalKeys`.
3. Width/admission (`worker-weight.ts`, `spawn-worker.ts`, job protocol `width`, `batchK`), and the
   walk-line fields.
4. Correctness gates, benchmark, docs (this plugin's `CLAUDE.md` "Two programs" section: "a cold run is
   one program" becomes "a cold run is ⌈N/K⌉ batches"), the wiki result section, and the next track task.

## Critical files

- `type-check/shared/name-run.ts`: `checkSet` at the two `runProgram` call sites, lint settle after
  `finalKeys`, global in the report.
- New `type-check/shared/batch-plan.ts`, `batch-run.ts`, `batch-worker.ts` (flat in `shared/`, so
  `engineSources()` / `producerSources()` derive them).
- `type-check/shared/worker.ts`: lint runner extracted, `width` / `K` from the job.
- `type-check/core/worker-protocol.ts` (`width`, `batchK`, `TypeCheckBatchJob/Result`),
  `core/worker-weight.ts`, `server/internal/spawn-worker.ts`.
- Reused as is: `runProgram` / `fileImports` / `CheckedFile` (`name-check.ts`), `RecordingResolver`
  (`name-resolve.ts`), `NameStore` contracts (`name-store.ts`), `spawnCaptured` (`infra/spawn`),
  `phase1` / `finalKeys` (`name-walk.ts`).

## Verification

- `./equin test plugins/framework/plugins/tooling/plugins/checks/plugins/type-check`. New
  `name-run.test.ts` cases run the existing fixtures at `K = 2`, which forces batching including a cycle,
  an environment `.d.ts` that imports a source, and a global file. Each case gets the same diagnostics,
  signatures, keys and lint outcomes as `K = ∞`. Plus a case where a missing edge throws loudly, and
  `batch-plan` unit tests.
- `scripts/dual-check.ts` and `scripts/walk-replay.ts` over the 31 main trees at `K` = the chosen value
  and at `K` = 300 (more batch boundaries): 0 divergences, 0 misses.
- Benchmark (isolated `SINGULARITY_DIR`, `./equin check type-check --jobs 1`, before = merge-base),
  added to the track sub-page:

  | Scenario | Measures |
  | --- | --- |
  | Cold (empty stores) | CPU, peak per process, peak concurrent (sum of overlapping children), wall, batches |
  | Producer edit (global) | same |
  | Global, 1-unit grant (`P` = 1) | same |
  | Unchanged tree, hub body edit, hub type edit | no regression |

  Target: peak per process 27–30 → ≤ ~4 GB, concurrent ≤ ~12 GB, CPU ≤ +15 %, wall ÷ ~2–3.
- `./equin check` and `./equin build` green.

## Result (2026-10-24, att-1792753401-9ljnnj)

**What changed from the plan, and why (measured):**

- **Width 3 dropped; one batch process at a time, K = 2000.** Every program
  re-pays the environment (lib, `@types`, the npm types the repo resolves):
  ~9 s to build plus ~5–7 s of extra checking per batch. Three processes at once
  split the ready work into many small batches: K = 1000 → 29 batches,
  945 CPU-s (+125 %); K = 4000 → 17 batches, 665 CPU-s (+54 %), tsc only.
  Decided with the user: few big batches, one at a time.
- **Batches grow along their dependants.** The first scheduler put only READY
  components in a batch, so the import graph's depth (101 components) forced
  ≥ 101 programs (+38 % CPU at K = 1000 in-process). A batch now takes a fair
  share of the ready components, then every component whose dependencies are
  done or in the batch, up to K: 13 batches at K = 1000, 7 at K = 2000.
- **In-process batches bound nothing.** Programs built one after another in the
  worker kept 11–15 GB resident, with or without a forced full GC between them;
  the same batch in a fresh process peaks at 5.8 GB (K = 4000, tsc only). So a
  batch is always its own process (`shared/batch-processes.ts`,
  `shared/batch-worker.ts`); the in-process runner is the fixtures'.
- **Lint goes with the file**, keys decided afterwards (`LintHook.adopt`).
  Typed lint inside a batch roughly doubles its peak (tsc 5.8 → 14.8 GB at
  K = 4000), which is why K = 2000.
- **A global source file is an import of every file**, so it and what it
  imports share one component (an augmentation and the module it augments
  need each other's `.d.ts`). A repo `.d.ts` root's imports go first.
- **A type is spelled by its declaring file in the canonical `.d.ts`**
  (`canonicalDeclarations`' `declaringOf`, resolved through the checker in
  `checkFile`). The first dual gate at K = 4000 found 12 signature divergences
  (no diagnostic one): one program printed
  `import("../../server").JobFactory`, a batch served the barrel's `.d.ts`
  printed `import("../../server/internal/registry").JobFactory`. Phase A had
  seen the same class. A producer change: it moves the global hash once.
- **Process plumbing joins the existing debt exemption** for
  `boundaries/no-platform-api` (task-1792338443-riwqev): `shared/worker.ts`,
  which spawns the batches, is on it and may not import a `machine/` half.
  Decided with the user.

**Correctness.** Dual mode on the real tree (cold, isolated store), batched
against a fresh whole program: K = 4000 and K = 2000 — 0 of 12,796 files
diverge (after the canonical-spelling fix; 12 signature-only before it), walks
0 differences (tsc-only batch peak at K = 2000: 6.7 GB).
Fixtures: every `name-run.test.ts` run is repeated in batches of one file and
must check, key and report the same (106 tests pass).

**Benchmark** (`./equin check type-check --jobs 1`, cold, isolated
`SINGULARITY_DIR`, lint included; one sample each on a loaded host, load 13–41,
so CPU is noisy; before = the same code with K = ∞, i.e. one program):

| Cold check | Batches | Worker CPU (sys) | Peak per process | Wall |
| --- | --- | --- | --- | --- |
| One program (before) | 1 | 620 s (198 s) | 22.1 GB | 647 s |
| K = 6000 | 3 | 370 s (31 s) | 17.4 GB | 290 s |
| K = 4000 | 4 | 495 s (44 s) | 14.8 GB | 387 s |
| K = 3000 | 5 | 404 s (33 s) | 12.8 GB | 303 s |
| **K = 2000 (shipped)** | 7 | 442 s (42 s) | **10.3 GB** | 314 s |
| K = 2000, the real build's cold run | 7 | 397.5 s (38 s) | 10.4 GB | 291 s |

The whole program's memory pressure (198 s of system time) costs more than
the batches re-pay: every batched configuration used less CPU than one
program on this host. Warm runs are unchanged (a set ≤ K is one program, as
before). Cost left on the cold path: planning reads each file's imports from
its entry (89 ms in the build); on an EMPTY store it parses every file
(5–30 s, 177 s once at load 30).
