# Restore the Sonata Chord Grid as a library-integrated song source

## Context

Sonata's chord-grid source still exists and is still loaded
(`plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid/`): its
`Sonata.Source` contribution (a textarea loader + `compile()` → `Score`) is wired
up correctly and still merges into the player's composed score. But it became
**unreachable** in commit `1ef5226e1` (*"feat(sonata): song library landing +
server-backed persistence"*), which reworked Sonata from an inline-authoring tool
into a **library → player** model and deleted the two UI surfaces that exposed the
chord grid:

1. the **Source picker** (let you switch to "Chord Grid"), and
2. the **active-source loader strip** (rendered the chord-grid textarea).

On top of that, chord-grid never got a `Library.Source` contribution, so — unlike
MIDI — it cannot be saved or opened as a song.

**Goal:** make the chord grid a *first-class, library-integrated* song source,
exactly mirroring how MIDI integrates. After this change a user can press
**"New Chord Grid"** in the library header, get a new song opened in the player,
edit its chord text / voicing / octave (and its title) in an **editor panel**
that live-recompiles the score and autosaves, and reopen it later from the
gallery. We deliberately do **not** bring back the global source picker / loader
strip — editing lives in a per-source editor section, owned by the chord-grid
plugin.

## Approach

Mirror the MIDI source's persistence pattern byte-for-byte
(`plugins/apps/plugins/sonata/plugins/sources/plugins/midi/`), swapping the
attachment for three text/int columns, and adding an **update** path (chord text
is editable, where MIDI files are immutable). The chord-grid plugin gains a
`server/` and `shared/` tree plus two new web components; the library server
gains one small generic helper; the Sonata context gains a clean per-source raw
accessor so the editor section can read/write the chord-grid raw without
hijacking `activeSourceId`.

### The chord-grid raw shape (already defined)

`ChordGridRaw = { text: string; voicingId: string; octave: number }`
(`.../chord-grid/web/compile.ts:32`). This is exactly what `hydrate` returns and
what the loader/`compile()` consume — no new shape needed.

---

### 1. Server persistence — new `server/` + `shared/` in the chord-grid plugin

Mirror `sources/plugins/midi/{server,shared}`.

**`shared/resources.ts`** — live-resource descriptor (for the optional CardMeta):
```ts
resourceDescriptor("sonata-song-chord-grid", z.array(SongChordGridRowSchema), [])
```

**`shared/endpoints.ts`** — three endpoints (`defineEndpoint`, mirroring
`midi/shared/endpoints.ts`). All responses need an explicit zod `response` schema
(client returns `undefined` otherwise — see memory `fetchEndpoint needs response schema`):
- `createChordGridSong` — `POST /api/sonata/songs/chord-grid`, body
  `{ title, composer, chordText, voicingId, octave, durationSec, endBeat }`,
  response `{ id, title }`.
- `getSongChordGrid` — `GET /api/sonata/songs/:id/chord-grid`, response
  `{ chordText, voicingId, octave } | null`.
- `updateChordGridSong` — `PUT /api/sonata/songs/:id/chord-grid`, body
  `{ title, chordText, voicingId, octave, durationSec, endBeat }`, response
  `{ ok: true }`. (Carries recomputed `durationSec`/`endBeat` + `title` so the
  parent song row stays in sync; client computes them since `compile()` is web-side,
  exactly as MIDI's create computes `endBeat`/`trackCount` client-side.)

**`server/internal/tables.ts`** — entity-extension side-table via
`defineExtension` (`@plugins/infra/plugins/entity-extensions/server`):
```ts
export const songChordGrid = defineExtension(_songs, "chord_grid", {
  chordText: text("chord_text").notNull(),
  voicingId: text("voicing_id").notNull(),
  octave: integer("octave").notNull(),
});
export const _songChordGridExt = songChordGrid.table; // drizzle-kit discovery
```
Produces `sonata_songs_ext_chord_grid` (`parent_id` PK FK→`sonata_songs.id`
CASCADE → delete is automatic & source-agnostic; no `handleDeleteSong` change).

**`server/internal/routes.ts`** — `implement(...)` for all three:
- create: `createSongRow({title,composer,durationSec,endBeat})` →
  `songChordGrid.upsert(id,{chordText,voicingId,octave})` →
  `songChordGridLiveResource.notify()` → return `{id,title}`. No
  `songAttachments.add` (no attachment).
- get: `db.select().from(_songChordGridExt).where(eq(parentId, params.id))` →
  map to `{chordText,voicingId,octave}` or `null`.
- update: `songChordGrid.upsert(...)` → `updateSongMeta(id,{title,durationSec,endBeat})`
  (new library helper, below) → `songChordGridLiveResource.notify()`.

**`server/internal/resource.ts`** — `defineResource({ mode:"push", loader: () =>
db.select().from(_songChordGridExt) → rows.map(r => ({songId:r.parentId, ...})) })`.

**`server/index.ts`** — register the three routes + `Resource.Declare(songChordGridLiveResource)`;
re-export `songChordGrid` and the live resource. (Optional `onReady` seed — see
"Optional polish".) New server plugin is auto-discovered by `./equin build`.

### 2. Library server — one new generic helper

Add to `plugins/apps/plugins/sonata/plugins/library/server/`:

**`internal/update-song-meta.ts`** — mirror `create-song-row.ts`. The library owns
`_songs` mutations; sources never poke the parent table directly.
```ts
export interface UpdateSongMetaInput { id: string; title?: string; durationSec?: number; endBeat?: number }
export async function updateSongMeta(input: UpdateSongMetaInput): Promise<void> {
  await db.update(_songs).set({ ...definedFields }).where(eq(_songs.id, input.id));
  songsLiveResource.notify();
}
```
Export `updateSongMeta` from `library/server/index.ts` next to `createSongRow`.

### 3. Sonata context — clean per-source raw accessor

`plugins/apps/plugins/sonata/plugins/shell/web/context.tsx`. Today the only way to
read a source's raw is `activeRaw` (gated on `activeSourceId`), and `setRaw` writes
the active slot. The editor section must read/write the chord-grid slot
specifically without commandeering `activeSourceId`. Add two generic methods to
`SonataContextValue` (and the provider value):
- `sourceRaw: (sourceId: string) => unknown` → `rawById[sourceId]`.
- `setSourceRaw: (sourceId: string, raw: unknown) => void` → merge one key
  (`setRawById(prev => ({ ...prev, [sourceId]: raw }))`).

Refactor existing `setRaw` to call `setSourceRaw(activeSourceIdRef.current, raw)`
and `activeRaw` to `sourceRaw(activeSourceId)` (no behavior change). This is a
minimal, generic generalization — no contributor names, collection-consumer clean.

### 4. Web — `Library.Source` + editor section (chord-grid plugin)

**`web/hydrate.ts`** — `hydrate(songId): Promise<ChordGridRaw | undefined>`:
`fetchEndpoint(getSongChordGrid,{id:songId})` → `{text:chordText,voicingId,octave}`
or `undefined`. (The library's `useOpenSong` stores this under key `"chord-grid"`.)

**`web/components/chord-grid-add-action.tsx`** — the `Library.Source.AddAction`,
rendered in the library header (`song-library.tsx` already maps `s.AddAction`).
Mirror `midi-add-action.tsx`: on click, build a starter `ChordGridRaw`
(`text: "| C  G | Am  F |"`, `voicingId: DEFAULT_VOICING_ID`, `octave: 4`),
`compile()` it client-side for `endBeat`/`durationSec`
(`scoreEndBeat` + `beatToSeconds` from
`@plugins/apps/plugins/sonata/plugins/score/core`), `fetchEndpoint(createChordGridSong,
{}, { body: { title: "New Chord Grid", composer: null, ...raw, durationSec, endBeat } })`,
then `useOpenSong()(song)` to open it immediately.

**`web/components/chord-grid-editor-section.tsx`** — the `Sonata.Section` with
`area: "editor"` (renders in the layout's `subId="editor"` column — first editor
section in the app). It:
- reads the chord-grid raw via `sourceRaw("chord-grid")` (default to the EMPTY raw
  if undefined);
- renders an editable **title** field (reuse `useEditableField` from
  `@plugins/primitives/plugins/editable-field/web`; on save → debounced
  `updateChordGridSong` with current raw-derived metrics) — solves the
  "new song has no title / no rename" gap;
- renders the existing `ChordGridLoader` with `raw` + an `onRaw` that:
  1. `setSourceRaw("chord-grid", raw)` for instant in-memory recompile (live score), and
  2. debounced (~500 ms) `fetchEndpoint(updateChordGridSong, { id: currentSongId },
     { body: { title, chordText, voicingId, octave, durationSec, endBeat } })`
     where `durationSec`/`endBeat` come from `compile(raw)` + `scoreEndBeat`.
  Guard the save on `currentSongId` (no save on the library view). Reuse
  `useEditableField`'s focus-aware/serialized-save behavior where it fits, or a
  small `useRef` debounce mirroring the timer pattern.

**`web/index.ts`** — add to `contributions`:
```ts
Library.Source({ sourceId: "chord-grid", hydrate, AddAction: ChordGridAddAction }),
Sonata.Section({ id: "chord-grid-editor", label: "Chord Grid", icon: MdGridView,
                 component: ChordGridEditorSection, area: "editor" }),
```
(Keep the existing `Sonata.Source({ id: "chord-grid", ... })`.) Import `Library`
from `@plugins/apps/plugins/sonata/plugins/library/web`, exactly as
`midi/web/index.ts` does.

### Optional polish (include if cheap; not required by the ask)

- **`Library.CardMeta`** — a `ChordGridCardMeta` showing e.g. bar count, reading
  the new `songChordGridLiveResource` (mirrors MIDI's track-count CardMeta). If
  omitted, drop the live resource + `shared/resources.ts`.
- **Boot seed** — `server/index.ts` `onReady` seeds one demo chord-grid song
  (stable id via `createChordGridSong`'s idempotent `createSongRow`), mirroring
  `seedMidiStarters`, so the gallery ships with an example.

## Critical files

- New: `sources/plugins/chord-grid/shared/{endpoints,resources}.ts`
- New: `sources/plugins/chord-grid/server/{index.ts,internal/{tables,routes,resource}.ts}`
- New: `sources/plugins/chord-grid/web/hydrate.ts`
- New: `sources/plugins/chord-grid/web/components/{chord-grid-add-action,chord-grid-editor-section}.tsx`
- Edit: `sources/plugins/chord-grid/web/index.ts` (+`Library.Source`, +`Sonata.Section`)
- Edit: `plugins/library/server/index.ts` + new `internal/update-song-meta.ts`
- Edit: `plugins/shell/web/context.tsx` (+`sourceRaw`/`setSourceRaw`)
- Reference (mirror): `sources/plugins/midi/{web,server,shared}/*`,
  `plugins/library/server/internal/create-song-row.ts`,
  `plugins/library/web/{hooks.ts,slots.ts,components/song-library.tsx}`,
  `plugins/shell/web/components/sonata-layout.tsx` (editor-section render site).

## Verification

1. `./equin build` (regenerates the `sonata_songs_ext_chord_grid` migration,
   builds web/server, restarts; commit the generated migration). Confirm the build
   publishes (checks/health green — stale dist otherwise, per memory).
2. Open `http://att-1780821184-4qoa.localhost:9000` → Sonata → Library. Verify a
   **"New Chord Grid"** button sits next to MIDI's **Import** in the header.
3. Click it → a new song opens in the player; the right pane shows the **Chord
   Grid** editor section (title field + textarea + voicing/octave). Editing the
   grid live-updates the displayed score; play works.
4. Edit chord text + title; go **← Library**; confirm the card shows the new title
   and updated length. Reopen from the gallery → edits persisted (hydrate round-trip).
5. `mcp__singularity__query_db` →
   `SELECT * FROM sonata_songs_ext_chord_grid;` shows the row
   (`chord_text`,`voicing_id`,`octave`); `SELECT title,duration_sec FROM sonata_songs`
   reflects edits.
6. Delete the song from the gallery → confirm the `sonata_songs_ext_chord_grid`
   row is gone (FK CASCADE).
7. `./equin check` passes (migrations-in-sync, eslint, plugin-boundaries,
   plugins-doc-in-sync).
8. Scripted check (optional): `bun e2e/screenshot.mjs --url <player-url> --click
   "New Chord Grid" --out /tmp/chord` to confirm the affordance + editor render.
