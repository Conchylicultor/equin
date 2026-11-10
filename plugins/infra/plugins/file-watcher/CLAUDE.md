# file-watcher

Every in-process file watcher is **declared once** with `defineFileWatcher`
and opened as instances of that declaration. The engine underneath
(`shared/engine.ts`) is one `@parcel/watcher` subscription per watched dir, with
the debounce + ceiling flush — and no timer: a missed event is reported by the
watch itself (`onLost`).

## Declaration vs instance

```ts
// module scope, in the owning plugin — the static policy, the same for every instance
export const allowFilesWatcher = defineFileWatcher({
  name: "conversation-view.allow-files",            // unique per process; a duplicate throws on register
  description: "Notices when a conversation's worktree gains or loses a bypass-permission file.",
  extensions: [".json"], debounceMs: 200,             // extensions?, ignore?, debounceMs?, ceilingMs?,
  // writesWhileOpen?, depth?, mainOnly?
});
// server/index.ts: register: [allowFilesWatcher]

// per instance, wherever one is opened:
const w = await allowFilesWatcher.start({ dirs: [worktree], label: conversationId, onChange });
await w.stop();
```

- `description` is required: a tsc error when missing, a throw when empty. It is
  the sentence Debug → Background activity shows for the entry.
- `start()` throws when the declaration was never mounted in `register: [...]`
  (it would watch without being listed), and when `mainOnly` is set off main.
- `label` names the instance in the catalog (a conversation id, a worktree).
  Omit it for a watcher with one instance.
- Each declaration is one catalog entry (the `background-arm` child): open
  instances and their dirs, the backend (FSEvents / kqueue / inotify), the last
  change batch, and every `onChange` / `onLost` dispatch as a run. A
  throwing handler is recorded as failed and still rethrown. Recording is O(1)
  per dispatch and the catalog push is throttled (outcome change, instance
  open/close, or a quiet minute), so a `debounceMs: 0` watcher costs nothing.
- The registry lives in `shared/registry.ts`. The file-watcher barrels never
  import the catalog's server barrel — they are imported early at boot.

## Writes to a file held open: `writesWhileOpen` follows NAMED files

macOS FSEvents reports a content change when the writer CLOSES the file, so a
long-lived writer (a detached child's transcript, an agent's `events.jsonl`, a
background shell's output) is heard only at its exit. A `writesWhileOpen: true`
declaration hears every write (kqueue on darwin, inotify elsewhere) — and its
instances take **`start({ files })`, never `{ dirs }`** (a tsc error, and a
throw for a caller that bypasses the types):

```ts
export const eventsWatcher = defineFileWatcher({ name, description, writesWhileOpen: true });
await eventsWatcher.start({ files: [eventsPath], label: id, onChange });
```

Why files: kqueue holds one descriptor per watched file, so a dir-wide watch
costs one per entry and grows with the dir. That shape crash-looped main on
2026-11-05 (the SDK events watch over `state/sdk-agents/<ns>/`: ~4,400
descriptors, past the old 5,000-entry ceiling's throw) and held one per entry
of `runs/` (~1,100) during every supervised run. A follow costs what its caller
enumerated: one descriptor per named file present plus one per directory —
`extensions`, `ignore` and `depth` have no meaning there and no spelling.

- **A file not there yet** is heard from its creation (the dir's descriptor
  hears the entry appear); a rename-and-recreate (a sink rotating) is a
  `delete` + `create` of the path.
- **One subscription per directory per process** (`shared/follow-files.ts`):
  parcel caches a dir's listing by path across subscriptions, so two with
  different ignores on one dir fail outright. Every follow of a dir — any
  declaration — shares one subscription whose ignore lets through exactly the
  union of their names, re-opened when that union changes. After every
  (re)open each follower is handed an `update` for each of its files on disk
  (nothing was heard while it was closed): a follower reads from its own
  cursor, so it must treat an update as "look", never as "something was
  appended".
- **Upstream parcel 2.6.0's kqueue backend leaks the descriptor of a watched
  file that is deleted or renamed** (it never `close`s it; `unsubscribe` does
  not either — measured: 70 deletes under a dir-wide watch left 90 descriptors
  after unsubscribe). We run a patched build instead: see *The patched addon*
  below.
- An open lists the dir (parcel stats every entry, ignored ones included): an
  entry deleted mid-listing fails the open. A follower that deletes in the
  same dir holds its deletes outside its opens (`supervised-job`'s
  `pruneOutsideWatcherStart`).

## The patched addon (darwin)

Upstream's kqueue backend leaks; this engine runs a patched build of
`@parcel/watcher` instead, owned by the **`parcel-addon`** child plugin (its
`CLAUDE.md`): `patches/@parcel%2Fwatcher@*.patch` fixes the backend and makes
`index.js` load `build/Release/watcher.node` — on darwin that and nothing
else — and every install links the compiled `parcel-watcher-addon`
dependency there (`parcel-addon`'s provision, run by the root postinstall), so
it exists wherever the package does; `./equin build` refreshes it. A darwin release bundle seals the same dependency and vendors it as the
addon its launcher points `EQUIN_PARCEL_WATCHER_NODE` at. On darwin a missing
copy is an error naming the fix, never upstream's prebuild (its kqueue backend
races: a test process ran it and spun 31 h); Linux loads the prebuild.
A child, not this plugin's own `deps/`: the deps engine and the CLI exec
context both import this plugin.

## Delivery lag: how late the OS reported a write

Every declared watcher measures it, on every backend: the engine samples the
batches its native watch delivers (`shared/delivery-lag.ts`; before any
debounce, at most one in flight and one per 5 s per instance) as the changed
path's **ctime → the batch's arrival**. ctime, not mtime: a moved-in or
`touch -t`'d file keeps an old mtime. A path changed again since it was heard
is skipped (never 0); one rewritten before it is heard under-reads.
Only what the native watch reported is timed. An event the engine makes up — a
follow's re-read `update` after each (re)open, a kqueue children watch's
listing diffed on its move to FSEvents, a new folder's walk on inotify — goes
through `look`, never the probe (`followFiles` and `ChildrenWatchOn` require
both): timed, it reads the file's age as lag.

- `recordSpan("bg", "watch-delivery:<backend>", lagMs, { variant: watcher }, { latency: true })`:
  slow-ops holds it to the live-update bar — one row and one report per
  backend (`watch-delivery:fs-events`), every watcher it delayed a variant.
- `onWatchDelivery(listener)`: the latency ledger's `watch-delivery` metric.
- The catalog's `Heard after` fact (`FileWatcherSnapshot.lastDelivery`).

FSEvents' lag is fseventsd's queue, shared by every stream on the machine:
measured 2026-11-09 with fseventsd stuck at one full core, p50 3–10 s,
p90 13–14 s, in a fresh tmp dir as in `~/.claude/projects`; kqueue on the same
files p50 0 ms, max 2 ms. A value a user waits on whose files are KNOWN
follows them (`writesWhileOpen`) rather than riding a tree watch
(`conversations/transcript-watcher`).

## Reactions are coalesced: return the work

A reaction (`onChange`, `onLost` — the `WatchReaction` / `WatchLost`
types) may return a promise, and **should return its async work rather than
detach it**. Every layer that hands a batch to a subscriber — the engine (per
instance, so `defineFileWatcher` and `watchForCommand`), `acquireDirWatch` (per
watcher) and `infra/git/checkout-watch` (per reader) — runs it through
`packages/coalesce`: one reaction at a time, and the batches that land while it
runs fold into ONE trailing call with their events merged. However fast the
folder changes and however slow the work, a subscriber costs at most one running
plus one pending reaction, and the last change is always answered by a run that
started after it. A sync reaction (`notify()`) runs inline, as before.

`onChange: () => { void recompute(); }` escapes all of that — one recompute per
batch, unbounded (on 2026-10-12 it queued 3,291 edited-files recomputes behind
the 2-slot heavy-read gate and blanked main). `watcher-safety/no-detached-watch-reaction`
rejects it. Work keyed INSIDE one batch (one run per room) triggers a
`createKeyedCoalescer` instead (see `conversations/transcript-watcher`).

The catalog's `Folded` fact counts the batches an instance folded.

**`drained()` / `losses()`** — what a consumer that remembers "the watch has
told me everything up to here" asks (corpus-index's cursor checkpoint).
`drained()` resolves once every event the instance had received when called
has been handed to `onChange` by a run that settled (a batch in its debounce
window is handed over at once); `losses()` counts the loss reports it received,
at arrival — equal readings bracket a stretch with nothing dropped.

## In a CLI command: `watchForCommand`

A foreground `./equin` command that waits on the disk (`await`) imports
`watchForCommand` from `@plugins/infra/plugins/file-watcher/cli`: the same
engine, no registry (a CLI process has no catalog, and a wait is not background
activity). It takes the engine's options directly — `dirs` (or, with
`writesWhileOpen: true`, `files`) + `onChange` required.

## Other ways to watch are lint errors

`watcher-safety/no-direct-parcel-watcher` keeps `@parcel/watcher` inside this
plugin's `shared/`; `watcher-safety/no-raw-fs-watch` bans `fs.watch` /
`watchFile` / `fs.promises.watch` / chokidar in host-process code, with a
reasoned `exempt/index.ts` manifest.

## Lost events: `onLost` — the only backstop, no timer

A native watch that reports an error may have dropped events. The engine still
delivers the batch's events (parcel hands the error WITH the rest of the batch),
logs the error, and calls the instance's optional `onLost(dir, err)` —
coalesced per dir like `onChange`, since drops come in bursts, and recorded as a
run. `acquireDirWatch` fans it out as `onLost(err)` to every watcher riding that
watch, and `infra/git/checkout-watch` delivers it as `onResync`. A consumer
whose value is kept fresh by the watch alone must re-derive it there — nothing
else will. (A `children` watch's error is already reported as its dir gone.)

A `subtree` watch whose dir itself goes (removed, moved away, replaced — checked
against its inode) is **closed at once** and reported to `onLost` with a
`WatchedDirGoneError`. Not tidiness: a parcel subscription whose root is gone
hears nothing more — not even a folder re-created at the path — raises no
error, and while it stays open every OTHER parcel subscription in the process
hears nothing either (measured, macOS FSEvents, parcel 2.6.0; unsubscribing it
restores them). A holder that wants the dir again opens a new watch.

`acquireDirWatch` retires such a root (its native watches are keyed by dir and
generation, like the single-directory ones): its riders hear `onLost`, the next
acquire of that dir — or of one under it — opens a fresh root instead of joining
the dead one, and riders still holding the dead root move onto the fresh root
once one opens at or above their old root. A consumer that must follow a folder
through its deletion and re-creation without someone else re-acquiring it uses
`acquireEventualDirWatch` (below), which re-acquires when the folder reappears.
A bare `defineFileWatcher(...).start` instance is not re-armed: it stays closed.
One that must follow its folder is opened with `startEventualFileWatcher` (below)
instead — never by re-creating the folder with `mkdir` on the loss, which races
a replace (rm, then a new folder renamed in).

There is **no reconcile timer**, and no spelling for one. Which backends report
a loss, read from `@parcel/watcher` 2.6.0's source:

| backend | a dropped event | reported? |
|---|---|---|
| FSEvents (macOS) | `MustScanSubDirs` (client / kernel dropped, or coalesced) | **yes** — "Events were dropped by the FSEvents client…" |
| kqueue (`writesWhileOpen` follow) | no queue to overflow; a failed watch | yes |
| Windows | buffer overflow | yes |
| inotify (Linux) | `IN_Q_OVERFLOW` | **no** — parcel skips it silently |

Measured on macOS: the gateway logs held ~6,000 `[file-watcher] error on …
Events were dropped by the FSEvents client` lines across 316 backends — drops
are real, and they arrive. A 25-minute run of `scripts/measure-reconcile.ts`
over the five dirs that used to carry a 30 s reconcile found no change a walk
saw that the watch had not reported. On Linux an inotify queue overflow (more
than `max_queued_events`, 16,384, while parcel's reader thread lags) leaves a
value stale until the next change there or a restart.

A 30 s reconcile used to stand in for this: a full re-derive per watcher per
backend that, in steady state, found nothing (~280 ms of stats per tick for the
corpus index on main; two `git rev-parse` per backend for the ref watcher). And
a tick is not a change: it once fell back to `onChange([])`, and the prototypes
gallery reloaded every open mock every 30 s.

A fact the filesystem cannot report at all — a process that died without
writing its end — is not a file watcher's question. It gets its own named
mechanism (`defineTimer`, listed under Timers): `op-store.dead-op-sweep` (main
only), `supervised-job.liveness` (while a run is live), and `./equin await`'s
own heartbeat.

Plan and measurements:
[`research/2026-10-25-infra-file-watcher-reconcile-to-onlost.md`](../../../../research/2026-10-25-infra-file-watcher-reconcile-to-onlost.md).

## A new folder's entries: heard even when they came first

parcel's inotify (Linux) backend watches each directory on its own (so did
kqueue, back when a `writesWhileOpen` watch took dirs). They hear a new folder by diffing its
parent, then watch that folder alone — never what is already inside it. An
entry written into the folder before parcel's thread got to it (a folder moved
in whole, or `mkdir` + write while the thread lags) is never watched: no
`create`, no later write, no error (@parcel/watcher 2.6.0
`KqueueBackend::compareDir`; inotify upstream #97 / #243, open). On 2026-10-31
an SDK agent's `events.jsonl`, created 7 s after its folder on a loaded host,
went unheard by main's consumer (`sdk-consumer-stalled`).

So the engine (`shared/new-dirs.ts`), on inotify, subscribes parcel
to every folder a watch reports created — `subscribe` walks what it is given
and watches every entry — then reports as `create` everything found inside
(minus `ignore`, read the way parcel reads it). A path may be reported twice;
consumers key by path. Cost: one more native subscription per folder created
under the watch, until it is deleted or the watcher stops. FSEvents reports by
path from one stream and needs none of it. Tests: the moved-in folder cases in
`shared/engine.test.ts` (Linux only; they fail without it).

## What changed while nobody watched: the journal

A watch hears changes only while it runs. `journalCursor(root)` marks a point
in the file-system journal (FSEvents' history, parcel's `writeSnapshot`);
`journalChangesSince(cursor)` replays it — every path named under the root
since, in time proportional to the changes (8–135 ms on `~/Downloads`, where
walking it is 26k dirs). Both are fail-closed results, never a guess:
`unsupported` / `unknown` when it is not FSEvents, the root is off the user's
data volume (a share or drive may keep no journal), the root was replaced
(device or inode) or reached through a symlink, the cursor is over 7 days
old (parcel cannot tell a purged history from a quiet one), the journal's ids
went back, or the history reports
dropped events — the caller then walks. parcel itself returns `[]` for a
missing snapshot file; the cursor carries its snapshot, so that cannot happen
here. `infra/corpus-index` uses it for its boot catch-up.

## `depth: "children"`: a folder's own entries, and the folder going

A `children` watch (what `acquireDirWatch({ scope: "children" })` opens when no
recursive root covers the dir) hears the dir's direct entries and the dir
itself going — reported once, as a `delete` of the dir (removed, moved away,
or replaced by another folder of the same name: an inode check), on which the
holder re-arms. A watch that reported its dir gone is retired from the hub, so
that re-arm opens a fresh watch of whatever folder now sits at the path rather
than joining the dead one. **It is live when it resolves**: a write landing
right after `start` / `acquire` is heard, so "arm, then read" is correct.

- **macOS: kqueue** (`shared/kqueue-children.ts`): parcel's kqueue backend on
  the dir, every deeper path ignored natively — one descriptor on the dir and
  one on each entry, registered before `subscribe` resolves. Never an
  FSEvents stream: a stream is delivered every event under its path however
  deep, so the file explorer's children watches of `/` and `~` made
  fseventsd deliver every file event of the machine to the process, to hear
  a few dozen entries; and FSEvents is 3–14 s late while fseventsd is loaded,
  kqueue milliseconds. kqueue costs what the dir holds, not what happens
  below it, so its descriptors are bounded: a dir holding more than 256
  entries at open (`KQUEUE_CHILDREN_OPEN_BUDGET`), or one that would take
  the process's kqueue children watches past 8,192 descriptors, rides the
  FSEvents pool instead (below); one that grows past 1,024 while watched
  moves to it — the pool ride opens first, the kqueue subscription closes,
  then the dir is listed and diffed against the names the watch knew (new
  → `create`, gone → `delete`, the rest an `update`, a look): parcel
  debounces what kqueue reported, so the close drops a batch not yet
  delivered, which the FSEvents stream (started "since now") never reports.
  A change around the move may be heard twice, never lost. The dir going is its own descriptor firing,
  checked against the inode, reported once. An entry this account may not
  open (macOS privacy protection: `~/.Trash` without Full Disk Access) is
  listed with no descriptor (the patched addon, `parcel-addon`): heard coming
  and going, not written. An entry written by a process holding it open is
  heard on every write, not only at close. A native error reaches `onLost`.
- **Elsewhere: Bun's single-directory `fs.watch`** of the dir, plus a second
  one of its **parent** filtered to the dir's own name (Bun's watch of a dir
  reports nothing when that dir is removed or moved away); `/` has no parent
  and cannot go. A failing watch is reported as its dir gone. Its liveness at
  return is not measured off macOS.

Why not Bun's `fs.watch` on macOS (what this depth was until 2026-11-08): it
opened the native watch on its own thread after returning, and every directory
watch of the process shared ONE FSEvents stream that Bun restarted from "now"
whenever any of them opened or closed. Measured side by side on one loaded host
(fseventsd at ~190% CPU, 30 s to be heard): `fs.watch` missed 10 of 10 writes
made right after it opened and 48 of 50 writes made while another watch opened
and closed; the parcel stream missed 0 of 10 and 0 of 50. The daemon's pid-file
holder (`infra/spawn/daemon`), which arms then reads, missed exactly such
writes. Tests: the `depth children` cases in `shared/engine.test.ts`.

It also **held the JS thread on every open and close** (main's 1.2 s
`close ← closeNativeWatcher ← … ← stop` stall, and the `watch ← FSWatcher ←
watchChildren` ones). Sampled (`scripts/measure-watch-blocking.ts`, Bun 1.4.4):
the JS thread waits on Bun's FSEvents-loop lock (`_os_unfair_lock_lock_slow`)
while Bun's `CFThreadLoop` thread, holding it, restarts the shared stream —
`FSEventStreamStart → register_with_server → mach_msg`, a synchronous RPC to
`fseventsd`. So each open or close cost one fseventsd round trip ON the event
loop: 50 ms median, up to ~600 ms on an idle-ish host, over a second while
fseventsd is loaded. parcel makes the same RPCs (`FSEventStreamStart` /
`Stop`) in its subscribe / unsubscribe async work, on Bun's worker pool: the
JS thread holds ~0.05 ms per call and sits idle in `kevent` meanwhile. Off
macOS, `fs.watch` is inotify: one descriptor per watch, no shared stream to
restart. Write-up: `research/2026-11-08-infra-file-watcher-close-stall.md`.

## One FSEvents stream per watched root

Every FSEvents stream is work fseventsd does on every file event of the
machine, and every open or close is a synchronous RPC to it — 0.05 s idle,
20–30 s while it is stuck at one full core (2026-11-09: the
`file-watcher.dir-entries:stop` spans of a busy worktree). So on macOS every
watch with no `ignore` — any declaration; a `children` one only when it is
past kqueue's budget (above) — rides the process's **stream pool**
(`shared/fsevents-pool.ts`) rather than opening its own:

- A watch whose dir is at or below an open (or opening) recursive stream
  rides it, its events filtered in JS to its own scope; joining a started
  stream is live at once (and may also hand it a change made just before it
  started, still in fseventsd's queue — a look, never a loss). Otherwise it
  opens a stream of its dir, which later
  watches below it ride (`children` ones join a children stream of the same
  dir). The last rider to leave closes the stream.
- **Riders never move.** A stream opening above an open one does not take its
  riders over: closing the lower stream would drop what fseventsd has queued
  for it and not delivered yet (seconds at load), and parcel cannot tell when
  that queue is empty. The lower stream lives until its riders leave.
- A rider's dir going (removed, moved away with a folder above it, replaced)
  is checked against its inode on an event naming it or a folder between it
  and the stream's root, and reported to that rider alone. The stream's own
  root going closes the stream at once (a dead root deafens every other
  stream) and every rider with it.
- A watch with an `ignore` neither rides nor carries others (the ignore keeps
  paths out of the stream): it opens its own, which parcel shares with
  another of the same dir and ignore. kqueue follows (`writesWhileOpen`) and
  other platforms are untouched.

`fsEventsStreams()` reads the pool (open streams with their rider counts,
and how many it has opened). Measured on main's own watch set
(`scripts/measure-stream-pool.ts --set`, 2026-11-09): 29 watches, 27 streams
before, 22 after; a children watch riding a covering stream is delivered as
late as one on its own (p50 8 s / 9 s with fseventsd stuck — the lag is
fseventsd's queue), 0 of 60 writes missed. Write-up:
`research/2026-11-09-infra-file-watcher-stream-pool.md`.

## A dir that may not exist: `acquireEventualDirWatch` (machine)

`acquireDirWatch` rejects for a missing dir. A dir whose path is known before
it exists, or that can be removed while watched (an attempt's checkout: its
path is recorded at launch, `git worktree add` runs later in the spawn job, and
the reaper removes it while its conversation is still open), is watched with
`acquireEventualDirWatch` from the `machine` barrel: a children watch of the
parent, and the dir's own watch while it is there. Its appearing, going or
being replaced reach `onChange` as `create` / `delete` events at the dir path
itself — filter on `e.path === dir` as well as on the entries you care about.
It rejects only when the parent cannot be watched.

The dir's own watch reporting `WatchedDirGoneError` marks it dead and re-syncs,
so a folder back at the path — even one with the inode the old folder had — is
watched again rather than mistaken for the dead one. If the parent itself goes,
its watch is lost (`onLost`) and not re-armed.

`startEventualFileWatcher(decl, { dir, label, onChange, onLost })` is the same
follow for a **declared** watcher: an instance of `decl` (its policy, its
catalog entry, its label) is held while a dir is at the path and started
again on a new one; while none is there the declaration lists no instance.
The parent's children watch is the hub's. `infra/paths/data-files` opens every
watching root's watcher this way, so a data dir restored or removed and
re-created is watched again (a `rescan` on each appearing or going).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: defineFileWatcher: the one declared in-process file watcher — a named, described declaration (static policy: extensions, ignore, debounce, ceiling, writesWhileOpen, depth, mainOnly) whose start({dirs, label, onChange, onLost}) — start({files, …}) for a writesWhileOpen one, which follows writes to the named files only (kqueue on darwin, one descriptor per file; every follow of a directory shares one subscription) — opens instances over one @parcel/watcher engine (debounce + ceiling flush; no timer — a dropped event is reported to onLost, the one backstop). Records per declaration its open instances, last change batch and a ring of handler runs for the Background activity catalog (onWatcherActivity / listFileWatchers / fileWatcherRecentRuns). The cli barrel's watchForCommand is the same engine for a foreground command, with no registry. acquireDirWatch({dir, scope, onChange}) is the shared directory-watch hub: refcounted native watches, a dir under a watched root riding its watch (a watcher never moved off a live root: a root opening above leaves it where it is), with subtree or children (depth-1 listing) scope — a children request with no root above it opening only a single-directory watch (depth children), never a recursive one. On macOS a children watch is kqueue's (a descriptor on the dir and each entry, budgeted — a dir past the budget rides FSEvents), so watching / or ~ puts nothing on fseventsd; every other FSEvents watch with no ignore rides the process's stream pool — one stream per watched root, a dir under an open recursive stream riding it, whatever declaration asks (fsEventsStreams reads it).
- Cross-plugin:
  - Imported by: 40 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra` ×13
    - `debug` ×8
    - `build` ×5
    - `conversations` ×5
    - `apps` ×2
    - `config_v2`
    - `framework/cli/await`
    - `integrations/google-maps`
    - `plugin-meta/plugin-tree`
    - `release`
    - `reports/outbox`
    - `stats/cost`
- Exemptions:
  - Exempts itself from:
    - `watcher-safety/no-direct-parcel-watcher` — `shared` (sanctioned)
    - `watcher-safety/no-raw-fs-watch` — `shared/engine.ts` (sanctioned)
    - `boundaries/no-platform-api` — `server/internal/dir-hub.ts`, `shared/engine.ts`, `shared/follow-files.ts`, `shared/journal.ts`, `shared/new-dirs.ts` (debt)
- Server:
  - Exports (types):
    - `DeliveryLagSample`
    - `DirWatchRelease`
    - `DirWatchRequest`
    - `DirWatchScope`
    - `FileChangeEvent`
    - `FileFollowStartOptions`
    - `FileWatcher`
    - `FileWatcherBatch`
    - `FileWatcherDecl`
    - `FileWatcherInstanceInfo`
    - `FileWatcherSnapshot`
    - `FileWatcherSpec`
    - `FileWatcherStartOptions`
    - `JournalCursor`
    - `JournalCursorResult`
    - `JournalReplay`
    - `ServerFileWatcherSpec`
    - `WatchDelivery`
    - `WatcherBackend`
    - `WatchLost`
    - `WatchReaction`
  - Exports (values):
    - `acquireDirWatch`
    - `BATCH_SAMPLE_MAX`
    - `defineFileWatcher`
    - `fileWatcherRecentRuns`
    - `journalChangesSince`
    - `journalCursor`
    - `listFileWatchers`
    - `onWatchDelivery`
    - `onWatcherActivity`
    - `WatchedDirGoneError`
  - Register:
    - `defineFileWatcher('file-watcher.dirs')`
    - `defineFileWatcher('file-watcher.dir-entries')`
- Machine:
  - Exports (types): `EventualFileWatcherOptions`
  - Exports (values):
    - `acquireEventualDirWatch`
    - `startEventualFileWatcher`
- Cli:
  - Exports (types):
    - `FileWatcher`
    - `WatchForCommandOptions`
    - `WatchLost`
    - `WatchReaction`
  - Exports (values): `watchForCommand`
- Test helpers:
  - Server: `@plugins/infra/plugins/file-watcher/server/testing`
    - `registerDirWatchHub` — Register the shared directory-watch hub's two declarations, as the file-watcher server plugin's `register: [...]` does at boot — for a suite that opens the real hub (`acquireDirWatch`, `acquireEventualDirWatch`, `startEventualFileWatcher`) without booting the graph.
- Sub-plugins:
  - **`background-arm`** — File watchers in the Background activity catalog: registers the `file-watcher` background kind — every declaration made with defineFileWatcher under File watchers, triggered on file change, its…
  - **`parcel-addon`** — @parcel/watcher's native addon built from the repo's patched source (its kqueue backend closes the descriptor of a watched file that is deleted or renamed): the parcel-watcher-addon build…

<!-- AUTOGENERATED:END -->
