# Build cache prunes off the critical path

Task: task-1793715799-6tkacn (under task-1793712666-aurzii, slow main builds).

## Problem

A no-change build did O(the machine's whole cache) filesystem work:

- `artifacts:detect` opened with `pruneWebArtifactCaches()` under the exclusive
  store lock: a readlink of every link of every dist on the host, plus a stat
  of every unreferenced store entry.
- `openCheckCache()` listed the whole check cache on every check run, and
  once an hour also stat'd every entry and every `flights/` file.
- The browser-host planner (`listArtifacts`) listed the whole store (~27k
  names) for a prefix, once per host, on every build.

## Measured (this host, 2026-11-03, during the file-metadata stall)

Read-only scans (`web-artifacts/scripts/measure-cache-scans.ts`; fs calls
counted from what each scan iterates, since Bun binds `node:fs` natively and
no sudo for `fs_usage`):

| what | entries | fs calls | wall |
|---|---|---|---|
| dist roots (prune) | 126 ns, 186 dist dirs, 448k links | ~448,700 | 100–150 s |
| store survey (prune) | 26.8k entries, 4.0k stats | ~4,000 + readdir | 7.5–9.8 s |
| CSS / vendors / package-assets | 532 | ~500 | 1.7–2.7 s |
| check-cache open-time readdir | 18.6k names | 1 listing | 2.0–2.8 s |
| check-cache hourly stat pass | 18.6k | 18.6k | 19–40 s |
| check-cache flights sweep | 56k | 56k | 36–89 s |

No-change build of the same tree, `artifacts:detect`:

| | detect wall | fs metadata in detect |
|---|---|---|
| before (main, builds 1793703830…1793714385, 0 stale) | 122–152 s | ~453k (prune) + ~1.2k `hasArtifact` + 2 × 27k-name store listings |
| after (this worktree, build-1793721113-qf5jo1, 0 stale) | **4.21 s** (source 0.00, identity 0.04, targets 3.85, registry 0.03, browser-hosts 0.28) | ~1.2k `hasArtifact` + 2 small index listings |

Check startup: before, one listing of 18.6k names per run (127.7 s once during
the stall) and the full sweep once an hour; after, one `mkdir -p` of the cache
dir.

The prune itself (now a scheduled job): unlocked phase ~115 s on this host
(stalled); locked phase 624 fs calls + the links of dists changed meanwhile
(1 here): 29 s stalled vs the whole ~150 s scan held under the lock before.

## Change

- Both prunes are hourly main-only supervised jobs (`web-artifacts.prune`,
  `checks.cache-prune`); no build or check run prunes. The build lease already
  keeps what a build composes, so a build needs no prune.
- `pruneWebArtifactCaches` is two-phase: unlocked dist scan (each dist stamped
  by its `artifacts/` inode+mtime before its links are read) + cache surveys;
  locked: leases, re-read of new/changed dists only, judge, re-stat victims.
- Browser-host builds are listed from a per-host index (`index/<group>/`).
- `detect` reports its sub-steps as profiler spans/log lines.

## Not done / follow-ups

- ~~The prune is still O(dists × links) when it runs (unlocked).~~ Done
  (task-1793730068-i1lch0): each dist's targets are memoized in the cache
  (`dist-links/`), valid while its `artifacts/` stamp matches, so a scan reads
  only the links of dists published since the last prune. Memoized by the
  scan rather than written at compose, so one writer covers every dist,
  including those composed before the change, and a memo can never be trusted
  past a change to the links it describes.
- The store grows with worktrees (~34k linked entries): carry-forward keeps
  every address a dist ever served while the cache holds it.
