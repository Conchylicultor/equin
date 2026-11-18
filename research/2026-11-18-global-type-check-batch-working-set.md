# A type-check batch's memory is its own working set, not a re-loaded environment

2026-11-18. Follows `2026-11-18-global-cold-check-pass-memory.md`, whose follow-up said:
"every batch program re-loads ~5k `.d.ts` (env + served), so share the environment".
Goal (Performance supervisor): a cold check pass fits an 8 GB host (~6.45 GB free with
the app running; the check process ~2 GB, orchestrator 0.7, worker 0.6) with margin.

## Result

- **The hypothesis is wrong.** What every batch truly shares — lib, `@types/node`,
  `bun-types`, the repo `.d.ts` roots and the global files — is 534 files, **0.23 GB
  live** (parsed and bound). The other ~5k `.d.ts` a batch loads are the import closures
  of ITS OWN 2,000 sources: different per batch, all needed by that batch's checks.
  Sharing them across batches would save parse CPU, never a batch's peak: the peak is
  what one program needs alive at once.
- **Where one batch's memory goes** (the heaviest, live after a full GC): parse
  0.86 GB, bind 0.26 GB, **the checker's types 1.46 GB** (55 %), emit ~0.
- **Landed:** the program host parses JSDoc as `tsc` does (`ParseForTypeErrors`):
  −90 MB live (−3.5 %) and −4 s of parse CPU per program. Small, free, and every program
  (warm runs too) gets it.
- **Not landed, a decision:** what lowers a batch's peak enough for 8 GB is fewer sources
  per program and tighter heap pacing, both paid in CPU (table below). Proposed as a
  small-host profile, not shipped.

## 1. Why a batch loads ~9.5k files

Cold keyed run (forced cold by a nonce in `shared/name-store.ts`), K 2000: 9 batches, 902
batch CPU-s, peak 4.3 GB. Each batch replayed (`EQUIN_TYPE_CHECK_KEEP_BATCHES` +
`scripts/batch-memory-bench.ts`), Mac, current pacing (4 GB):

| batch | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| files in the program | 4,671 | 5,678 | 4,955 | 6,304 | 7,459 | 8,909 | 9,558 | 11,172 | 10,920 |
| peak footprint (GB) | 2.6 | 3.0 | 3.1 | 3.9 | 3.5 | 3.7 | 4.0 | 4.2 | 4.2 |
| CPU (s) | 59 | 62 | 79 | 113 | 87 | 164 | 164 | 115 | 129 |

Batch 6 (2,000 sources), by kind (text size):

| kind | files | text |
| --- | --- | --- |
| npm `.d.ts` (pixi.js 719, @base-ui 567, drizzle 242, @anthropic-ai/sdk 171, zod 110, …) | 2,901 | 20.1 MB |
| served contracts (repo `.d.ts`) | 4,571 | 12.4 MB |
| sources | 2,000 | 10.6 MB |
| TypeScript lib | 71 | 3.5 MB |

An env-only program (the same roots, no sources) holds 532 files: 179 MB parsed, 233 MB
bound. That is everything every batch shares.

The import graph of all 9 programs (sources, contracts, npm files, each with its edges)
was dumped and replayed in a simulator that reproduces the real run exactly (9 batches,
69,628 files loaded; per batch 4,671 … 11,173):

- **A source's own closure beyond that shared base: median 358 files**, p90 1,322, p99
  2,645. 12,145 of 17,987 sources are under 500; six are over 8k (`web.generated.ts`,
  `App.tsx`, `main.tsx` and three web-core tests: the whole web graph).
- **A batch is the union of 2,000 such closures**: barrels' contracts re-export every
  module, so closures overlap little, and 2,000 of them reach 4.6k–11k files.
- **No batch order does better.** Filling a batch by path (plugin) locality: 81.8k files
  loaded in total, max 15k (worse: plugins import widely). Greedy least-new-closure inside
  the dependency order: 66.2k total (−5 %), max 14.2k (worse: the top of the graph is
  left for the last batch). The dependency order already groups low-level libraries.
  K 1000: 18 batches, max 10.3k files; K 500: 36 batches, max 9.6k. The batch that
  checks `web.generated.ts` loads the whole web graph whatever K is.
- **Pruning to what the checker touches would save little**: after checking batch 6, it
  had touched 815 of 2,901 npm files but 13.3 of their 20.1 MB, and 2,817 of 4,571
  contracts (10.2 of 12.4 MB).

## 2. The checker's types are the biggest part

Batch 6, live after `Bun.gc(true)` at each phase: start 43 MB, parsed 907 MB, bound
1,163 MB, semantic-checked 2,623 MB (1.04M types, 5.2M instantiations, 2.75M symbols),
emitted 2,638 MB.

Type creation is heavy-tailed and charged to the first file that touches a type graph:
the top 30 files create 39 % of the batch's types, the top 100 59 %.
`supervisor-roles/pane/web/internal/reads.ts` (10 KB) creates 82k in the batch; alone in
a program, 142k types and 716k instantiations. Its imports alone cost 31k types; the
first `useLive(taskWindow, …)` call +21k types / +83k instantiations, the same call again
+90 types / +36k instantiations, each new `where` shape ~18k types. `useLive` has several
overloads of up to 15 type parameters each over large conditional types; `network/live`
files alone make 14 % of batch 6's types. Every batch that reads `taskWindow` builds those
types again. That is a library-design follow-up (below), not something the type check can
share between processes.

## 3. What was tried and what landed

**JSDoc parsing** (landed, `shared/name-host.ts`). `createProgram` asks its host for
`jsDocParsingMode`. `tsc` sets `ParseForTypeErrors` (parse JSDoc in a `.ts` / `.d.ts`
only where it holds `@see` / `@link`, all of it in JS); our host left the default,
`ParseAll`. This repo's sources, the contracts emitted from them (which keep their
comments) and the npm `.d.ts` are full of `/** … */`. Batch 6:

| | ParseAll (before) | ParseForTypeErrors |
| --- | --- | --- |
| parsed (live) | 907 MB | 837 MB |
| bound | 1,163 MB | 1,097 MB |
| checked + emitted | 2,638 MB | 2,545 MB |
| parse CPU | 15.4 s | 11.6 s |
| AST nodes | 3.74M | 3.59M |

Nothing here reads JSDoc nodes: declaration emit copies comments from the text, the
canonical `.d.ts` drops them, no lint rule in the repo reads JSDoc tags (no
`no-deprecated`), `@deprecated` only feeds suggestion diagnostics. The oracle
(`full-check.ts`, `viewCompilerHost`) still parses everything, so `--mode dual` compares
the two modes file by file (section 5).

**Emitting contracts without comments** (not done). Contracts are 47 % comments by text
(21.7 MB → 11.6 MB printed without), but with JSDoc unparsed a comment costs only its
characters (a few MB per batch). Not worth a producer change.

**Locality-aware batch planning** (not done): section 1.

**Sharing parsed files across batches in one process** (not done). It saves the
~16–22 s of parse + bind CPU per batch, but a process keeping the parsed files of every
batch holds their union, more than any one batch. Sequential programs in one process
also stayed resident before (11–15 GB, research/2026-10-23-global-type-check-bounded-batches.md).

## 4. The trade-off left: sources per program and heap pacing

Every batch of both kept runs replayed on this Mac (64 GB, loaded host, so CPU is ±10 %;
no lint, as in the keyed runs):

| configuration | batches | max batch peak | batch CPU |
| --- | --- | --- | --- |
| K 2000, paced 4 GB (today) | 9 | 4.2 GB | 971 s |
| K 2000, paced 2 GB | 9 | 3.8 GB | 1,027 s (+6 %) |
| K 1000, paced 4 GB | 18 | 3.6 GB | 1,118 s (+15 %) |
| K 1000, paced 2 GB | 18 | 2.9 GB (most 2.0–2.6) | 1,341 s (+38 %) |

On Linux a batch peaked 3.9–4.95 GB where the Mac measured 4.0 (previous doc), so expect
K 1000 / 2 GB at ~3 GB there. Beside ~3.3 GB of check process, orchestrator and worker,
that is ~6.3 GB of the 6.45 GB free: it fits only together with the other follow-up (the
check process releasing finished checks' memos).

The CPU only needs paying on a small host: a profile chosen from the host's RAM (K and
`BUN_JSC_forceRAMSize` for batches), leaving a 16 GB+ host as today. That is the decision
handed back.

## 5. Validation

- **Correctness**: `scripts/dual-check.ts . --mode dual`, cold (the change moves the
  producer hash): walks 0 differences; 0 diagnostic divergences; 2 of 17,987 signature
  divergences (desktop `launcher-controls.ts`, `switcher-controls.ts`), the SAME keyed
  and full hashes main's backstop already filed on 2026-11-17 before this change
  (report-1794890177-gf92fh / -egdcki): a batched-vs-whole-program divergence, not this
  change. In one whole program both modes give byte-identical diagnostics and `.d.ts`
  for those files and their 1,519 neighbours.
- **Independent review** (a separate agent): both modes compared on 1,393 repo files
  (diagnostics and raw `.d.ts` byte-identical) and on the ESTree typescript-eslint builds
  from all 17,962 convertible files (identical, comments and tokens included); no lint rule,
  record or inference edge reads JSDoc nodes. It found the source-file cache key did not
  name the mode (safe while one host fills it): the key now includes it.
- **Cost**: the controlled numbers are section 3's (live heap after a forced GC: −93 MB,
  −3.5 %; parse −3.8 s CPU per program). Peak footprint could not resolve it on this host:
  8 interleaved before/after replays of batches 3, 6, 7, 8 under heavy memory pressure
  (up to 158 s of system CPU per batch) swung ±1 GB between identical runs (job 8: 4.8 vs
  3.7 GB, same code); summed peaks 34.8 vs 35.2 GB, user CPU 994 vs 980 s. A cold keyed
  run after the change read 1,230 CPU-s / 5.3 GB against 902 s / 4.3 GB before, on the
  same loaded host: the same noise. Not re-measured on an 8 GB VM: the change is too
  small for a VM to show, and section 4's trade-off is what a VM run should measure.

## Follow-ups

- `useLive`'s overload set builds ~20k types per collection per program and ~18k per new
  `where` shape: the live API's types are the largest single share of a batch's checker
  memory found here (14 % of batch 6 directly, more through callers like `reads.ts`).
  Owners: network/live.
- The small-host profile (section 4), if chosen.

Raw data: `$EQUIN_SCRATCH` of conv-1795031131-nsyvmw (kept batches, graph dump, scripts
`phase.ts` / `gather.ts` / `sim.ts` / `perfile.ts` / `types.ts` / `one.ts`).
