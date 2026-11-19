# The cold check pass's peak is collector slack, not records

2026-11-19. Follows `2026-11-19-global-check-pass-memory-release.md`, whose open item
was: a cold check pass (no plugin record made yet, the first update after an install)
peaks its process at 2.4–6.4 GB on the Mac against ~1.6 GB warm, "the record producers
running together", with a 2× swing between identical runs. Task: fix the cause, then
prove the first cold deploy on a fresh 8 GB Linux host.

## Result

- **The peak is what JavaScriptCore lets pile up before a full collection, against
  the machine's whole RAM.** After a full GC with H live, JSC lets the heap reach
  about (1 + 2·e^(−2H/RAM))·H (`packages/heap-pacing`). The check process was the one
  heavy bun process the repo did not pace. With H ≈ 1.4 GB in a cold pass, that is
  ×2.9 on the 64 GB Mac (4.1 GB) and ×2.4 on an 8 GB host (3.4 GB): the 4.05 GB Mac
  peak and the 3.1–3.7 GB Linux peaks.
- **Fixed: every check pass is paced at 2 GB** (`CHECK_PROCESS_RAM_BYTES`): a build's
  or push's check child (`runCheckSubprocess`) and a direct `./equin check` (the
  `./equin` shim). A pace this repo sets is now the process's own (marked
  `EQUIN_HEAP_PACED`), so the type-check worker still runs at its profile's
  (4 GB, or 1.5 GB on one unit) and its batches at the worker's.
- **Measured on a fresh 8 GB Ubuntu VM:** the cold pass's process peaks at 2.26–2.56 GB
  instead of 3.09–3.43 GB, for +10–15 % wall time.

## How it was split

### Serial vs parallel (Mac, cold records, every check but type-check)

| run | peak footprint | wall |
| --- | --- | --- |
| `--jobs 1` | 1.73 GB | 96 s |
| unbounded (2 runs) | 1.63, 1.68 GB | 108, 178 s |
| `--jobs 8` | **4.05 GB** | 110 s |

Width is not the lever: one `--jobs 8` run reached 4 GB while two unbounded ones
stayed under 1.7 GB. That run's footprint, sampled every 250 ms, climbed linearly from
0.77 to 4.05 GB over 6 s, then fell to 1.47 GB in one step and stayed flat for ~10 s.
That is one full collection: the mutator allocating through a long concurrent mark,
then the sweep. Those ~10 s of held thread are what the run's
`check-thread-stall` reported (7.7 s "in" `tree-fold.ts:336`, a loop that allocates).

### The producers alone (Mac, cold, in-memory or SQLite store)

| work | peak footprint | live after GC |
| --- | --- | --- |
| one cold fold over 18k files (theme-bridge-reads) | 0.26–0.37 GB | 0.13–0.19 GB |
| four cold folds at once | 0.37 GB | 0.21 GB |
| relocate's fold over all 26k files | 0.34 GB | 0.13 GB |
| every barrel of every runtime evaluated | 1.24 GB | 0.79 GB (20.5k modules) |

No producer is large by itself, and overlapping them does not add up. The live heap a
pass stands on is what matters: the evaluated barrels' ~20k modules (which a module
cannot unload, and which the live declaration passes import on warm runs too) plus the
pass's held memos. The cold producers' allocations then fill the collector's slack
above it.

### On the target: 8 GB Ubuntu 24.04 VM, 4 CPUs

Fresh `install.sh --terminal` of main (99a2d79171), then the post-install record
caches restored before each run (build records as the install left them, check
records cold, as on a first update). Every tree and deploy check but type-check and
layout-geometry, `--no-cache`, unbounded. Check process `RssAnon`, sampled every 0.2 s:

| heap pace | peak RssAnon | settled at the end | wall |
| --- | --- | --- | --- |
| none (the machine's 8 GB) | 3.09, 3.43, 3.20 GB | 1.9–2.3 GB | 66–78 s |
| 4 GB (`HEAVY_PROCESS_RAM_BYTES`) | 3.49 GB | 2.3 GB | 84 s |
| **2 GB** | **2.26, 2.56 GB** | 1.65 GB | 81–84 s |
| 1.5 GB | 2.54 GB | — | 89 s, 19 s of stalls |
| none, warm records | 1.78 GB | — | ~20 s |

The longest cold producer is the source-scope slot naming
(`evaluateAllBarrels`: every server / machine / cli / e2e barrel imported live,
because the install's build evaluated only the web ones), 48 s of the pass, during
which the process climbs from ~1 to ~3.4 GB.

## Why pacing, and not moving record production off the process

Producing cold records in workers would move each producer's garbage into a heap
that dies, but the producers themselves are small (above), and barrel evaluation
must stay in one realm with the live declaration passes (plugin-records' CLAUDE.md,
"Misses on worker threads"). What made the peak was the collector's policy against
RAM the process does not have. The repo already paces its other heavy processes
for exactly this, and the check pass was the omission.

## Not done

- **The live floor**, ~1.4 GB in a cold pass and still ~1.65–2.3 GB of RSS once it
  settles (freed pages Bun keeps, `2026-11-18-global-cold-check-pass-memory.md`):
  mostly the ~20k modules every pass loads to read barrels live.
- **`check-thread-stall` reports on main** (report-1794956977-7e0zb4,
  report-1794456158-edud7b): the 7.7 s one in this note's `--jobs 8` run was a
  full collection of a 4 GB heap. Pacing makes collections smaller and more
  frequent, but the 1.5 GB pace showed more stall time, not less, so this note
  does not claim them fixed.
- **What else now runs at the check pass's 2 GB pace**: JSC's option is per
  process, so type-check's prepare thread (a Bun Worker inside the check process)
  runs at 2 GB too. That is unmeasured here, and the deploy's own run on the 8 GB VM is
  the measurement. live's read-misuse compile probe, a child of its own, is
  paced as a heavy process (4 GB) instead of inheriting the pass's pace.
