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
`index.js` load `build/Release/watcher.node` first, and `./equin build` copies
the compiled `parcel-watcher-addon` dependency there. A darwin release bundle
seals the same dependency and vendors it as the addon its launcher points
`EQUIN_PARCEL_WATCHER_NODE` at. Without the copy (a checkout never built,
Linux) the upstream prebuild loads.
A child, not this plugin's own `deps/`: the deps engine and the CLI exec
context both import this plugin.

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

- **macOS: its own FSEvents stream** (`subscribeChildren` in
  `shared/engine.ts`): a parcel subscription of the dir with every deeper path
  ignored natively (a relative path holding a `/`, dropped before parcel stats
  it). FSEvents watches by path prefix — no descriptor per entry, nothing
  walked — so `~` or `/` costs one stream. parcel starts the stream
  (`FSEventStreamStart`, since now) before `subscribe` resolves, and each
  subscription has its own, so no other watch opening or closing touches it.
  The dir going is heard on the stream itself (its own path), closed at once
  like a `subtree` root. A native error (FSEvents dropped events) reaches
  `onLost`.
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

- Description: defineFileWatcher: the one declared in-process file watcher — a named, described declaration (static policy: extensions, ignore, debounce, ceiling, writesWhileOpen, depth, mainOnly) whose start({dirs, label, onChange, onLost}) — start({files, …}) for a writesWhileOpen one, which follows writes to the named files only (kqueue on darwin, one descriptor per file; every follow of a directory shares one subscription) — opens instances over one @parcel/watcher engine (debounce + ceiling flush; no timer — a dropped event is reported to onLost, the one backstop). Records per declaration its open instances, last change batch and a ring of handler runs for the Background activity catalog (onWatcherActivity / listFileWatchers / fileWatcherRecentRuns). The cli barrel's watchForCommand is the same engine for a foreground command, with no registry. acquireDirWatch({dir, scope, onChange}) is the shared directory-watch hub: one native watch per folder tree, refcounted, a dir under a watched root riding its watch, with subtree or children (depth-1 listing) scope — a children request with no root above it opening only a single-directory watch (depth children, fs.watch), never a recursive one.
- Cross-plugin:
  - Imported by: 39 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra` ×13
    - `debug` ×7
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
