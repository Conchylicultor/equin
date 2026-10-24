# Sonata library — play count, last-played & MIDI track count

## Context

The Sonata song library ([`2026-06-05-sonata-song-library-ux.md`](./2026-06-05-sonata-song-library-ux.md))
just landed: `sonata_songs` rows + MIDI attachments, a reactive gallery, and a streamlined
player. Each card today shows only title, composer, and duration — it reads as a static
catalog with no sense of *use*. This plan surfaces three per-song facts so the gallery can
show usage and sort by it:

- **MIDI track count** — how many (note-bearing) tracks the file has.
- **Play count** — how many times the song has been played.
- **Last played** — when it was last played.

Storage follows the boundary the song nature dictates (locked during design):

- **Track count is immutable, file-derived** → it belongs on the core `sonata_songs` row
  alongside `durationSec`/`endBeat`, populated once at import/seed time.
- **Play count & last-played are mutable usage data written by the player, not the library**
  → they live in an **entity-extensions side-table** owned by a *new, independently
  composable* `playback-history` sub-plugin, so the library schema stays stable and the
  feature can be added/removed with zero library changes.
- **Aggregates (e.g. total song count) are derived, not stored.**

A "play" is counted on **playback start** — the first time the user presses Play after
opening a song (pause→resume does not re-count; reopening the song re-arms). The gallery
also gains **sort controls** (Newest / Recently played / Most played), with the play-based
orderings *contributed by* `playback-history` so the library never imports play data.

## Architecture

Three pieces, each respecting the DAG (`playback-history → library → shell`; nothing
imports `playback-history`):

1. **Library (extend in place):** add the immutable `midiTrackCount` column + field;
   render it on the card; define two extension seams the card/gallery expose
   (`SongLibrary.CardMeta` render slot, `SongLibrary.Sort` slot) and a built-in "Newest"
   sort.
2. **Shell (two small, generic additions):** track `currentSongId` (+ a `songOpenEpoch`
   bump per open) so a play can be attributed to a song; add a headless, always-mounted
   `Sonata.Effect` slot for Sonata-scoped side effects (reusable seam, not one-off).
3. **New `playback-history` sub-plugin:** the `sonata_songs_ext_playback` side-table via
   `defineExtension`, a `recordPlay` endpoint (atomic increment), a live resource, a headless
   observer (contributed to `Sonata.Effect`) that POSTs `recordPlay` on playback start, a
   card-stats component (→ `SongLibrary.CardMeta`), and the two play-based sort options
   (→ `SongLibrary.Sort`).

## Implementation

### 1. Library: immutable `midiTrackCount` (on the core row)

- **`library/server/internal/tables.ts`** — add to `_songs`:
  `midiTrackCount: integer("midi_track_count")` (nullable — honestly unknown for any row
  imported before this change; new content always populates it).
- **`library/core/schemas.ts`** — `SongSchema`: add `midiTrackCount: z.number().nullable()`.
- **`library/core/endpoints.ts`** — `CreateSongBodySchema`: add `midiTrackCount: z.number()`.
- **`library/server/internal/resources.ts`** — `toSong()`: map `row.midiTrackCount`.
- **`library/server/internal/handle-create-song.ts`** — insert `midiTrackCount: body.midiTrackCount`.
- **`library/server/internal/seed.ts`** — starters are single-track: insert
  `midiTrackCount: midi.tracks.length` (= 1). Also **backfill existing starters**: change the
  `if (existing.has(starter.id)) continue;` branch to, when already present, run a cheap
  `UPDATE sonata_songs SET midi_track_count = 1 WHERE id = $id AND midi_track_count IS NULL`
  so the canonical seeds aren't left blank after the migration. (Attachments are *not*
  re-minted.)
- **`library/web/components/song-library.tsx`** — `importFile()` already has
  `const score = compile(buf)`; pass `midiTrackCount: score.tracks.length` in the
  `createSong` body. (`score.tracks` = note-bearing tracks, the same set the roll renders —
  the consistent definition of "tracks".)
- **`library/web/components/song-card.tsx`** — render `{n} track{s}` next to the duration
  when `song.midiTrackCount != null`.

### 2. Library: card + sort extension seams (new slots)

- **New `library/web/slots.ts`** (mirrors `shell/web/slots.ts`):
  ```ts
  export const SongLibrary = {
    // Per-card metadata strip (play stats, future per-card badges). Headless-friendly.
    CardMeta: defineRenderSlot<{ song: Song }>("sonata.library.card-meta", { reorder: false }),
    // Extra gallery orderings. Each option exposes a hook returning a comparator so a
    // contributor can read its OWN resource (the library never sees play data).
    Sort: defineSlot<{
      id: string;
      label: string;
      useComparator: () => (a: Song, b: Song) => number;
    }>("sonata.library.sort"),
  };
  ```
  Re-export `SongLibrary` from `library/web/index.ts` (barrel-pure re-export, like `Sonata`).
- **`library/web/components/song-card.tsx`** — render
  `<SongLibrary.CardMeta.Render song={song}>{(m) => <m.component … />}</…>` in the card body.
- **`library/web/components/song-library.tsx`** — sort UI in the header:
  - Built-in "Newest" comparator (by `createdAt` desc) is the default. Contribute it to
    `SongLibrary.Sort` from the library web plugin (uniform list) **or** prepend it inline.
  - `const opts = SongLibrary.Sort.useContributions();` then call each `opt.useComparator()`
    once (stable contribution list ⇒ rules-of-hooks safe) and apply the active one's
    comparator to `songs.data`.
  - Active sort id in `useState("newest")` (optionally persisted via
    `@plugins/primitives/plugins/persistent-draft/web`, key `"sonata-library-sort"`).
  - Render the options as a `SegmentedControl`
    (`@plugins/primitives/plugins/toggle-chip/web`) or a small dropdown.

### 3. Shell: song attribution + headless effect slot

- **`shell/web/context.tsx`**:
  - Add state `currentSongId: string | null` and `songOpenEpoch` (number).
  - Change `openPlayer` to take the song:
    `openPlayer: (song: { id: string; title: string }) => void` → sets id + title,
    `view="player"`, and bumps `songOpenEpoch` (re-arms a play even when reopening the same
    song). Update the `SonataContextValue` interface, the `value` memo + deps.
  - Expose `currentSongId` and `songOpenEpoch` in context.
- **`shell/web/slots.ts`** — add a headless, always-mounted side-effect seam:
  ```ts
  Effect: defineRenderSlot<{ component: ComponentType }>("sonata.effect", { reorder: false }),
  ```
- **`shell/web/components/sonata-layout.tsx`** — render it once **inside** `SonataProvider`
  (so contributed components can `useSonata()`), in both views:
  `<Sonata.Effect.Render>{(e) => <e.component key={e.id} />}</Sonata.Effect.Render>`.
- **`library/web/components/song-library.tsx`** — `open(song)` calls
  `openPlayer({ id: song.id, title: song.title })`.

> Shell stays ignorant of playback-history: it only exposes *which song is open* + *is it
> playing* (already exposed) + *a slot to mount effects*. All recording logic lives in the
> consumer.

### 4. New plugin: `plugins/apps/plugins/sonata/plugins/playback-history/`

```
playback-history/
  package.json            # deps: drizzle-orm, zod, react-icons
  core/
    index.ts
    schemas.ts            # PlaybackHistoryRowSchema { songId, playCount, lastPlayedAt: string|null }
    resources.ts          # playbackHistoryResource = resourceDescriptor("sonata-playback-history", array, [])
    endpoints.ts          # recordPlay: POST /api/sonata/songs/:id/play
  server/
    index.ts              # httpRoutes + Resource.Declare(playbackHistoryLiveResource)
    internal/
      tables.ts           # defineExtension(_songs, "playback", {...}) + re-export .table
      resources.ts        # live loader over the ext table
      handle-record-play.ts
  web/
    index.ts              # contributes Sonata.Effect + SongLibrary.CardMeta + 2× SongLibrary.Sort
    hooks.ts              # usePlaybackHistoryMap(), usePlaybackHistory(songId)
    components/
      record-play-observer.tsx   # headless; → Sonata.Effect
      play-stats.tsx             # card stats; → SongLibrary.CardMeta
```

**`server/internal/tables.ts`** — side-table via the entity-extensions primitive (mirrors
`tasks_ext_auto_start`):
```ts
import { integer, timestamp } from "drizzle-orm/pg-core";
import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";

export const songPlayback = defineExtension(_songs, "playback", {
  playCount: integer("play_count").notNull().default(0),
  lastPlayedAt: timestamp("last_played_at", { withTimezone: true }),
});
export const _songPlaybackExt = songPlayback.table; // drizzle-kit discovery
// → table sonata_songs_ext_playback (parentId PK FK→sonata_songs.id ON DELETE CASCADE)
```

**`server/internal/handle-record-play.ts`** — atomic increment (no read-modify-write race),
then notify the live resource:
```ts
implement(recordPlay, async ({ params }) => {
  const now = new Date();
  await db.insert(_songPlaybackExt)
    .values({ parentId: params.id, playCount: 1, lastPlayedAt: now })
    .onConflictDoUpdate({
      target: _songPlaybackExt.parentId,
      set: { playCount: sql`${_songPlaybackExt.playCount} + 1`, lastPlayedAt: now, updatedAt: now },
    });
  playbackHistoryLiveResource.notify();
  return { ok: true };
});
```
The FK makes a play for a non-existent song fail loudly (good). `recordPlay` has no body and
a tiny `{ ok }` response (or void).

**`server/internal/resources.ts`** — `mode: "push"`, loads all rows from `_songPlaybackExt`,
maps to `{ songId: parentId, playCount, lastPlayedAt: lastPlayedAt?.toISOString() ?? null }`.

**`web/components/record-play-observer.tsx`** — headless; the single write trigger:
```ts
export function RecordPlayObserver() {
  const { currentSongId, isPlaying, songOpenEpoch } = useSonata();
  const prevPlaying = useRef(false);
  const recordedEpoch = useRef<number | null>(null);
  useEffect(() => {
    const started = !prevPlaying.current && isPlaying;
    prevPlaying.current = isPlaying;
    if (started && currentSongId && recordedEpoch.current !== songOpenEpoch) {
      recordedEpoch.current = songOpenEpoch;            // once per open ⇒ pause/resume safe
      void fetchEndpoint(recordPlay, { id: currentSongId });
    }
  }, [isPlaying, currentSongId, songOpenEpoch]);
  return null;
}
```

**`web/components/play-stats.tsx`** — reads `usePlaybackHistory(song.id)`; renders
`▶ {playCount} plays · {formatRelativeTime(lastPlayedAt)}`
(`@plugins/primitives/plugins/relative-time/web`). Renders nothing / "Not played yet" when
absent.

**`web/index.ts`** contributions:
```ts
contributions: [
  Sonata.Effect({ id: "record-play", component: RecordPlayObserver }),
  SongLibrary.CardMeta({ id: "play-stats", component: PlayStats }),
  SongLibrary.Sort({ id: "most-played",     label: "Most played",     useComparator: useMostPlayedComparator }),
  SongLibrary.Sort({ id: "recently-played", label: "Recently played", useComparator: useRecentlyPlayedComparator }),
],
```
The two comparator hooks both read `usePlaybackHistoryMap()` (one resource read) and sort
descending by `playCount` / `lastPlayedAt` epoch (absent ⇒ 0, sorts last).

## Critical files

| File | Change |
|---|---|
| `…/library/server/internal/tables.ts` | + `midiTrackCount` column |
| `…/library/core/schemas.ts` · `core/endpoints.ts` | + `midiTrackCount` field / body |
| `…/library/server/internal/{resources,handle-create-song,seed}.ts` | map / insert / seed + backfill track count |
| `…/library/web/slots.ts` | **new** — `SongLibrary.{CardMeta,Sort}` |
| `…/library/web/index.ts` | re-export `SongLibrary` |
| `…/library/web/components/song-card.tsx` | render track count + `CardMeta` slot |
| `…/library/web/components/song-library.tsx` | sort dropdown + `Sort` slot + built-in Newest; `openPlayer({id,title})`; pass `midiTrackCount` on import |
| `…/shell/web/context.tsx` | `currentSongId` + `songOpenEpoch`; `openPlayer(song)` |
| `…/shell/web/slots.ts` | + headless `Sonata.Effect` |
| `…/shell/web/components/sonata-layout.tsx` | render `Sonata.Effect` inside provider |
| `…/sonata/plugins/playback-history/**` | **new** plugin (core/server/web per layout) |

## Key reused helpers (with paths)

- `defineExtension` — `@plugins/infra/plugins/entity-extensions/server` (precedents:
  `tasks/plugins/auto-start`, `tasks/plugins/task-preprompt`)
- `_songs` — `@plugins/apps/plugins/sonata/plugins/library/server`
- `defineEndpoint` / `implement` / `fetchEndpoint` — `@plugins/infra/plugins/endpoints/{core,server,web}`
- `resourceDescriptor` / `useResource` / `defineResource` — `@plugins/primitives/plugins/live-state/{core,web}` and `@plugins/framework/plugins/server-core/core`
- `defineRenderSlot` / `defineSlot` — `@plugins/primitives/plugins/slot-render/web`, `@plugins/framework/plugins/web-sdk/core`
- `formatRelativeTime` / `RelativeTime` — `@plugins/primitives/plugins/relative-time/web`
- `SegmentedControl` / toggle chips — `@plugins/primitives/plugins/toggle-chip/web`
- `useDraft` (optional sort persistence) — `@plugins/primitives/plugins/persistent-draft/web`
- `compile` (gives `score.tracks`) — `@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/web`
- `db` / `sql` — `@plugins/database/server` / `drizzle-orm`

## Verification

1. `./equin build` — generates two migrations (the `sonata_songs.midi_track_count`
   column + the `sonata_songs_ext_playback` table), regenerates the plugin registry, seeds +
   backfills starter track counts. Confirm no check fails (`migrations-in-sync`,
   `plugin-boundaries`, `eslint`, `plugins-doc-in-sync`).
2. Open `http://<worktree>.localhost:9000/sonata` → the library cards now show
   **"N tracks"** (starters: 1) and **play stats** ("Not played yet").
3. Open a starter → press **Play**. Return to Library → the card shows **1 play · just now**.
   Press Play again on the same open session after a pause → still 1 (pause/resume doesn't
   re-count). Reopen the song and Play → 2 plays (a fresh open re-arms).
4. Sort dropdown: switch to **Most played** / **Recently played** → order reflects the data;
   **Newest** restores create order.
5. Live push: with two tabs open, play in one → the other tab's count/last-played update with
   no reload (resource `.notify()`), no polling.
6. DB check (`mcp__singularity__query_db`):
   `select id, midi_track_count from sonata_songs;` and
   `select * from sonata_songs_ext_playback;` → counts/timestamps match the UI; deleting a
   song cascades its playback row away.
7. Scripted: `bun e2e/screenshot.mjs --url …/sonata --click "<starter title>"` then click
   **Play**; re-open the library and assert the play count rendered.

## Out of scope / follow-ups

- Per-play history rows (a log of every play) — v1 stores only the rollup (count + last).
- Play *duration* / "counts only if ≥ N seconds played" thresholds — v1 counts on start.
- Track *names*/instruments on the card (compile already exposes `score.tracks[].name`).
- Most/least-played analytics across the whole library.
