# file-watcher

Every in-process file watcher is **declared once** with `defineFileWatcher`
and opened as instances of that declaration. The engine underneath
(`shared/engine.ts`) is one `@parcel/watcher` subscription per watched dir, with
the debounce + ceiling flush and kqueue sizing — and no timer: a missed event
is reported by the watch itself (`onLost`).

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

## In a CLI command: `watchForCommand`

A foreground `./equin` command that waits on the disk (`await`) imports
`watchForCommand` from `@plugins/infra/plugins/file-watcher/cli`: the same
engine, no registry (a CLI process has no catalog, and a wait is not background
activity). It takes the engine's options directly — `dirs` + `onChange`
required.

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

There is **no reconcile timer**, and no spelling for one. Which backends report
a loss, read from `@parcel/watcher` 2.6.0's source:

| backend | a dropped event | reported? |
|---|---|---|
| FSEvents (macOS) | `MustScanSubDirs` (client / kernel dropped, or coalesced) | **yes** — "Events were dropped by the FSEvents client…" |
| kqueue (`writesWhileOpen`) | no queue to overflow; a failed watch | yes |
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

## `depth: "children"`: a folder's own entries, and the folder going

A `children` watch (what `acquireDirWatch({ scope: "children" })` opens when no
recursive root covers the dir) is Bun's single-directory `fs.watch` of the dir —
plus a second one of its **parent**, filtered to the dir's own name. Bun's watch
of a dir reports nothing when that dir is removed or moved away (measured on
macOS: no event, no error, no close), so without the parent watch an open
listing of a deleted folder would stay stale. The parent hears it as a `rename`
of the dir's entry; an inode check turns that into a `delete` of the dir
(removed, moved away, or replaced by another folder of the same name), on which
the holder re-arms. `/` has no parent and cannot go. A watch that reported its
dir gone is retired from the hub, so that re-arm opens a fresh watch of
whatever folder now sits at the path rather than joining the dead one.

Two Bun behaviours a caller of this depth must know (measured on macOS, Bun
1.4.3):

- **It goes live a moment after it resolves.** Bun opens the native watch on
  its own thread; a change landing before that is never reported. A test that
  writes right after `acquire` must first wait for a probe entry to be heard
  (`untilLive` in `server/internal/dir-hub.test.ts`).
- **Every directory watch of the process shares one FSEvents stream**, which
  Bun restarts from "now" whenever any directory watch opens or closes — so a
  live watch can miss a change landing during another watch's open or close
  (measured: 72 of 300 writes missed under constant open/close churn, none
  without).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: defineFileWatcher: the one declared in-process file watcher — a named, described declaration (static policy: extensions, ignore, debounce, ceiling, writesWhileOpen, depth, mainOnly) whose start({dirs, label, onChange, onLost}) opens instances over one @parcel/watcher engine (debounce + ceiling flush, kqueue sizing; no timer — a dropped event is reported to onLost, the one backstop). Records per declaration its open instances, last change batch and a ring of handler runs for the Background activity catalog (onWatcherActivity / listFileWatchers / fileWatcherRecentRuns). The cli barrel's watchForCommand is the same engine for a foreground command, with no registry. acquireDirWatch({dir, scope, onChange}) is the shared directory-watch hub: one native watch per folder tree, refcounted, a dir under a watched root riding its watch, with subtree or children (depth-1 listing) scope — a children request with no root above it opening only a single-directory watch (depth children, fs.watch), never a recursive one.
- Cross-plugin:
  - Imported by: 23 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×7
    - `infra` ×7
    - `apps` ×2
    - `conversations/transcript-watcher`
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
    - `boundaries/no-platform-api` — `server/internal/dir-hub.ts`, `shared/engine.ts` (debt)
- Server:
  - Exports (types):
    - `DirWatchRelease`
    - `DirWatchRequest`
    - `DirWatchScope`
    - `FileChangeEvent`
    - `FileWatcher`
    - `FileWatcherBatch`
    - `FileWatcherDecl`
    - `FileWatcherInstanceInfo`
    - `FileWatcherSnapshot`
    - `FileWatcherSpec`
    - `FileWatcherStartOptions`
    - `ServerFileWatcherSpec`
    - `WatcherBackend`
    - `WatchLost`
    - `WatchReaction`
  - Exports (values):
    - `acquireDirWatch`
    - `BATCH_SAMPLE_MAX`
    - `defineFileWatcher`
    - `fileWatcherRecentRuns`
    - `listFileWatchers`
    - `onWatcherActivity`
    - `WRITES_WHILE_OPEN_MAX_ENTRIES`
  - Register:
    - `defineFileWatcher('file-watcher.dirs')`
    - `defineFileWatcher('file-watcher.dir-entries')`
- Cli:
  - Exports (types):
    - `FileWatcher`
    - `WatchForCommandOptions`
    - `WatchLost`
    - `WatchReaction`
  - Exports (values): `watchForCommand`
- Sub-plugins:
  - **`background-arm`** — File watchers in the Background activity catalog: registers the `file-watcher` background kind — every declaration made with defineFileWatcher under File watchers, triggered on file change, its…

<!-- AUTOGENERATED:END -->
