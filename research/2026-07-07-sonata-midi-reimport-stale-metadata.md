# Fix: folder re-import of an edited `.mid` leaves song metadata stale

## Context

When a watched-folder `.mid` file is edited on disk, the folder watcher enqueues
`sonata.midi.import`, which re-reads the bytes and calls `importMidiSong` with
the existing song id so the re-import updates the song **in place** instead of
spawning a duplicate library row.

`importMidiSong` correctly re-parses the edited bytes and recomputes the derived
metadata (`title`, `durationSec`, `endBeat` via `deriveMidiSongMeta`), then hands
it to `writeMidiSong`. But `writeMidiSong` only writes that `meta` into the
generic `sonata_songs` row on the **fresh-create** branch (`createSongRow`). On
every **reuse** branch (`existingSongId` set, or a content-hash dup adopted) it
upserts only the MIDI extension row (`songMidi.upsert`) and re-links the
attachment (`songAttachments.set`) — the recomputed `meta` is silently dropped.

Result: the library row's `duration_sec` / `end_beat` / `title` go stale after an
edit. Observed live: song `d2b12907-43cc-4eb0-9bb6-65f80ad56c98`
("BosaNova Modern-37182 (clean)") had its file replaced (new content 19.9s /
40 beats) but the row still reported the old 14.18s / 41.8 beats. The player is
unaffected because it re-parses the attachment on open, so the drift only shows
in library metadata (gallery card, DataView columns, sort/filter) — easy to miss.

**Decision (confirmed with user):** re-import should refresh `title` too (not just
the derived metrics), mirroring the sibling sources byte-for-byte. MIDI's title is
filename-derived and a same-path re-import keeps the same filename, so in practice
this is a no-op for title unless the file was renamed on disk (content-hash
adopt path) — but we make the row authoritative over the file regardless.

## Root cause

`writeMidiSong` in
`plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server/internal/import.ts`
(lines 61-108) applies `meta` only through `createSongRow` on the create branch.
No `updateSongMeta` call exists on the reuse path.

This is the one gap vs. the established precedent — every other song source
already syncs the parent row on edit:

- `seed.ts` (lines 100-114) — after `createSongRow` (insert-if-absent), calls
  `updateSongMeta({ id, title, composer, durationSec, endBeat })` with the exact
  comment "Make STARTERS authoritative over metadata too … No-op on a fresh
  insert; corrects a drifted row."
- ultimate-guitar `routes.ts` (lines 113-127) — upserts its ext row, then
  `updateSongMeta({ id, title, composer, durationSec, endBeat })`.
- chord-grid `routes.ts` (line 63) — same pattern.

`updateSongMeta` is the library's sanctioned generic mutation
(`plugins/apps/plugins/sonata/plugins/library/server/internal/update-song-meta.ts`),
already re-exported from the library server barrel and **already imported** by the
MIDI server (`seed.ts`). It writes only the provided fields and pushes the
reactive `songsResource` so the gallery updates live.

## Change

Single edit in `import.ts` → `writeMidiSong`. After the song id is resolved and
the extension row + attachment link are written, sync the generic row from the
freshly derived `meta`:

```ts
  await songMidi.upsert(id, {
    attachmentId,
    trackCount,
    sourcePath,
    sourceMissing: false,
    contentHash,
  });

  await songAttachments.set(id, [attachmentId]);

  // Make the library row authoritative over the file on every re-import: the
  // reuse branches (existingSongId re-import, content-hash adopt) skip
  // createSongRow, so without this the recomputed title/duration/endBeat from an
  // edited file would never reach the generic sonata_songs row. No-op on a fresh
  // insert (createSongRow just wrote the same values); corrects a drifted row.
  await updateSongMeta({
    id,
    title: meta.title,
    composer: meta.composer,
    durationSec: meta.durationSec,
    endBeat: meta.endBeat,
  });

  return id;
```

Add `updateSongMeta` to the existing library-server import at the top of
`import.ts`:

```ts
import {
  createSongRow,
  songAttachments,
  updateSongMeta,
} from "@plugins/apps/plugins/sonata/plugins/library/server";
```

### Why this placement (not gated to only the reuse branch)

- The early-return "redundant second on-disk copy" path (line 81) returns
  *before* this code, so it is correctly left untouched — we never disturb a
  live different file's song.
- On the fresh-create path the call is a redundant no-op (same values just
  inserted), exactly as `seed.ts` documents. Placing one unconditional call
  after the shared upsert covers all three reuse paths (`existingSongId`,
  content-hash moved-file adopt, manual) with no branch-specific logic — the
  simplest correct shape and identical in spirit to `seed.ts`.

## Files

- **Modify:** `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server/internal/import.ts`
  - add `updateSongMeta` to the library-server import (line ~8-11)
  - add the `updateSongMeta(...)` call in `writeMidiSong` after
    `songAttachments.set` (line ~105), before `return id`
- No schema change, no new migration, no doc-sync change (the MIDI CLAUDE.md
  reference block already lists `apps/sonata/library.updateSongMeta` as a used
  import).

## Verification

End-to-end, driving the real re-import path:

1. `./equin build` from the worktree, confirm it comes up.
2. Reproduce the stale-metadata drift and confirm the fix live:
   - Pick (or create) a folder-imported MIDI song and note its
     `duration_sec` / `end_beat` / `title` via the `query_db` MCP tool:
     `select id, title, duration_sec, end_beat from sonata_songs where id = '<id>';`
   - Find its `source_path` from `sonata_songs_ext_midi`
     (`select parent_id, source_path, content_hash from sonata_songs_ext_midi where parent_id = '<id>';`).
   - Overwrite that on-disk `.mid` with a different-length MIDI file (e.g. copy a
     longer starter over it), keeping the same path so the watcher fires an
     `update` and the re-import takes the `existingSongId` branch.
   - After the `sonata.midi.import` job runs, re-query `sonata_songs`: confirm
     `duration_sec` / `end_beat` now match the new file's derived values (and
     `content_hash` in the ext row changed), instead of staying at the old values.
3. Confirm the create path is unaffected: import a brand-new `.mid` (drag/drop or
   drop into a watched folder) and verify the row is created once with correct
   metadata (no duplicate row, no regression).
4. Optional: confirm a user-visible refresh — the gallery card / DataView
   duration column for the edited song updates live without reload (the
   `updateSongMeta` push drives `songsResource`).

## Out of scope / notes

- No change to edit-detection: the watcher still fires on OS create/update
  fsevents and the job reuses the row by `source_path`. This fix only ensures the
  reused row's generic metadata is refreshed. (A content-hash short-circuit to
  skip no-op re-imports is a possible future optimization, not needed here.)
- `title` is filename-derived; per the confirmed decision we overwrite it on
  re-import to keep the row authoritative over the file. A same-path edit keeps
  the same filename, so this is a no-op for title in the common case.
