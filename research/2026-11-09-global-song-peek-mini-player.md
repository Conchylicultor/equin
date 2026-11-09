# Song peek pane, a shared Sonata mini player, and pane-only id chips

Task: task-1794184870-9534jc.

## Context

Clicking a song id chip in a transcript (e.g. "ii–V–I warm-up") opens Sonata
full-screen instead of a column beside the conversation. Of the nine
`IdKinds.Presenter` contributions, song is the only one whose `useTarget` is an
app navigation:

- `active-data/song/web/internal/presenter.ts` calls `useAppLink()(sonataPlayerRoute.link(…))`.
- The other eight (task, attempt, conv, page-link, report, build-run, prototype,
  event-source) push a pane, or toggle one.

Inside `/demo`, the embed's nav boundary answers the app link, so the whole
embedded surface switches app.

Two causes:

1. **No pushable view of a song exists.** The player (`sonataPlayerPane`) is a
   full-surface `mode: "root"` pane.
2. **The slot allows it.** `IdPresenter.useTarget` returns any `LinkTarget`.

The user also wants the file explorer's MIDI preview
(`sonata/sources/midi/file-preview`) and the new song side pane to share one
mini-player primitive.

## Design

### 0. Prototype first: proto-1794188835-xbk4u1

The look comes from the immersive player's theme (proto-1792113547-2qr6g7). The
split of ownership:

- **The host owns its header row, in its own theme.**
  - Files: the file name, then path · size · date.
  - The peek pane: the pane chrome, the title, its Expand **Open in Sonata**,
    and close.
- **Everything below it is Sonata's immersive player, scaled down**, in
  Sonata's night theme (the content region wears Sonata's theme scope, not the
  host app's).
  - **No head band:** the notes fill the region, falling onto a keyboard fitted
    to the song's range (at least two octaves), with chord tags in their degree
    colours.
  - **Title on the stage:** it sits straight on the notes, over a fade. Under it
    is one quiet line, the key and the tempo, and nothing else. The full facts
    list is dropped.
  - **Glass floats over the notes:** a glass **Open in Sonata** pill (files
    host; in the peek it is the pane's Expand), and one glass transport: play,
    time, a sections timeline with a loop band, loop, speed, volume.

- **Files:** the explorer's header row is the only header, with the standard
  Expand (Open in Sonata) beside present and close.
  - Nothing of the player is in it: no speed, no volume, no song title on the
    stage, because the header already names the file.
  - The FileViewer host header needs an Expand that a renderer can declare.
    Today the MIDI renderer draws its own button.
- **Peek is immersive, like the agent manager's prototype pane.**
  - The pane is a floating rounded card on the app's backdrop, and the song
    fills all of it.
  - Its chrome is drawn in Sonata's own design: the title (+ key · tempo) sits
    straight on the notes, at the left.
  - The pane's actions are one glass bar at the right, in the Sonata player's
    toolbar style (Expand, close). It is not a capsule around the title.
  - The transport floats under them.
  - This needs the pane chrome to let a pane draw its header in its own style
    (a chromeless / floating chrome mode).
- **Variant `tools` (peek only):** speed and volume either stay in the
  transport (`bar`) or join the glass action bar (`header`).

The prototype's options:

| Option | Values |
|---|---|
| `host` | `files` \| `peek` |
| `transport` | `top` (under the title, as in the immersive player) \| `bottom` (just above the keyboard) |
| `tools` | `bar` \| `header` (peek only) |
| `glow` | |
| `accent` | |

The implementation follows the reviewed prototype pixel-perfect, so §1's layout
details are its, not the current preview's.

### 1. `apps/sonata/plugins/mini-player` (new, web)

The MIDI preview's `PlayerPreview` body is moved out into a reusable component:

```tsx
<SonataMiniPlayer
  identity={SongIdentity}        // {kind:"file",key} | {kind:"library",songId}
  rawMap={Record<sourceId, raw>} // what useLoadDocument takes
  title={string}
  leading?={ReactNode}            // defaults to the music-note tile
  extraFacts?={MiniFact[]}        // e.g. the file's size
  action?={ReactNode}             // e.g. the file preview's Open in Sonata
/>
```

**What the component owns.** The behaviour is today's, unchanged, so the MIDI
preview reads the same:

- its own `SonataPlayerScope`, keyed per identity;
- a `useLoadDocument` once;
- one `Loading` until `usePlayerView().drawn`, then reveal and `play()` once
  (the layout-effect ordering kept);
- a compose-failure placeholder;
- the header: leading tile, title, facts `Cluster`, action;
- the body: `PlayerDisplay displayId="piano-roll"` in the rounded clip;
- the footer: `PlayerTransport`.

**Facts.** `midiFacts` → `scoreFacts(score)` (BPM, meter, bars, tracks · notes,
range), moved here with `pitchLabel`. Duration comes from the score's end too.
Size stays in the file preview, as an `extraFacts` entry with `formatBytes`.

**File preview.** It shrinks to: read bytes → parse (`deriveMidiSongMeta`) →
`<SonataMiniPlayer identity={{kind:"file",key}} rawMap={{[MIDI_SOURCE_ID]: bytes}} … action={<OpenInSonata/>}/>`.
Its e2e scripts (`open-in-sonata-verify`, `keyboard-verify`) must keep passing
as-is.

### 2. `apps/sonata/plugins/song-peek` (new, web)

**The pane.**
`songPeekPane = Pane.define({ route: defineRoute({ id: "sonata-song-peek", segment: "song-peek/:songId" }), app: sonataApp, width: 480, … })`.

- **Title:** `useText` is the song's title from `useLive(songLibrary, { id })`.
- **Expand:** `expand: { app: sonataApp, useTarget }`. It answers
  `{ kind: "ready", target: appLink(sonataSongLink(songId)) }`, the same shape
  as `filePeekPane`'s `useExpandToFiles`.
  - The pane chrome draws **Open in Sonata**, and the pane→app morph runs.
  - This is the one sanctioned way out to the full app.
- **Body:**
  - gates on `useDeferredLoadComplete()` (sources are deferred);
  - hydrates through the library's `SongHydrator` (render the pending sources'
    `Body`, as `SongLoader` does);
  - renders `<SonataMiniPlayer identity={{kind:"library",songId}} rawMap={h.rawMap} title={song.title} leading={<SongCover…/>}/>`.
- **Boot cost:** the body is a `lazyComponent`, so the pane object the chip
  imports costs nothing at boot.
- **Library exports:** the library barrel exports what the peek needs and does
  not export today: `SongHydrator` and `SongCover` + `resolveSongCover`
  (currently internal). That is cleaner than re-implementing them.

**A library document, on purpose.** It is the same song, so its per-song
settings apply, and the user's edits land on the song: transpose, speed and
mixer are shared with Sonata. A play there records a play
(`playback-history`'s `Sonata.Effect`), which is the truth: they listened.

**The chip.** The song presenter points at
`paneTarget(songPeekPane, { songId: songIdKind.key(id) })`.

### 3. Narrowing `IdPresenter`: pane-only targets

**Pane primitive (`primitives/pane/web`):**

- `PaneTarget`: an existentially-erased `{ pane, params }`, built only by
  `paneTarget(pane, params)` (tsc-checked params).
- `usePaneTargetLink(target): LinkTarget`:
  - a `push` beside the surface holding it;
  - a **toggle**: a second click closes the column that this surface opened for
    the same pane + params (via `pane.useOpenedHere()` + `pane.close`).
  - Today that is conv/attempt's behaviour; it becomes every chip's.

**`IdPresenter`.** `useTarget: Hook<(id) => LinkTarget>` → `usePane: Hook<(id) => PaneTarget>`.

- `genericIdChip` turns it into a link through `usePaneTargetLink`, so a
  presenter cannot spell an app navigation or a root open (rung 2: type).
- Every presenter returns `paneTarget(…)`:
  - **page-link:** page vs block.
  - **attempt:** the first conversation, else the attempt pane.
- Their bespoke chips (`page-link-chip`, `attempt-chip`) go through the same
  hook.

**Conversations.** `useConversationOpener().toggle` is rebuilt on
`usePaneTargetLink`, so there is one toggle implementation.

**Unchanged.** Stranding stays as it is: a push with no host surface (global
chrome) heads the route and is sent to its home app. For the song peek that
home is Sonata, which is correct there.

## Files

**New**
- `plugins/apps/plugins/sonata/plugins/mini-player/web/{index.ts,components/mini-player.tsx,facts.ts}`
  - plus `facts.test.ts`, moved from the file preview.
- `plugins/apps/plugins/sonata/plugins/song-peek/web/{index.ts,panes.tsx,components/song-peek-body.tsx}`

**Edited**
- `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/file-preview/web/components/midi-file-preview.tsx`
  and its `CLAUDE.md`; drop its `facts.ts`.
- `plugins/apps/plugins/sonata/plugins/library/web/index.ts`: export
  `SongHydrator`, the cover.
- `plugins/primitives/plugins/pane/web/pane.ts` + `index.ts`: `PaneTarget`,
  `paneTarget`, `usePaneTargetLink`.
- `plugins/ids/web/slots.ts`: `usePane`.
- `plugins/active-data/plugins/id-chip/web/components/generic-id-chip.tsx`
  (+ the `id-chip.ts` docs).
- The nine presenters under `plugins/active-data/plugins/*/web`.
- `plugins/conversations/plugins/conversation-view/web/use-conversation-opener.ts`.

## Verification

- **Static:** `./equin check` (type-check, boundaries, plugin docs, tiers).
- **Tests:** `./equin test` on `primitives/pane` (a toggle test beside
  `promote-control-expand.test.tsx`), `active-data`, `sonata/mini-player`.
- **Deploy:** `./equin build`.
- **Song chip, in my build:** `/demo` and an agent-manager conversation with a
  song id.
  - Clicking the chip opens a peek column beside the transcript: cover, title,
    facts, piano roll, transport, autoplay.
  - Open in Sonata goes to the player.
  - A second click closes the column.
- **File preview, unchanged:** a `.mid` in Files reads as before. Run
  `open-in-sonata-verify.ts` and `keyboard-verify.ts`.
- **Other chips:** task, conv and page chips still open their panes; conv still
  toggles.

## As built (differences from the plan above)

- **The peek pane lives in the Sonata library** (`songPeekPane` in
  `library/web/panes.tsx`, body `components/song-peek.tsx`), not in its own
  `song-peek` plugin. The library already owns the player pane and the song
  hydrator, so nothing internal had to be exported.
- **`usePaneToggle()` returns a toggle function** (`(target) => LinkTarget`),
  so the conversation opener (`toggle(convId)`) shares it. Its close goes to the
  surface's own store (an embed's included).
- **New in `pane/web`: `PaneEndControls`**, the header's Expand + close,
  shared by `PaneChrome` and by a pane drawing its own header (the peek).
- **New in `file-viewer/web`: `FileHeaderActions` / `FileHeaderAction`**.
  - A renderer's header actions are portaled into the host's header, while
    staying in the renderer's tree.
  - `FileContent` now takes the renderers handle, so a host cannot forget to
    pass it.
- **The peek's subtitle is the composer** (as in the full player's header),
  not "key · tempo". The key names live privately in `progress/keys`.
- **Speed and volume:** in the peek they join the glass pill
  (`songPeekPane.Actions`, reorder config
  `config/apps/sonata/library/sonata-song-peek.actions.jsonc`). Files has
  neither, as decided after the prototype.
- **The keyboard is still the roll's full 88 keys.** The prototype's
  keyboard fitted to the song's range is a piano-roll feature (follow-up).

## Follow-ups (not in this change)

- Open in Sonata from the peek at the playhead's bar. The pane chrome sits
  outside the player scope, so it needs the scope's cursor exposed to `expand`.
- The trace chip still navigates to Debug (declined for now).
- The piano roll fitted to the song's range (the prototype's keyboard), for
  narrow hosts.
- "key · tempo" under the peek's title: move `longKeyName` to `score/core`.
