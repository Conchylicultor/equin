# Type-check batches on bun: the slack is JSC's heap pacing, fixed by pacing against 4 GB

Task: task-1793986737-azfp2g (responsiveness audit, supervisor
task-1793965642-94fdhj). It follows task-1793984663
(`2026-11-06-global-agent-ops-memory-is-gc-slack.md`, which measured a
proxy program, not a real batch). User decision: stay on bun.

## Result

| cold whole-tree check, lint included (8 batches of ≤ 2,000) | worker CPU | batch peak RSS |
| --- | --- | --- |
| before (bun default) | 448 s | **10.4 GB** |
| after (heap-paced, 4 GB) | 473 s (+6 %) | **5.3 GB** |

Both runs are on the same tree, each forced cold by a producer edit, on a
loaded host. CPU noise is about ±10 %.

## 1. Known upstream? Yes: a documented JSC heuristic, tracked as bun issues

There is no bug in the sense of a leak. JSC paces collections against the
machine's RAM. After a full GC with H bytes live, the heap may grow to about
`(1 + heapGrowthMaxIncrease · e^(−heapGrowthSteepnessFactor · H / ram)) · H`.
Bun ships `heapGrowthMaxIncrease = 2` and steepness 2. JSC assumes it owns the
whole machine. With 64 GB of RAM a 4.4 GB heap may reach ~2.7 × H.

Open bun issues on exactly this:

- [oven-sh/bun#39424](https://github.com/oven-sh/bun/issues/39424): `tsc`
  under bun holds ~1.5× node's peak RSS.
  - Reproduced by a maintainer.
  - `--smol` has no effect.
  - `BUN_JSC_forceRAMSize=2147483648` cuts RSS and wall time.
- [oven-sh/bun#39844](https://github.com/oven-sh/bun/issues/39844): the heap
  peaks 1.4–2.6× above node under sustained allocation.
  - The maintainer gives the formula above.
  - They call it a throughput-vs-peak tuning choice.
- [oven-sh/bun#34917](https://github.com/oven-sh/bun/issues/34917):
  `--max-old-space-size` and the JSC heap caps are ignored. Bun has no way to
  bound a heap.
- [oven-sh/bun#34924](https://github.com/oven-sh/bun/pull/34924) (open PR):
  wires `--max-old-space-size` into `forceRAMSize`. Not released.

We run bun 1.4.4 (2026-10-22), the newest release. Its notes change nothing
here: a JSC upgrade, and a cgroup heap-sizing fix that is Linux only.

**No new upstream report is needed**: #39424 is this case. The real-workload
data was posted there on 2026-11-09, shortened:
https://github.com/oven-sh/bun/issues/39424#issuecomment-6729911920. The full
draft:

> Data point from a real workload (bun 1.4.4, macOS arm64, 64 GB): a
> TypeScript 6 program of 2,000 sources plus ~20k `.d.ts`, checked and then
> linted with typescript-eslint (typed). It has 4.4 GB live after
> `Bun.gc(true)` and peaks at 8.6–9.7 GB RSS by default.
> `BUN_JSC_forceRAMSize`:
>
> - 6e9: 7.8 GB
> - 5e9: 6.9 GB
> - 4e9: 6.95–7.2 GB
> - 3e9: 6.8 GB
> - 2e9: 6.7 GB
>
> CPU is +5–10 % at 4e9 and +26 % at 2e9. `--smol` (9.4 GB),
> `heapGrowthMaxIncrease=1` (8.95), `useConcurrentGC=0` (8.9),
> `MIMALLOC_PURGE_DELAY=0` (9.5) and `Bun.gc(true)` between phases (8.9) are
> all within noise. A per-process `--max-old-space-size` mapped onto
> `forceRAMSize` (#34924) would let tools set this without the env var.

## 2. A real batch, measured

Method:

1. `batch-processes.ts` now keeps a run's spool when
   `EQUIN_TYPE_CHECK_KEEP_BATCHES=<dir>` is set. The spool is every job file
   and every `.d.ts` the batches were served.
2. A cold whole-tree check was kept that way.
3. `scripts/batch-memory-bench.ts` replays one batch through the real
   `batch-worker.ts` per variant, against a scratch checkout at the run's exact
   tree.

During the investigation the batch worker also printed `bun:jsc` `heapStats()`
at the phase boundaries. That instrumentation was not committed.

Per batch, default bun (sources / peak RSS / CPU):

| batch | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sources | 2000 | 2000 | 2000 | 2000 | 2000 | 2000 | 2000 | 1523 |
| default peak | 2.38 | 4.90 | 4.84 | 5.72 | 7.43 | 8.62 | 8.6–9.7 | 6.84 |
| paced (4 GB) peak | 2.17 | 3.59 | 4.55 | 4.65 | 5.19 | 5.11 | 6.95–7.2 | 5.31 |

Deeper batches cost more. They have the same number of sources, but they are
served more `.d.ts` and their files read bigger type graphs.

Batch 6, the heaviest, phase by phase (default):

| point | RSS | JSC heap size | heap capacity |
| --- | --- | --- | --- |
| program built + checked + emitted | 8.94 GB | 4.34 GB | 8.05 GB |
| after `Bun.gc(true)` there | — | **4.42 GB live** | 6.74 GB |
| linted 2,000 files | 8.48 | 4.48 | 7.43 |

What this shows:

- **The peak is in the tsc check, before lint.** Typed lint adds ~0.05 GB
  live and no peak. A GC between lint files cannot help.
- **The live data of a real deep batch is 4.4 GB, not the proxy's 2.3 GB.** The
  slack is ~2× live, not 3–4×.
- Capacity stays ~1.8× live. RSS sits ~0.9–1.5 GB above capacity: malloc
  outside the JS heap, and freed pages not returned.

Variants on batch 6 (peak RSS / CPU). The host was loaded, so CPU noise is
±15 %; defaults repeated four times:

| variant | peak | CPU |
| --- | --- | --- |
| default (×4) | 8.64 / 8.99 / 9.57 / 9.69 | 112–196 s |
| `--smol` | 9.39 | 121 |
| `Bun.gc(true)` after the check | 8.94 | 153 |
| `Bun.gc(true)` every 250 lint files | 9.40 | 146 |
| `BUN_JSC_heapGrowthMaxIncrease=1` | 8.95 | 117 |
| `BUN_JSC_useConcurrentGC=0` | 8.90 | 129 |
| `MIMALLOC_PURGE_DELAY=0` | 9.49 | 131 |
| `BUN_JSC_forceRAMSize` 8e9 | 8.41 | 127 |
| 6e9 | 7.80 | — (host swap: sys 91 s) |
| 5e9 | 6.92 | 119 |
| **4e9** (×2) | **6.95 / 7.19** | **125 / 118** |
| 3e9 | 6.77 | 127 |
| 2e9 | 6.70 | 141 |

Only `forceRAMSize` moves the peak, as the formula predicts. With H = 4.4 GB
the growth ceiling is ~2.7× at 64 GB, 1.66× at 8 GB, 1.22× at 4 GB and 1.02×
at 2 GB. The knee is 3–5 GB: below it, CPU rises and memory does not fall.

## 3. What landed

- **`packages/heap-pacing`** (core): `pacedHeapEnv(env)` sets
  `BUN_JSC_forceRAMSize = HEAVY_PROCESS_RAM_BYTES` (4e9) unless `env` already
  names one.
  - Small heaps (H ≪ 4 GB) keep a ~2–3× growth factor, so scripts and light
    runs collect as rarely as before. Only multi-GB heaps are paced tightly.
  - A test spawns bun with and without it and asserts the paced peak is lower,
    so a bun that stopped reading the option fails it. The probe measured
    2.96 vs 1.51 GB.
- Applied at the spawn sites of TS-program processes. Every descendant
  inherits it through the env:
  - the type-check worker (`spawnTypeCheckWorker`, so the check, build's
    `--skip-checks` path and the backstop);
  - batch processes (`batch-processes.ts`);
  - every `./equin run` script, which covers the unadmitted whole-repo
    scripts (inventory, scratch-rename: 5–7 GB) and `dual-check` /
    `walk-replay`.
- `EQUIN_TYPE_CHECK_KEEP_BATCHES` + `scripts/batch-memory-bench.ts`: real
  batches can now be measured. The 2026-11-06 doc's "not done here" gap.

## 4. K and the worker weight, re-measured

| cold, paced | batches | worker CPU | batch peak |
| --- | --- | --- | --- |
| K 2000 | 8 | 473 s | 5.3 GB |
| K 3000 | 6 | 460 s | 6.1 GB |

- **K stays 2000.** K 3000 saves ~3 % CPU, inside noise, for +15 % peak, and
  memory is the host's scarce resource.
- **`TYPE_CHECK_WORKER_PEAK_BYTES` stays 7.2e9.** It is a mean over
  transcripts, and paced runs do not dominate them yet. The heaviest paced
  run, 5.3 GB, is still 2 units, as is anything in (3.6, 7.2] GB.
  `TYPE_CHECK_WORKER_UNITS` is unchanged.

## Not done / follow-ups

- The `check` / `build` CLIs (2–6 GB each in `health-owners`) are bun
  processes with the same pacing, but they are not spawned through these
  sites. Measure one before pacing them: their heap is mostly not a TS
  program.
- Re-read the worker's mean peak from transcripts after a week of paced runs.
  `TYPE_CHECK_WORKER_PEAK_BYTES` may then drop below 3.6 GB, which would be 1
  unit.
