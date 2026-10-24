# Sonata MIDI — raw-byte content-hash deduplication

## Context

Today Sonata keys MIDI songs only on **file path** (`source_path` in
`sonata_songs_ext_midi`). Consequences:

- **Move a `.mid` to a different folder** → the old path's song is badged
  `source_missing`, and the new path is imported as a **brand-new song** → a
  duplicate.
- **Re-upload / re-import the same file manually** → always a new song
  (manual imports have `source_path = null`, so no dedup at all).
- A song's identity is "which path it came from", not "what music it is".

Goal: dedupe on **raw file bytes** (SHA-256). Importing the same MIDI — moved,
re-scanned, or manually re-uploaded — collapses into a **single song row**.

Scope: raw-byte hash only (an exact-bytes match). Re-exported / re-tagged MIDIs
of the "same" song are intentionally out of scope.

## Design

Add a nullable `content_hash` column to `sonata_songs_ext_midi`, compute the
SHA-256 of the raw bytes on every import, and look up an existing song by hash
**before** creating a new row. All three import writers (folder watcher, manual
upload, boot seeder) funnel their write through one new internal helper
`writeMidiSong()` that owns the dedup decision. A boot backfill populates
`content_hash` for songs imported before this change so the move/dedup behavior
also works on the existing library.

### Dedup decision (in `writeMidiSong`)

Given `{ contentHash, attachmentId, trackCount, meta, sourcePath, existingSongId }`:

1. If `existingSongId` is set (folder re-import of the *same* path) → write to
   that id (refreshes bytes + hash). No hash lookup.
2. Else look up `getSongMidiByContentHash(contentHash)`:
   - **No match** → `createSongRow(...)` (genuinely new song).
   - **Match that is `source_missing` (file moved) or `source_path = null`
     (manual)** → reuse its id and **adopt** the new `sourcePath`, clearing
     `source_missing`. This is the headline case: a moved file re-attaches to its
     original song.
   - **Match with a *live* (`!source_missing`) different `source_path`** → this
     is a redundant second on-disk copy. **Return the existing id unchanged** —
     do not create a song and do not steal the live path (prevents reconcile
     flip-flop between two identical files). The new copy collapses into it.
3. On any write branch: `songMidi.upsert(id, { attachmentId, trackCount,
   sourcePath, sourceMissing: false, contentHash })` then
   `songAttachments.set(id, [attachmentId])`, then notify.

This single helper replaces the current divergent write logic in `import.ts`
(folder) and `routes.ts` (manual), so dedup lives in exactly one place.

> **Known edge (acceptable, documented):** the `content_hash` index is
> **non-unique**. Two *brand-new* byte-identical files discovered and imported
> concurrently in the same reconcile pass can both miss the hash lookup and
> create two songs. Every other case (move, re-import, manual re-upload, and any
> later reconcile once the first row exists) dedupes correctly. A unique index is
> avoided because it would turn that rare race into a loud crash + churn rather
> than a rare harmless duplicate.

## Files to modify

All under `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/`.

1. **`server/internal/tables.ts`** — add `content_hash` column to the
   `songMidi` extension:
   ```ts
   contentHash: text("content_hash"),  // SHA-256 hex of the raw .mid bytes; dedup key. Null = legacy/un-backfilled.
   ```
   Add an index on `content_hash` if `defineExtension` accepts an index option;
   otherwise leave un-indexed (the table is small) and note it. Comment the
   column. `./equin build` auto-generates the additive migration.

2. **`server/internal/import.ts`**
   - Add `export function hashMidiBytes(bytes: Uint8Array): string` (Node
     `createHash("sha256").update(bytes).digest("hex")`).
   - Add `getSongMidiByContentHash(contentHash)` → `{ songId, sourcePath,
     sourceMissing } | null` (mirrors existing `getSongMidiBySourcePath`,
     selects on `_songMidiExt.contentHash`). Internal (not barrel-exported).
   - Add internal `writeMidiSong(input)` implementing the dedup decision above.
     `meta` carries `{ title, composer, durationSec, endBeat }`.
   - Refactor `importMidiSong` to: `parseMidi` → `deriveMidiSongMeta` →
     `hashMidiBytes` → `createAttachment` → `writeMidiSong(...)`. (Same external
     signature; `composer` stays `null` for folder imports.)
   - Add `backfillContentHashes()`: select every `_songMidiExt` row with
     `content_hash IS NULL`, read its attachment bytes
     (`getAttachment(row.attachmentId)` → `Bun.file(diskPath).bytes()`), and
     `songMidi.upsert(parentId, { contentHash })`. Idempotent (null-only).
     A missing attachment file is logged + skipped (narrow ENOENT catch), not
     fatal — boot must not crash on an orphaned row.

3. **`server/internal/routes.ts`** (`handleCreateMidiSong`) — replace the direct
   `createSongRow` + `songMidi.upsert` + `songAttachments.add` body with: load
   the uploaded attachment (`getAttachment(body.attachmentId)`; 400 via
   `HttpError` if absent), read its bytes, `hashMidiBytes`, then
   `writeMidiSong({ contentHash, attachmentId: body.attachmentId, trackCount:
   body.trackCount, meta: { title, composer, durationSec, endBeat },
   sourcePath: null })`. Return `{ id, title: body.title }` (id may be an
   existing song on dedup — the client's `openSong` then opens the real song).

4. **`server/internal/seed.ts`** (`seedMidiStarters`) — compute
   `hashMidiBytes(bytes)` from the synthesized `midi.toArray()` bytes and pass
   `contentHash` to `songMidi.upsert`. Keeps starters dedupable against a manual
   re-upload of the identical starter file. (Seeder stays keyed on
   `songMidi.get(starter.id)`; unchanged otherwise.)

5. **`server/index.ts`** — call `await backfillContentHashes()` in `onReady`
   after `seedMidiStarters()`.

No web changes: dedup is entirely server-side. No barrel/API surface changes
(`importMidiSong` keeps its signature; the new helpers stay `internal/`).

## Reuse / key references

- `getSongMidiBySourcePath` (`import.ts:85`) — pattern to copy for
  `getSongMidiByContentHash`.
- `getAttachment(id)` → `{ diskPath, ... }` (`infra/attachments/server`,
  `operations.ts:37`) + `Bun.file(diskPath).bytes()` (already used in
  `import-job.ts:34`) — for reading attachment bytes in the route and backfill.
- `songMidi.upsert` / `songAttachments.set` (`library/server`) — existing write
  primitives, reused unchanged.
- `HttpError` from `@plugins/infra/plugins/endpoints/server` — for the
  missing-attachment 400.

## Verification

1. `./equin build` — confirm the additive migration is generated/applied
   and the server boots (backfill runs without error).
2. `./equin check` — boundaries, migrations-in-sync, eslint, docs-in-sync.
3. **Manual re-upload dedup:** in the Sonata library Import the same `.mid`
   twice → exactly one song. Verify via MCP:
   `mcp__singularity__query_db` →
   `SELECT count(*), content_hash FROM sonata_songs_ext_midi GROUP BY content_hash HAVING count(*) > 1;`
   returns no rows.
4. **Move dedup (headline):** add a watched folder (midi-folders config), drop a
   `.mid` in it (one song appears, `content_hash` set), then move the file to a
   sub/other watched folder. After reconcile: still **one** song, not
   `source_missing`, `source_path` updated to the new location. Check
   `sonata_songs` row count is unchanged and `source_path` followed the file.
5. **Backfill:** confirm pre-existing songs got a non-null `content_hash`:
   `SELECT count(*) FROM sonata_songs_ext_midi WHERE content_hash IS NULL;` → 0
   (excluding any rows with a genuinely missing attachment file).
6. **No regression on new song:** importing a genuinely different `.mid` still
   creates a new song.
7. Use `e2e/screenshot.mjs` against `http://<worktree>.localhost:9000` (Sonata
   library) to confirm the import button still works and no duplicate cards
   appear after a re-import.
