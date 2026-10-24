# Sonata UX redesign — Song Library landing + persistent songs

## Context

Sonata currently opens **straight into the piano-roll player** (`sonata-layout.tsx`): a
toolbar (Source picker, Display picker, transport), a MIDI dropzone strip, and an empty
roll. A first-time user lands on a bare grid with a dropzone — it reads as an unfinished
tool, not an app. Worse, **nothing is persisted**: raw MIDI lives only in React state
(`rawById` in `context.tsx`); there is no DB table, no server plugin, no attachment link.
So every reload forces re-dropping the file.

Both complaints share one missing primitive: **a persistent song library you land on, and
a focused player you enter from it.** This plan adds:

1. A **Song Library** landing (gallery of saved songs) as the app's home view.
2. **Server-backed persistence**: a `sonata_songs` table + each song's MIDI stored via the
   attachments primitive, so songs survive reloads and never need re-selecting.
3. **Bundled starter songs**, generated programmatically with `@tonejs/midi` at boot (no
   binary blobs in the repo, no licensing concerns), so the library is alive on first open.
4. A **streamlined player**: open a song → clean header (← Library, title, transport) +
   piano roll. Source picker and MIDI dropzone hidden; Display picker kept.

Decisions locked with the user: library/home landing · server-backed (DB + attachments) ·
bundle a few starters · streamlined player.

## Architecture

Everything is a plugin. The work splits cleanly:

- **New sub-plugin `library/`** owns persistence + the gallery + song hydration.
- **Shell** gains only generic navigation state + a `Sonata.Home` slot + the streamlined
  player chrome. The shell never imports the library (clean DAG; library → shell).
- **Attachments primitive** gains a small server-side `createAttachment(bytes,…)` helper
  (today it only has an HTTP multipart upload handler — there is no way to mint an
  attachment from bytes on the server, which seeding requires). This is a reusable
  structural addition, not a one-off.

Plugin registration is **fully automatic** via codegen (`plugin-registry-gen.ts` →
`web.generated.ts` / `server.generated.ts`). Creating the new `library/web/index.ts` and
`library/server/index.ts` with default exports and running `./equin build` registers
them — no manual registry edits.

### What a "song" is (v1 = MIDI)

A song is a stored **MIDI file (attachment)** + extracted metadata. The MIDI source already
parses an `ArrayBuffer` purely client-side (`midi/web/compile.ts` via `@tonejs/midi`), and
the score pipeline is driven by `rawById`, so hydrating a saved song = fetch its attachment
bytes → feed them to the MIDI source. The chord-grid stays a live authoring source (not
persisted as a song in v1). Generalizing songs to arbitrary multi-source raw maps is future
work — the new `setRawMap` primitive (below) already supports the multi-source restore path.

## Implementation

### 1. Attachments: server-side `createAttachment` (new reusable primitive)

`plugins/infra/plugins/attachments/server/internal/operations.ts` — add:

```ts
import { diskPathFor, ensureAttachmentsRoot } from "./paths";
export async function createAttachment(
  bytes: Uint8Array, filename: string, mime: string,
): Promise<Attachment> {
  await ensureAttachmentsRoot();
  const id = crypto.randomUUID();
  const diskPath = diskPathFor(id, filename);
  await Bun.write(diskPath, bytes);
  const [row] = await db.insert(_attachments).values({
    id, filename, mime, size: bytes.byteLength, diskPath,
  }).returning();
  if (!row) throw new Error("failed to record attachment");
  return toAttachment(row);
}
```

- Refactor `handle-upload.ts` to call `createAttachment` (DRY — same disk-write + insert).
- Export it from `attachments/server/index.ts`: `export { …, createAttachment } from "./internal/operations";`

> Note: a server-minted attachment is initially **unlinked** — the hourly orphan sweep
> reclaims unlinked rows past TTL. The library MUST create a link row (see §2) so seeded /
> imported songs are never swept.

### 2. New plugin: `plugins/apps/plugins/sonata/plugins/library/`

```
library/
  package.json            # deps: @tonejs/midi, drizzle-orm, zod, react-icons
  core/
    schemas.ts            # SongSchema (zod) + Song type
    resources.ts          # songsResource = resourceDescriptor("sonata-songs", …)
    endpoints.ts          # createSong (POST), deleteSong (DELETE)
  server/
    index.ts              # httpRoutes + register(resource) + onReady(seed)
    internal/
      tables.ts           # _songs = pgTable("sonata_songs", …)
      schema-attachments.ts  # Attachments.defineLink(_songs)
      resources.ts        # defineResource({ key: songsResource.key, mode:"push", loader })
      handle-create-song.ts  # implement(createSong) + notify
      handle-delete-song.ts  # implement(deleteSong) + notify
      seed.ts             # idempotent boot seed of bundled starters
      starters.ts         # note-array definitions of bundled songs
  web/
    index.ts              # contributes Sonata.Home(SongLibrary)
    components/
      song-library.tsx    # gallery: useResource(songsResource) + import + open
      song-card.tsx       # one card (title, composer, mm:ss, play, delete)
```

**`core/schemas.ts`**
```ts
export const SongSchema = z.object({
  id: z.string(),
  title: z.string(),
  composer: z.string().nullable(),
  midiAttachmentId: z.string(),
  durationSec: z.number(),     // for the mm:ss card label
  endBeat: z.number(),
  createdAt: z.string(),
});
export type Song = z.infer<typeof SongSchema>;
```

**`core/resources.ts`** — reactive list via live-state:
```ts
export const songsResource = resourceDescriptor(
  "sonata-songs", z.array(SongSchema), [],   // [] initial → no pending flash
);
```

**`server/internal/tables.ts`** — mirror tasks-core conventions (text PK, tz timestamps):
```ts
export const _songs = pgTable("sonata_songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  composer: text("composer"),
  midiAttachmentId: text("midi_attachment_id").notNull(),
  durationSec: doublePrecision("duration_sec").notNull(),
  endBeat: doublePrecision("end_beat").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

**`server/internal/schema-attachments.ts`** — keeps the server-only `Attachments` import
out of any web-reachable `tables.ts` (mirrors tasks-core `schema-attachments.ts`):
```ts
import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { _songs } from "./tables";
export const songAttachments = Attachments.defineLink(_songs);
export const _songAttachmentsTable = songAttachments.table;   // picked up by drizzle-kit
```

**`server/internal/resources.ts`**
```ts
export const songsLiveResource = defineResource({
  key: songsResource.key, mode: "push", schema: z.array(SongSchema),
  loader: async () => (await db.select().from(_songs).orderBy(desc(_songs.createdAt)))
    .map(toSong),
});
```
Both `handle-create-song` and `handle-delete-song` call `songsLiveResource.notify()` after
their mutation so all open clients update over the WS push (no polling).

**`handle-create-song.ts`** — the import path. Client uploads the MIDI first (gets an
attachment id), then POSTs metadata:
```ts
implement(createSong, async ({ title, composer, attachmentId, durationSec, endBeat }) => {
  const id = crypto.randomUUID();
  await db.insert(_songs).values({ id, title, composer: composer ?? null,
    midiAttachmentId: attachmentId, durationSec, endBeat });
  await songAttachments.add(id, [attachmentId]);   // link → safe from orphan sweep
  await songsLiveResource.notify();
  return toSong(...);
});
```
**`handle-delete-song.ts`** deletes the row (FK cascade drops the link row; the now-unlinked
attachment is reclaimed by the orphan sweep) and notifies.

**`server/internal/starters.ts`** — bundled songs as note arrays (public-domain melodies):
```ts
export const STARTERS = [
  { id: "seed-ode-to-joy",  title: "Ode to Joy",     composer: "Beethoven", bpm: 100, notes: [...] },
  { id: "seed-twinkle",     title: "Twinkle Twinkle", composer: "Trad.",    bpm: 110, notes: [...] },
  { id: "seed-fur-elise",   title: "Für Elise (opening)", composer: "Beethoven", bpm: 72, notes: [...] },
];
// notes: { midi: number; time: number; duration: number }[]  (seconds)
```

**`server/internal/seed.ts`** — idempotent, runs once at boot in `onReady` (not a timer):
```ts
export async function seedStarters() {
  const existing = new Set((await db.select({ id: _songs.id }).from(_songs)).map(r => r.id));
  for (const s of STARTERS) {
    if (existing.has(s.id)) continue;             // skip → no duplicate attachments
    const midi = new Midi(); midi.header.setTempo(s.bpm);
    const track = midi.addTrack();
    for (const n of s.notes) track.addNote(n);
    const att = await createAttachment(midi.toArray(), `${s.id}.mid`, "audio/midi");
    const endBeat = Math.max(...s.notes.map(n => /* beats */)) ;
    const durationSec = Math.max(...s.notes.map(n => n.time + n.duration));
    await db.insert(_songs).values({ id: s.id, title: s.title, composer: s.composer,
      midiAttachmentId: att.id, durationSec, endBeat }).onConflictDoNothing();
    await songAttachments.add(s.id, [att.id]);
  }
}
```
`server/index.ts`: `onReady: async () => { await seedStarters(); }`, plus
`httpRoutes` for create/delete and `register: [songsLiveResource]`.

> `@tonejs/midi` write API confirmed: `new Midi()`, `midi.addTrack()`, `track.addNote(...)`,
> `midi.toArray(): Uint8Array` (v2.0.28, in bun cache).

**`web/components/song-library.tsx`** — the gallery (rendered as the home view):
```ts
const songs = useResource(songsResource);
const { setRawMap, openPlayer } = useSonata();

async function open(song: Song) {
  const buf = await fetch(attachmentUrl(song.midiAttachmentId)).then(r => r.arrayBuffer());
  setRawMap({ [MIDI_SOURCE_ID]: buf });   // hydrate the MIDI source
  openPlayer(song.title);                 // switch shell view → player
}

async function importFile(file: File) {
  const buf = await file.arrayBuffer();
  const score = compileMidi(buf);                       // metadata for the card
  const up = await uploadAttachment(file, file.name, "audio/midi");
  const endBeat = scoreEndBeat(score);
  const song = await fetchEndpoint(createSong, { body: {
    title: score.meta.title ?? file.name.replace(/\.midi?$/i, ""),
    composer: null, attachmentId: up.id,
    durationSec: beatToSeconds(score, endBeat), endBeat } });
  await open(song);                                      // open immediately after import
}
```
- Header: "Library" + **Import** button (hidden `<input type="file" accept=".mid,.midi">`).
- Grid of `SongCard`s: title, composer, `mm:ss` (from `durationSec`), play affordance;
  delete-on-hover → `fetchEndpoint(deleteSong, …)`. List updates reactively via the resource.
- Reuse `attachmentUrl` from
  `@plugins/primitives/plugins/text-editor/plugins/paste-images/core`, and the score helpers
  (`scoreEndBeat`, `beatToSeconds`, `compile`) from the score/midi cores.

### 3. MIDI source: export its id

`sources/plugins/midi/web/index.ts` — export a constant and use it in the registration so
the library imports an id rather than a magic string:
```ts
export const MIDI_SOURCE_ID = "midi";
// … Sonata.Source({ id: MIDI_SOURCE_ID, … })
```
Library → midi-source is a legitimate, declared DAG edge (the library is intentionally
MIDI-backed; this is not a collection-consumer special-case).

### 4. Shell: navigation state + `Sonata.Home` slot + streamlined player

**`shell/web/context.tsx`** — add to `SonataContextValue` + `SonataProvider`:
```ts
view: "library" | "player";          // default "library"
currentSongTitle: string | null;
setRawMap: (rawMap: Record<string, unknown>) => void;   // bulk raw write, source-agnostic
openPlayer: (title: string) => void;                    // set title + view="player"
backToLibrary: () => void;                              // stop() + view="library"
```
```ts
const setRawMap = useCallback((m: Record<string, unknown>) =>
  setRawById(prev => ({ ...prev, ...m })), []);
```
`backToLibrary` calls `stop()` first. The existing `useEffect([baseScore])` already resets
cursor/playing when `rawById` changes, so opening a new song auto-stops + rewinds.
Gate the transport keyboard shortcuts on `view === "player"` (publish the transport bus only
in the player, or check `view` in `togglePlay`) so Space doesn't play from the library.

**`shell/web/slots.ts`** — add a single-purpose home slot:
```ts
Home: defineRenderSlot<{ component: ComponentType }>("sonata.home", { reorder: false }),
```

**`shell/web/components/sonata-layout.tsx`** — branch in `SonataLayoutInner`:
- `view === "library"` → render `<Sonata.Home.Render>{(h) => <h.component/>}</…>`.
- `view === "player"` → **streamlined** chrome:
  - Header row: `← Library` button (`backToLibrary`), `currentSongTitle`, transport
    (Play/Stop, beat, tempo), and the **Display picker** only.
  - **Hide** the Source picker and the active-source `LoaderComponent` strip.
  - Keep `Sonata.Transport.Render`, the display dispatch, and the side `Section` panels.
- `SonataProvider` continues to wrap both views (transport/raw state persists across nav);
  `PaneOverlayHost` stays at the `SonataLayout` level unchanged.

## Critical files

| File | Change |
|---|---|
| `plugins/infra/plugins/attachments/server/internal/operations.ts` | **new** `createAttachment(bytes,…)` |
| `plugins/infra/plugins/attachments/server/internal/handle-upload.ts` | refactor to use `createAttachment` |
| `plugins/infra/plugins/attachments/server/index.ts` | export `createAttachment` |
| `plugins/apps/plugins/sonata/plugins/library/**` | **new** plugin (core/server/web per layout above) |
| `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/web/index.ts` | export `MIDI_SOURCE_ID` |
| `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` | nav state + `setRawMap`/`openPlayer`/`backToLibrary`; gate shortcuts on view |
| `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` | add `Sonata.Home` slot |
| `plugins/apps/plugins/sonata/plugins/shell/web/components/sonata-layout.tsx` | view branch + streamlined player header |

## Key reused helpers (with paths)

- `uploadAttachment` — `@plugins/infra/plugins/attachments/web`
- `Attachments.defineLink`, `createAttachment` (new) — `@plugins/infra/plugins/attachments/server`
- `attachmentUrl` — `@plugins/primitives/plugins/text-editor/plugins/paste-images/core`
- `defineEndpoint` / `implement` / `fetchEndpoint` — `@plugins/infra/plugins/endpoints/{core,server,web}`
- `resourceDescriptor` / `useResource` / `defineResource` — `@plugins/primitives/plugins/live-state/{core,web}` and `@plugins/framework/plugins/server-core/core`
- `rankText` (if ordering needed) — `@plugins/primitives/plugins/rank/core`
- `compile`, `scoreEndBeat`, `beatToSeconds`, `Score` — sonata `…/sources/plugins/midi/web` and `…/sonata/plugins/score/core`
- `db` — `@plugins/database/server`

## Verification

1. `./equin build` (regenerates migrations for `sonata_songs` + the attachments link
   table, regenerates the plugin registry, seeds starters on boot). Confirm no check fails.
2. Open `http://<worktree>.localhost:9000/sonata` → lands on the **Library** with the 3
   bundled starter cards (title, composer, mm:ss). No bare piano roll.
3. Click a starter → enters the **streamlined player** (← Library, title, transport, roll;
   no source picker / dropzone). Press Play → notes fall and audio plays.
4. ← Library → Import a real `.mid` file → it saves, appears as a card, and auto-opens.
5. Reload the page → the imported song is **still in the library** (persistence works; no
   re-selection). Delete a card → it disappears for all open tabs (live resource push).
6. DB check: `mcp__singularity__query_db` → `select id,title,midi_attachment_id from sonata_songs;`
   and confirm matching rows exist in `sonata_songs_attachments` (orphan-sweep safe).
7. Scripted check with `e2e/screenshot.mjs --click` to confirm a card opens the player and
   Play toggles `aria-pressed` / playing state.

## Out of scope / follow-ups

- Multi-source songs (persisting chord-grid JSON alongside MIDI). `setRawMap` already
  supports the restore; storage model would extend to per-source raw.
- URL-backed deep links (`/sonata/song/:id`) via the pane system — v1 uses in-app view state.
- In-player "Save to library" for ad-hoc dropped MIDI (v1 routes adds through library Import).
- Cover art / tags / search & sort on the library grid.
