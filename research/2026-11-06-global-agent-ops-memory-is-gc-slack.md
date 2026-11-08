# Agent ops memory: a type-check batch is ~2.3 GB of data in a 7–14 GB bun process

Task: task-1793984663 (continues task-1793977698,
[`2026-11-06-global-host-pressure-by-owner.md`](2026-11-06-global-host-pressure-by-owner.md)).
Supervisor: task-1793965642-94fdhj.

## Question

Agent ops are the largest equin-owned memory holder (median 11.5 GB, max
28 GB). Why does one type-check worker reach 7.6 GB, how much of the bucket is
concurrency vs per-op size, and what is the biggest structural lever?

## 1. What the agent-ops tail is made of

`health-owners` (main, 14:28–18:05 UTC, 309 samples), the agent-ops bucket
split by its named processes:

| component | median | p90 | max | mean over the top 10 % samples |
| --- | --- | --- | --- | --- |
| type-check batch processes | 0 | 5.4 | 9.6 GB | 5.6 GB |
| type-check workers | 0 | 2.2 | 6.6 | 1.4 |
| `check` CLIs (runner) | 0.7 | 4.8 | 10.9 | 5.5 (≈4 at once) |
| `build` CLIs | 0.6 | 2.2 | 5.0 | 1.8 |
| other named / unnamed | | | | 5.1 |
| **agent ops total** | 5.5 | 16.1 | 28.0 | **19.4** |

Concurrency is bounded and small: at most 3 type-check processes in a sample
(heavy pool 2 + light pool 3 slots, a batch child runs inside its worker's
slot), ~4 check/build CLIs. The tail is **per-process size**: one batch
process alone is 5–10 GB.

Check transcripts (`~/.equin/worktrees/*/check-*.log`, 2026-11-06): 291
type-check runs, median peak 1.1 GB. **9 whole-tree (batched) runs hold 56 %
of the day's type-check CPU (4,822 of 8,610 CPU-s)** and every peak above
7.5 GB: batch processes at 7.5, 7.6, 7.8, 8.0, 8.2, 8.4, 10.6, 11.9 and
13.9 GB, alive 3–23 min each (wall 172–1,398 s), so they sit in many 30 s
samples. Triggers, each a legitimate global change under the design (one
typed-lint group, the lint engine, or the producer moved; or a base was
pruned / absent):

| trigger | runs |
| --- | --- |
| a lint contribution with a type-aware rule edited (scroll-safety, blocking-fs) | 2 |
| lint engine / base group moved (every group stale) | 3 |
| typed engine (producer) moved, or the lint base root pruned → full walk | 3 |
| no walk recorded in the checkout | 1 |

## 2. Why one batch process is 7–14 GB: it is not the data

A batch = ≤ K = 2000 sources + served `.d.ts` + env, then typed lint of its
files. Reproduced with one program over `conversations` + `page` (1,908 roots,
11,458 files of which **9,063 repo sources** — more source than a real batch,
which serves most files as `.d.ts`): build, semantic diagnostics of the roots,
declaration emit; same script, same TypeScript 6.0.3.

| runtime | peak footprint | live heap after full GC |
| --- | --- | --- |
| node 25 (V8) | **3.1 GB** (2.85 on a second run) | V8 used 2.11 GB |
| bun 1.4.4 (JSC), as the worker runs today | **7.36 GB** | — (RSS 5.77 after `Bun.gc(true)`) |
| bun `--smol` | 5.57 GB | JSC heap 2.17 GB, capacity 3.16 |

Then the repo's real lint engine (`createLintEngine`, every group, typed,
`whole`) over the same 1,908 files in the same bun program:

| point | RSS |
| --- | --- |
| program built | 1.47 GB |
| roots checked | 4.12 GB |
| linted 500 / 1000 / 1908 | 6.83 / 7.26 / 7.27 GB (peak 8.5 GB) |
| after `Bun.gc(true)` | 4.34 GB; **JSC heap 2.32 GB** |

So:

- **The live data is ~2.1–2.3 GB**, the same under V8 and JSC.
- **Typed lint retains ~0.15 GB** (2.17 → 2.32 GB live). The "typed lint
  doubles a batch's peak" measured in the bounded-batches work
  (tsc 5.8 → 14.8 GB at K = 4000) is per-file garbage (ESTree conversion,
  node maps, rule state) that JSC has not collected yet. It is not data the
  batch keeps.
- **The other 5–12 GB of a batch process is JSC GC slack plus allocator
  retention**: heap capacity runs ~1.5× live, and RSS stays ~1.4 GB above
  capacity after a full GC (freed pages not returned). V8 holds the same
  workload in ~3 GB. Bun also spent more CPU: 64–73 user-s vs node's 49–55.
- The spread between batches (7.5 → 13.9 GB for the same K) fits slack, which
  depends on the allocation pattern, better than it fits data: the 13.9 GB
  batch linted only 1,025 files.

## 3. Same cause outside type-check (for task-1793983938-8ex7oq)

The agents bucket's peaks (15–16 GB) in this window are unadmitted
`./equin run` scripts that build a whole-repo `ts.createProgram` and run typed
ESLint under bun: `blocking-fs/scripts/inventory.ts` 5.3 GB,
`scratch-rename.ts` 7.2 GB (17:21). That is the type-check batch's workload
and runtime. **The shared cause is the TypeScript compiler + typed ESLint
running on bun/JSC.** A process like this holds 2–3× its live data, so any
fix to the runtime or GC pacing of TS-program processes covers both.

## 4. The lever

Per-op size, not concurrency. At the measured ratio, the same batches on V8
would peak at ~3 GB instead of 7.5–14 GB. On the top-10 % samples that is
~5 GB less from type-check alone, and more if the check CLIs (2–6 GB each,
also bun) carry the same slack. Shrinking the host grant would only queue
these processes longer. It would not make them smaller.

**User decision (2026-11-08): stay on bun; no switch to node.** The node
numbers above are a measurement baseline (what the live data costs on a heap
that tracks it), not the recommended fix. The lever is bun-side:
task-1793986737-azfp2g investigates fixes on bun — GC pacing in the batch
(a collection between lint files, `--smol`: −24 % peak measured), allocator
retention, and whether this is a known bun/JSC issue — then re-derives
`TYPE_CHECK_WORKER_PEAK_BYTES` (7.2 GB) and K from the new peaks (K = 2000
was chosen against bun's slack).

Not done here: a real batch job measured (job files are deleted after a run).
