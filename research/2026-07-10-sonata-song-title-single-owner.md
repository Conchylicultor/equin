# Sonata: give the song title a single owner (fix the deep-link "Untitled" data loss)

## Context

**The bug.** Deep-link to `/sonata/song/:id` for a chord-grid song titled `"7th"`, type one
character in the Chord Grid textarea, and ~500ms later the song's title in `sonata_songs` is
`"Untitled"`. The real title is gone, with no warning. Opening the same song from the Library
gallery does not reproduce.

**Why.** `sonata_songs.title` is canonically owned by the **library** plugin (it lives in the DB
and streams through `songsResource`). But the **shell**'s `SonataContext` keeps a *second copy*
of it — `currentSongTitle` — and that copy is seeded from a pane `input` hint rather than from
the canonical resource:

```ts
// library/web/panes.tsx:140  — the player surface's mount effect
setCurrentSong({ id: songId, title: input.title ?? "Untitled" });
```

`input.title` is an **optimistic display hint**, populated only when something calls `openPane`
with `input: { title }` — i.e. from `useOpenSong` (gallery cards) and `openSongImperative`
(source create affordances). A direct URL navigation constructs the pane from the URL segment
alone, so `input.title` is `undefined` and the context is seeded with the literal string
`"Untitled"`.

That copy is then read at a **write** site as if it were authoritative:

```ts
// sources/chord-grid/web/components/chord-grid-editor-section.tsx:50
const title = currentSongTitle ?? "Untitled";
// …debounced 500ms…
fetchEndpoint(updateChordGridSong, { id }, { body: { title, chordText, durationSec, endBeat } });
```

and the endpoint has no way to refuse it — `UpdateChordGridSongBodySchema` declares
`title: z.string()` as **required**, so the server cannot distinguish "the user renamed this
song to Untitled" from "the client never knew the title". `updateSongMeta` dutifully writes it.

**Three failures stacked**, each of which alone is enough to lose data:

1. **A mirror that can be unhydrated.** The shell context mirrors server state it does not own.
   Its "I don't know the title yet" state is representable and reachable.
2. **An absorbable value at a write boundary.** Two `?? "Untitled"` fallbacks turn "unknown" into
   a legitimate-looking value. This is precisely the failure the repo's
   [absorbable-failure guardrail](2026-07-08-global-absorbable-failure-guardrail.md) forbids —
   the live-state twin, `no-pending-data-collapse`, bans the same shape for `ResourceResult`.
3. **A full-snapshot write for a partial edit.** A *chord-text* edit ships the *title*. The
   endpoint's shape makes "don't touch the title" inexpressible.

The instance fix is one line in `panes.tsx`. The structural fix is to **delete the mirror**: the
title has exactly one owner (the library's `songsResource`), and the source editors stop writing
it. Then there is no unhydrated copy to absorb, and no title field on the chord-grid endpoint to
absorb it into.

**Blast radius today.** `currentSongTitle` / `renameCurrentSong` / `setCurrentSong` are used only
inside `plugins/apps/plugins/sonata/` (verified repo-wide). No live DB damage: `sonata_songs` in
both the `singularity` (main) and this worktree's DB have zero `Untitled`/empty titles. Nothing
to repair.

---

## Design

### The invariant

> Server-owned state has one client-side owner: its live-state resource. A convenience mirror of
> it may exist for *display*, but must never be a *write* source — and the cheapest way to
> guarantee that is not to have the mirror.

Concretely: the shell context stops carrying a title. It carries the song **identity**
(`currentSongId`) and the **open epoch**. Anything that wants the title reads `songsResource`.

This is layering-clean. `shell` cannot import `library` (that would cycle — `library → shell`
already exists for `useSonata`), so the shell has no business holding library-owned data in the
first place. Every consumer that needs the title (`library`'s toolbar + now-playing bar,
`chord-grid`'s editor, `ultimate-guitar`'s editor) **already imports `library`**, so they can all
read `songsResource` directly.

### Where the title becomes editable

Today the rename affordance is a `<input>` buried in the chord-grid editor card — which means
MIDI songs cannot be renamed from the player at all, and the UG editor has to keep a parallel
in-memory sync path. Title is *generic, source-agnostic song metadata*; its editor belongs in the
library, next to the other generic metadata.

Move it to the **player toolbar title** (`SonataToolbar.Start` "title", already owned by library)
as an inline-editable field — the Notion / `PageHeader` pattern this repo already uses. One
rename affordance, present for every source, on the surface where the song's name is displayed.

Precedent to mirror byte-for-byte: `plugins/apps/plugins/pages/plugins/page-tree/web/components/page-header.tsx`
— `ResourceView` gates the mount, so `useEditableField` is only ever *seeded from settled data*
(the sanctioned "never autosave from a not-yet-loaded value" guard), and `useEndpointMutation`
PATCHes on debounce. It also gets sync-status ("Saving…/Saved") for free via `useEditableField`.

### Why the endpoint change matters independently

Even with a correct context, `updateChordGridSong` taking a required `title` means *any* future
autosave bug re-opens the same data-loss path. Dropping `title` from that body makes the class of
bug unrepresentable: a chord-grid save physically cannot carry a title.

`updateUltimateGuitarSong` **keeps** its title (`tab.songName`) — for a UG song the fetched tab
genuinely *is* the title's source of truth, and that value is never a fallback. The distinction
is exactly right: UG *derives* the title from imported data; chord-grid does not derive it at all.

---

## Changes

### 1. `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` — delete the mirror

- Remove `currentSongTitle: string | null` from `SonataContextValue`, its `useState`, and both
  memo dep arrays.
- Remove `renameCurrentSong`.
- Narrow `setCurrentSong: (song: { id: string; title: string }) => void`
  → `setCurrentSong: (songId: string) => void`. The `{id, title}` shape is what *invited* the
  fabrication; a bare id cannot be fabricated.
- `clearCurrentSong()` keeps clearing `currentSongId` (+ epoch semantics unchanged).
- Update the doc comments (they currently promise a title).

Also update `plugins/apps/plugins/sonata/plugins/shell/CLAUDE.md` ("It keeps the open-song state
(`currentSongId`/`currentSongTitle`/`songOpenEpoch`)").

### 2. `plugins/apps/plugins/sonata/plugins/library/web` — the title's single owner

**New `web/use-current-song.ts`**

```ts
/**
 * The canonical row for the song currently open in the player, straight from
 * `songsResource`. `pending` while the resource loads; `null` when no song is
 * open, or the open id is not in the list. THE read path for the open song's
 * title — the shell context deliberately keeps no copy.
 */
export function useCurrentSong(): ResourceResult<Song | null>
```

Implemented as `useResource(songsResource)` + a `useMemo` find on `currentSongId`, preserving the
`pending` discriminant (never collapse — `no-pending-data-collapse`).

**New `web/components/song-title-field.tsx`** — the inline-editable toolbar title.

- `SongTitle()` reads `useCurrentSong()`, returns `null` when no song is open, renders
  `<Loading variant="text"/>` while pending (via `matchResource`), and otherwise mounts
  `SongTitleInner({ song })` — so `useEditableField` is only ever seeded from a settled title.
- `SongTitleInner` = `useEditableField({ value: song.title, label: "Song title", onSave })` +
  `useEndpointMutation(updateSong)` → `PATCH /api/sonata/songs/:id` with `{ title: next }`.
- Chrome: a borderless input that reads as text until interacted with —
  `bg-transparent border border-transparent hover:border-border focus:border-primary rounded-md`,
  `font-semibold text-body`, `px-sm`, matching `control-*` height. Blank input is allowed
  locally (you must be able to clear it to retype) but `onSave` **skips the write when the
  trimmed draft is empty** — an empty title is not a rename, and re-mounting re-seeds from the
  canonical value. Placeholder `Untitled` is display-only.
- Replaces the current `SongTitle` in `components/player-toolbar-items.tsx` (delete it there;
  keep `BackToLibrary` / `DisplayPicker`). Re-point the barrel import.

**`web/components/now-playing-bar.tsx`** — drop `currentSongTitle ?? "Untitled"`. Read
`useCurrentSong()`; render nothing until a song row is available (the bar is already conditional
on `currentSongId`); the "Open in player" click passes the real `song.title` as the optimistic
`input.title`.

**`web/panes.tsx`**
- `setCurrentSong(songId)` — the `?? "Untitled"` is gone with the parameter.
- `input: type<{ title: string }>()` **stays** — it remains a legitimate optimistic hint for
  `useTitle` (the browser tab / tab-strip label before `songsResource` settles). Add a comment
  saying so explicitly, so nobody promotes it back into a data source.

**`web/use-playback.ts`** — `setCurrentSong(song)` → `setCurrentSong(song.id)`.

**`web/index.ts`** — export `useCurrentSong` (consumed by both source editors).

### 3. `plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid` — stop writing the title

- **`shared/endpoints.ts`**: drop `title` from `UpdateChordGridSongBodySchema`
  (`{ chordText, durationSec, endBeat }`). Rewrite the doc comment: this endpoint persists the
  grid + its **derived** metrics; the title is generic metadata owned by the library and patched
  through `PATCH /api/sonata/songs/:id`. `createChordGridSong` keeps `title` (creation supplies it).
- **`server/internal/routes.ts`**: `handleUpdateChordGridSong` calls
  `updateSongMeta({ id, durationSec, endBeat })` — no `title`. (`updateSongMeta` already skips
  `undefined` keys.)
- **`web/components/chord-grid-editor-section.tsx`**: delete the title `<input>`, the
  `currentSongTitle`/`renameCurrentSong` reads, and `title` from the save body + effect deps.
  The card becomes purely the `ChordGridLoader`. Update the component doc comment.

### 4. `plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar` — drop the mirror sync

`web/components/ug-editor-section.tsx`: remove `currentSongTitle` / `renameCurrentSong` and the
`if (currentSongTitle !== tab.songName) renameCurrentSong(...)` line. The PUT still persists
`title: tab.songName`; the DB change-feed pushes `songsResource`, and the toolbar title updates
live from the canonical row — no in-memory sync needed. Update the doc comment (it currently
explains the `renameCurrentSong` sync).

### 5. Docs

Regenerated by `./equin build` (`plugins-doc-in-sync`), plus the hand-written prose edits
in `shell/CLAUDE.md` and `library/CLAUDE.md` (the latter documents `SongTitle`).

---

## What this does *not* do

- **No new lint rule.** The repo already has `no-pending-data-collapse` (live-state) and
  `no-absorbed-failure` (promise-safety). Neither would have caught this, because the absorbed
  value came from a *pane input hint*, not a `ResourceResult` or a `catch`. Generalising either
  rule to "any `?? <literal>` feeding a fetch body" would be a heuristic with a bad false-positive
  rate. The right fix here is the one taken: remove the mirror, and remove the field from the
  endpoint. Both make the bug *unrepresentable* rather than *detected*.
- **No data repair migration.** Verified: zero damaged rows in `singularity` and in this
  worktree's DB.

---

## Verification

1. `./equin build` (regenerates docs/registry; runs checks).
2. `./equin check` — `type-check` proves every `currentSongTitle` / `setCurrentSong({…})`
   consumer was updated (the narrowed signature makes a missed call site a compile error).
3. **The repro, end-to-end**, scripted with Playwright (`e2e/screenshot.mjs` as a base):
   - `query_db`: note the title of the chord-grid song `283ac814-…` (`"7th"`).
   - Navigate directly to `http://<worktree>.localhost:9000/sonata/song/283ac814-…`.
   - Assert the toolbar shows `7th`, **not** `Untitled` (this alone proves the hydration fix).
   - Type a character into the Chord Grid textarea; wait > 1s.
   - `query_db` again: `title` is still `"7th"`, and `chord_text` reflects the edit.
4. **Rename still works, from the toolbar**: click the title, type `7th (edited)`, blur, wait,
   `query_db` confirms the new title; the Library gallery row reflects it live.
5. **Rename works for a MIDI song too** (new capability): deep-link a MIDI song, rename, verify.
6. **Empty title is refused**: clear the title input entirely, blur → `query_db` shows the title
   unchanged.
7. **Gallery path unregressed**: open `7th` from the Library gallery, edit the grid, confirm the
   title survives.

## Files touched

| File | Change |
| --- | --- |
| `shell/web/context.tsx` | remove `currentSongTitle` + `renameCurrentSong`; `setCurrentSong(songId)` |
| `shell/CLAUDE.md` | prose: context no longer holds the title |
| `library/web/use-current-song.ts` | **new** — canonical open-song row |
| `library/web/components/song-title-field.tsx` | **new** — inline-editable toolbar title |
| `library/web/components/player-toolbar-items.tsx` | drop `SongTitle` |
| `library/web/components/now-playing-bar.tsx` | read canonical title |
| `library/web/panes.tsx` | `setCurrentSong(songId)`; comment `input.title` as display-only |
| `library/web/use-playback.ts` | `setCurrentSong(song.id)` |
| `library/web/index.ts` | export `useCurrentSong`; re-point `SongTitle` |
| `library/CLAUDE.md` | prose: title ownership |
| `sources/chord-grid/shared/endpoints.ts` | drop `title` from the update body |
| `sources/chord-grid/server/internal/routes.ts` | stop syncing the title |
| `sources/chord-grid/web/components/chord-grid-editor-section.tsx` | drop the title input + payload |
| `sources/ultimate-guitar/web/components/ug-editor-section.tsx` | drop the in-memory title sync |
