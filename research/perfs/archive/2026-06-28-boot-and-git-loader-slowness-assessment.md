# Perf assessment: boot-snapshot & git-derived loaders are slow — and it isn't the cache layer

**Date:** 2026-06-28
**Scope:** Why the app feels slow despite repeated caching/snapshot work, and whether
adopting a battle-tested sync engine (Rocicorp Zero) would fix it.
**Verdict:** **No — do not adopt Zero as a performance fix.** The dominant costs are
server-side *work* and *contention*, not client↔DB transport latency. Zero replaces the
one layer that is **not** the bottleneck, and its worst-case offenders (git/filesystem-derived
resources) cannot live in a Postgres replica at all. Fix the root causes below instead.

---

## 1. Method

- Pulled the live runtime profile of **main** (`get_runtime_profile`, worktree `singularity`,
  kind `all`).
- Cross-checked the slowest DB query with `EXPLAIN (ANALYZE, BUFFERS)` against the same DB.
- Measured table sizes / row counts directly.

All numbers below are from that single profiling window on main.

## 2. Evidence

| What | Recorded | Nature |
|---|---|---|
| `GET /api/resources/boot-snapshot` | **7.77 s** | pure work |
| `GET /api/plugin-view/tree` | **14.3 s** | pure work (studio route, not a hot path) |
| `edited-files` resource (under subscription) | **7.71 s** | git I/O on first-subscribe |
| `commits-graph.delta` (under subscription) | **7.32 s**; of the loader's 4.89 s avg only **126 ms is real work** — the rest is *waiting* | head-of-line blocking |
| `live_state_snapshot` persisted read (23 keys, one query) | **1.88 s** | bloat (see below) |
| `tasks` rank query *as recorded* | **1.19 s** | **0.12 ms in Postgres** — pure queueing |
| `live_state_snapshot` table | **102 MB for 20 live rows** | dead-tuple bloat from ~5 000 churny UPSERTs |
| `pg_snapshot_xmin(...)` calls | 8 706 | live-state watermark churn |

### The decisive measurement

The `tasks` rank query was recorded at **1 193 ms**. Run directly against the same DB right now:

```
Index Only Scan using tasks_folder_rank_idx on tasks  (actual time=0.059..0.082 rows=45)
Execution Time: 0.123 ms
```

**0.12 ms.** The query is correctly indexed and fast. The recorded 1.2 s is the result
sitting in a queue while the runtime is blocked — **not** slow SQL. This single fact relocates
the entire problem away from the caching/query layer.

## 3. Root causes

### A. Git-derived loaders on the critical path (`edited-files`, `commits-graph`)

`computeEditedFiles` (`plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts`)
shells out to **four** git invocations (`merge-base`, `diff --name-status`, `status --porcelain`,
`diff --numstat`) plus per-untracked-file byte scans, all under a host-wide
`withHeavyReadSlot` gate. First-subscribe for a conversation pays the full cost; the
`commits-graph.delta` numbers show **~4.7 s spent waiting for a slot**, not working.

This data is the **git/filesystem state of a worktree**. It does not live in Postgres and
**cannot be served from a Postgres replica** — so no sync engine can touch this path.

### B. Event-loop / heavy-read-pool starvation

While the heavy git reads run, everything else queues behind them — that's why a 0.12 ms
indexed query is recorded at 1.2 s (cause A → symptom B). The host-wide `withHeavyReadSlot`
budget serializes git across worktrees, so a burst of subscribers (many conversations, a
review, cold boot) head-of-line-blocks each other. The DB is idle; the **server process** is jammed.

### C. `live_state_snapshot` table bloat

**102 MB to hold 20 logical rows.** Thousands of dead tuples from ~5 000 churny `UPSERT`s that
autovacuum can't keep up with. Consequence: the boot-snapshot's *own* "fast path" — a single
batched read of 23 persisted rows — takes **1.88 s**. The persistence layer built to make boot
fast is now slow *because of how it writes*.

### Putting boot-snapshot's 7.77 s together

`handleBootSnapshot` (`plugins/infra/plugins/boot-snapshot/server/internal/handle-boot-snapshot.ts`)
= one persisted read for keys that have a row + a `loadResourceByKey` fallback for keys that
don't. So **7.77 s ≈ 1.9 s bloated persisted read + ~5.8 s of loader fallbacks** for keys with
no persisted row. Both halves are fixable directly (C for the read; "why are keys missing a
persisted row?" for the fallbacks).

## 4. Why the prior caching work didn't move the needle

This is the user's own observation, and the code confirms it. The edited-files path *already* has:
a per-worktree memo with a generation signature, a `@parcel` watcher acting as the authoritative
writer, `withHeavyReadSlot` admission, single-flight collapse. Boot *already* has an L2 persisted
single-query snapshot and an L3 "no boot recompute unless tables changed" read-set. (See the
2026-06-14 → 2026-06-23 research docs.)

Layers of cache are already present **and it's still 7 s.** That is the signal that the fixes were
applied one layer too high: caching the *output* of a producer that is slow, synchronous, and
event-loop-blocking does not help when (a) cold/first-subscribe still pays full compute, (b) the
heavy-read gate serializes those computes, and (c) the cache's own storage is bloated. The bug
is not "our cache is homemade" — it's "we cache things we should not compute synchronously on the
hot path, and our cache table is thrashing."

## 5. Why Zero specifically would not fix this

- **Zero replicates Postgres tables.** The two worst offenders (`edited-files`, `commits-graph`)
  are git/filesystem-derived and **cannot be replicated**. Migrate tomorrow → boot is still ~7 s.
- **A blocked event loop stays blocked.** Zero adds a second replicating process; it does not
  unblock the git I/O starving the runtime.
- **You still have to compute the snapshot.** Zero changes *where queries run*, not whether the
  underlying work is expensive.

Keep Zero on the table for the day equin wants **multi-device / offline sync** — that's a
real reason. Decouple that from this performance problem.

## 6. Recommendations (each must be benchmarked before/after)

The work below is created as tasks. The non-negotiable constraint on every one: **investigate the
root cause first (why is the original operation slow?), and produce an empirical before/after
benchmark** — not "add another cache and call it faster."

1. **Benchmark harness (prerequisite).** A repeatable, cold-cache measurement of: boot-snapshot
   total + per-key source/timing, edited-files first-subscribe, commits-graph first-subscribe,
   and event-loop lag during the burst. Reset the profiler, drive a cold load, capture numbers.
   Every other task reports its before/after through this.
2. **Root-cause the git loaders off the critical path.** Why does first-subscribe cost 7 s, and
   why does `commits-graph` spend 4.7 s *waiting*? Profile the four git spawns + the heavy-read
   gate; make the data lazy/post-paint and bound git concurrency so it stops starving the loop.
3. **Fix `live_state_snapshot` bloat.** Root-cause the write amplification (5 000 UPSERTs, churn),
   then reduce write frequency / tune autovacuum / one-time `VACUUM FULL`. Target: the 23-key
   persisted read drops from 1.9 s to low-ms.
4. **Root-cause boot-snapshot loader fallbacks.** Identify which boot-critical keys lack a
   persisted row (forcing the ~5.8 s of from-scratch loads) and why; close that gap.
5. **Confirm event-loop starvation is gone.** After 2–3, verify the phantom 1.2 s indexed-query
   recordings disappear (health-monitor event-loop lag + re-profile).
