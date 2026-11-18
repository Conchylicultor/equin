# The cold check pass on an 8 GB host: where its memory goes

2026-11-18. Follows `2026-11-18-global-linux-8gb-deploy-oom.md` (bd82e3510d made an
OOM kill safe). Question: why does the cold check pass of main's first update after an
install (~8.7 GB of its own on a 16 GB VM) not fit on 8 GB, and what of it is held for no
reason.

## Result

- **Fixed: the type-check worker's up-front lint.** Before it built any program, the worker
  ran every file's stale syntactic rule groups (`LintDecisions.beforeProgram`). On a cold
  or global run that is ~18k parses, ~250 CPU-s. They grew the worker to 2.6–2.7 GB, which
  it then held idle beside every batch process. The light attempt (`batch: refuse`) also
  paid all of it before refusing its first program over 100 sources, then threw it away.
  Now that lint runs only right before a program is built in the worker
  (`LintHook.beforeProgram`), and each batch lints its own files' syntactic groups first,
  before its program.
- **Not fixed, and still too big for 8 GB:** the check process (4.5 GB in its first
  minute on Linux, ~2 GB afterwards) and one type-check batch (4–5 GB, nearly independent of
  K) do not fit together in the ~6.5 GB an 8 GB host has left once the app is running. Each
  is a follow-up below.

## Why idle memory stays resident

Bun returns freed memory to the OS only page by page, when the page is empty. A small
allocation that survives keeps its whole page. Measured with a scratch script: allocate
6M small objects (1.2 GB), free them all, and RSS drops to 14 MB. Keep every 50th one
alive (2 %), and RSS stays at 1.09 GB, with or without `Bun.gc(true)` or `Bun.shrink()`.

That is why the worker held its peak. The syntactic results it kept (small message
arrays, one per file) were interleaved with ~18k files' worth of parse garbage. A process
that works in phases holds its biggest phase's footprint for the rest of its life.

## The type-check worker, before → after

Forced-cold run on this Mac (a nonce comment in `shared/name-store.ts` and
`shared/lint-engine.ts`, so every result key and lint group misses; the run carries a
lint base, so it goes light first and escalates). Mac RSS, one sample per second.

| | before | after |
| --- | --- | --- |
| light attempt (refused) | cpu 264 s, wall 252 s, RSS → 2.6 GB | cpu 4.8 s, wall 4.8 s |
| heavy worker, while the 9 batches run | 2.63–2.69 GB | 0.58–1.01 GB |
| worker lint cpu / batch cpu | 249 s / 409 s | 17 s / 676 s |
| worker + batches cpu (heavy run) | 686 s | 722 s |
| batch peak footprint (max of 9) | 4.6 GB | 4.5 GB |
| end phase (`.d.ts` holder program, walk base) | 4.18 GB RSS | 3.88 GB RSS |

The syntactic lint moved into the batches (same parses, before each batch's program)
instead of happening in the worker. The batch peak is in the tsc check, so it did not move.

## K is a poor lever

Cold keyed runs (`scripts/dual-check.ts --mode keyed --batch-k K`, no lint), Mac, background
priority:

| K | batches | batch cpu | batch peak footprint |
| --- | --- | --- | --- |
| 2000 | 9 | 928 s | 4.0 GB |
| 1000 | 18 | 1,209 s (+30 %) | 3.6 GB (−10 %) |

A batch's memory is mostly the type environment every program loads: ~2,700 env `.d.ts`
(lib, `@types`, npm types) plus ~2,500–3,000 served repo `.d.ts` per batch, whatever K is
(program 1 at K 1000: 44,235 `.d.ts` + 40,595 env over 18 batches; at K 2000: 26,990 +
24,513 over 9). K stays 2000.

## The check process

An uncached pass of every tree check except type-check, on this Mac. Its live heap after
each GC climbs steadily to ~1.1 GB. At the end of the pass, after `Bun.gc(true)`, JSC
reports `heapSize` 976 MB and 422 MB of native ("extra") memory. A heap snapshot there
holds 325 MB of strings (file texts, masks), ~200 MB of TypeScript syntax trees
(`NodeObject` 723k, `IdentifierObject` 405k, `TokenObject` 110k), and the code of ~21k
loaded modules (63 MB of `ModuleRecord`). The strings and trees are reached through
weak edges: the per-run `sharedMemo` WeakMaps keyed on the run's file set, which live
until the pass ends.

Neither `--jobs 4` (peak 2.3 GB, same as unbounded) nor pacing the check process's heap
(`BUN_JSC_forceRAMSize` 1e9: 2.1 GB, 2e9: 2.6 GB) moved it. So this is live data that
outlives its use, not GC slack or fan-out. While the type-check (the pass's longest check)
runs alone at the end, the check process still holds every finished check's memo.

## 8 GB Linux VMs, before → after

Two fresh Tart Ubuntu 24.04 VMs, 8 GB (7.9 GB usable, no swap), 4 CPUs. One had main at
bd82e3510d, the other bd82e3510d plus this change. Each ran `./install.sh --terminal`
(3 min 40 s), then got a research commit on main: the first update after an install, with
a cold check pass. Samples: `/proc/*/status` RSS and `smaps_rollup` PSS every second. With
the app idle, MemAvailable is 6.45 GB.

| | before | after |
| --- | --- | --- |
| outcome | OOM kill at the first type-check batch (19:17:58) | OOM kill during the first minute of checks (19:13:36) |
| killed | the batch (anon RSS 2.46 GB, still growing) | the check process (anon RSS 4.71 GB) |
| at the kill (PSS) | check process 1.91, worker 1.42, batch 2.34, orchestrator 0.67, app 0.7 | check process 4.49, orchestrator 0.68, batch 0.66, worker 0.55, app 0.7 |
| worker while waiting for its first program | 0.8 → 2.6 GB over 4 min (up-front lint) | 0.55 GB |

Both fail. The worker no longer holds anything for long. With no 4 minutes of lint to do
first, though, its first batch now starts while the check process is at its own peak (its
parallel first minute). Both were measured with the build's checks and frontend
serialized on one unit (bd82e3510d).

What a cold pass needs at once on an 8 GB host:

- **First minute:** the check process (4.5 GB) + the orchestrator (0.7 GB) ≈ 5.2 GB of
  the 6.45 GB left, before any type-check batch.
- **Batches:** one batch (4–5 GB) + the check process's ~2 GB after its first minute +
  the orchestrator (0.7 GB) + the worker (0.6 GB) ≈ 7.5–8.3 GB.

Neither fits with margin.

## Follow-ups

- **The check process holds what finished checks memoized until the pass ends**
  (~1 GB live JS + 0.4 GB native at the end; 4.5 GB RSS in the first minute on Linux).
  Releasing a memo once no running check can still read it, or running the pass's heavy
  readers so their garbage does not pin pages beside long-lived data, is what an 8 GB host
  needs most.
- **A type-check batch costs 4–5 GB, nearly independent of K:** each program re-loads
  ~5k `.d.ts`. Sharing the environment, or making a batch lighter in another way, is the
  other half.
- Until both land, an 8 GB host cannot run a cold check pass: what main's update on such an
  install should run is a decision (task-1795006239-dae69p).

Raw data: `~/equin-vm-runs/coldpass/`: the VM samples (`{before,after}.mem.tsv`, read with
`vmana.py <tsv> ~/equin-vm-runs/memsplit/analyze.py`, written by `sampler.py`), the VMs'
check transcripts, and the Mac cold runs (`cold1` before, `cold2` after; `k1000` / `k2000`).
