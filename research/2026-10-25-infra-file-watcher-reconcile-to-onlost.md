# File watchers: drop the 30 s reconcile timer, rely on `onLost`

## Context

The file-watcher engine (`plugins/infra/plugins/file-watcher/shared/engine.ts`)
offers `reconcileMs` + `onReconcile`: a per-instance `setInterval` described as
the "backstop for a dropped fsevent". Five server watchers declare it
(corpus-index, git-watcher, transcript-watcher, op-store, prototypes/files), plus
two that are not on the task's list (`supervised-job.runs-dir`, 60 s, and the
`./equin await` CLI wait, 15 s). In steady state every tick is a full re-derive
that finds nothing — polling under another name, multiplied by ~60 backends.

The engine already has the push signal for lost events: `onLost(dir, err)`,
raised when the native watch reports an error. Sonata's midi-folders watcher
already moved from its timer to `onLost` (commit 5fbd3bb522).

## Findings

### 1. Does @parcel/watcher report dropped events? — macOS yes, Linux no

Read from `node_modules/@parcel/watcher/src` (2.6.0):

- **FSEvents** (`macos/FSEventsBackend.cc`): any event carrying
  `kFSEventStreamEventFlagMustScanSubDirs` sets the batch error —
  "Events were dropped by the FSEvents client" (`UserDropped`), "…by the kernel"
  (`KernelDropped`), or "Too many events" (coalesced). The JS callback receives
  `(err, events)` — **both**: the error *and* the rest of the batch.
- **kqueue**: no queue to overflow; `EV_ERROR` / a failed `open` throw a
  `WatcherError`, which reaches the callback as `err`.
- **inotify** (`linux/InotifyBackend.cc`): `IN_Q_OVERFLOW` is `continue`d —
  **swallowed silently**. A failed `inotify_add_watch` on a new subdir does
  surface (`WatcherError`).
- **Windows**: buffer overflow throws "Some events may have been lost" → `err`.

**Empirical confirmation on this machine** — the gateway logs
(`~/.singularity/logs/gateway/*.log`) hold ~6,000 `[file-watcher] error on …
Events were dropped by the FSEvents client` lines across 316 backends since
June: on `.claude/worktrees` (4,062), `~/.singularity/worktrees` (820),
`.git/refs` (549 — the git-watcher's own dir), config dirs, `plugins/`. Drops
are real, and they are *reported*. No "kernel dropped" line was ever seen.

### 2. An engine bug on the way

On `err` the engine logs, calls `onLost`, and **returns** — discarding the
events parcel delivered in the same batch. A watcher without `onLost` loses
those events outright. Fix: deliver the events, *then* raise `onLost`.

### 3. What each tick costs (main, `get_runtime_profile` kind `bg`, 4 ticks)

| watcher | where | per tick | what a tick does |
|---|---|---|---|
| `corpus-index.stats.cost.usage` | main only | **277 ms avg, 511 ms max** | full walk of `~/.claude/projects` (~1.2k dirs, ~4k stats) under a heavy-read slot |
| `git-watcher.refs` | every backend | 36 ms | 2× `git rev-parse` subprocess → ~4 spawns/s host-wide at 60 backends |
| `prototypes-files.tree` | every backend | 18 ms | a stat of every file of every prototype |
| `op-store.op-log` | every backend | 5 ms | drain (stat) + dead-op reconcile (DB query) |
| `transcript-watcher.transcripts` | every backend with rooms | ~3 ms per room | chain re-resolve (DB query + glob + stats) per open room |

### 4. What each tick can repair that `onLost` cannot

A tick's *unique* repairs are changes no event named **and** no error
reported — on macOS FSEvents, by construction, none (every drop is flagged,
§1). Per watcher, the only non-filesystem reasons a tick existed:

- **corpus-index** — none; its own comment: "the backstop for a dropped event".
- **git-watcher** — "packed-refs-only movement". A ref *advance* under the
  files backend always writes the loose ref (lockfile + rename under `refs/`),
  so the watched dir hears it; packed-refs is only rewritten by `pack-refs`
  (sha unchanged) and deletions — never an advance. → none.
- **transcript-watcher** — also a "missed `refreshConversationChain`". The chain
  has exactly one writer (`status-reconciler.ts` → `recordSessionId`), which
  calls `refreshConversationChain` in-process right after; a crash in between
  re-resolves every room on restart. → none.
- **prototypes/files** — none (signature-gated, documented as the backstop).
- **op-store** — **yes: process death.** A SIGKILLed op writes no terminal and
  leaves no filesystem event; the tick is what notices its marker unlocked.
  That is a liveness poll, not a file-watcher concern. Only main needs it (main
  appends the reconciler terminal to the log, which every other backend then
  hears as a file event; a worktree closes rows only after an ingest gap, which
  it discovers on the drain itself).
- **supervised-job** — also liveness (a detached child dead without its exit
  marker) + adopting runs another process started.
- **await CLI** — re-checks and prints progress every 15 s: a heartbeat of the
  command itself.

A direct repair counter does not exist, so the measurement is made directly:
`scripts/measure-reconcile.ts` (below) runs the engine over the five dirs and,
every 30 s, compares a fresh walk against what the events named — a file whose
`(mtime, size)` moved with no event naming it (and no `onLost` since the last
walk) is exactly a repair only the timer could make.

### 5. Measured repair rate: zero

`scripts/measure-reconcile.ts`, 25 min on a busy machine (≈60 backends, agents
writing transcripts), walking each dir every 30 s like the reconcile did:

| dir | walks | avg walk | files moved | `onLost` | changes no event named |
|---|---|---|---|---|---|
| `~/.claude/projects` | 45 | 1,970 ms | 43 | 0 | **0** |
| `.git/refs` | 45 | 20 ms | 12 | 0 | **0** |
| `~/.singularity/apps/prototypes` | 45 | 1,603 ms | 0 | 0 | **0** |
| `~/.singularity/logs/op-log` | 45 | 2 ms | 24 | 0 | **0** |

A first run reported 2 unheard transcript writes; both were the script's own
race (an event heard during a walk was cleared before the walk that saw its
change). Fixed — the window now spans from the previous walk's start and carries
in-walk events over — and the re-run found none.

So in 180 ticks a timer would have repaired nothing, while every drop that does
happen (§1's ~6,000) is reported.

## Decision

**The file-watcher engine stops offering a timer.** Lost events are a push
signal (`onLost`); a fact the filesystem cannot report (a process died) is not
the file watcher's question and gets its own honestly-named mechanism.

### Engine (`infra/file-watcher`)

- `shared/engine.ts`: remove `reconcileMs` / `onReconcile` / the interval and
  its coalescer. On `err`: `take(events)` first, then `onLost`. Coalesce
  `onLost` reactions like the others (one at a time, trailing fold), tracked as
  `watch:<name>:lost`.
- `shared/registry.ts`, `server/internal/define.ts`: drop the `reconcileMs`
  generic and `WatchReconcile`; `onLost` is recorded as a run (like
  `onReconcile` was), so Background activity shows when a watcher recovered.
  Snapshot field `reconcileMs` removed; the background-arm provider stops
  printing "Every N s".
- `cli/`: `watchForCommand` loses `reconcileMs`; `WatchReconcile` export goes.
- `detached-work-safety/no-raw-set-interval` exemption for `shared/engine.ts`
  removed (no interval left).
- CLAUDE.md: replace "onChange and onReconcile are different questions" with
  "Lost events: onLost is the backstop" — the verified per-backend table, and
  the Linux gap.

### Consumers

| watcher | change |
|---|---|
| corpus-index | `onReconcile` → `onLost`: `markDirty()` + `ensureFresh()`. `CorpusIndexEnv.startFileWatcher` takes `onLost`. Description text loses "every 30 s". |
| git-watcher | `onLost: () => recomputes.run()`; comments on packed-refs corrected. |
| transcript-watcher | `onLost`: re-resolve every room (what the tick did). Description + CLAUDE.md. |
| prototypes/files | `onLost: () => refreshes.run()` (same signature gate). Docs. |
| op-store | `onLost: () => passes.run()`; the dead-op check moves to a **main-only `defineTimer`** `op-store.dead-op-sweep` (30 s, `timer/no-unlisted-timer` exemption: "process death leaves no filesystem event; real polling awaiting a push replacement"). One instance host-wide instead of ~60. |
| supervised-job | `onLost: () => reconcileSupervisedRuns()`; the liveness re-check becomes a `defineTimer` `supervised-job.liveness` started/stopped with the watcher (only while a run is live), same 60 s, exemption reason likewise. |
| await CLI | its own 15 s heartbeat (`setInterval` in `cli/`, which the raw-interval rule does not cover) calling `check()` + progress; `onLost: () => check()`. |

### Linux

inotify's `IN_Q_OVERFLOW` is invisible to JS (parcel drops it), so after this
change an overflow on Linux leaves a value stale until the next change or
restart. Overflow needs >16,384 queued events while parcel's reader thread
lags, which our watchers' dirs make rare; documented in the engine's CLAUDE.md
and filed as a task (surface `IN_Q_OVERFLOW` from parcel as a subscription
error — patch upstream) rather than keeping 60 backends × 5 timers on macOS
for it.

## Verification

1. `./equin run plugins/infra/plugins/file-watcher/scripts/measure-reconcile.ts`
   over the five dirs for ≥ 20 min while the machine is busy → expect 0 repairs
   not preceded by an `onLost`.
2. `./equin test plugins/infra/plugins/file-watcher plugins/infra/plugins/corpus-index
   plugins/framework/plugins/tooling/plugins/lint/plugins/watcher-safety`
   (+ op-store / supervised-job tests if present); engine test: an error batch
   still delivers its events and raises `onLost`.
3. `./equin build` (type-check + lint + plugin docs); Debug → Background
   activity on the worktree: the five watchers show no "Every 30 s" fact, the two
   new timers listed (op-store's only on main).
