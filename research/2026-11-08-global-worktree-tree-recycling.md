# A new checkout starts from a reaped one

Task: task-1794172113 (responsiveness audit, supervisor task-1793965642-94fdhj).
Follows research/2026-11-08-global-fseventsd-event-volume.md: fseventsd at ~1 core
under load, folder watches delivered late (p99 11–39 s), and checkout writes the
largest event source (~43.6k events per checkout, 25–50 % of all events in a busy
hour).

## Layers

**Why 10–20 checkouts an hour?** Not spare churn. From the `worktree-spare-refill`
and `worktree-prepare` channels on main:

| day | spares written | claimed | fresh (pool empty) | pruned unclaimed |
| --- | --- | --- | --- | --- |
| 11-04 | 57 | 57 | 42 | 1 |
| 11-05 | 87 | 86 | 21 | 0 |
| 11-06 | 46 | 45 | 40 | 0 |
| 11-08 | 46 | 46 | 34 | 0 |

A spare is one launch's checkout written early; one is pruned unclaimed about once
a week. So checkouts = launches (80–130 a day, bursts of 10–20 an hour). The pool
sizing (target 1) decides only *when* a checkout is written, never how many.
Shrinking or growing it changes no event count.

**Why is one checkout ~33k events?** Every tracked file is written (23,165
files), from an empty dir. Then 72 h later the reaper `rm -rf`s the same files:
another ~23k+ events.

**Must the files be written?** Only those that differ from the target. A reaped
checkout is ~3 days behind `main`:

| tree age | files differing from main | commits |
| --- | --- | --- |
| 24 h | 1,590 | 88 |
| 72 h | 2,773 | 170 |
| 96 h | 4,793 | 315 |

## Options weighed

- **Refresh the spare in place** — the claim already switches with a two-tree
  checkout (diff only); the spare's own creation is the full write. No gain.
- **Directory clone (`clonefile`) of a template checkout** — one event instead of
  23k, but a directory clone holds the volume's rename lock for its whole run
  (research/2026-11-05-global-bulk-tree-mutations-rename-lock.md: 0.2–1.9 s per
  install-sized clone, every `rename` on the disk waits), and the clone's inodes
  differ, so the first `git status` re-hashes every file. Rejected.
- **Recycle the reaped checkout** (chosen) — the reap already produces a whole
  tree; keep it with its git index. `git reset --hard <target>` with that index
  trusts the stat data of every unchanged file and writes only the diff;
  `git clean -ffdx` removes what the old agent left. No rename lock (a dir
  rename is O(1)), and the reap's delete of the tracked files disappears too.

## Measured (prototype, a clone in $EQUIN_SCRATCH)

Tree at main − 76 h, renamed (as the pool does), with an edited tracked file, an
untracked file, ignored output and a `node_modules`. Counted as entries written
or deleted (ctime / listing); an FSEvents client was also run, but under a burst
fseventsd coalesces, so its counts are a lower bound only.

| step, per checkout | before | after |
| --- | --- | --- |
| write the tracked tree | 23,165 files, 5.1 s | 2,771 files, 1.1 s (+ clean 0.5 s) |
| delete it at reap | ~23.2k files (`rm -rf`, 19.6 s) | 0 (kept; deleted only at the 3-day expiry) |
| dependency re-link onto an adopted store | ~0.7–0.8k entries | ~0.7–0.8k entries (unchanged) |
| **total** | **~47k** | **~4–6k** (−90 %) |

Corrected 11-08 (research/2026-11-08-global-dependency-relink-cost.md): this
row first read 12.4k entries, which no re-measurement reproduces — two real
adopted installs on main changed 665 entries each, and the scratch replay
800 (5 new packages). The totals are recomputed from it.

`git status --porcelain --ignored` empty afterwards. A rename probe in another
dir during reset + clean: max 0.9 ms (0.3 ms idle) — no rename-lock hold (a
directory clone held it 183–542 ms in the 11-05 research): the tree's move is
one `rename`, the rest is per-file writes and unlinks.

## Isolation: nothing of the old checkout survives

- Untracked and ignored files (build output, `node_modules`, local settings
  files): `git clean -ffdx`; the tests assert `status --porcelain --ignored` is
  empty.
- Tracked edits, modes, symlinks: `reset --hard` compares every index entry with
  its file (stat data) and the target. The one hole — an entry flagged
  skip-worktree / assume-unchanged, which git never compares — is refused
  (`assertNoTrustFlags`; the recycle falls back to an empty start; tested).
- Per-worktree git state (rebase/merge state, `ORIG_HEAD`, HEAD reflog,
  `refs/bisect`, `refs/worktree/*`, `config.worktree`): all in the admin dir,
  which is new; only the index file is carried. The stash and hooks are
  repo-wide (`refs/stash`, tracked `.githooks`), shared by every checkout
  before this change too.
- Per-worktree DB, data dir, socket: keyed by the checkout's name
  (`~/.equin/worktrees/<name>`), never inside the tree.
- Known: a `.gitattributes` EOL/filter change between the two commits leaves an
  unchanged-blob file as the old checkout wrote it; the repo uses only
  merge drivers there.

## How many wait

Bounded by age, not count: a tree waits at most 3 days (`TREE_POOL_MAX_AGE_MS`),
then the reaper's sweep deletes it — the same `rm -rf` the reap ran before, just
later. Supply is the reap rate (every checkout, 72 h after it was made) and
demand is the launch rate, so in steady state the pool stays near empty; it
grows only while launches fall below the reaps of 3 days earlier, to at most 3
days of reaps (≤ ~300 at 100/day). A waiting tree is ~170 MB of real files
(no `node_modules`: its store went to the dependency-store pool), so the worst
case is ~50 GB for 3 days — less than the 72 h every one of those checkouts
already held on disk with its `node_modules`. A waiting tree makes no file
events. None waiting: every file is written, as before (`TreeStart.empty`).

## Not changed

- **The dependency re-link (~0.8k entries per checkout, ~1.2k with the
  `git clean` of the old links)** — bun writes only the top-level and
  workspace links plus what the lock changed; it does not rewrite the store's
  own links (re-measured, research/2026-11-08-global-dependency-relink-cost.md).
  Keeping the recycled tree's `node_modules` whole would save ~1k of it, but bun
  never prunes a top-level entry the lock dropped (dep-store-pool.ts), so it
  needs a prune of dropped links first. Not done: the tracked-tree diff is the
  larger cost.
- **fseventsd CPU after** — the pool fills only as the reaper takes 72 h-old
  checkouts after main deploys this; measure the `tree recycled` share in
  `worktree-prepare` / `worktree-spare-refill` and fseventsd CPU in
  `~/.equin/logs/monitors/fs-latency.jsonl` a day later. Before (11-08, hourly
  medians): fseventsd 100–103 % CPU at load 7–27.
