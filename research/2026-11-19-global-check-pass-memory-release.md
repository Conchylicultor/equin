# The check pass lets go of what finished checks read

2026-11-19. Follows `2026-11-18-global-cold-check-pass-memory.md`: on a fresh 8 GB
Linux host, main's first update after an install was OOM-killed in its check pass
(the check process at 4.5 GB in its first minute, ~2 GB afterwards beside a 4–5 GB
type-check batch). Two questions: what does the check process keep that no running
check needs, and why does the first minute peak.

## Result

- **Fixed: every per-run memo lived until the pass ended.** Each `sharedMemo` (the
  codegen pass and trees, evaluated barrels, registry context, portability), the
  source analysis (a bare `WeakMap`) and the masks (a module-level `Map`) were keyed
  by the run's one file set or by path, so whatever any finished check had read
  stayed alive while the type-check ran alone for minutes. Now each check runs under
  a holder, every memo entry it reads is held by it, and the holder lets go when the
  check settles (`packages/shared-work` memo holds; `checks/core/memo-lifetime.ts`).
- **Fixed: the module graph kept every module text a cold walk scanned.** Its
  `memberContent` map (meant to share one read between a plain set's blob id and its
  scan) also cached a snapshot's reads, for the life of the graph: ~21k texts, 116 MB
  of strings, during the cold minute and after it.
- **Measured, not fixed: the first-minute peak is the cold record store.** With the
  record store warm, the same pass peaks at ~1.6 GB; cold, at 3–6.4 GB on this Mac.
  The extra is the record producers (module graph, file scans and folds over every
  file, facet extraction, in-process barrel evaluation) running together.

## Method

Every tree and deploy check except type-check (209 checks), `--no-cache`, against a
fresh record store per run (a temporary path, so the shared store stayed untouched):
the cold pass of a first update. macOS, 18 cores, background priority, a busy host.

- **Footprint** (`proc_pid_rusage` phys_footprint, every 250 ms, plus the kernel's
  lifetime peak): the Mac analog of Linux anon RSS, what the VM was killed on. Mac
  RSS is not: it also counts clean file-backed pages (the SQLite stores, file reads)
  and freed allocator pages the OS may take back at any time. In one run RSS reached
  6.5 GB while the footprint stayed at 0.75–1.8 GB.
- **After the pass:** four forced full GCs 5 s apart, then the heap and footprint:
  the state the type-check runs beside once every other check settled.
- A heap snapshot after the last GC, grouped by class and by retainer.

`Bun.jsc.heapStats()` is O(heap) (it counts every object type): sampled every 250 ms
it stalled the pass for minutes. `process.memoryUsage().heapUsed` moves only when a
GC runs, so a reading between GCs says little.

## After the pass (forced GC, no check running)

| | live JS heap | footprint | strings in the snapshot |
| --- | --- | --- | --- |
| before (memos for the run) | 1.20 GB | 1.79 GB | — |
| holds | 0.53 GB | 1.39 GB | 199 MB (473 MB snapshot) |
| holds + module-graph fix | 0.40 GB | 1.37 GB | 85 MB (358 MB snapshot) |
| as shipped (+ `forProcess` memos) | 0.63 GB | 1.27 GB | — |

**As shipped** keeps some memos for the process (`sharedMemo`'s `forProcess`), from
an independent review: the live slot-declaration passes must run once per process,
a barrel evaluation's miss re-runs one, and plugin-records' per-set identities key
the module graph (made again, every graph would be walked again). A memo keyed by
another memo's value (the trees keyed by a codegen pass) also holds that value's
entry, so the pass stays the one its memo answers. Those cost ~0.2 GB of the
release. Holds are installed by the check command (an AsyncLocalStorage handed in
as `RunChecksOptions.memoContext`) on the first pass, never on import: a build or
test process loads the checks barrel too, and holds with no unit running would pin
every entry.

What is left: ~21.5k loaded modules (64 MB of `ModuleRecord`, their code and
bytecode; a cold pass imports every plugin barrel to evaluate it and a module cannot
be unloaded), 85 MB of strings, 42 MB of `ArrayBuffer`s, and the module graph (its
state is keyed by the run's snapshot and lives for the run, shared by every reader).

## The first minute

| run | records | holds | peak footprint |
| --- | --- | --- | --- |
| b4 | cold | no | 6.4 GB |
| b6 | cold | no | 5.0 GB |
| b9 | cold | no | 3.0 GB |
| b5 | warm | no | ~1.6 GB (RSS, 1 s samples) |
| b7, b8, b10, b11, b12 | cold | yes | 4.3, 3.6, 3.4, 1.8, 3.2 GB |
| b13 (as shipped) | cold | yes | 2.4 GB |

The peak swings by 2× between identical runs: it is made of short bursts (1.5 → 5.4
GB in 8 s, then back) whose height depends on which producers overlap, and the host
ran other agents' check passes and builds throughout. The release lowers what the
bursts stand on (a check's held entries go as it settles), but no claim about the
peak itself is made from these numbers.

What the bursts are made of: the cold record producers, all in the check process.
A check pass installs no record workers, so facet extraction and barrel evaluation
run in-process, beside every check's cold scans and folds over every file; they do
not happen at all on a warm store. Each is transient (a scan's parse is garbage once
its record is written), so the peak is their concurrent working set plus the heap
the collector has not yet caught up with.

## Follow-ups

- **The cold-store peak.** Options: run a cold pass's record production off the
  check process (record workers, as the build does, so their heaps die with them),
  or bound how many cold whole-tree producers run at once. Needs a steadier peak
  measure first (a Linux VM, or the same pass with the host otherwise idle).
- **The module graph lives for the run**, keyed by the snapshot through a hand-rolled
  `WeakMap` chain. Every reader shares it, so it stays held; it could become a held
  memo too once its size is measured.
