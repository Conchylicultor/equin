# Type-check worker memory: where a 5–6 GB worker goes

Task: task-1794507804-t1rkzl (D2 host memory overload, supervisor block-ac0877bd).
It follows task-1794505131-05sye5, which fixed the check process.

## Result

A heavy worker's peak comes from what one TypeScript program holds while it
is checked and typed-linted: ASTs, the checker's types, and the walk state.
JSC heap pacing roughly doubles that. Nothing outlives its use in a way that
raises the peak.

The heavy runs fall into three classes. One of them is avoidable: a
syntactic lint-rule edit pulls every file with an eslint directive (~470)
into program 2 as source, only to re-lint them whole with their types.

| one rules-move run, same tree, same `Check` type edit | program 2 | worker peak | worker CPU |
| --- | --- | --- | --- |
| a type edit only | 132 sources + 1,832 `.d.ts` | **2.0 GB** | 16 s |
| the same + a one-line edit of one syntactic rule | 598 sources (132 checked) + 4,187 `.d.ts` | **5.2 GB** (×4 runs: 5.2, 5.2, 5.3, 5.2) | 106–140 s |

So ~466 directive files cost +3.2 GB of peak and ~100 CPU-s per run. Only the
syntactic group's ~16k-file re-lint (~90 CPU-s, no program, flat memory) is
the rule edit's own cost.

Every heavy check transcript since heap pacing landed (2026-11-09; n = 1,092
runs, 121 at ≥ 4 GB):

| class | runs ≥ 4 GB | mean peak | avoidable |
| --- | --- | --- | --- |
| in-process program, 500–2,000 checked sources | 49 | 5.08 GB | no: real checking |
| batched: cold, global change, typed re-lint of the tree | 39 | 5.57 GB | no: bounded by K (2026-11-08 doc) |
| **directive drag**: `(all) ≥ 300` in the lint line | 33 | 5.10 GB | **yes**: ~2 GB without it |

The task statement's 6.7–7.6 GB were measured with `/usr/bin/time -l`, which
reports the largest descendant: a batch process in a batched run. My cold
run, forced cold by a producer edit, peaked at 5.1 GB per batch. The
worker's own process stayed at 0.65 GB.

## The split

### A batch (cold run)

Replayed with `scripts/batch-memory-bench.ts`. Heap probes are `Bun.gc(true)` +
`heapStats()` at the phase boundaries. They were not committed.

| batch 6 of a cold run (2,000 sources) | live heap | RSS |
| --- | --- | --- |
| program built + checked + emitted | 2.18 GB | 3.23 GB |
| linted (typed + syntactic) | 2.44 GB | 4.16 GB |
| process peak | | 4.59 GB |

This is the TS program and its checker, bounded by K. Pacing and allocator
slack make the peak ~1.9× live. Both were measured and tuned in
`2026-11-08-global-type-check-bun-heap-pacing.md`. Nothing new here.

### The worker (incremental run with a rules move)

Replayed by running a copy of `shared/worker.ts` (kept outside the tree, under
`.cache/`) on a captured job file:

| point | live heap | of which |
| --- | --- | --- |
| before the walk | 0.07 GB | runtime, job |
| program 2 built (598 sources, 132 checked) | 1.19 GB | walk state + ASTs/binding |
| after `getSemanticDiagnostics` of the 598 | 2.15 GB | +0.96 GB: the checker's types (+760k closures) |
| after typed lint | ~2.3 GB | lint itself adds ~0.1 GB |
| end, program and walk dropped | 0.20 GB | the walk state was ~0.9 GB (full walk) |

RSS (1 s samples of a real run) reaches 5.1 GB 14 s in, during program 2's
check and typed lint. It stays at 5.2 GB for the rest of the run: the
~16k-file syntactic phase and the output.

So the checker's types for the 466 files that are only linted are the largest
avoidable part. Those types exist only because the typed rules of a whole
directive file need them.

## Why the directive files are in program 2

A file with an eslint directive is one lint unit (`LINT_GROUP_ALL`, ~4 % of
files): "an unused directive depends on every rule". Any rule change, even a
syntactic one, re-lints it whole, typed rules included. A whole re-lint
needs a program holding it as source, and that program needs the `.d.ts` of
everything it imports. So a one-line edit of a syntactic rule builds a
~600-source program.

The follow-up is filed: directive usedness depends only on the rules a
directive names. The design needs care: ESLint groups unused rules of one
directive into one message, and multi-rule directives, `eslint-enable`
pairing and blanket disables must all be handled. It also bumps the lint
store format.

**Fixed (2026-11-12, task-1794517407).** A directive file's typed parts are
now RAW (its rules' problems before the directives, warnings and suppressed
ones included), keyed and run like any typed part. Its verdict is combined
with no program: the real syntactic rules beside every type-aware rule
replayed from the raw parts (the config builder's `{ replayed }` type
source), so ESLint applies the directives itself. Parity: every real
directive file against one whole-file run (`scripts/directive-parity.ts`):
472 files, 405 verdict messages, 0 differ. The same scenario (a `Check` type
edit + a one-line edit of `no-global-declaration-in-source`, one run from a
base):

| | program 2 | worker peak | worker CPU |
| --- | --- | --- | --- |
| before | 598 sources (132 checked) + 4,187 `.d.ts` | 5.2 GB | 106–140 s |
| after | 132 sources (132 checked) + 1,835 `.d.ts` | 3.6 GB | 46 s |
| after, the rule edit alone | 131 sources (0 checked) | 3.2 GB | 39 s |

What is left above the type edit's 2.0 GB is the rule edit's own cost:
its group re-linted over all ~16.5k files with no program (35 CPU-s of
lint). Its ~3 GB of RSS is not split yet (live heap vs. heap pacing's
growth); filed as a follow-up.

**Split (2026-11-13, task-1794520941).** The rule edit alone, replayed on a
captured job, with heap probes and a heap snapshot at the start of the
syntactic phase:

| the worker, one-line edit of one syntactic rule | live heap | RSS |
| --- | --- | --- |
| job parsed | 0.13 GB (1.08 M strings: every file's ~65 typed keys) | 0.25 GB |
| after the walk (1 source + 90 `.d.ts` checked) | 0.48 GB | 0.66 GB |
| after the whole-tree syntactic re-lint | 0.58 GB | 1.7–2.5 GB peak |

- **CPU is the parse, not the rule.** Per 3,000 files: TS scan+parse ~1 s,
  ESTree conversion ~2 s, tokens ~1.2 s, scope analysis ~0.6 s, ESLint's per
  call overhead ~1 s (it re-normalizes a plain config array on every
  `verify`, ~0.2–0.3 ms a file). The rule's own listeners cost ~0. A rule
  edit must re-parse every file the rule runs on, and ESLint also parsed
  every file the rule is OFF for (test / e2e files, `outOfScope`
  categories: 3,379 of 16,562 for this rule, ~20% for nearly every group).
  Of 183 syntactic rules, only 9 narrow themselves to < 5% of files inside
  `create()`; most listen to node types every file has, so neither a
  node-type nor a self-scope skip would help in general.
- **Memory is GC headroom over what is live.** The same re-lint run alone
  (~50 MB live) peaks at ~0.45 GB; in the worker (~0.48 GB live) at
  2.2–2.5 GB. The live heap is the job (~0.13 GB of typed keys, sent for
  every file although no typed part moved), program 1 (~0.15 GB: JSC's
  compiled `createProgram` code — `processSourceFile`'s code block, a GC
  root — holds the program's closure scope after every reference of ours
  is gone), and the runtime's code and shapes. The walk state is NOT
  retained: freeing it in its own frame (and the typed-config cache by
  program) measured no change, so neither was shipped.

Fixed: a split file whose selected syntactic rules are all off by the
config is answered with no parse (`lint-engine.ts`, `anyRuleOn`, resolved by
`ESLint#calculateConfigForFile` in ~0.07 ms a file). Exact: a split file has
no directive and no inline config, so the config alone decides which rules
run. The whole-tree re-lint of the group: 70.8 → 48.3 CPU-s (same host,
same files, the HEAD engine against this one). Filed: the job's typed keys
on a rules-only move (task-1794569143).

## Tried and rejected: freeing programs and the walk earlier

Two lifetime bugs exist, but neither moves the peak:

- `shared/lint-engine.ts` caches each typed config in a plain `Map` for the
  worker's life, and each config holds `parserOptions.programs: [program]`.
  ESLint's `Linter` also keeps the last `SourceCode` it linted, and through it
  the program. So program 1 and program 2 stay alive to the end of the run.
- `run()` in `shared/worker.ts` keeps `out` / `written`, and with them the walk
  state (every base shard read), through the whole-tree syntactic phase. That
  phase needs only `out.keys`.

Fixed (a `WeakMap` per program with its own `Linter`, plus the type check in its
own scope): live heap during the syntactic phase fell from ~2.3 GB to ~0.2 GB.
Real-run peaks stayed the same: 5.1 and 5.4 GB against 5.2–5.3 GB. RSS also
stays at 5.2 GB through that phase, because JSC keeps the pages it grew into
during program 2. The change was not shipped. It would have moved every lint
fingerprint (`shared/worker.ts` is in the lint engine), costing the host a
whole-tree re-lint for no measured gain.

## How to measure a worker yourself

- **Capture a job file.** `spawnTypeCheckWorker` writes
  `/tmp/type-check-<name>-<pid>.json`, and the worker deletes it once read.
  Copy it while the worker runs, and keep a pristine copy: each replay
  consumes its own.
- **Run instrumented code from outside the tree.** Copy the plugin dir under
  `.cache/` (gitignored) and run `./equin run .cache/<copy>/shared/worker.ts
  <job copy>`. The job names its tree: what the run reads is that tree's
  blobs, whatever the disk holds. An instrumented copy kept beside them
  cannot be mistaken for the code under check.
- **Mind the walk namespace.** Changing any walk-engine file (every top-level
  `shared/*.ts` but the worker plumbing — `lint-engine.ts` included) refuses
  the job's walk base. The replay then does a FULL walk, which is a different
  run.
- **Probe with `Bun.gc(true)` + `heapStats()`.** Track a program's lifetime
  with a `WeakRef`. `ts.createProgram` cannot be patched (a read-only
  export), so register it where the lint hook receives it.
- **For peaks, sample RSS from outside**, at 1 s. In-process
  `memoryUsage().rss` at phase marks misses the transient peaks.

## The rule edit's remaining ~2 GB, split (2026-11-13, task-1794578922)

After the job stopped shipping every file's typed keys, a one-line edit of one
syntactic rule (`no-global-declaration-in-source`) still read **maxRSS
1.9–2.1 GB** with ~0.36 GB live at the start of the syntactic phase. Replayed on
a captured job (incremental walk, program 1: 1–2 sources + 90–104 `.d.ts` +
559 env), resident size and physical footprint sampled every 50 ms from
outside (`proc_pid_rusage`), heap probes (`Bun.gc(true)` + `heapStats()`) in a
copy of the worker:

| part of the ~1.8 GB maxRSS (replay) | size | what it is |
| --- | --- | --- |
| not charged by the kernel | ~0.55 GB | allocator pages already freed (`vmmap`: JSC/bmalloc `Memory Tag 240` resident 1.4 GB, dirty 0.94 GB) — counted in resident size until the kernel takes them back, never in the footprint |
| shared library text | ~0.1 GB | file-backed, shared |
| **physical footprint** | **1.11–1.17 GB** | JSC heap capacity ~1.0 GB + ~0.15 GB extra memory |
| of which live at the syntactic phase | 0.36 GB (0.42 at its end) | the program's scope (largest dominator), JIT code and structures, the job's decisions |

So **maxRSS over-states the worker by ~0.65 GB**; the footprint is what the
host pays. The footprint is heap pacing over what is live: JSC lets a heap of
H grow to (1 + 2·e^(−2H/4 GB))·H ≈ 2.6 × 0.4 GB ≈ 1.05 GB, the capacity
measured. One factor at a time:

| factor | footprint peak | worker CPU (replay, E-cores) |
| --- | --- | --- |
| pacing default (64 GB) | 1.42–1.61 GB | 90–113 s |
| **pacing 4 GB (current)** | **1.15–1.17 GB** | 82–112 s |
| pacing 2 GB | 1.21 GB | 100 s |
| pacing 1 GB | 1.03 GB | 130 s |
| typed engine and its configs dropped before the phase | 1.16 GB | — (program still alive) |
| a second `createProgram` before the phase | 1.25 GB | — (program still alive) |
| syntactic groups before the program, verdicts after | 1.01 GB | — |
| **syntactic groups and carried verdicts before the program** | **0.58 GB** | same |

- **Pacing is not the lever**: 4 GB is the knee (lower buys ≤0.1 GB for
  +30–50 % CPU).
- **The program cannot be freed in-process.** A heap snapshot at the
  syntactic phase: the largest dominator is `createProgram`'s closure scope
  (its `files` → every SourceFile), retained by `FunctionCodeBlock`s that are
  GC roots (JSC's optimized code of its inner functions: `processSourceFile`,
  `findSourceFile`, `toPath3`, …). Dropping every reference of ours, and
  invalidating a singleton scope with a second `createProgram`, both leave it
  alive (WeakRef after a full GC).
- **The ~470 directive verdicts matter as much as the 16.3k syntactic
  parses**: each runs every rule over the file, so with the program alive they
  alone regrow the heap to ~1 GB.

**Fixed:** what needs no program and no result key runs before the type check
builds one (`LintDecisions.beforeProgram`): every stale syntactic group (a
function of the text and the groups), and — when the verdicts moved and no raw
part did — every carried directive file's verdict from the base's raw parts.
A verdict is a function of its text and the raw messages it replays, so the
answer uses an early one only for the same raw messages (a file whose key
moved is combined again: exact by construction). A batch is not asked again
for a syntactic group that already ran.

Real check runs, same incremental rule-edit shape, alternating code:

| | maxRSS | worker CPU (lint) |
| --- | --- | --- |
| before | 1.9, 2.0 GB | 31.6 s (29.0), 31.4 s (28.6) |
| after | 1.4, 1.3, 1.4 GB | 30.5 s (28.7), 29.7 s (27.8), 31.0 s (29.1) |

Replayed: footprint 1.11–1.17 → 0.61–0.63 GB. Results: the same captured job
through the old and the new worker gives the same 16,770 lint results, lint
keys and tsc output. What is left of the footprint is the program phase itself
(~0.4 GB live) and the early phase (~0.42 GB for 16.3k parses with ~0.1 GB
live).
