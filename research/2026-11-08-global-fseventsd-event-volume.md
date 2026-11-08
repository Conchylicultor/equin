# fseventsd saturation: where the file-event volume comes from

Task: task-1794161254 (responsiveness audit, supervisor task-1793965642-94fdhj).
Symptom: folder watches (all on FSEvents) deliver events 0.1–30 s late under host
load; fseventsd at ~100 % CPU.

## Method

No root on this host, so no `fs_usage` / fseventsd internals. Instead, a
user-level FSEvents client (`kFSEventStreamCreateFlagFileEvents`, latency 0.2 s,
`NoDefer`) on `/` counts every event fseventsd delivers, bucketed by path
(Swift, outside the repo). These are fseventsd's *output* events (after its own
per-path coalescing), so they are a lower bound on what it processes. Delivery
latency is measured by a second client that creates one file per second in its
own empty directory and times create → callback.

## The daemon

From `~/.equin/logs/monitors/fs-latency.jsonl` (hourly medians, UTC, 11-08):

| hour | fseventsd CPU | load1 | new vnodes/s | disk write ops/s |
| --- | --- | --- | --- | --- |
| 00–11 | 0.1–0.5 % | ~0.9 | ~4 | ~18 |
| 13 | 0.7 % | 2.8 | 49 | 60 |
| 14 | 2.2 % | 5.9 | 2,223 | 226 |
| 15 | 107 % | 19.8 | 14,504 | 853 |
| 16–18 | 103–113 % | 24–33 | 14–20k | 820–1,070 |

One thread holds nearly all of it (`ps -M`). The CPU rises ~50× when file activity
rises ~6×: once fseventsd is at one core it queues, and delivery latency is that
queue.

## Delivery latency (before)

- Quiet probe dir, 90 s at load ~27: **p50 468 ms, p90 2.5 s, p99 11.5 s**, 9/90 not
  delivered by the end of the run.
- A burst of 20k file creates (7 s) in an UNRELATED /tmp dir: the probes written
  during the burst arrived **91–99 s** late; probes written after it, ~0.4 s. So
  delivery is not FIFO: one bulk tree mutation anywhere stalls unrelated watches
  for over a minute.
- 10 extra `/` file-event clients: p99 1.9 s → 6.1 s (noisy, but fseventsd's work
  is events × receiving clients, not events alone).

## Who generates the events

10-minute whole-machine sample (19:18–19:28 CET, load 20–29): **282,733 events,
471/s**.

| source | share | notes |
| --- | --- | --- |
| worktree checkouts `.claude/worktrees/*/plugins,research,config,…` | 25 % | almost all from ONE spare being created (below) |
| worktree `node_modules` | 12 % | installs / re-links |
| `~/.equin/cache/web-artifacts/store` | 7 % | |
| Postgres `data-pg18/base` | 6 % | DB forks: 1–2k events per database copied |
| `~/.equin/cache/check/flights` | 3 % | one flight file per (check, sig, tree) per run |
| `~/.equin/worktrees/*/web-addresses` | 2.4 % | |
| `/private/tmp/node-compile-cache` | 2 % | |
| `.git` (objects, worktree index/locks) | 1.5 % | |
| type-check stores (`type-check-*`) | 1.8 % here — **58 %** of a 1-min sample at 19:12, 38k events in another 3-min sample | bursty: a whole-tree lint rewrite |
| dependency-store pool `.claude/worktree-dep-stores` | **0** | waiting stores are inert |
| a test's `/private/tmp/pw-race-*` | ~15 % | transient |

### Spare checkouts: ~45k events each, 10–20 an hour

A 5-minute sample of `.claude/worktrees/` caught one spare being made:
**43.6k events** (checkout 33k: plugins 29.1k, research 2.4k, config 1.1k; install
10.5k with a pool-adopted store). Checkouts ran at 10–20/h this afternoon
(`.git/worktrees` names), so ~120–240 events/s ≈ **25–50 % of all events**. Each
is reaped (an `rm -rf` of the same tree) 72 h later.

### Type-check stores: whole-tree rewrites, ~3 an hour

Every type-check store is one JSON file per entry (`shared/pass-set.ts`); each
record is a tmp create + write, a rename, and a rewrite of the generation's
`.writes` counter. Counters on 11-08: the lint store took **246k writes in 6.5 h
for 15.4k files** (name records 109k, contracts 109k): ~105k store writes/hour.
Runs that rewrote ≥ 5,000 lint entries after 13:20: **18**, each ~15.4k entries:

- 7: the lint ENGINE moved (`rules moved (125 groups)`) — every group of every file;
- 6: one rule group moved (one lint contribution edited) — still every file's entry;
- 3: a fresh worktree whose HEAD had no stored run base (`base none`);
- 2: unattributed.

Engine moves on main, 11-01..11-08 (461 first-parent commits), recomputed per
commit from the engine's inputs: **20**. Of those, **8 came from files that
cannot change a lint message**:

| cause | moves |
| --- | --- |
| `packages/timed-fs` (the stylesheet reader's file I/O) alone | 4 |
| `patches/` of packages no rule loads (graphile-worker, @parcel/watcher) — with their lockfile / package.json lines | 4 |
| lint/core builder, worker, @utility set, real dependency, tsconfig | 12 |

Each engine move costs every active worktree one whole-tree re-lint once it
rebases: 500–800 CPU-s (a load source in itself) and ~15k × 3 file events.

### The dependency-store pool (for decision D20)

Measured 0 events from `.claude/worktree-dep-stores` in every sample: a waiting
store is a renamed directory nobody touches. Its event cost is at the edges:
adoption (the 10.5k-event re-link above, against a cold install's full clone)
and deletion (an `rm -rf` of ~75k entries). Keeping stores until 7 days deletes
each at most once; the old `POOL_MAX = 2` deleted 231 of 260 harvested stores,
each such delete followed by a cold install. On file-event volume, retention is
cheaper than the bound it replaced; what it holds costs disk only.

## What landed

The lint engine (the runtime import closure of `lint/core/build-lint-config.ts`)
no longer reaches the stylesheet reader: `buildLintConfig`,
`loadLintContributions` and `typeAwareLintGroups` take the `@utility` set as
data (`declaredUtilities`), read by each caller with `readDeclaredUtilities` —
the same pattern as the exemption manifests. The engine now reaches `lint/core`
and `exempt/core` only (held by `lint-groups.test.ts`'s `ENGINE_FOLDERS`);
`timed-fs` and `user-path` edits no longer re-lint anything. On last week's
history this removes 4 of 20 engine moves, so roughly one whole-tree re-lint per
active worktree every two days. The edit itself moves the engine once.

## After

Measured right after the build at comparable load: see the task's outcome report.
The engine-move effect is measured over days (`rules moved (125 groups)` count
in check transcripts), not minutes.

## Not done here (follow-ups)

- **Patches of packages lint never loads** still move the engine (4 of 20).
  Needs the lint engine's npm closure to decide which patches count.
- **One rule group's edit rewrites all 15k entries** (one entry per file holds
  every group): 6 of 18 rewrites today.
- **Fresh worktrees with no HEAD base** re-lint the whole tree (3 of 18).
- **Spare checkouts** are the largest event source (~45k each). The volume is
  in the checkout itself (git writes every tracked file); avoiding it means a
  different way to materialize a tree (e.g. a directory clone, which has its own
  cost: it holds the volume's rename lock, see
  research/2026-11-05-global-bulk-tree-mutations-rename-lock.md).
- **`pass-set.ts` rewrites the `.writes` counter on every record/promotion**
  (~1/3 of a record's events, ~1/2 of a promotion's). Not changed here: the file
  is in the type check's producer sources, so editing it re-checks every file in
  every worktree once.
- **Machine settings** (need the user's approval, not done): Spotlight exclusion
  of `~/.equin/cache` and `.claude/worktrees` (mds was not busy in any sample, so
  low value); moving high-churn data to a separate APFS volume
  (fseventsd's per-volume history log can be disabled there).
