# Paying down the blocking-fs/no-sync-fs debt

Part of the responsiveness audit (task-1793965642-94fdhj). Task: task-1793991088-yd3u37.
Follows research/2026-11-06-global-sync-helpers-on-backends.md, which extended
`blocking-fs/no-sync-fs` to `*Sync` helpers and sync child processes and left
33 backend files on `debt` exemptions.

## Before → after

33 debt exemptions → 1 (host-admission's gate gauge, task-1794166603-5gddnj).
Four more are now `sanctioned`, each true by its callers: an exit handler, a
line written before the backend listens, a fatal sink whose caller exits next.

Measured cost driving the order: the newest event-loop stall on main
(2026-11-08, 3.2 s) was `appendFileSync ← writeAppend ← appendAll ←
publishAll ← health-monitor tick` — file-sink's synchronous append under the
log channels. Earlier ones named `openSync ← openOwnedFd` (5.1 s, host-semaphore
slot files), `readdirSync` / `readFileSync` through timed-fs, and the
checkout-deploys reads.

## The one primitive: an async file-sink append

`FileSink.append` / `appendAll` are now asynchronous, queued per live path
(a keyed coalescer from `packages/coalesce`): one write runs per path, lines
appended meanwhile fold into the next write in call order. So:

- appends from one process never interleave or reorder, and two writes can
  never both decide to rotate;
- a line stays queued until the write carrying it is issued, and the `exit`
  listener file-sink's server half arms (`flushQueuedAppendsSync`) writes what
  is left synchronously — so an exit loses only a write already issued (a
  SIGKILL, everything queued, as before);
- a burst against a slow disk costs two writes, not one per caller;
- `openDynamicSink`'s fresh sink objects for one file share the queue (keyed by
  path, not by sink).

The sync writer stays as `appendSync` / `appendAllSync` for processes that may
block (a CLI op's event, an `exit` handler). Both writers walk one plan
(`planAppend`: the size gate turns lines into `write` / `rotate` steps), so
rotation is byte-identical either way (tested). `settleFileSinkWrites()` lets
`log-channels#machine`'s `onShutdown` land what is queued.

Consumers:

- **log-channels** — `LogSink.appendAll` returns the write; `publishAll`
  returns it, `publish` detaches it (unprofiled, background lane: it is
  observability's own write). The browser ingress awaits it, so `accepted`
  means stored and a failed write is an error the browser re-sends on — before,
  the synchronous throw did the same.
- **op-log** — the profiler (the op writer) and the file reader only ever run
  in CLI processes; they moved to a new `op-log/cli` barrel and keep the
  synchronous append (an event must be on disk before the process can die).
  The one backend writer, main's reconciler, uses the async `appendOpLog`.
- **fs-wait** — async, except the episode summary from the `exit` handler.
- **sentinel worker** — the episode line is awaited before the trip / clear
  frame is announced, off the worker's thread.
- **boot-events** — the watchdog's `dead` line is async; `start` (before any
  import) and `exited` (exit listener) stay synchronous, sanctioned.

## The rest, by kind

- **Async twin sharing the parse** (one parse function, two I/O fronts):
  paths core's checkout owner / minter stamps, the data-dirs manifest write,
  the root layout (`dataRootLayout`, `backupsDir`), supervised-job's
  `readRunTerminal` / `observeRun` and run-artifact prune, playwright's
  executables read, icon sets, mise lookup, scratch trust.
- **Already had a twin**: `listWorktreeDirsAsync` (boot watchdog, sentinel
  sample, timeline, reaper).
- **Resolved once, before it is read**: the database config
  (`loadDatabaseConfig()` in the pg driver's `ready()`, then a memory read);
  the browser hosts' code id (one promise per process).
- **Misnamed**: `listNamedCompositionRegistriesSync` was async with
  `readdirSync` inside; flock's `HeldFlock.releaseSync` blocks on nothing (a
  signal or an fd close) — renamed `releaseNow`, so the name no longer claims a
  fact the lint reads.
- **Interface made async**: config_v2's `ConfigGitLayer.document` (two rare,
  already-async callers); the race test caught a lock-ordering bug, fixed.
- **Ordering fixed by the move**: `observeRun` reads the process group before
  the marker, so a run ending during the async read is not taken for a hard
  kill; the run-artifact prune and the watcher re-open share a mutex.

## Independent review

No correctness bug in the designs; fixed from it: the scratch trust write
became a compare-and-swap (re-read before the rename, retry, loud after 5 — a
Claude Code process writes the same file); rejected promises are no longer
memoized (browser host code id, database config, the memory config store's
seed); queued lines are flushed on exit (above). Kept, noted: host-semaphore's
fast path reads the line before an await, so a same-process waiter can be
passed by one acquirer (fairness only; the holder bound is unaffected).

## Left

- host-admission's gate gauge (`probeOccupancySync`): runtime-profiler's
  `registerGateGauge` reader is synchronous and read on every slow-wait
  notification. Needs occupancy known without I/O at read time, or an async
  gauge contract — task-1794166603-5gddnj.
- `blocking-fs/sync-named` debt (task-1793991095-ppkf09: `DataDir.ensure` /
  `.path`, `dataRoot()`) is a separate task, untouched here.
