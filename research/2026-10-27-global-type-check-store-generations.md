# Type-check stores: open and eviction in O(1) / O(evicted), not O(store)

Track: "Track: build and push speed" (wiki block-e5afc5b1-…), Rung 2 sub-page (block-a9e68ab6-…), item
"The stores' O(store) costs". Scoped to one task, so the plan stays in `research/`; the result goes to
the design sub-page and the track header.

## Context

After steps 3b–3d a type-check run costs what changed, except for the host-wide content-addressed
stores. They all go through `type-check/shared/pass-set.ts` (`openPassSet`):

- **Every open lists the whole directory** (`prune` → `readdirSync(dir)`) to read the count for the
  count backstop. A run opens 8 of them (name records, contracts, lint results, run-base roots +
  shards, walk-base roots + shards), and **every batch process of a cold run or global change opens
  the name store again** (`batch-worker.ts`).
- **Once an hour per store the open also stats every entry** (age sweep, `pruneIntervalMs`), inside
  whichever check happened to open it first.
- `readContract` does a `utimesSync` on **every** read (`touch` = mtime as last-used), a write
  syscall per contract read.

### Measured now (this host, 2026-10-27, Python `listdir` + `stat`, which matches the syscalls)

| Store | Entries | Size | readdir, cold cache | readdir, warm | Stat sweep, cold cache | Stat sweep, warm |
| --- | --- | --- | --- | --- | --- | --- |
| type-check-contracts | 194,440 | 0.82 GB | 3.0 s wall, 0.55 CPU-s | 1.0 s, 0.40 | **41.9 s wall, 8.6 CPU-s** | 11 s, 6.3 |
| type-check-walk-shards | 134,730 | **6.6 GB** | 0.9 s, 0.36 | 0.23 s, 0.18 | 7.0 s, 3.8 | 0.7 s, 0.7 |
| type-check-run-base-shards | 101,586 | 0.63 GB | 0.8 s, 0.23 | 0.15 s, 0.14 | 5.7 s, 2.9 | 0.8 s, 0.6 |
| type-check-name-records | 50,234 | 0.36 GB | 0.26 s, 0.09 | 0.06 s, 0.06 | 2.7 s, 1.6 | 0.4 s, 0.3 |
| type-check-lint-results-v3 | 22,168 | 0.19 GB | 0.2 s, 0.05 | 0.02 s, 0.02 | 1.0 s, 0.6 | 0.2 s, 0.15 |

- The contracts sweep (8.6 CPU-s, 7.4 of it system time) is the 9 CPU-s spike seen in a worker.
- Opening every store costs ~1 CPU-s warm and up to ~5 s wall cold, on a run whose real work on an
  unchanged tree is 0.5 CPU-s. All of it is linear in entries, so it grows with the store, which grows
  with the repo × trees seen in 14 days.
- **The contracts store is at 194k of its 200k count bound.** When it trips, every open that sees it
  over the bound sorts and trims 34k entries by mtime: the backstop is about to become the evictor.
- Side finding, not fixed here: walk shards average 49 KB, 6.6 GB in total. That is a size-per-entry
  problem, not an open cost. Will be filed as a follow-up.

## Design: generations instead of per-entry ages

The age bound needs "when was this entry last used". Today that is each file's mtime, so knowing which
entries expired requires a stat of all of them: O(store) by construction. Store the age in the
**directory** instead:

```
<store>/g<N>/<sha256(key)>.json    N = floor(now / period), period = maxAgeMs / GENERATIONS
<store>/g<N>/.writes               one byte appended per record (O_APPEND): the gen's write count
```

- **Write** (`record`): into the current generation (tmp + rename, as today).
- **Read / has**: probe the generations newest first, at most `GENERATIONS` (4) `stat`/`open` calls.
  A hit in an older generation is **promoted** on `read` and `touch`: `link()` it into the current
  generation, which is O(1) and atomic, and leaves the old one where it is. So the bound is **least
  recently used**, as today's touch-on-read intends. The promotion runs at most once per entry per
  period, not once per read: the per-read `utimes` on contracts goes away.
- **Eviction**: an open lists only the store's top directory (≤ `GENERATIONS` + 2 names), and a
  generation older than the window is renamed to `.trash-*` (atomic, so a concurrent opener sees it
  gone or not, never half) and removed. Cost: what is evicted, once per period per store, never the
  live entries. Removal can run detached, so a check never waits on it (decide in implementation;
  measure first).
- **Count backstop**: an open stats the `GENERATIONS` `.writes` counters (O(1)). Over `maxEntries`,
  drop the oldest generation early. Coarser than today's trim-to-N, and only a disk guard; age stays
  the intended evictor.
- **Lifetime**: an entry used last at t survives at least `maxAge × (G−1)/G` and at most `maxAge`.
  With G = 4: 14 d stores keep 10.5–14 d; 7 d roots keep 5.25–7 d.
- **No clock coordination**: the generation is derived from the clock, so concurrent processes and
  worktrees agree without a marker. `.last-prune` and `pruneIntervalMs` go away.

`PassSetBounds` becomes `{ maxAgeMs, generations, maxEntries }` (`trimTo`, `pruneIntervalMs` removed:
tsc flags every store's declaration). `PassSet`'s interface (`has/read/record/touch`) is unchanged, so
`name-store.ts`, `lint-results.ts`, `run-base.ts`, `walk-base.ts` change only their bounds.

### Invariant that becomes checkable

`run-base.ts` / `walk-base.ts` rely on "every shard outlives every root that names it":
`ROOT.maxAge + TOUCH_AFTER_DAYS < SHARD.maxAge`. With generations the shard's guarantee is its
**minimum** lifetime, 10.5 d, against 7 + 3 = 10 d: it still holds, barely. `pass-set.ts` exports
`minLifetimeMs(bounds)`, and both modules assert the invariant at load (rung 4, loud), replacing the
comment. If it fails, the fix is G = 5 or a shorter `TOUCH_AFTER_DAYS`, chosen when measured.

Walk base: "a shard gone since `openWalkBase` checked it throws". That holds today too (the hourly sweep
can delete a 14 d shard mid-run). With promotion on `touch`, a shard the open checks is promoted, so a
generation drop mid-run cannot remove it. Check in implementation that `openWalkBase` touches or
reads what it checks.

### Migration: keep the host warm

The existing flat `*.json` entries are read as an **extra, oldest generation**. A hit promotes it into
`g<N>` like any older generation, so nothing goes cold. The flat entries are deleted by one sweep once
`maxAgeMs` has passed since the first generation directory was created (its birth time). That is one
O(legacy) pass per store, once ever, run detached. The alternative, new `-v2` data dirs, would cost
every host one cold check (~400 CPU-s) for no gain.

### Not chosen

- Hash-prefix subdirectories with an amortized sweep: smaller opens, but the sweep's total work per
  period is still O(store).
- An SQLite index with a last-used column: O(evicted) sweeps, but a row write per read from
  concurrent processes, plus a second source of truth beside the files.

## Files

- `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/pass-set.ts`: the
  generation layout, promotion, O(1) open, generation drop, legacy generation, `minLifetimeMs`.
- `…/shared/name-store.ts`, `lint-results.ts`, `run-base.ts`, `walk-base.ts`: the new bounds, and
  the invariant asserted in the two base modules.
- `…/shared/pass-set.test.ts` (new): lifetime bounds, promotion, concurrent rotation (two openers
  racing a drop), the legacy generation read, promotion and expiry, and the count backstop.
- `…/scripts/store-bench.ts` (new): the growth benchmark below. It runs against a temporary
  `SINGULARITY_DIR`, never the live stores.
- `…/data-dirs/index.ts`: descriptions mention the generation layout (the reclaim audit reads
  directories).
- Worker cost line: add `storeOpen` ms per run. Fleet logs then show the floor without a profiler.

## Verification

1. **Growth curve (before/after)**: `store-bench.ts` builds synthetic stores of 25k / 100k / 200k /
   800k entries and measures the open (cold and warm page cache, `purge` between) and a full
   eviction, CPU split into user and system. Expected: before is linear, with an 800k sweep around
   35 CPU-s; after, the open stays flat (≤ 10 syscalls) and eviction scales with the evicted
   generation only.
2. **End to end on the real tree** (`./equin check type-check --jobs 1`, isolated `SINGULARITY_DIR`
   seeded by copying today's stores, so the before and after sides start from the same 194k
   contracts): unchanged tree with the sweep due and not due, hub body edit, and a cold run with its
   batch processes. Report end-to-end CPU-s, the worker's system time, wall and `storeOpen`.
3. **Correctness**: `./equin test plugins/framework/plugins/tooling/plugins/checks/plugins/type-check`
   (106 existing plus the new pass-set tests). `walk-replay.ts` over a few trees on the generation
   store: 0 divergences. One run across a forced generation boundary (a fake clock in the test, and a
   real run with `period` shortened through a test-only bound).
4. `./equin build` green, then the before/after table goes to the design sub-page ("Step 3e result")
   and the track header, and the next task is filed (git's stat floor via fsmonitor, or the walk-shard
   size).
