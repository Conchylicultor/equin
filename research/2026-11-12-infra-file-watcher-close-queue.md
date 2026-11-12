# Children-watch closes of 6–42 s: one open listing 690k files under the kqueue lock

Task: task-1794466989-dtdnml. Reports: `report-1794188653-6df5ej` (slow-op
`bg file-watcher.dir-entries:stop`, up to 12–42 s) and
`report-1794229800-x57z5t` (op-time: 838 s across 137 closes in one window).

## What the stall looked like (main, 2026-11-12 00:32:52–00:33:17Z)

The trace for one slow close (`traces` 9a5f5e76…) holds the backend's open
spans at the moment it ended:

- 44 `sub start:files.computer.peek` and 59 `bg file-watcher.dir-entries:stop`
  spans, opened within ~2 s of each other. The first was a peek
  subscribe, 3 ms before the first close.
- Every close ended within the same 2 ms, with identical durations
  (12,365 ms). A serial queue of closes would spread its end times out.
  These all waited on one thing.
- One peek subscribe waited **15.8 s in `fs-stat`**. A plain `stat` is
  microseconds, unless no thread is free to run it.
- Host load was 4.8 on 18 CPUs. The host was not under pressure.

The peeks came from the file explorer. Each visible folder row holds a
`children` watch of its folder (`files.computer.peek`), and closes it when the
row leaves the view. The peeked folders included `~/.equin/cache`,
`~/.claude`, `~/.config` and the prototype folders. That churn is the UI doing
its job: one watch per visible folder, released when the folder is no longer
shown. The churn was not the problem.

## The cost, split

| part | measured | how |
|---|---|---|
| the close itself (`KqueueBackend::unsubscribe`, alone) | **0.1–0.3 ms** | `scripts/measure-close-burst.ts`, 10 solo closes |
| queue: closes waiting on 60 small opens and closes (40 entries each) | p90 60–100 ms | same script, burst |
| queue: closes waiting on ONE open of `~/.equin/cache` | **37,294 ms** | scratch script, 20 closes queued behind it |
| that open | **37,293 ms** | same |
| a plain `stat()` during it | **37,286 ms** | same |

So the close is free. Its whole time is queue wait, and the queue is one
subscribe.

## Why one subscribe took 37 s

parcel's kqueue backend runs `subscribe` and `unsubscribe` under one mutex
per backend (`Backend::watch` / `unwatch`; the batch loop takes it too). It
is one backend per process, so every kqueue watch shares it.

The engine opened a children watch as a whole-tree subscription with
`ignore: [/[/]/]` (every path holding a `/` below the dir).
`readTree` (`src/unix/fts.cc`) walks with fts. On an entry folder's preorder
visit, the entry is not ignored, so fts descends. To return the folder's
first child, `fts_build` reads the whole folder and `lstat`s every entry. Only
then does the ignore drop each one (`FTS_SKIP`). A children watch therefore
listed and stat'ed everything one level below its entries:

| folder | entries | one level below |
|---|---|---|
| `~/.equin/cache` | 44 | **690,655** |
| `~/.claude` | 39 | 5,160 |
| `~/.equin/asset-mirror` | 5 | 720 |

Warm cache: 20 entry folders × 1,000 files took 78–89 ms to open, against
1.2 ms for 20 files. With the file cache emptied (the same hour had a
`host-io-degraded` report), every one of the 690k stats was a disk read.

Every other subscribe and unsubscribe of the process waited on the mutex
meanwhile. Each one is napi async work, so each held a **Bun worker-pool
thread** while it waited. Bun runs async `node:fs` calls on the same pool.
With ~100 queued watch ops against 18 threads, the pool filled, and plain
file reads queued behind the watcher. That answers the task's open question:
yes, a close holds a worker thread that file reads need, but only while
something holds the lock for a long time.

The same thing happened again while the watch was open. A write inside an
entry folder fires that folder's descriptor (`NOTE_WRITE`). `compareDir` then
lists the folder and `fstatat`s every entry the tree lacks into the tree
(each one ignored), all under the lock.

## The fix: the watch has a depth, not an ignore regex

From a regex the backend cannot tell that nothing below an entry folder is
wanted. It can tell from a depth. The patched addon now takes
`opts.depth` (`Watcher::mMaxDepth`, part of the native watcher's identity
like the ignore):

- `isIgnored` drops paths deeper than the depth;
- `readTree` adds a folder at the depth as an entry and never descends into
  it (`FTS_SKIP` at its preorder visit, before fts reads it);
- `compareDir` never lists a folder its watcher cannot see into
  (`seesBelow`). A tree that never held that folder's entries has nothing to
  remove either.

The engine's kqueue children watch passes `depth: 1` instead of
`ignore: [/[/]/]` (`KQUEUE_CHILDREN_DEPTH`). The identity stays distinct
from any FSEvents subscription of the same dir, which the old regex spelling
existed for.

## After

| | before | after |
|---|---|---|
| open `~/.equin/cache` children watch | 37,293 ms | **14 ms** |
| 20 closes queued behind it | 37,294 ms | **max 10 ms** |
| 20 opens queued behind it | 37,295 ms | max 10 ms |
| `stat()` meanwhile | 37,286 ms | max 6 ms |
| burst of 60 closes + 60 opens, flat folders | 99–213 ms | 72–110 ms (unchanged: what remains) |

## What it does not hide

- Nothing is timed differently. `file-watcher.dir-entries:stop` still spans
  the whole close, queue included. A queue behind a slow open would still
  show up there, and in the open's own span.
- There is no deadline, retry or threshold change, and the close is not fire-and-forget. The work is gone:
  the backend no longer reads files the watch never wanted.
- What remains is that opens and closes still take turns on one lock, each
  holding a pool thread. What runs under the lock is now bounded: a kqueue
  children open lists at most 256 entries at depth 1
  (`KQUEUE_CHILDREN_OPEN_BUDGET`, ~6.5 ms). Larger folders ride the FSEvents
  pool.

Scripts: `plugins/infra/plugins/file-watcher/scripts/measure-close-burst.ts`
(the close split and the burst); the `~/.equin/cache` numbers came from a
one-off scratch run of the same shape: one big open, 20 closes and 20 opens
queued behind it, and `stat` probed alongside.
