# file-watcher

Every in-process file watcher is **declared once** with `defineFileWatcher`
and opened as instances of that declaration. The engine underneath
(`shared/engine.ts`) is one `@parcel/watcher` subscription per watched dir, with
the debounce + ceiling flush, an optional reconcile timer and kqueue sizing.

## Declaration vs instance

```ts
// module scope, in the owning plugin — the static policy, the same for every instance
export const allowFilesWatcher = defineFileWatcher({
  name: "conversation-view.allow-files",            // unique per process; a duplicate throws on register
  description: "Notices when a conversation's worktree gains or loses a bypass-permission file.",
  extensions: [".json"], debounceMs: 200,             // extensions?, ignore?, debounceMs?, ceilingMs?,
  // writesWhileOpen?, reconcileMs?, mainOnly?
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
  change batch, and every `onChange` / `onReconcile` dispatch as a run. A
  throwing handler is recorded as failed and still rethrown. Recording is O(1)
  per dispatch and the catalog push is throttled (outcome change, instance
  open/close, or a quiet minute), so a `debounceMs: 0` watcher costs nothing.
- The registry lives in `shared/registry.ts`. The file-watcher barrels never
  import the catalog's server barrel — they are imported early at boot.

## Reactions are coalesced: return the work

A reaction (`onChange`, `onReconcile` — the `WatchReaction` / `WatchReconcile`
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

A foreground `./singularity` command that waits on the disk (`await`) imports
`watchForCommand` from `@plugins/infra/plugins/file-watcher/cli`: the same
engine, no registry (a CLI process has no catalog, and a wait is not background
activity). It takes the engine's options directly — `dirs` + `onChange`
required.

## Other ways to watch are lint errors

`watcher-safety/no-direct-parcel-watcher` keeps `@parcel/watcher` inside this
plugin's `shared/`; `watcher-safety/no-raw-fs-watch` bans `fs.watch` /
`watchFile` / `fs.promises.watch` / chokidar in host-process code, with a
reasoned `exempt/index.ts` manifest.

## `onChange` and `onReconcile` are different questions

- `onChange(events)` — the filesystem said these paths moved.
- `onReconcile()` — the timer came round; re-derive whatever a dropped fsevent
  could have left stale.

The reconcile timer **only exists if the declaration sets `reconcileMs`**,
which makes `onReconcile` required on every `start()` (and passing one without
`reconcileMs` a type error); there is no spelling that routes the tick into
`onChange`. It used to fall back to
`onChange([])`, which meant every consumer written as `onChange: () => rebuild()`
— the common shape, since most of them rebuild wholesale and never read the
events — was told "something changed" every 30 seconds, forever, on an idle
machine. The prototypes gallery believed it: its version resource is the iframe
cache-bust, so every open prototype reloaded every 30s and the author lost
whatever state they had clicked into. A declared `reconcileMs` whose instance
passes no `onReconcile` is a type error rather than a knob that does nothing.

A reconcile is a *backstop*, not a change poll — if reacting to it is expensive,
gate it on a cheap signature of the watched tree and return early when nothing
moved (see `apps/prototypes/files`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: defineFileWatcher: the one declared in-process file watcher — a named, described declaration (static policy: extensions, ignore, debounce, ceiling, writesWhileOpen, reconcile, mainOnly) whose start({dirs, label, onChange, onReconcile}) opens instances over one @parcel/watcher engine (debounce + ceiling flush, reconcile timer, kqueue sizing). Records per declaration its open instances, last change batch and a ring of handler runs for the Background activity catalog (onWatcherActivity / listFileWatchers / fileWatcherRecentRuns). The cli barrel's watchForCommand is the same engine for a foreground command, with no registry. acquireDirWatch({dir, scope, onChange}) is the shared directory-watch hub: one native watch per folder tree, refcounted, a dir under a watched root riding its watch, with subtree or children (depth-1 listing) scope.
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: 29 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×7
    - `infra` ×7
    - `conversations` ×6
    - `apps` ×2
    - `build`
    - `config_v2`
    - `framework/cli/await`
    - `integrations/google-maps`
    - `plugin-meta/plugin-tree`
    - `release`
    - `reports/outbox`
- Exemptions:
  - Exempts itself from:
    - `detached-work-safety/no-raw-set-interval` — `shared/engine.ts` (sanctioned)
    - `watcher-safety/no-direct-parcel-watcher` — `shared` (sanctioned)
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
    - `WatchReaction`
    - `WatchReconcile`
  - Exports (values):
    - `acquireDirWatch`
    - `BATCH_SAMPLE_MAX`
    - `defineFileWatcher`
    - `fileWatcherRecentRuns`
    - `listFileWatchers`
    - `onWatcherActivity`
    - `WRITES_WHILE_OPEN_MAX_ENTRIES`
  - Register: `defineFileWatcher('file-watcher.dirs')`
- Cli:
  - Exports (types):
    - `FileWatcher`
    - `WatchForCommandOptions`
    - `WatchReaction`
    - `WatchReconcile`
  - Exports (values): `watchForCommand`
- Sub-plugins:
  - **`background-arm`** — File watchers in the Background activity catalog: registers the `file-watcher` background kind — every declaration made with defineFileWatcher under File watchers, triggered on file change, its…

<!-- AUTOGENERATED:END -->
