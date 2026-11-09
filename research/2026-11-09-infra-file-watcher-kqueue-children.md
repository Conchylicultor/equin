# Children watches on kqueue, known files followed, and no hub hand-over

Task: task-1794194104 (follow-up of task-1794190734-vy7zh3,
research/2026-11-09-infra-file-watcher-stream-pool.md §5 and "What the pool
does not change").

## The three problems

1. Watches that only read KNOWN files rode FSEvents: 3–14 s late while
   fseventsd was loaded, where a kqueue follow of the same file is 0–2 ms.
2. Main's file explorer holds `children` watches of `/` and `~`. An FSEvents
   stream is delivered every event under its path, so those two received every
   file event of the machine — the largest per-stream cost equin put on
   fseventsd — to hear a few dozen entries.
3. The dir hub's absorb hand-over released a lower root's native watch once a
   root above it opened. Closing an FSEvents stream drops what fseventsd has
   queued for it, so a change made just before the hand-over could go unheard.

## 1 + 2: a `children` watch on macOS is kqueue's

One primitive fixes both: a children watch wants a dir's entries, and kqueue
costs what the dir HOLDS (one descriptor per entry) where FSEvents costs what
HAPPENS below it. `shared/kqueue-children.ts`: parcel's kqueue backend on the
dir, every deeper path ignored natively — a descriptor on the dir and one per
entry, registered before `subscribe` resolves (live at resolve, as before).

Bounded by construction:

| bound | value | past it |
|---|---|---|
| entries at open | 256 | the watch rides the FSEvents pool instead |
| entries while open | 1,024 | moves to the pool: ride opens, kqueue closes, then the dir is listed and diffed (see below) |
| descriptors, all kqueue children watches of a process | 8,192 | new ones ride the pool |

The move's listing is required, not belt and braces: parcel debounces what
kqueue reported before it delivers, so closing the subscription drops a batch
not yet handed over, and the FSEvents stream (started "since now") never
reports it. Found by the repeated test runs: 27 of 1,075 creates lost in one
of ten runs, with fseventsd healthy (no loss reported). After the move the dir
is listed and diffed against the names the watch knew: new → `create`, gone →
`delete`, the rest `update` (a look).

`/` holds 23 entries here, `~` 57: both are on kqueue now, putting nothing on
fseventsd.

### What the patched addon had to learn

`~/.Trash` cannot be listed nor opened (`O_EVTONLY` → EPERM) without Full Disk
Access. Upstream parcel's kqueue backend lists every entry folder (`fts`) and
opens each entry: the whole subscription failed, so no kqueue watch of `~`
could open. The patch (`patches/@parcel%2Fwatcher@2.6.0.patch`, `parcel-addon`)
now keeps such an entry in the tree with no descriptor — in `readTree`
(EACCES / EPERM below the root), `subscribe` and the directory diff. Its coming
and going is heard by its folder's diff; its own writes are not.

Two upstream kqueue bugs this path hit, both fixed in the same patch:

- **The root `/`.** `Watcher::isIgnored` and the directory diff built the
  child prefix as `dir + "/"` — `//` for `/`. Nothing matched it: a watch of
  `/` ignored nothing (the kqueue open walked the whole disk: 9 min, 800 MB,
  killed) and diffed `/` as entries `//bin`, never in its tree. `childPrefix`
  (DirTree.hh) is now the one spelling. The same bug meant the FSEvents
  children stream of `/` had never ignored deeper paths natively either.
- **Atomic rewrites.** A batch holding the folder's `NOTE_WRITE` and the old
  file's `NOTE_DELETE` (write a sibling, rename it over) could diff the folder
  first — the path still in the tree, no create — then drop it on the delete:
  the new file was never watched, and every later rewrite went unheard (five
  rename-overs: rounds 2–5 reported nothing). Each batch now handles every
  delete / rename before any diff; each rewrite reports the path (a `delete`
  and a `create` may land in successive batches — a look either way).

Gotcha found and designed around: parcel shares ONE native Watcher per
(dir, ignore) whatever the backend. The pool's children streams ignore `/\//`;
kqueue children ignore `/[/]/` — the same set, spelled apart, so a dir watched
both ways (during a move to the pool) is two watchers, not one attached to two
backends.

### Semantics that changed

- An entry written by a process holding it open is heard per write (kqueue),
  not only at close (FSEvents).
- An unopenable entry: heard coming and going, not written.
- `watcherBackend(false, "children")` on darwin is `kqueue` (the catalog's
  backend column); a dir past the budget is on FSEvents nonetheless.

### Known files: followed

| declaration | before | after |
|---|---|---|
| `mcp-browser.host-status` | FSEvents, its dir, `.json` | follow of `status.json` |
| `browser-engine.host-status` | FSEvents, its dir, `.json` | follow of `status.json` |
| `model-provider.catalog` | FSEvents, its dir, ignore `*.tmp` (own stream, unpooled) | follow of `catalog.json` |
| `google-maps.browser-config` | FSEvents, its dir | follow of `browser-config.json` |
| `io-health.fs-latency-log` | children (FSEvents) of the monitors' dir | follow of the log (every append) |
| `sentinel.status` | FSEvents, two dirs, recursive | children (kqueue) — status files are `status.<pid>.json`, not known ahead |
| host-fs `watchEntryOver` | hub children | unchanged code: an uncovered children watch is kqueue now; one under an open hub root rides it |

## 3: the hub never moves a live watcher

`dir-hub.ts`: a root opening above open roots leaves their watchers where they
are; the lower root lives until its last watcher releases, and later acquires
below it ride the nearest root. Only watchers stranded on a DEAD root (its dir
went) move — a dead watch hears nothing, so nothing queued can be lost. Cost:
one more native watch of the lower tree while it is held (on macOS the pool
already holds it apart for the same reason; on Linux its inotify descriptors).

## Measurements

2026-11-09 ~05:00 CET, fseventsd stuck the whole time (100 % CPU, 8.9–9.4 GB
RSS). `scripts/measure-kqueue-children.ts --rounds 30`, a children watch of a
scratch dir, each change waited for before the next:

| change | FSEvents children (before, 5 rounds) | kqueue children (after, 30 rounds) |
|---|---|---|
| write | p50 4.1 s, max 5.7 s | p50 147 ms, max 248 ms |
| rename-over | p50 0.5 s, max 14.1 s | p50 149 ms, max 210 ms |
| create | p50 1.6 s, max 6.1 s | p50 148 ms, max 202 ms |
| delete | p50 2.3 s, max 6.6 s | p50 148 ms, max 259 ms |
| missed | 0 | 0 |

(The ~150 ms floor is parcel's own native debounce.) Opening the children
watch of `/`: 453 ms; of `~`: 85 ms (both on parcel's worker thread: the
listing of each entry folder); FSEvents streams held: 0. Descriptors: 1 for
the empty scratch dir, 2 with the target file, 0 after stop.

Tests: the engine's new `children watches on kqueue` cases (a descriptor per
entry and no stream, rename-over, an unlistable entry, past the open budget,
growing past the cap) and the hub's two no-move cases pass; every consumer
plugin's suite passes (424 tests). The FSEvents-wait tests (3–5 s budgets)
fail on this host in this state — the base commit fails the same kind
(journal replay, registry batches), so they are fseventsd's, not this change's.

## The thresholds: design bounds, and how they were chosen

`scripts/measure-kqueue-children.ts --sizes` (2026-11-09, fseventsd healthy;
native kqueue subscription, 5 opens each):

| entries | open p50 / max (files) | open p50 / max (folders, 64 files in each of the first 64) | descriptors |
|---|---|---|---|
| 16 | 0.6 / 1.2 ms | 7.7 / 41 ms | 17 |
| 64 | 2.0 / 2.5 ms | 36 / 70 ms | 65 |
| 256 | 6.5 / 9.2 ms | 33 / 75 ms | 257 |
| 1,024 | 48 / 216 ms | 65 / 82 ms | 1,025 |
| 4,096 | 218 / 491 ms | 313 / 777 ms | 4,097 |

- **256 at open**: opens stay in single-digit ms and a watch holds at most
  257 descriptors. The dirs that make FSEvents expensive are near the top of
  the tree and small (`/` 23, `~` 57, status dirs under 10); dirs of hundreds
  of entries are leaf content whose subtree traffic is their own, where an
  FSEvents stream is cheap.
- **1,024 while open**: 4× the open budget (no flip-flop near it), well under
  the ~4,400 descriptors of the one watch that crash-looped main on
  2026-11-05.
- **8,192 per process**: main held 240 descriptors in all; the per-process
  limit is 245,760 and the machine's 491,520 (24,894 open). ~20 backends each
  at this bound would hold a third of the machine's limit.

They are judgment calls guided by these numbers, not a measured crossover
(there is no single one: FSEvents' cost is per event below the dir, kqueue's
per entry). No test or run hit them; none was raised to make anything pass.

## The bus error: an upstream FSEvents race, fixed in the patch

The test run that crashed (04:40, iteration 1 of the kqueue patch) and a second
one at 04:56 (iteration 2) both died with heap corruption caught in malloc on
a pool thread inside `FSEventsBackend::startStream` — the FSEvents backend,
which the kqueue patch did not touch — while fseventsd was stuck. Cause, in
upstream 2.6.0: a stream callback that sees its root deleted stops the stream
itself (an fseventsd RPC) before clearing `watcher->state`; the batch naming
the root is already delivered, and the engine unsubscribes a watch whose root
went at once — from a pool thread, while the callback is still in the RPC —
so the stream was stopped and released twice and `watcher->state` written
from two threads. The window is the RPC: milliseconds normally, seconds with
fseventsd stuck.

Reproduced with `scripts/stress-root-gone.ts` (delete a root, unsubscribe on
the batch naming it; 16 at once; malloc scribble / guard / heap checks on) and
an addon built with that stop delayed 300 ms: 2 crashes in 3 runs (one a
"Bus error"), 0 in 2 undelayed control runs. Fix (patch,
`FSEventsBackend.cc`): `unsubscribe` stops on the run loop thread, serialized
with every callback; the run loop holds a never-firing source so its thread
outlives the last stream (upstream's exited, which also deadlocked the first
version of the fix); the stream's state is complete before it starts. With the
fix: 0 crashes in 4 delayed runs (800 rounds). Iteration 1 itself ran the full
suite 10 times with fseventsd healthy without crashing — the crash needed the
stuck daemon's window, not the kqueue change.

Separate and not fixed here: main's current addon (`54DFA80C`) also crashes
with `std::terminate` from `SubscribeRunner::execute` (an uncaught C++
exception on a pool thread; 02:40–03:39 and 06:11 on 2026-11-09, other
checkouts) — filed as a follow-up.
