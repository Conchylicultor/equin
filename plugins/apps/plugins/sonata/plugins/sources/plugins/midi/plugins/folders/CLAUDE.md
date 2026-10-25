# folders

Mirrors user-configured folders of `.mid`/`.midi` files into the Sonata library.

`sourceMissing` is a field the MIDI source's extension EXPOSES on every list of
songs (`songMidiShape`, its public core; labelled **"File"**, not "Source" — the
library already lists a `source` field, and two columns headed "Source" is
unreadable). Its meaning is this plugin's, so this plugin PRESENTS it
(`FieldPresentation.Register({ owner: songMidiShape.exposure })`,
`web/internal/presentation.tsx`): a "File missing" badge, nothing when present.
Being a field, "show me the songs whose file vanished" is a filter, not a visual
scan — run on the server over the exposed column, which every library row
carries.

Two mechanisms keep the DB in sync with disk:

- **Live watcher** (`watcher.ts`) — a `@parcel/watcher` over the configured dirs.
  Create/update enqueues `importMidiFileJob`; delete badges the song
  `sourceMissing`. Rebuilt whenever the `midi-folders` config changes (via
  `watchConfig`), so there is no polling.
- **Drift reconcile** (`reconcile.ts`) — catches what the watcher cannot: files
  that changed while the backend was down, and pre-existing files in a
  newly-added folder (the watcher emits no events for those). It runs at boot
  (the warm-up below), on a real config change, and when the watch reports
  lost events (`onLost`: FSEvents / inotify dropped some) — **never on a
  timer**. One reconcile is a recursive walk of every watched folder, and a
  watched folder can be a big tree (`~/Downloads`: 26k dirs holding 31 MIDI
  files, ~2.6 s of `readdir` per walk); the former 30 s `reconcileMs` backstop
  re-walked it every 30 s in every backend to find nothing changed.

### An unreadable folder is a state, never a skip

Every configured folder is **probed** (`server/internal/folder-status.ts`:
resolve with `realpathSync`, then open it) into a typed `FolderStatus` —
`ok`, `missing`, `not-a-folder`, `denied` (EPERM: macOS's Files & Folders
refused equin; EACCES: the folder's own permissions) or `unreadable` (any
other errno, with its code and message). Only the `ok` folders' real paths
(`readableDirs()`) are watched, walked by the corpus index and used by
reverse drift — so one bad folder can neither crash the backend, abort the
walk nor fail the watcher for the others, and the songs of an unreadable
folder are never marked "File missing" (their files are not known to be gone).

The statuses are the `sonata.midi-folders.status` live value (pushed when a
probe's result changes); the library shows each unreadable folder as a
`Library.Notice` — which folder, why, and Allow access (EPERM only) / Check
again / Change folder… / Remove — and the library header's gear lists every
folder with its status and song count (`sonata.midi-folders.song-count`).
The probe runs on every config change, at the start of every reconcile, and on
`POST /api/sonata/midi-folders/recheck` (Check again): macOS sends no signal
when access is granted. A probe that changes WHICH folders are readable
re-mounts the watcher and reconciles, so a fixed folder imports at once.

### Corpus index + boot deferral

The reconcile enumerates the watched folders through a **`defineCorpusIndex`**
(`infra/corpus-index`) rather than an ad-hoc `readdir`. The index supplies the
throttled, heavy-read-gated, `(mtimeMs,size)`-fingerprinted walk and — via
`ensureFresh()`'s `modifiedPaths` — lets reconcile re-import a file whose bytes
changed while the backend was down (a drift hole the old boot reconcile could
never close). There is no per-file payload, so `parse` is omitted (an
enumerate-only `CorpusIndex<null>`; `entries()` after a refresh is the
authoritative on-disk set). The single per-file `getSongMidiBySourcePath`
round-trip is gone: reconcile loads the whole folder-imported set once with
`listFolderImportedSongs()` and diffs in memory.

- **`modifiedPaths`, never `addedPaths`** — only a file that HAD a fingerprint
  and whose fingerprint changed proves an edit. `addedPaths` means "the index had
  no entry", which on a cold index is every file (see below) — so the DB (`!song`)
  is the authority on what is genuinely new. Keying re-import off the two
  conflated re-imported all 19 MIDI files on every worktree boot.
- **`scope: "host"`** — the corpus is a host-global user folder, so ONE shared
  index lives in the Sonata app's one data dir, `~/.singularity/apps/sonata/`
  (`sonataDir`, declared at the app root, not here), and only main persists it. A
  per-worktree index would make every freshly-forked worktree re-walk from
  scratch. The DB is still per-worktree, so `reconcile()` runs on every backend,
  reading the shared index and computing its own delta. Corollary: a **worktree
  backend never persists** (`computePersist("host", isMain()=false)`), so its
  index is cold on every boot and `modifiedPaths` is empty there until main has
  written the shared index — edits-while-down are detected against main's
  fingerprints, which is exactly why `addedPaths` must not trigger work.
- **Own-your-watcher** — this plugin runs its own watcher over the same dirs, so
  it must NOT call the index's `startWatcher()` (double-watch, and it is
  `isMain()`-gated). `reconcile()` calls `markDirty()` before every
  `ensureFresh()` — the only invalidation seam when you own the watcher.

The initial boot reconcile is a declared **`midiFoldersWarmup`**
(`defineWarmup`, `scope: "worktree"`) drained after `onAllReady`, not run inside
`onReady`. `onReady` now only mounts the watcher (cheap); the recursive walk no
longer sits on the boot path. Warm-up throw-tolerance is correct here — reconcile
is drift repair, not a correctness dependency.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Watched-folder UI for the MIDI source: registers the midi-folders config and presents the File field (the MIDI exposure's `sourceMissing`) that flags — and lets you filter for — folder-imported songs whose file has been deleted from disk. Shows every watched folder that cannot be read (denied by macOS, missing, not a folder) as a notice on the library — which folder, why, and Allow access / Check again / Change folder / Remove — and puts the folder list itself, with each folder's status, under a Sonata settings gear in the library header. Watches configured folders for .mid/.midi files and mirrors them into the Sonata library: auto-imports on create/edit (via a per-file job), badges 'source deleted' on removal, and reconciles drift on boot and config change. The watched-folder list is a config_v2 listField. Probes each folder (ok / missing / not a folder / denied / unreadable): only readable folders are watched and walked, and the statuses are served live (sonata.midi-folders.status) with a Check again endpoint, plus each folder's imported-song count.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "midi-folders"
    - `FieldPresentation.Register` "exposure:sonata_songs_ext_midi"
    - `Library.Notice` "midi-folders" → `MidiFoldersNotice`
    - `sonataLibraryPane.Actions` "midi-folders" → `MidiFoldersSettingsButton`
  - Uses: 30 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `config_v2` ×3
    - `primitives/css/ui-kit` ×3
    - `apps/sonata/library` ×2
    - `network/live` ×2
    - `primitives/css/control-panel` ×2
    - `primitives/css/spacing` ×2
    - `primitives/folder-picker` ×2
    - `primitives/live-state` ×2
    - `infra/endpoints.useFetchEndpoint`
    - `primitives/css/badge.Badge`
    - `primitives/css/card.Card`
    - `primitives/css/center.Center`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/overlay/popover.InlinePopover`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `ConfigV2.Register` "midi-folders"
    - `resource.declare` "sonata.midi-folders.song-count"
    - `resource.declare` "sonata.midi-folders.status"
  - Uses:
    - `apps/sonata/sources/midi.getSongMidiBySourcePath`
    - `apps/sonata/sources/midi.importMidiSong`
    - `apps/sonata/sources/midi.listFolderImportedSongs`
    - `apps/sonata/sources/midi.setSourceMissing`
    - `apps/sonata/sources/midi.songMidi`
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `config_v2.watchConfig`
    - `database.db`
    - `infra/corpus-index.CorpusDelta`
    - `infra/corpus-index.defineCorpusIndex`
    - `infra/endpoints.implement`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileChangeEvent`
    - `infra/file-watcher.FileWatcher`
    - `infra/jobs.defineJob`
    - `infra/warmup.defineWarmup`
    - `network/live.serveValue`
  - Register:
    - `defineJob('sonata.midi.import')`
    - `defineWarmup('sonata.midi-folders.reconcile')`
    - `defineFileWatcher('sonata-midi-folders.folders')`
  - Resources:
    - `sonata.midi-folders.song-count` (push)
    - `sonata.midi-folders.status` (push, notified, whole: one entry per configured watched folder — a handful, user-authored)
  - Routes: `POST /api/sonata/midi-folders/recheck`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-lg`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-caption`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/import-job.ts`, `server/internal/reconcile.ts`, `server/internal/folder-status.ts` (debt)

<!-- AUTOGENERATED:END -->
