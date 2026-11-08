# Dependency-store pool: supply is demand, 72 h late; the "30-min delete" was a sleeping laptop

Task: task-1794152871 (from the 24 h after-audit,
`research/2026-11-08-global-app-health-24h-after.md` §4 / §6 item 16).

## 1. Why stores were produced and consumed at different rates

Source: main's `worktree-cleanup`, `worktree-prepare` and
`worktree-spare-refill` log channels, 11-05 → 11-08.

| per UTC day | 11-05 | 11-06 | 11-07 | 11-08 (part) |
| --- | --- | --- | --- | --- |
| demand: installs (cold + adopted) | 73 | 88 | 3 | 29 |
| supply: stores harvested at reap | 47 | 35 | 95 | 83 |

- **A store is produced when its checkout is reaped.** The reaper takes a
  finished checkout only once it is `SAFE_REAP_AGE_MS` = 72 h old.
- **The lag is exact.** All 260 harvests came from checkouts created 72–80 h
  earlier (p10 72 h, median 73 h, p90 74 h; the `att-<epoch>` id is the
  creation time).
- **A store is consumed when a checkout is created** (a spare refill or a
  task add).
- Every checkout created is reaped once, so **supply(t) = demand(t − 72 h)**.
  It is the same series, shifted by three days.
- Launches swing from 3 to 88 a day, so today's supply and today's demand
  disagree by tens of stores in either direction.
- **The fixed bound could not buffer that shift.** `POOL_MAX = 2` deleted a
  quiet day's reaps, which the busy day after then installed cold.
- **Burst race.** The reaper harvests 3 at a time. Each harvest trimmed the
  pool to 2, so 3 concurrent trims `rm -rf`'d each other's just-published
  stores (11-07 20:16Z).

### Replaying the real event stream

| pool policy | cold installs (of 193) | stores deleted (of 260) | peak depth |
| --- | --- | --- | --- |
| count ≤ 2 (old) | 164 | 231 | 2 |
| count ≤ 10 | 128 | 195 | 10 |
| count ≤ 40 | 79 | 134 | 40 |
| age ≤ 7 d only (new) | 79 | 0 in window | 174 |

- **The model matches reality.** The ≤ 2 replay gives 66 / 72 / 0 / 26 cold
  installs per day; the real counts were 63 / 73 / 0 / 26.
- **Age-only per day: 49 / 30 / 0 / 0.** The 79 cold installs that remain all
  land in the first two days, before the pool had stock: it went live on
  11-05, and its first supply came from checkouts created 11-02.
- **Cost.** One waiting store measured ~18 MB of disk (`df` delta of a
  `cp -c -R` of a 1,107-package store; its files are APFS clones of bun's
  cache).

## 2. Why one pooled-store `rm -rf` "took 30 min"

It didn't: the machine was asleep.

- `pmset -g log` for 11-07 21:03–22:20 local (+0100): the laptop was on
  battery, in **Deep Idle**, with 2–5 s DarkWakes every ~16 min.
- `health-host` samples show matching `wallJumpMs` of 554–1041 s.
- The reap sweep started in the 20:16:09Z dark wake.
- The `rm -rf` "timed out after 1800000 ms" at 20:49:14Z, which is exactly
  the instant of a later dark wake.
- The child had been awake for about 11 s in total.
- **Bun's `setTimeout` counts sleep**, so every `spawnCaptured` `timeoutMs` was
  a wall-clock deadline: it fired at the first wake after the deadline had
  passed in wall time.
- **For comparison:** a foreground `rm -rf` of a whole store measured 50 s on
  this busy host (5–21 s in the 11-05 research).

## Fix

- **Pool** (`infra/worktree/server/internal/dep-store-pool.ts`):
  - no count bound — harvest only renames, and the reaper's sweep
    (`emptyDepStorePool`) is the one place a store is deleted, past 7 days of
    age;
  - this also removes the trim race and takes every `rm -rf` off the reap
    path.
- **Deadlines** (`infra/spawn/core/internal/awake-deadline.ts`):
  - `spawnCaptured`'s `timeoutMs` counts awake time, from `CLOCK_UPTIME_RAW`
    (new `readAwakeClock` in `packages/sleep-clock`);
  - when the timer fires, it re-arms for whatever awake budget is left;
  - this fixes every caller, not just this delete.
