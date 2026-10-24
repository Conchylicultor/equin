# Sonata — Auto-register MIDI files from watched folders

**Date:** 2026-06-10
**Status:** Design — awaiting approval

## Context

Sonata only ingests MIDI through explicit user action (an "Import" button or an
in-player drag/drop). There is no way to point Sonata at a folder and have its
`.mid` files appear in the library automatically, the way Synthesia watches a
songs directory. This plan adds **watched folders**: the user configures one or
more directories; Sonata mirrors their `.mid`/`.midi` contents into the song
library, keeping it in sync as files are added, edited, or removed.

Decisions locked with the user:

- **Byte storage:** copy bytes into the existing attachment store on import
  (reuses the player path unchanged), not reference-in-place.
- **On file deletion:** keep the imported song in the library but **mark it
  visually as "source deleted"** — never silently drop it.

## Architecture overview

Everything the import path needs already exists; the work is wiring, one schema
extension, and moving the MIDI parser so the server can call it.

```
config_v2 listField (folders)
        │  watchConfig
        ▼
folder-watcher manager  ──(@parcel/watcher via infra/file-watcher)──▶ FS events
        │  create/update → enqueue job        delete → mark missing (inline DB update)
        ▼
sonata.midi.import job
        │  read bytes → parseMidi (shared) → createAttachment
        │  → createSongRow → songMidi.upsert(sourcePath) → songAttachments.set → notify
        ▼
songMidiLiveResource (push) ──▶ Library cards (badge when sourceMissing)
```

Failures are isolated per file by running the heavy import as a **job**
(graphile retry), so one corrupt `.mid` can't take down the watcher.

## New sub-plugin

Create `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders/`
(child of the existing `midi` source — auto-discovered by the plugin loader, **no
registry edits**). It owns the watched-folder concept end to end:

```
folders/
  shared/config.ts        defineConfig({ name: "midi-folders", fields: { folders: listField(...) } })
  server/index.ts         ConfigV2.Register + register:[importMidiFileJob] + onReady/onShutdown (watcher)
  server/internal/
    watcher.ts            start/stop manager (mirrors git-watcher), watchConfig re-mount, reconcile
    import-job.ts         defineJob "sonata.midi.import" — read/parse/create
    reconcile.ts          initial scan + drift detection (file gone → mark missing; file back → clear)
  web/index.ts            ConfigV2.WebRegister + Library.CardMeta badge contribution
  web/components/source-deleted-badge.tsx
```

### Config (the folder registry + its UI, for free)

```ts
// folders/shared/config.ts
export const midiFoldersConfig = defineConfig({
  name: "midi-folders",
  fields: {
    folders: listField({
      label: "Watched MIDI folders",
      itemFields: { path: textField({ label: "Absolute folder path" }) },
      default: [],
    }),
  },
});
```

- Editing is handled by config_v2's **built-in settings pane** (ConfigNav /
  ConfigDetail, list field has a drag-sortable add/remove renderer). No custom
  form to build.
- Stored per-worktree at
  `~/.singularity/config/<worktree>/apps/sonata/sources/midi/folders/midi-folders.jsonc`.
- `listField` items carry auto-injected `id` + `rank`; the server reads
  `getConfig(midiFoldersConfig).folders.map(f => f.path)`.
- *Optional discoverability:* add a gear entry from the Sonata library toolbar
  via `useOpenConfig()` (config-link sub-plugin). Not required for v1.

## Schema change — `sonata_songs_ext_midi`

Add two nullable/defaulted columns to the existing extension
(`sources/plugins/midi/server/internal/tables.ts`):

```ts
export const songMidi = defineExtension(_songs, "midi", {
  attachmentId: text("attachment_id").notNull(),
  trackCount: integer("track_count").notNull(),
  sourcePath: text("source_path"),                 // null = manual import; set = folder-imported
  sourceMissing: boolean("source_missing").notNull().default(false),
});
```

- `sourcePath` is the **idempotency key** for folder imports and what marks a
  song as folder-managed. Manual imports leave it null and are never touched by
  the watcher.
- `sourceMissing` drives the library badge.
- Surface both on `SongMidiRow` + `songMidiLiveResource` (already a push
  resource consumed by the cards) so the badge needs no new endpoint.
- Generate the migration via `./equin build` (never `drizzle-kit` by hand).

## Refactors (make the import path reusable server-side)

1. **Move the MIDI parser to `shared/`.** `web/compile.ts` imports only
   `@tonejs/midi` + Score core types — it is already Node/Bun-safe. Move it to
   `sources/plugins/midi/shared/parse.ts` and update the two web importers
   (`midi-add-action.tsx`, `loader.tsx`). `@tonejs/midi` is isomorphic.

2. **Extract a shared metadata helper.** Add
   `deriveMidiSongMeta(raw, filename) → { title, durationSec, endBeat, trackCount }`
   in `shared/parse.ts`, replacing the inline computation in
   `midi-add-action.tsx`. Both the web import button and the server job call it.

3. **Extract one server import function** in the midi plugin and export it from
   `sources/plugins/midi/server/index.ts`:

   ```ts
   // importMidiSong({ bytes, filename, sourcePath? }) → songId
   //   const score = parseMidi(bytes)                         // shared
   //   const meta  = deriveMidiSongMeta(bytes, filename)      // shared
   //   const att   = await createAttachment(bytes, filename, "audio/midi")
   //   const id    = await createSongRow({ title, composer:null, durationSec, endBeat })
   //   await songMidi.upsert(id, { attachmentId: att.id, trackCount, sourcePath, sourceMissing:false })
   //   await songAttachments.set(id, [att.id])   // set (not add): file edits don't leak orphan attachments
   //   songMidiLiveResource.notify()
   ```

   `handleCreateMidiSong` and `seedMidiStarters` stay as-is (they already have
   metadata/bytes); the new function is what the watcher job calls. Also export
   helpers `getSongMidiBySourcePath(path)` and `setSourceMissing(songId, bool)`.

## Watcher + import job

Mirror **git-watcher** (`infra/git-watcher/server/internal/watcher.ts`) exactly —
module-level `watcher: FileWatcher | null`, `start`/`stop`, re-mount on change.

`folders/server/internal/watcher.ts`:

- `startMidiFolderWatcher()` (from `onReady`): read folder paths from
  `getConfig`, `createFileWatcher({ dirs, extensions: [".mid", ".midi"],
  onChange, onReconcile })`, then run an **initial reconcile** (the watcher does
  not emit events for pre-existing files).
- `watchConfig(midiFoldersConfig, …)` callback: `await watcher.stop()` then
  recreate over the new dir set, and reconcile (imports files in newly added
  folders).
- `onChange`: per event — `create`/`update` → `importMidiFileJob.enqueue({
  sourcePath })`; `delete` → look up by sourcePath and `setSourceMissing(id,
  true)` inline (trivial UPDATE).
- `onReconcile` + initial scan (`reconcile.ts`): diff DB folder-imported songs
  against on-disk files. File present & no song → enqueue import. File present &
  song.sourceMissing → clear flag (came back). Song present & file gone → mark
  missing. Catches changes that happened while the server was down.
- `onShutdown`: `stopMidiFolderWatcher()`.

`folders/server/internal/import-job.ts`:

```ts
export const importMidiFileJob = defineJob({
  name: "sonata.midi.import",
  input: z.object({ sourcePath: z.string() }),
  event: z.never(),
  async run({ sourcePath }) {
    const existing = await getSongMidiBySourcePath(sourcePath);
    const bytes = await Bun.file(sourcePath).bytes();
    if (existing) { /* re-import bytes, upsert same song, clear sourceMissing */ }
    else await importMidiSong({ bytes, filename: basename(sourcePath), sourcePath });
  },
});
```

Per-file isolation + graphile retry means a corrupt file fails loudly in the job
log (and can file a crash task per the recoverable-error policy) without
stalling the watcher.

## UI — "source deleted" badge

`folders/web/` contributes to the existing **`Library.CardMeta`** slot (same slot
playback-history uses). It reads the song's midi row from the live resource the
cards already consume; when `sourceMissing` is true it renders a small badge
(e.g. `badge` primitive, `variant` warning, "Source deleted") so the song is
visibly flagged but still playable from its copied attachment.

## Idempotency / sync semantics

| Event | Action |
|---|---|
| File created in watched folder | enqueue import → new folder-managed song |
| File edited | re-import bytes, upsert same song (matched by sourcePath), clear missing |
| File deleted | keep song, set `sourceMissing = true` → badge |
| File restored | reconcile clears `sourceMissing` |
| Folder added to config | watcher re-mounts; reconcile imports its existing files |
| Folder removed from config | stop watching; existing songs untouched (not marked missing) |
| Server restart | initial reconcile catches all drift |
| Manual import (sourcePath null) | never touched by the watcher |

## Files

**Create**
- `…/sources/plugins/midi/plugins/folders/shared/config.ts`
- `…/folders/server/index.ts`, `server/internal/{watcher,import-job,reconcile}.ts`
- `…/folders/web/index.ts`, `web/components/source-deleted-badge.tsx`
- `…/sources/plugins/midi/shared/parse.ts` (moved from `web/compile.ts`)

**Modify**
- `…/sources/plugins/midi/server/internal/tables.ts` — add `sourcePath`, `sourceMissing`
- `…/sources/plugins/midi/server/internal/resource.ts` + `SongMidiRow` schema — surface the two fields
- `…/sources/plugins/midi/server/index.ts` — export `importMidiSong`, `getSongMidiBySourcePath`, `setSourceMissing`
- `…/sources/plugins/midi/web/{loader.tsx, components/midi-add-action.tsx}` — import parser from `shared/`
- delete `…/sources/plugins/midi/web/compile.ts` (moved)

## Reused APIs (no new infra)

- `createFileWatcher` — `infra/file-watcher/server` (dynamic stop/recreate)
- `getConfig` / `watchConfig` / `ConfigV2.{Register,WebRegister}` — `config_v2/{server,web}`
- `defineConfig` / `listField` / `textField` — `config_v2/core`, `fields/plugins/text/.../config/core`
- `createAttachment` — `infra/attachments/server`
- `defineJob` — `infra/jobs/server`
- `createSongRow`, `songAttachments` (`.set`) — `…/sonata/plugins/library/server`
- `songMidi` (`defineExtension` `.upsert/.get`), `songMidiLiveResource` — midi plugin
- git-watcher manager pattern — `infra/git-watcher/server/internal/watcher.ts`

## Verification

1. `./equin build` (generates the migration, applies on restart) and
   confirm the `sonata_songs_ext_midi` migration was created + committed.
2. In the config settings pane, add a watched folder (e.g. `/tmp/sonata-midi`).
   Drop a `.mid` file in it; confirm the song appears in the Sonata library
   (`query_db` on `sonata_songs` / `sonata_songs_ext_midi`, and visually).
3. Edit/replace the file; confirm the song updates (new attachment, no
   duplicate row).
4. Delete the file; confirm the song stays and shows the "source deleted" badge
   (`sourceMissing = true`).
5. Restore the file; confirm the badge clears via reconcile.
6. Restart the server with a pre-populated folder; confirm the initial reconcile
   imports/marks correctly.
7. Confirm a manually-imported song (null sourcePath) is never modified by any
   of the above.
8. `./equin check` passes (plugin boundaries, migrations-in-sync, docs).

## Out of scope

- Reference-in-place storage (rejected; we copy).
- Recursive/sub-directory watching toggle, glob filters, per-folder options.
- Auto-deletion of songs when files are removed (we keep + badge).
- Watching non-MIDI formats.
