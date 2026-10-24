# Sonata — source-owned song persistence (decouple MIDI from the core song model)

## Context

The Sonata song library (see `2026-06-05-sonata-song-library-ux.md`) shipped with MIDI baked
into the **core** song model:

- `sonata_songs` carries `midi_attachment_id` and `midi_track_count` columns.
- The library imports `MIDI_SOURCE_ID` and hydrates only the MIDI source on open
  (`setRawMap({ [MIDI_SOURCE_ID]: buf })`).
- The library owns the MIDI **Import** button (parses `.mid`, posts a MIDI-shaped `createSong`).
- The library **seeds** MIDI starter songs at boot.

But Sonata has multiple input *sources* (MIDI = binary attachment, chord-grid = JSON, sheet
music later = something else), and a song should be able to carry any subset of them. The core
song row should be **source-agnostic**; each source should own its own persisted shape — the
exact job of the **entity-extensions** primitive, mirroring how `playback-history` already owns
`sonata_songs_ext_playback` without the library knowing about it.

**Goal (confirmed full decoupling):** the `library` plugin and the `sonata_songs` schema become
100% source-agnostic. Every MIDI specific — its persisted data, its hydration, its Import
affordance, and its starter seeding — moves into the **MIDI source** plugin. Adding a future
source (sheet music) requires **zero** changes to `library` or the core schema. Chord-grid
persistence is deferred (the seams support it; not built now).

This is the **collection–consumer separation** the repo mandates: `library` owns the registry +
generic interface (`Library.Source` slot, generic `createSongRow`, generic song→attachment link);
each source is a contributor. The dependency flips the right way — today `library → midi`
(via `MIDI_SOURCE_ID`); after this, `library` depends on no source, and `midi → library`
(like `playback-history → library`).

## Current state (verified)

- `library/core/schemas.ts` — `SongSchema` has `midiAttachmentId` + `midiTrackCount`.
- `library/core/endpoints.ts` — `createSong` body has `attachmentId` + `midiTrackCount`.
- `library/server/internal/{tables,resources,handle-create-song,seed,schema-attachments}.ts` —
  MIDI columns, MIDI-shaped create, MIDI starter seeding, `songAttachments = defineLink(_songs)`.
- `library/web/components/song-library.tsx` — `open()` hardcodes `MIDI_SOURCE_ID`; `importFile()`
  hardcodes the MIDI import; header has a hardcoded Import button.
- `library/web/components/song-card.tsx` — renders `song.midiTrackCount` inline.
- `sources/plugins/midi/` — **web-only** today (`compile`, `MidiLoader`, `MIDI_SOURCE_ID`,
  `Sonata.Source`). No `server/`, no `shared/`.
- `shell/web/context.tsx` — `setRawMap` **merges** into `rawById` (line 192); only `open()` uses it.
- **Precedent to mirror exactly:** `playback-history` (`shared/` resources+endpoints,
  `server/internal/{tables,resource,routes}.ts` + `Resource.Declare`, `web/hooks.ts` reading a
  push resource, `Library.CardMeta` contribution). `playback-history` extends `_songs` via
  `defineExtension(_songs, "playback", {...})` and never touches the library schema.
- `Attachments.defineLink(owner)` **requires `owner.id`** and names the table
  `<owner>_attachments`. An extension table is keyed by `parentId` (no `.id`) and would collide
  on name — so the generic song→attachment link **stays in `library` keyed on `_songs.id`**
  (it is source-agnostic: "a song may have linked attachments"); the MIDI source calls it.

## Design

### The generic collection seam: `Library.Source`

New slot defined **and consumed** by `library/web` (library owns the registry; sources
contribute). A plain `defineSlot` carries both data and an optional component:

```ts
// library/web/slots.ts
Source: defineSlot<{
  sourceId: string;
  /** Produce this source's client raw for a song, or undefined if it has no data for it. */
  hydrate: (songId: string) => Promise<unknown | undefined>;
  /** Optional "add a song of this source" affordance, rendered in the library header. */
  AddAction?: ComponentType;
}>("sonata.library.source", { docLabel: (c) => c.sourceId }),
```

**Loading** (new exported hook `useOpenSong` in `library/web`, used by both cards and AddActions):

```ts
export function useOpenSong() {
  const sources = Library.Source.useContributions();
  const { setRawMap, openPlayer } = useSonata();
  return useCallback(async (song: { id: string; title: string }) => {
    const entries = await Promise.all(
      sources.map(async (s) => {
        const raw = await s.hydrate(song.id);
        return raw === undefined ? null : ([s.sourceId, raw] as const);
      }),
    );
    setRawMap(Object.fromEntries(entries.filter((e): e is [string, unknown] => e !== null)));
    openPlayer({ id: song.id, title: song.title });
  }, [sources, setRawMap, openPlayer]);
}
```

Zero special-casing of any source. The library never imports `MIDI_SOURCE_ID`.

### `setRawMap` → replace semantics

`open()` must load **exactly** the opened song's sources, not merge with the previously-opened
song's lingering raw (otherwise opening a MIDI-only song after a multi-source song keeps stale
inputs). Only `open()` uses `setRawMap` (verified), so change it to **replace**:

```ts
// shell/web/context.tsx
const setRawMap = useCallback((m) => setRawById(m), []);   // was ({ ...prev, ...m })
```

Update the doc comment to "load a song's complete input set (replaces prior)". The existing
`useEffect([baseScore])` already resets cursor/playing on change.

### Core schema: generic only

`library` core/server lose all MIDI fields:

- `SongSchema` → `{ id, title, composer, durationSec, endBeat, createdAt }`
  (`durationSec`/`endBeat` are score-level, source-agnostic).
- `tables.ts` `_songs` → drop `midi_attachment_id`, `midi_track_count`.
- `resources.ts` `toSong` → drop the two fields.
- `core/endpoints.ts` → **remove** `createSong` + `CreateSongBodySchema`; keep `deleteSong`
  (generic; FK CASCADE drops every extension + the attachment link).
- New `library/server` helper used by sources + any seeder:
  ```ts
  export async function createSongRow(meta: {
    id?: string; title: string; composer: string | null; durationSec: number; endBeat: number;
  }): Promise<string> { /* id ?? randomUUID(); insert onConflictDoNothing; notify; return id */ }
  ```
- `library/server/index.ts` → drop `createSong` route + `onReady` seeding; export `createSongRow`,
  `songAttachments`, `songsLiveResource`, `_songs`. Keep `schema-attachments.ts` (generic link).
- `library/web/components/song-card.tsx` → remove the inline `midiTrackCount` block (track count
  now arrives via `Library.CardMeta`). `MdMusicNote` icon header stays (generic).
- `library/web/components/song-library.tsx` → replace the hardcoded Import button + hidden input
  + `importFile()`/`open()` with: render `Library.Source` AddActions in the header, and use
  `useOpenSong()` for card opens. Empty-state copy → source-agnostic ("No songs yet").
- `library/web/index.ts` → also export `useOpenSong`. Update plugin description (no "imports MIDI").

### MIDI source gains a server + shared + web persistence (mirror `playback-history`)

```
sources/plugins/midi/
  package.json          # + @tonejs/midi, drizzle-orm, zod, @plugins deps
  shared/
    resources.ts        # SongMidiRowSchema {songId, attachmentId, trackCount} + songMidiResource
    endpoints.ts        # createMidiSong (POST), getSongMidi (GET :id)
  server/
    index.ts            # httpRoutes + Resource.Declare(songMidiLiveResource) + onReady(seedMidiStarters)
    internal/
      tables.ts         # songMidi = defineExtension(_songs,"midi",{attachmentId,trackCount}); export _songMidiExt
      resource.ts       # songMidiLiveResource (push; loads all ext rows)
      routes.ts         # handleCreateMidiSong, handleGetSongMidi
      seed.ts           # seedMidiStarters (idempotent, keyed on ext presence — see migration note)
      starters.ts       # MOVED from library: the 3 public-domain note arrays
  web/
    index.ts            # Sonata.Source (unchanged) + Library.Source({sourceId, hydrate, AddAction}) + Library.CardMeta(MidiCardMeta)
    constants.ts        # MIDI_SOURCE_ID (unchanged)
    compile.ts / loader.tsx (unchanged)
    hooks.ts            # useSongMidi(songId) reading songMidiResource (mirror usePlaybackHistory)
    components/
      midi-add-action.tsx  # the Import button + file input + import flow (moved from library)
      midi-card-meta.tsx   # "N track(s)" from useSongMidi (replaces inline card field)
```

**`tables.ts`** (mirrors `playback-history/.../tables.ts`):
```ts
export const songMidi = defineExtension(_songs, "midi", {
  attachmentId: text("attachment_id").notNull(),
  trackCount: integer("track_count").notNull(),
});
export const _songMidiExt = songMidi.table;   // → sonata_songs_ext_midi; drizzle-kit discovery
```

**`createMidiSong` handler** — one round trip; library helper owns the `_songs` write:
```ts
implement(createMidiSong, async ({ body }) => {            // {title,composer,attachmentId,durationSec,endBeat,trackCount}
  const id = await createSongRow({ title, composer, durationSec, endBeat });
  await songMidi.upsert(id, { attachmentId, trackCount });
  await songAttachments.add(id, [attachmentId]);           // generic link from library → orphan-safe
  songMidiLiveResource.notify();
  return { id, title };                                     // enough for useOpenSong
});
```

**`getSongMidi` handler** → `{ attachmentId, trackCount } | null` for `hydrate` (a one-shot fetch
in a non-hook context; the push resource serves the reactive card list separately).

**`hydrate`** (in `midi/web`):
```ts
async (songId) => {
  const m = await fetchEndpoint(getSongMidi, { id: songId });
  if (!m) return undefined;
  const res = await fetch(attachmentUrl(m.attachmentId));
  if (!res.ok) throw new Error(`Failed to load MIDI (${res.status})`);
  return res.arrayBuffer();
}
```

**`MidiAddAction`** — moved import flow: upload → `compile` (metadata) → `fetchEndpoint(createMidiSong,…)`
→ `useOpenSong()(created)`. Hidden `<input accept=".mid,.midi">` + "Import" button.

**`MidiCardMeta`** — `useSongMidi(song.id)?.trackCount` → "N track(s)" (mirror `PlayStats`).

### Seeding moves to the MIDI source + survives the migration

The migration **drops** `midi_attachment_id`/`midi_track_count` and **creates**
`sonata_songs_ext_midi` (empty). drizzle-kit does not backfill, so the seeder must **self-heal**:
key idempotency on **ext-row presence**, not song-row presence.

```ts
// midi/server/internal/seed.ts
for (const s of STARTERS) {
  if (await songMidi.get(s.id)) continue;                  // already has MIDI ext → done
  const midi = new Midi(); midi.header.setTempo(s.bpm); /* addTrack/addNote … */
  const att = await createAttachment(midi.toArray(), `${s.id}.mid`, "audio/midi");
  await createSongRow({ id: s.id, title: s.title, composer: s.composer, durationSec, endBeat });
  await songMidi.upsert(s.id, { attachmentId: att.id, trackCount: midi.tracks.length });
  await songAttachments.add(s.id, [att.id]);
}
songMidiLiveResource.notify();
```

On the first boot after migration, existing starter `_songs` rows lack a MIDI ext → re-mint the
attachment + ext (the `_songs` row is preserved via `createSongRow`'s `onConflictDoNothing`).
**Caveat:** user-imported (non-starter) songs lose their MIDI link (no backfill path through the
generated-migration flow) and must be re-imported — acceptable, since worktree DBs are forks and
the only durable data are the auto-seeded starters. Flag at hand-off.

## Critical files

| File | Change |
|---|---|
| `…/library/core/schemas.ts` | drop `midiAttachmentId`/`midiTrackCount` from `SongSchema` |
| `…/library/core/endpoints.ts` | remove `createSong`/`CreateSongBodySchema`; keep `deleteSong` |
| `…/library/server/internal/tables.ts` | drop the two MIDI columns from `_songs` |
| `…/library/server/internal/resources.ts` | `toSong` loses the two fields |
| `…/library/server/internal/handle-create-song.ts` | delete; add `create-song-row.ts` (`createSongRow`) |
| `…/library/server/internal/seed.ts` + `starters.ts` | **move** to `midi/server/internal/` |
| `…/library/server/index.ts` | drop create route + seed `onReady`; export `createSongRow`, `songAttachments` |
| `…/library/web/slots.ts` | add `Library.Source` slot |
| `…/library/web/index.ts` | export `useOpenSong`; update description |
| `…/library/web/components/song-library.tsx` | render `Library.Source` AddActions; use `useOpenSong`; drop hardcoded import |
| `…/library/web/components/song-card.tsx` | remove inline `midiTrackCount` block |
| `…/library/web/hooks.ts` (new) | `useOpenSong` |
| `…/sources/plugins/midi/{package.json,shared,server,web/hooks,web/components}` | **new** server+shared+persistence (mirror playback-history) |
| `…/sources/plugins/midi/web/index.ts` | + `Library.Source` + `Library.CardMeta` contributions |
| `…/shell/web/context.tsx` | `setRawMap` → replace semantics + doc |

## Key reused helpers (paths)

- `defineExtension` — `@plugins/infra/plugins/entity-extensions/server` (template: `playback-history/server/internal/tables.ts`)
- `createAttachment` — `@plugins/infra/plugins/attachments/server`; `uploadAttachment` — `…/attachments/web`
- `songAttachments` (generic link) / `createSongRow` / `_songs` / `songsLiveResource` — `…/library/server` (exported)
- `attachmentUrl` — `@plugins/primitives/plugins/text-editor/plugins/paste-images/core`
- `compile`, `scoreEndBeat`, `beatToSeconds` — `…/sources/plugins/midi/web` + `…/sonata/plugins/score/core`
- `defineEndpoint`/`implement`/`fetchEndpoint` — `@plugins/infra/plugins/endpoints/{core,server,web}`
- `resourceDescriptor`/`useResource`/`defineResource`/`Resource.Declare` — live-state + server-core
- `useSonata` (`setRawMap`,`openPlayer`) — `…/sonata/plugins/shell/web`

## Verification

1. `./equin build` — regenerates the migration (drop 2 cols + create `sonata_songs_ext_midi`),
   regenerates docs/registry, seeds MIDI starters on boot. Confirm no check fails
   (`migrations-in-sync`, `plugin-boundaries` — especially **no `library → midi` edge** remains,
   and **no cycle**).
2. Open `http://<worktree>.localhost:9000/sonata` → Library shows the 3 starters with title,
   composer, `m:ss`, **and "N track(s)"** (now via `Library.CardMeta`, not the core row).
3. Click a starter → player hydrates and Play works (generic `useOpenSong` → MIDI `hydrate`).
4. ← Library → **Import** a real `.mid` (MIDI source's AddAction) → saves, card appears with
   track count, auto-opens.
5. Reload → imported song persists. Delete a card → disappears for all tabs (live push;
   FK CASCADE drops `sonata_songs_ext_midi` + the attachment link; orphan sweep reclaims bytes).
6. DB checks via `mcp__singularity__query_db`:
   - `\d sonata_songs` → **no** `midi_attachment_id` / `midi_track_count`.
   - `select * from sonata_songs_ext_midi;` → one row per song (attachment_id, track_count).
   - `select * from sonata_songs_attachments;` → matching link rows (orphan-safe).
7. `e2e/screenshot.mjs --click` on a card to confirm the player opens and Play toggles state.

## Out of scope / follow-ups (seams already support)

- **Chord-grid persistence** (deferred): add a `chord-grid` extension owning JSON + a
  `Library.Source` contribution (`hydrate` returns the JSON, `AddAction` = "New chord chart").
  Zero library/core changes — proves the generality.
- **Sheet-music source** — same recipe; the point of this refactor.
- **Multi-source songs** — `useOpenSong` already collects every source's raw and `setRawMap`
  (now replace-semantics) loads them in one shot; the score pipeline already merges.
- **Backfill of user-imported songs** across the column-drop migration (only starters self-heal).
