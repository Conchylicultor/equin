# type-check

The unified TypeScript + type-aware-ESLint check. It replaces the separate
`typescript` and `eslint` checks, which each built the full TS program (tsc for
diagnostics; typescript-eslint via `projectService` for the type-aware rules).
Type-aware linting is ~99% TS-program construction — the same work tsc does — so
the cold cost was paid twice. This check type-checks the repo in one worker
process, in **at most two programs per run, sized by what changed** (below), and
runs type-aware lint inside those programs, via typescript-eslint's
`parserOptions.programs`.

## One program, and why there is no target list

There is exactly ONE TypeScript project: the root `tsconfig.json`, whose
`include` is `["plugins", "test", "*.config.ts"]` — every `.ts`/`.tsx` git
tracks. `checks/core/discover.ts` names it (`repoProgram(root)`) and there is
nothing to iterate. (A run's two programs are views of that one project — the
files to check as source, the rest as their stored `.d.ts` — not targets.)

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
  import graph + content hashes, parses the tsconfig's include-expansion, runs
  the coverage gate (replaces projectService's "every file resolves to a
  project"), and reads the lint result store: every lintable file goes to the
  worker with its stale syntactic groups and its typed parts to decide (only
  the worker knows each file's result key). After the worker, `finalize`
  records the fresh lint results and assembles the lint verdict under the
  current exemptions.
- `shared/worker.ts` — the worker **process**. The **two-program check**
  (`shared/name-run.ts`, below): tsc diagnostics for the files with no valid
  stored result, and every file's result key → ESLint `Linter.verify`: each
  file's typed parts whose key moved, inside the program holding the file as
  source; its stale syntactic groups with no program; the messages raw. A
  separate process so the single-threaded TS work runs on its own core and its
  peak RSS is measurable from outside.

**Nothing that reads file bytes or walks the tree goes in `index.ts`** — it goes
in `prepare.ts`, whose values only the worker imports. That work is 70–130 s of
synchronous CPU; on the runner's thread it froze every concurrent check (no
timer, no socket), so `migration-applies-clean`'s pg connect sat silent past
Postgres's 60 s `authentication_timeout` and failed with `ECONNREFUSED`
(`research/2026-09-10-tooling-type-check-prepare-off-thread.md`).

A thread, not a helper process, because the session must survive the worker:
the record phase reuses the prepare phase's lint entries and content hashes,
which a process would have to serialize.

New files go FLAT in `shared/`: the engine (`tscEngineFp`, and lint's typed
engine) is every top-level non-test `.ts` there (`engineSources()`), listed
from the directory — a subdirectory would silently fall out of every key.

## The file universe comes from git, and is enumerated once

`run()` takes ONE `readTreeListing(root)` — a `TreeListing` whose files come
from `listRepoFiles` (`checks/core`) — and hands that value to every consumer:
`buildImportGraphs` (preparation thread) and `recordOuterReadSet` (runner
thread) both filter it with `lintableFiles`, so the recorded set is the linted
set; `findGlobalTriggerFiles` with `isGlobalTrigger`. The listing crosses to
the thread as a value, so it never re-lists. Nothing below the listing
enumerates: `import-graph.ts` and `fingerprint.ts` only read the bytes of files
handed to them, which is why they stay synchronous. (The worker's type check
takes its roots from the tsconfig's own expansion and keys resolutions on the
real filesystem — below — because that is what tsc reads.)

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
noise for one broken JSON file. The `unparsed` arm skips the gate and lets the
worker run, where tsc reports the broken config as the one diagnostic it is.

## Two programs sized by changed names

`shared/name-run.ts`. A run builds **at most two programs, both sized before
they are built**, against a host-wide per-file store — never the whole repo
(unless everything changed):

1. **Program 1:** the files with no valid stored result, as source; every other
   repo source file is served as its stored `.d.ts`, a virtual `x.d.ts` beside
   `x.ts` so its own imports resolve from there (`shared/name-host.ts`).
2. **The affected set, with no TypeScript** (`shared/name-walk.ts`): the files
   whose key moved once program 1's records are known, plus every file using a
   name that can move.
3. **Program 2:** the affected set as source (plus files whose typed lint must
   run and no program holds), the rest as stored `.d.ts`.

A body edit is program 1 alone (program 2 empty). A global change — a
`declare global`, a module augmentation, any repo `.d.ts`, the engine — misses
every key, so program 1 is the whole tree: one program.

**Keys, name by name.** Each exported name's record (`shared/name-records.ts`)
is its canonical `.d.ts` text hash `t` and its **name-use edges** `d` (what that
text references: an import binding, an `import("./e").T`, another export of the
file — first hop; a barrel's name is an alias edge to the next). Its meaning:

    M(F#n) = H( t, M of each d-edge target )      (a cycle of names: one hash)
    R(F)   = H( global, F's path and version, (use, M(use)) of every name F's source uses )

`global` is the engine (`tscEngineFp`: compiler, options, lockfile, patches,
`engineSources()`), every global source file's version and every repo `.d.ts`'s.
A stored result of F is valid iff its R is today's — what F's check reads is
its text, the `.d.ts` of what it imports and everything those name, and the
global scope: exactly what R hashes. So `f(r: PluginRegistry)`, whose text does
not move when `PluginRegistry` does, moves through its d-edge, and so does
every user of `f`.

Inside an import cycle (the `check/` registries, the lint rules, the exhibits:
100–175 files each) a member's key needs its cycle-mates' names, whose records
depend on which of their variants is valid, so a cycle SETTLES: each member
starts on its newest variant, the names are hashed, each member keyed, the
variant valid under its key kept, the misses demoted — until nothing changes.
Keys stay per file: a body edit inside a cycle checks the file, not the cycle
(step 1c re-checked the whole cycle).

**Inference edges** (`shared/name-check.ts`) predict, not key: when a file is
checked, each export's declaration is walked (minus bodies and initializers a
written type makes irrelevant, minus JSX elements, whose type is `JSX.Element`
whatever they render) and every identifier resolved — an import binding is an
edge to the name it imports. `export const x = foo()` prints `foo`'s return
type; an edit of `foo` changes `x`'s `.d.ts` while `x`'s file is unchanged. A
re-checked file's names reachable (over d ∪ i edges of its previous result)
from a target whose meaning differs from what that result was made against are
⊥; everything using a ⊥ name joins program 2. "Made against" is `depM` for a
stored result; for one program 1 just made, it is what program 1 was served —
a re-checked file counts as served its previous result (its non-⊥ names stand),
and a file served a `.d.ts` it no longer has counts as moved. A program-1 file
that read such a stale `.d.ts` joins program 2 itself. The prediction runs
inside the settling loop, so a cycle-mate keys against its mates' ⊥ names, not
their stand-in previous meanings. After program 2, every name predicted stable
is compared. One that moved is a MISS (the affected set missed what uses it),
handled per the job's `onMiss`: a check or build run (`whole`) discards the
attempt, checks every file in one program over the store read as empty
(rewriting it), so its verdict is right, and `spawnTypeCheckWorker` files each
miss as a `type-check-divergence` report (kind `prediction`: file, name,
commit; `server/internal/miss-reports.ts`) plus a `PREDICTION MISSED`
transcript line. Throwing there would fail every later run alike — a failed
run records nothing. The backstop, `scripts/dual-check.ts` and the tests
(`throw`) fail on it: a miss is what they look for.

**The store** (`shared/name-store.ts`) is host-wide and content-addressed, one
entry per file TEXT — `type-check-name-records`, key H(path, version): the
file's imports, its resolution record, whether it is global, and up to four
recent results (diagnostics, signature, raw `.d.ts` hash, per-name records,
`depM`), each under its R; `type-check-contracts`: raw `.d.ts` texts by hash,
plus the program-level diagnostics per global hash. A fresh worktree on a main
tree reads main's entries; a run writes only what it checked. Entries in use
are rewritten after 3 days so the 14-day age bound means "unused".

**Resolutions** (`shared/name-resolve.ts`) are keyed on what they PROBED: the
real `readdir` listing (names only) of every repo directory a lookup consulted —
a directory that does not exist counts its nearest existing ancestor, so
creating it moves the key — and the content of every repo file read (a
`package.json`). While the key holds the targets stand with no TypeScript call;
when it moves, that file's specifiers are resolved again, and a moved target
puts the file in program 1. An untracked file shadows like a tracked one.

**Generated registries need nothing special.** The unit design needed
`isolatedDeclarations`-clean `*.generated.ts` (contract-first) to break the
registry cycles; here nothing waits for another file's contract — each program
holds all its sources at once, a cycle settles like any file (above), and a
cold run is one program.

- **Soundness** is validated, not assumed. `dual` mode (`TscMode`) runs the
  check, then a full check of a FRESH whole program with TypeScript's own host
  (`shared/full-check.ts`), and compares every file's diagnostics and
  signature; on any divergence a cold run rewrites the store.
  `scripts/dual-check.ts` runs it by hand (`--mode keyed` for the check alone);
  the `backstop` sub-plugin runs it daily on main and files a
  `type-check-divergence` report per divergent file.
- Importers are served the RAW `.d.ts`, not the canonical one: served sorted,
  it changes how tsc prints a type in an importer's diagnostics (measured).
- A `.d.ts`'s text depends on its context, so its CANONICAL form is what is
  hashed (`canonicalDeclarations`): type-literal properties and union members
  sorted, and a type named through an import binding spelled as the import
  type (`Rank` ≡ `import("s").Rank` — emit copies the second from a served
  `.d.ts` and prints the first when it infers from source; found replaying
  main's abd05b5fe7).
- Requires `skipLibCheck` (declaration inputs are never checked) and throws
  without it.

Design: `research/2026-10-21-global-type-check-two-programs.md` (prototype:
`…-2026-10-19-…-shadow-v2.md`; step 1c, which this replaced:
`research/2026-10-18-global-tsc-recheck-follows-contracts.md`).

## The lint cache is keyed on what the rules read, and exemptions apply when it is read

A rule reads the file's own text and, if it is **type-aware** (declares
`meta.docs.requiresTypeChecking`, `isTypeAwareRule` in `lint/core`; a dozen
rules), the checker's types for it — a function of the *declarations* the file
can see, never of another file's source. So a file's result is stored per
**(file, content hash)** (`check/lint-results.ts`, `type-check-lint-results-v2`)
in parts, each under its own key:

| Part | Key | Re-linted when |
| --- | --- | --- |
| each syntactic group (base + one per contribution) | the group's fp | the file's text, or that group's rules/engine |
| each typed part — the type-aware rules of one group that has any (`(types) <group>`) | `typedResultKey(typed group fp, result key)` | the text, a declaration it can name, or that group's type-aware rules |
| a directive file, whole (`LINT_GROUP_ALL`) | `typedResultKey(all fp, result key)` | any of the above |

It used to be keyed on the source of the file's whole import closure, so a
body-only edit in a hub re-linted every transitive importer: a median of 470
files per main commit, p90 6,218. Design:
`research/2026-10-17-global-lint-keyed-on-what-it-reads.md`, the per-group
typed parts `research/2026-10-18-global-typed-lint-key-stops-at-contracts.md`,
and the result key that replaced the type fingerprint
`research/2026-10-21-global-type-check-two-programs.md`.

**The rules half** (`check/lint-groups.ts`) — one fingerprint per GROUP, each
folding in the **engine**: the config builder's import closure
(`LINT_CONFIG_SOURCE`, generated registries not followed), `shared/worker.ts`,
the root tsconfigs and `package.json`,
ambient `.d.ts`, `patches/**`, the lockfile **minus its workspace entries**
(`lockfileLintDigest`), and the declared `@utility` set (`lintDataKey`). The
**base** group is the builder's own rules (typescript-eslint, react-hooks,
eslint core); each **contribution** (`lintContributionPaths()`) is the import
closure of `plugins/<p>/lint/index.ts`, stopping at engine files (a rule's
`*.test.ts` is not in it; a helper it imports from outside `lint/` is). Each
group that holds a type-aware rule (`typeAwareLintGroups`, loaded in prepare
through the same classifier) has a **typed group fp** (`typedGroupFps`): its
group fp plus the **typed engine** — the type check's `engineSources()`, which
only parts that read types depend on. So a syntactic-only rule edit stales no
typed part, one type-aware rule edit stales its group's typed part only, and
editing the type check's code re-runs no syntactic result. A file whose result
key moved runs all its stale typed parts in ONE pass, in its program.

**The types half** — the file's **result key** R(F) (`shared/name-walk.ts`,
above): what the checker can tell a rule about the file is a function of its
text, the `.d.ts` of what it imports and of every name those name, and the
global scope — what its tsc result is keyed on. One key decides both. It
replaced the step 1b/1c type fingerprint, a Merkle hash over the FILE-level
contract graph: R is name-level, so an API change moves the files using the
names that moved, not every importer of the file.

**Only the worker knows R.** So prepare sends EVERY lintable file, its stale
syntactic groups and its typed parts with the few keys stored for each
(`known`); the worker computes `typedResultKey(fp, R)` per part and runs the
ones not among them — in the program that holds the file as source (program 1
or 2; a file whose typed part is stale while its tsc result is valid — a
type-aware rule edit, an evicted result — joins program 2 as a source to be
linted). The worker always runs: an unchanged tree costs its walk; the outer
read-set replay skips the whole check before prepare runs at all.

Running a syntactic group without a program (`typeSource: { none: true }`) is
the enforcement: a type-aware rule that forgot to declare itself throws in
`getParserServices` instead of caching an answer that read types (and
`rule-kind-safety/type-aware-rule-declared` catches a lazily reached one).
Null-id messages (parse failures) belong to the syntactic base part; the typed
pass drops them.

`check/lint-verdict.ts` assembles every file's messages — stored or fresh —
under the CURRENT exemptions, so an exemption edit re-lints nothing, and an
unused file-level exemption is reported for every file.

**A file with an eslint directive is one unit** (~4 % of files): whether a
disable directive is unused depends on every rule, so it is re-linted whole
whenever any rule or its result key changes.

What a change costs: a body-only edit — the file itself; an exported-type
change — the file plus the typed parts of the files using the names that moved
(and of what uses theirs, while it moves); a workspace-only lockfile, an
exemption, or an app.css token edit — nothing; one syntactic rule — that group
on every file (directive files whole); one type-aware rule — that group's typed
part on every file, in one program 2 over the whole tree; the type check's code
— every typed part; the lint core, a tsconfig, a `.d.ts`, a real dependency
bump — everything.

Each entry keeps a few keys per part, most recently USED first: a key a run
reused moves up beside the fresh ones, so two
worktrees on two versions of a hub keep each other's results. `finalize`
writes an entry only when that order changes.

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
3. **The foreground, as the slot's holder — in either lane.** The pool is
   `holder: "foreground"`, and the worker is spawned through the held slot
   (`slot.spawn`), which starts it out of darwinbg even from a darwinbg agent
   session and has no spelling for demoting it. The lane picks only the slot
   window (background's stays 1, so at most 2 foreground workers exist), never
   the tier: a background holder used to run `taskpolicy -b` on the E-cores,
   and the whole fleet waited out its stretched hold (slot wait median
   13.5 min, p90 38 min on 2026-10-15). Never the branch: a push checks the
   rebased agent branch and is interactive.

Design and the simulation behind the sizes:
`research/2026-10-15-global-push-typecheck-lane-priority-and-cap.md`; the
foreground holder: `research/2026-10-16-global-scarce-slot-holders-run-foreground.md`; the
original fleet-thrash bound: `research/2026-07-09-global-type-check-worker-host-budget.md`.

## There is no program key

Step 1c skipped the worker when a content key over the whole program (a
manifest of every file it loaded) was recorded green, and recorded a
signature table per program to decide typed lint in prepare. Both are gone with
the whole program: the per-file store answers both questions, in the worker,
and its stores are declared retired (`type-check-programs`,
`type-check-type-fps`, `type-check-file-results`; the manifest under
`.cache/type-check/` is no longer written).

`--no-cache` (and `SINGULARITY_CHECK_NO_CACHE=1`) still disarms the OUTER
cache (the runner's read-set replay); the per-file stores are content-addressed
facts and are used either way. To force a full re-check, run
`scripts/dual-check.ts`.

## One reading of the tree, passed around

`readTreeListing(root)` takes one git-backed reading of the repo per run, and everything that asks
what files exist takes that value: the lint universe, the outer read-set's trigger facts, and the
lint rule groups' engine. It used to be four independent
filesystem walks — seconds of traversal, measured, and four copies of the rules for what to skip
(`node_modules`, `dist`, `.check-*`, `.claude/worktrees`), which is also how they came to disagree
with the cache key. Now there are no rules to copy: `.gitignore` is the rule.

It is a value rather than a cache behind the function on purpose. A listing is a snapshot of a tree
that keeps changing, so its staleness window belongs at the call site; as a module-level memo the
window was silently "the rest of the process".

The per-composition registries (`web.composition.<name>.generated.ts`) are gitignored yet sit
inside the tsconfig `include`, so tsc compiles them. The worker takes its roots from the tsconfig's
own (filesystem) expansion and keys resolutions on real directory listings, so they are covered there
like any file.

`no-adhoc-repo-walk` (lint) bans the hand-written directory deny-list shape, so the next copy cannot
appear.

A BUILD will skip less often than a bare check of the same tree, by construction:
`./singularity build` regenerates barrel stubs and plugin registries before it runs checks, and those
generated files are in the program.

## Reading the transcript

`~/.singularity/worktrees/<wt>/check-<runId>.log` carries a handful of greppable
lines per run, and they are the instrument every claim about this check is made on:

- `type-check: lint 412/11455 files (61 whole, 351 partial; syntactic 20,
  typed 400; 99 groups, engine 28 files) — stale: (types) (base) 392,
  ui/plugins/icons 12` — every run, AFTER the worker: how many files the worker
  actually linted, how many whole (every part stale, or a directive file) vs
  only some parts, how many ran syntactic rules and how many typed ones, and
  the parts with the most stale files (`(types) <group>` is a typed part). The
  instrument for "did that edit cost its group, its importers, or the repo".
- `type-check worker repo: cpu 186.6s (sys 12.0s), wall 95.2s, maxRSS 7.2 GB, slot wait 3.1s`
  — every run. These are the numbers `TYPE_CHECK_WORKER_UNITS` is measured from, so a grep over many
  runs is how the weight gets re-derived. A large `sys` share is the host's
  memory pressure, not this program's work; `wall` is the slot's hold time
  (every queued worker waits it out); `slot wait` is what the
  `type-check-worker` cap cost this run.
- `type-check worker repo phases: type check 30.2s, lint 20.5s (cpu)` —
  beside the cost line: where the worker's CPU went (its own clock, so process
  start-up is left out): the type check (the walk, both programs' build, the
  files they check) and lint.
- `type-check worker repo programs: 1: 3 sources (3 checked) + 412 .d.ts, 2: 41
  sources (40 checked) + 3310 .d.ts; 43 checked of 12369; linted typed 41,
  syntactic 3` — what each program held: the instrument for "did that edit cost
  the file, the users of its names, or the repo".
- `type-check: walk: 12369 files, 3 without a valid result, 120 pending, 40
  re-checked (2 key moved, 38 use a name that may move, 0 after a stale
  .d.ts), 1 only linted; resolutions 0 moved, 2 re-keyed; versions …ms, reads …ms (12369), listings …ms, walk …ms, write
  …ms` and `type-check: program 1: …` / `program 2: …` (sources, served `.d.ts`,
  repo decls, env; build, check and record wall ms) — the walk's own cost and
  each program's.
- `type-check worker repo: lane background, priority foreground (slot holder)` —
  when the worker is about to run: the grant's lane (which slot window it
  queued in) and its tier — always the foreground as the slot's holder, or
  `unknown (<reason>)` on a host with no darwinbg tier.
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

- **Every file is checked against exactly one project.** There is no
  ownership assignment in `prepare.ts` — it was `web-core`-first so shared
  `core`/`shared` files linted under the program projectService would pick,
  and with one project there is nothing to pick. Within a run a file is checked
  at most twice (program 1, then program 2 when a `.d.ts` it was served turned
  out stale) and linted once, in the last program holding it.
- The flat config comes from the shared builder
  `@plugins/framework/plugins/tooling/plugins/lint/core` (`buildLintConfig`),
  the same one the root `eslint.config.ts` uses — editor and check can't drift.
- Warm paths: tsc checks only the files with no valid stored result and what
  their changed names reach (`shared/name-run.ts`), and every checked file's
  `.d.ts` is emitted, its canonical text per name being what keys its users.
  That is what lets a body edit stop at the file. The price is that every
  exported value must have a nameable type: a `TS2883` / `TS4023` declaration
  diagnostic is a real error here, fixed by an annotation; lint reuses the
  per-part result store (only stale parts re-lint, keyed on the same result
  key). A worker that crashes records no lint results (re-lints next run) and
  yields no lint verdict; one whose affected set missed a name (a predicted
  stable name moved in program 2) pays a cold check and files a report.
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
    - `ProgramSize`
    - `RawLintMessage`
    - `TscDivergence`
    - `TscMode`
    - `TscPredictionMiss`
    - `TypeCheckDivergencePayload`
    - `TypeCheckStats`
    - `TypeCheckWorkerJob`
    - `TypeCheckWorkerResult`
    - `TypedDecision`
    - `TypedPartFp`
    - `TypedPartOutcome`
    - `TypedParts`
  - Exports (values):
    - `LINT_GROUP_ALL`
    - `LINT_GROUP_BASE`
    - `TYPE_CHECK_DIVERGENCE_KIND`
    - `TYPE_CHECK_WORKER_PEAK_BYTES`
    - `TYPE_CHECK_WORKER_UNITS`
    - `TypeCheckDivergencePayloadSchema`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
  - Imported by: `framework/tooling/checks/type-check/backstop`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/spawn-worker.ts`, `shared/full-check.ts`, `shared/keys.ts`, `shared/lockfile.ts`, `shared/name-check.ts`, `shared/name-host.ts`, `shared/name-records.ts`, `shared/name-resolve.ts`, `shared/name-run.ts`, `shared/name-store.ts`, `shared/name-walk.ts`, `shared/pass-set.ts`, `shared/tsc-engine.ts`, `shared/worker.ts` (debt)
- Sub-plugins:
  - **`backstop`** — The two-program type check's backstop: a daily main-only job runs the type-check worker in dual mode (the two-program check beside a full check of a fresh whole program, compared file by file) and…

<!-- AUTOGENERATED:END -->
