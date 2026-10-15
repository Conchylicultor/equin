# type-check

The unified TypeScript + type-aware-ESLint check. It replaces the separate
`typescript` and `eslint` checks, which each built the full TS program (tsc for
diagnostics; typescript-eslint via `projectService` for the type-aware rules).
Type-aware linting is ~99% TS-program construction — the same work tsc does — so
the cold cost was paid twice. This check builds the repo's TS program **once**
(in one worker process) and reads both tsc diagnostics and type-aware lint off
it, via typescript-eslint's `parserOptions.programs`.

## One program, and why there is no target list

There is exactly ONE TypeScript program: the root `tsconfig.json`, whose
`include` is `["plugins", "test", "*.config.ts"]` — every `.ts`/`.tsx` git
tracks. `checks/core/discover.ts` names it (`repoProgram(root)`) and there is
nothing to iterate.

Until 2026-09-18 there were seven tsc targets — `web-core` (its own
`tsconfig.app.json`), `server-core`, `central-core`, `cli`, `tooling`, `tools`
(root `tsconfig.tools.json`) and `test` (root `tsconfig.test.json`) — and the
check spawned a worker per target. **Do not reintroduce that split**, and read
the measurement before proposing any second program.

### The measurement, so the isolation belief cannot come back

The split was believed to buy type-environment isolation: the doc that stood
here claimed "a `window` reference in `core/` fails under the node program".
**It did not.** Read from the seven pooled `.tsbuildinfo` files (TypeScript
6.0.3, this host, 2026-09-17), **six of the seven programs loaded the same
environment**:

- `lib.dom.d.ts` — the node-side tsconfigs set no `lib`, and the default for
  target ES2023 is `es2023.full`, which includes DOM.
- `@types/node`, `@types/bun`, `@types/react` — `tsconfig.app.json` set no
  `types`, so every `node_modules/@types/*` at the root was auto-included, and
  that auto-included set was exactly the set `tsconfig.test.json` named
  explicitly.

Only `tools` (`lib: ["ES2023"]`) withheld DOM, and every file it covered was
already checked under DOM by six other programs. Runtime isolation — web must
not import server — is the `plugin-boundaries` check's job, not tsc's.

What the split cost, from the same buildinfos: **30,649 file instances for 8,252
distinct repo files (3.7×)**.

| files in N programs | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| count | 1,148 | 3,137 | 76 | 365 | 49 | 3,045 | 432 |

`test` alone held 8,053 of the 8,252, of which only 1,076 were test-only — so
`test` was already a working prototype of the single program, and the union is
that program plus ~2.5% more files. Per-worker cost on a cold miss, over every
check transcript on this host (n ≈ 300 per target):

| target | cpu mean | peak RSS mean | max |
| --- | --- | --- | --- |
| test | 180 s | 7.2 GB | 16.6 |
| web-core | 209 s | 6.7 GB | 14.3 |
| server-core | 104 s | 4.3 GB | 7.8 |
| cli | 78 s | 3.9 GB | 8.8 |
| central-core | 79 s | 3.8 GB | 7.7 |
| tooling | 67 s | 3.5 GB | 6.8 |
| tools | 22 s | 1.0 GB | 1.9 |

A cold miss ran all seven at once: ~740 CPU-s and ~30 GB of simultaneous
resident memory. One worker is ~180 CPU-s and ~7 GB.

Design and decision: `research/2026-09-18-global-type-check-one-program.md`.

## Shape

- `check/index.ts` — the **check runner's thread**, shared by every check in
  the pass. Only: the async git reads (`getWorktreeRoot`, `readTreeListing`),
  the outer read-set (recorded from the listing alone), the one grant spend, the
  log lines, the verdict.
- `check/prepare.ts` — the **preparation thread** (one Bun `Worker` per run;
  entry `prepare-worker.ts`, runner-side host `prepare-thread.ts`). Builds the
  import graph + closure fingerprints, parses the tsconfig's include-expansion,
  runs the coverage gate (replaces projectService's "every file resolves to a
  project"), reads the lint result store (which rule groups each file still
  needs), materializes the warm base, computes the program key → returns a
  `Plan` and keeps the session. After the worker, `finalize` runs the records
  (warm-base publish, the fresh lint results, the program PASS or its
  re-record) and assembles the lint verdict under the current exemptions.
- `shared/worker.ts` — the worker **process**. `createIncrementalProgram` →
  `getPreEmitDiagnostics` (+ persists the shared `.tsbuildinfo`) → ESLint
  `Linter.verify` with the program injected, running only the rule groups each
  file's job names and returning the messages raw. A separate process so the
  single-threaded program build runs on its own core and its peak RSS is
  measurable from outside.

**Nothing that reads file bytes or walks the tree goes in `index.ts`** — it goes
in `prepare.ts`, whose values only the worker imports. That work is 70–130 s of
synchronous CPU; on the runner's thread it froze every concurrent check (no
timer, no socket), so `migration-applies-clean`'s pg connect sat silent past
Postgres's 60 s `authentication_timeout` and failed with `ECONNREFUSED`
(`research/2026-09-10-tooling-type-check-prepare-off-thread.md`).

A thread, not a helper process, because the session must survive the worker:
the record phase reuses the prepare phase's fingerprints, key and
`ProgramKeyContext.contentHash` memo, which a process would have to serialize.

New files go FLAT in `check/` or `shared/`: `selfSourceHash()` hashes only the
top-level `.ts` there, and it is part of every program key — a subdirectory
would silently fall out of it.

## The file universe comes from git, and is enumerated once

`run()` takes ONE `readTreeListing(root)` — a `TreeListing` whose files come
from `listRepoFiles` (`checks/core`) — and hands that value to every consumer:
`buildImportGraphs` (preparation thread) and `recordOuterReadSet` (runner
thread) both filter it with `lintableFiles`, so the recorded set is the linted
set; `findGlobalTriggerFiles` with `isGlobalTrigger`; the program key with
`isTscTrigger` and `isTsName`. The listing crosses to the thread as a value, so
it never re-lists. Nothing below the listing enumerates: `import-graph.ts`,
`fingerprint.ts` and `program-key.ts` only read the bytes of files handed to
them, which is why they stay synchronous.

This matters because the check is `inputKeyed`: its verdict must be a function
of the tree its cache key hashes, and that key is git-derived
(`computeTreeHash` = scratch index + `git add -A`). Both of the walks this
replaced saw _more_ than the key — every gitignored file — so on 2026-09-09 a
stray `.ts` an agent had left under `.cache/scratch/` counted as lintable,
matched no tsconfig program, and failed a push over content no commit contains.
The second walk had a matching bug of its own: it skipped a literal `dist`
segment but not `dist.staging.*` / `dist.live.*` / `dist.old.*`, so a build
artifact under one moved the global fingerprint and invalidated the whole
closure cache.

The two predicates now spell only what `.gitignore` does not: `*.generated.ts`
and `prototypes/**`, the remainder of eslint's ignore list
(`lint/core/build-lint-config.ts`) once git has done its part. Do not restate
`node_modules` / `dist` / `.check-*` / `.claude/worktrees` there — a
git-enumerated set never contains them, and a second copy of that list is
exactly what drifted. See
`research/2026-09-09-tooling-check-file-enumeration-from-git.md`.

(The root tsconfig's own `exclude` is the one place that list legitimately
reappears: tsc expands `include` by walking the FILESYSTEM, not by listing git,
so it needs `**/node_modules` and the `dist*` release trees named. Dot-prefixed
directories are never matched by a tsconfig wildcard, so `.cache` and
`.claude/worktrees` need no entry there either.)

## The coverage gate is set subtraction

`uncovered = lintable − roots`, where `roots` is the tsconfig's own
include-expansion. A lintable file that is not a root is, under a blanket
include, outside `include` by definition — a stray `scripts/x.ts` at the repo
root, or a new top-level directory — which is exactly what must fail.

It used to need a forward-import closure walk from each target's roots, because
a file could legitimately be outside every `include` yet reachable from one.
That case does not exist with one blanket include, so the walk is gone.

A tsconfig that will not PARSE is its own arm of the result, not an empty root
list. An empty list would report every lintable file as orphaned — a wall of
noise for one broken JSON file — and would mint a program key for a program we
could not describe. The `unparsed` arm skips the gate and the key and lets the
worker run, where tsc reports the broken config as the one diagnostic it is.

## The lint cache is keyed per rule group, and exemptions apply when it is read

A file's type-aware lint result depends on the file plus everything it imports
(its closure fingerprint, `check/fingerprint.ts`) and on the rules that ran on
it. The rules used to be ONE global hash over every `lint/`, `exempt/`,
tsconfig, lockfile, `.d.ts` and app.css file, so a change to any of them
re-linted all ~11.4k files: 657 CPU-s and 21.4 GB for a comment in one rule
(this host, 2026-10-15). On main, 61 of 226 commits in a week did that, plus 11
app.css edits — and not one of the 37 lockfile edits changed an npm resolution.

So `check/lint-groups.ts` splits the rules into GROUPS, each with its own
fingerprint:

- the **engine**, folded into every group: the config builder's import closure
  (`LINT_CONFIG_SOURCE`, generated registries not followed), `shared/worker.ts`,
  the root tsconfigs and `package.json`, ambient `.d.ts`, `patches/**`, the
  lockfile **minus its workspace entries** (`lockfileLintDigest`), and the
  declared `@utility` set (`lintDataKey`), not app.css's bytes;
- the **base** group (`LINT_GROUP_BASE`): the builder's own rules
  (typescript-eslint, react-hooks, eslint core) — the engine alone;
- one group per **lint contribution** (`lintContributionPaths()`): the import
  closure of `plugins/<p>/lint/index.ts`, stopping at engine files. A rule's
  `*.test.ts` is not in it; a helper it imports from outside `lint/` is.

`check/lint-results.ts` stores, per (file, closure fingerprint), the RAW
messages each group produced, under that group's fingerprint (the newest few per
group, so two worktrees on two versions of a rule do not thrash). The worker
re-runs only the stale groups of each file (`buildLintConfig`'s `rules`
selection), and `check/lint-verdict.ts` assembles every file's messages under
the CURRENT exemptions — so an exemption edit re-lints nothing, and an unused
file-level exemption is now reported for every file, not only re-linted ones.

**A file with an eslint directive is one unit** (`LINT_GROUP_ALL`, ~4 % of
files): whether a disable directive is unused depends on every rule, so its
result is keyed on all group fingerprints at once and it is re-linted whole.

What a change costs now: a workspace-only lockfile, an exemption, or an app.css
token edit — nothing re-linted; one contribution's rule — every file, but that
group's rules only (a directive file whole); a rule's test — nothing; the lint
core, a tsconfig, a `.d.ts`, a real dependency bump — everything, as before.
Design and measurements: `research/2026-10-15-global-lint-cache-per-contribution.md`.

## Host-wide worker admission — `server/spawnTypeCheckWorker`

The worker builds a 7–14 GB TS program. `spawnTypeCheckWorker` (`server/`) is
the ONE place a worker starts — for this check and for the build's
`--skip-checks` fast path — and it takes the caller's `Grant`, so admission and
priority cannot be skipped or disagree:

1. **A slot in the laned `type-check-worker` host pool** (size 2, in
   host-admission's `HOST_POOLS`; `server/internal/worker-pool.ts`). Background
   (agent builds, agent checks) may hold one slot; the interactive lane (push,
   main build/check) can take either. Taken FIRST, so a queued worker holds none
   of its holder's grant units.
2. **`TYPE_CHECK_WORKER_UNITS` of the holder's grant** (`core/worker-weight.ts`:
   `ceil(7.2 GB mean peak / PER_UNIT_BYTES)` = 2), the CPU share. The grant
   CLAMPS that to its own size, so a 1-unit holder still runs a whole worker —
   which is why the grant alone never bounded memory: up to `B` = 9 holders
   could each run one, and on 2026-10-14 two to four overlapped on a swapping
   host, each burning 718–2211 CPU-s on a 99.9 %-warm program (29–162 alone).
   Step 1 is the bound; this is the CPU accounting.
3. **The lane's scheduling tier.** `background` → `taskpolicy -b`;
   `interactive` → the holder's own tier, which `withHostGrant` lifted out of
   darwinbg for the grant's lifetime (an agent session is darwinbg as a whole,
   so without that a push's lock-holding worker ran on the E-cores). Never the
   branch: a push checks the rebased agent branch and is interactive.

Design and the simulation behind the sizes:
`research/2026-10-15-global-push-typecheck-lane-priority-and-cap.md`; the
original fleet-thrash bound: `research/2026-07-09-global-type-check-worker-host-budget.md`.

## The program is skipped when it is unchanged

An outer-cache MISS used to rebuild the program even when the edit could not
change what it contains. So `check/program-key.ts` gives the program a content
key, and a program whose key is already recorded green runs no worker.

The key is not the import graph. The import graph has blind spots (`*.generated.ts`
are excluded from it yet are tsc roots; `/// <reference>`, computed `import()`,
resolution shadowing), which are harmless only while tsc re-runs as the backstop
— and a skip removes that backstop. So the key is built from what TypeScript
itself loaded: `fileNames` out of the `.tsbuildinfo` (`L`), each file hashed by
content, repo and `node_modules` alike; plus the tsconfig's own
include-expansion (`R`), every `tsconfig*.json` / `package.json` / lockfile /
ambient `.d.ts`, a name-only census of every `.ts` in the repo (the
added-file-shadows-a-resolution hazard), and this check's own source.

Three orderings are load-bearing:

- The key is computed **after `materializeWarmBase`**, so a fresh worktree can
  enumerate the program from a sibling's base and skip on its very first run.
- The skip clause is read **after `lintFiles` is built**: a run with files still
  to lint is never skipped, so an evicted lint result re-runs the worker. That
  clause is also what lets the tsc key drop the lint-only globals
  (`eslint.config.ts`, `plugins/**/lint/**`): a lint-rule edit makes its group
  stale for every file, so the lint list is non-empty and nothing skips. An
  exemption edit stales nothing, and needs no worker: `finalize` re-assembles
  the verdict from the store either way.
- A PASS is recorded from the buildinfo the worker just **wrote**, so what is
  recorded describes the program that actually passed.

No buildinfo, an unparseable tsconfig, or a buildinfo shape we do not recognise
means **no key**, which means a cold run — never a key over an empty program.
Those are distinct arms of a discriminated result, not one nullish value, and
the run says WHY it could not key (`type-check: no program key — no buildinfo
yet`): "running" with no account of why there was nothing to compare against is
the shape of a report that hides a broken key.

The store is `programPassDir` (host-global, content-addressed, 14-day age
bound), a sibling of the lint result store over the shared `check/pass-set.ts`.

`--no-cache` (and `SINGULARITY_CHECK_NO_CACHE=1`) disarms the skip, via
`ctx.cacheEnabled`: someone typing it wants the program actually rebuilt. It
does NOT disarm the RECORD — the pass that run produces is still a good fact.
The per-file lint result store is unaffected either way.

**What the single program costs, stated plainly.** Any edit anywhere now runs
the one worker, whose identical-tree floor is ~45 CPU-s / ~2.7 GB (the parse;
tsc's own incremental engine then re-checks only the affected closure, thanks to
the real signatures). Before, an edit confined to one target ran only that
worker — a `tools`-only edit cost 22 CPU-s / 1 GB. That is the price of not
paying 3.7× on every other kind of edit. The unchanged-tree case still skips
everything.

## Which base a fresh worktree starts from

Every run picks an incremental `.tsbuildinfo` to start from, out of a
host-global pool every worktree publishes into (`checks/core/warm-base.ts`).
That choice is worth about 2 GB and 30 s against 7 GB and 240 s, and nothing
downstream catches a bad one — a mismatched base is not wrong, only slow.

The pool is partitioned by (typescript version, program name), so the seven old
partitions are simply unused after this change and age out in 14 days; the
`repo` partition's first entry is published by the first run after merge, and
every fresh worktree seeds from it thereafter. Each EXISTING worktree pays one
cold run (~7–10 GB, 100–300 CPU-s) the first time it checks after rebasing.

The pool used to hand out its NEWEST entry, which is always some sibling
branch: measured, seeding from it cost the same as starting cold, and 75 % of
`web-core` runs host-wide were near-cold. So a base is now chosen by **content
overlap**. Each candidate records a `version` per file (tsc's sha256 of the
file's text); the run hashes the files on disk and counts how many still match.
The highest count wins, ties go to the newer entry, and a local base already
present is replaced only by a strictly better one — so a worktree iterating in
place always keeps its own, while a just-rebased one picks up the pool's newer
main base.

Counts, not ratios: the score is "files tsc will not re-check", so a small
program matching perfectly must not beat a large one matching 99 % of ten times
as many files.

Two things make that work, and both are easy to get wrong:

- **A candidate is scored as if it already sat at this worktree's
  `.cache/tsbuildinfo/`.** A buildinfo's paths are relative to its own
  directory, so resolving a pooled entry against the pool directory gives paths
  that exist nowhere — every candidate scores zero and the pool silently looks
  empty. `readProgramFileList` takes the destination base explicitly for this.
- **The entry worth picking has to still be there.** A published base is
  labelled with its worktree's `HEAD` sha (`<ms>-<pid>-<sha12>.tsbuildinfo`),
  and the prune keeps the newest three plus up to six further entries whose sha
  is an ancestor of `main`. A fresh worktree's tree IS a main commit's tree, and
  the agent whose branch tip became that commit published exactly that base —
  which pure recency evicted within minutes. `main` is only fast-forwarded, so
  "is on main" never flips back.

`HEAD` is read in `finalize`, and only when there is something to publish. When
it is unavailable the run publishes a legacy unlabelled entry — still usable as
a base, never protectable — and says so on its summary line rather than
swallowing it.

The file hashes this needs are the ones the program key needs anyway: `prepare.ts`
creates one `ContentHashMemo` before the selection and hands the same memo to
`openProgramKeyContext`, so each file is read once and both steps necessarily
saw the same tree.

The pool has exactly ONE producer of a buildinfo: `shared/worker.ts`, spawned
through `core/spawnTypeCheckWorker`. The build's `--skip-checks` fast path
(`cli/plugins/build/cli/internal/app-artifacts.ts`) used to run its own
`tsc --noEmit` and publish the result into the same pool — a base whose every
signature is a placeholder, which makes a body-only hub edit re-check its whole
importer closure for whoever picks it up. It now spawns the same worker with no
lint files, at the same grant weight, so the compiler options and the
declaration emit live in one place and the two producers cannot drift.

## One reading of the tree, passed around

`readTreeListing(root)` takes one git-backed reading of the repo per run, and everything that asks
what files exist takes that value: the lint universe, the outer read-set's trigger facts, the lint
rule groups' engine, and both halves of the program key. It used to be four independent
filesystem walks — seconds of traversal, measured, and four copies of the rules for what to skip
(`node_modules`, `dist`, `.check-*`, `.claude/worktrees`), which is also how they came to disagree
with the cache key. Now there are no rules to copy: `.gitignore` is the rule.

It is a value rather than a cache behind the function on purpose. A listing is a snapshot of a tree
that keeps changing, so its staleness window belongs at the call site; as a module-level memo the
window was silently "the rest of the process".

**One exception, in `program-key.ts`.** The per-composition registries
(`web.composition.<name>.generated.ts`) are gitignored yet sit inside the tsconfig `include`, so tsc
compiles them — and two exist on `main`. A git-derived listing drops them, which silently removed them
from the name census that guards against resolution shadowing; since that key decides whether tsc runs
at all, nothing behind it would catch the miss. The census unions them back in via
`listNamedCompositionRegistries` — the codegen function that WRITES them, so reader and writer cannot
drift about where they live.

`no-adhoc-repo-walk` (lint) bans the hand-written directory deny-list shape, so the next copy cannot
appear.

A BUILD will skip less often than a bare check of the same tree, by construction:
`./singularity build` regenerates barrel stubs and plugin registries before it runs checks, and those
generated files are in the program.

## Reading the transcript

`~/.singularity/worktrees/<wt>/check-<runId>.log` carries a handful of greppable
lines per run, and they are the instrument every claim about this check is made on:

- `type-check: program unchanged since last pass, skipped (program keys <ms>ms)`
  or `type-check: program changed, running (program keys <ms>ms)` — whether the
  key hit, and what computing it cost. One or the other on EVERY run: the
  "running" half is what separates a cold tree from a broken key.
- `type-check: no program key — <why>` — only when the program could not be
  keyed at all.
- `type-check: lint 412/11455 files (61 whole, 351 partial; 99 groups, engine
  27 files) — stale: ui/plugins/icons 351, (base) 12` — every run: how many
  files the worker lints, how many whole (every group stale, or a directive
  file) vs only some groups, and the groups with the most stale files. The
  instrument for "did that rule edit cost its group or the repo".
- `type-check worker repo: cpu 186.6s (sys 12.0s), maxRSS 7.2 GB, slot wait 3.1s`
  — only when the worker RAN (a skipped run has no line, by construction). These
  are the numbers `TYPE_CHECK_WORKER_UNITS` is measured from, so a grep over many
  runs is how the weight gets re-derived. A large `sys` share is the host's
  memory pressure, not this program's work; `slot wait` is what the
  `type-check-worker` cap cost this run.
- `type-check worker repo: lane interactive, priority foreground` — when the
  worker is about to run: the grant's lane and the tier it gets (`background
  (taskpolicy -b)`, `background (inherited)` from a darwinbg holder, or
  `foreground`), read from this process itself. `interactive` with
  `background (inherited)` means the holder failed to leave darwinbg — a bug.
- `type-check: warm base repo: …` — every run, saying which incremental base it
  started from and how much of it still matches: `seeded 6701/6858 from pool
  <entry>` (cold worktree, took a pooled base), `pool <entry> matched 6701/6858
  files (local 5120, replaced)` (a pooled base beat the local one), `kept local
  6799/6858 (best pool 6701)` (the local base won), or `cold, pool empty`. A
  `seeded`/`kept` count far below the denominator is the signal that the pool
  holds nothing that fits.
- `type-check: published 1 warm base labelled <sha12>` — after the worker.
  `UNLABELLED (git: <reason>)` instead when `HEAD` could not be read; a
  parenthetical `(kept N, M on main)` when the prune protected entries.
- `type-check: prepared off-thread in 71.3s (finalize 2.1s)` — once per run:
  the preparation thread's cost before and after the worker (the work that
  used to freeze the runner; most of it is `parseProgramRoots`' include
  expansion). A coverage-gate failure says `(finalize skipped: coverage gate
  failed)`.

**Use `cpu`, not wall clock.** The identical program build measured 105s at host
load 12.8 and 266s at load 14.0; wall clock on this box measures the neighbours.
The same rule bites one level up: a per-check duration from a parallel check pass
measures the queue, so any per-check cost claim needs `./singularity check --jobs 1`.

## Invariants / caveats

- **Every file is checked exactly once, and linted exactly once.** That is the
  whole point of the single program. There is no ownership assignment left in
  `prepare.ts` — it was `web-core`-first so shared `core`/`shared` files linted
  under the program projectService would pick, and with one program there is
  nothing to pick.
- The flat config comes from the shared builder
  `@plugins/framework/plugins/tooling/plugins/lint/core` (`buildLintConfig`),
  the same one the root `eslint.config.ts` uses — editor and check can't drift.
- Warm paths: tsc is incremental via `.cache/tsbuildinfo/repo.tsbuildinfo`,
  and the worker EMITS declarations to a writer that keeps only the buildinfo,
  so every file in it carries a real signature (the hash of its public shape).
  That is what lets tsc skip the importers of a file whose body changed but
  whose API did not — under `noEmit` the signature is a placeholder and a
  body edit in a hub re-checks its whole importer closure (measured 4.4× the
  CPU and 3× the RAM of the same edit with real signatures). The price is that
  every exported value must have a nameable type: a `TS2883` / `TS4023`
  declaration diagnostic is a real error here, fixed by an annotation;
  lint reuses the per-group result store (only stale groups re-lint); and
  an unchanged PROGRAM runs no worker at all (above). A worker that crashes
  records no results (re-lints next run) and yields no lint verdict.
- **An editor loads this one ~11k-file project for any file**, where a
  server-only session used to load ~5.4k. Web sessions already loaded 9.8k.
- A new lintable file outside `plugins/`, `test/` and the root `*.config.ts`
  fails the coverage gate. Since the universe is git-derived, such a file is
  genuinely repo source: move it under `plugins/` where it belongs, or — if it
  really is a new top-level source tree — add it to the root tsconfig `include`.
  If it is not source, it does not belong in the git tree: delete it or gitignore
  it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: spawnTypeCheckWorker: the one way to start a repo-program type-check worker — admitted through the laned host-wide type-check-worker pool (background may hold one slot, the interactive lane the other) and the holder's grant, demoted only for a background-lane holder.
- Server:
  - Uses: `infra/host/host-admission.defineHostPool`
  - Exports (types): `TypeCheckWorkerRun`
  - Exports (values): `spawnTypeCheckWorker`
- Core:
  - Uses: `infra/host/host-admission.PER_UNIT_BYTES`
  - Exports (types):
    - `LintFileJob`
    - `LintFileResult`
    - `RawLintMessage`
    - `TypeCheckWorkerJob`
    - `TypeCheckWorkerResult`
  - Exports (values):
    - `LINT_GROUP_ALL`
    - `LINT_GROUP_BASE`
    - `TYPE_CHECK_WORKER_PEAK_BYTES`
    - `TYPE_CHECK_WORKER_UNITS`

<!-- AUTOGENERATED:END -->
