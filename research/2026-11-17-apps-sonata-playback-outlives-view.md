# Sonata playback that outlives its view

Follow-up of `2026-11-17-music-background-music-service-v2.md` (§ Follow-up), asked by the user.

## Context

Sonata's whole playback lives in `SonataPlayerScope` (`apps/sonata/plugins/player/web/scope.tsx`): the cursor store,
the song document, `PlaybackSession`, the `SonataSession.Provider` wrappers (audio store, live-play, recording) and
`SonataSession.Effect`s (audio engine with its `AudioContext` and ~500 MB of decoded samples, metronome, live play).
`SonataLayout` mounts it around the app surface, so when the surface unmounts — a rail switch in a maximized tab, the tab
made non-resident, a desktop window closed — the song stops. With *Keep playing across apps* on, the user expects it to
keep playing, to control it from the music button, and to find the same player (position, no reload, no gap) on coming
back.

What exploration established:

- The playback half reads **one** context from the view's location: `KeepScope` (`useKept(keptPlayhead / keptTempo)` in
  `session.tsx`). Everything else is page-level (transport, live-state, plugin registry, config) or provided by the
  scope itself. `PlayerViewProvider` and `ShownEffects` (`SonataPlayer.Effect`: keyboard transport, seek hold — reads
  `useSurfaceTabId`) are view-side.
- The view reads the scope through 7 contexts: cursor scoped store, `SessionContext`, `loadedSongStore`,
  `SongDocumentContext`, and the wrappers' audio store, live-play store, `RecordingContext`.
- A Sonata surface's stable identity is its **tab id** (`useSurfaceTabId()`): it survives a rail switch away and back,
  residency unload and reload; a desktop window is a set of member tabs, each with its own surface.
- `render-origin` already hosts content away from its caller: `useRenderOrigin().raise(node)` renders `node` at the
  nearest origin — the page's `Core.Root` normally, an `AppEmbed` / `DemoScope`'s own inside those — under that place's
  transport and registry, until `remove()`. That is exactly the lifetime a playback instance needs (an embedded Sonata's
  instance dies with its embed, as it should).
- Re-attaching to an instance that already holds the song triggers no load (`SonataPlayerSurface` only mounts
  `SongLoader` when the loaded song differs). `useBarSeek`'s pane-local `placedForRef` would re-seek a `;bar=N` URL.

## Design

### 1. `primitives/scope/plugins/context-relay` (new, web)

Re-provides contexts captured in one place of the tree in another — the bridge between a raised host and its view.

```ts
relayOf(context)                 // Relayed<T>: an opaque, declared token (only the owner can mint one for its context)
createRelayLink()                // RelayLink: the captured values, an external store
<RelayCapture link relays/>      // host side: reads each relay with use(context), publishes in a layout effect
<RelayProvide link fallback>     // view side: useSyncExternalStore on the link, nests each context's Provider;
                                 //   renders `fallback` (primitives/loading) until the first capture
```

Owners publish tokens for their contexts — never the context object itself:

- `scoped-store`: `ScopedStoreHandle.relay` — one for every scoped store (cursor, loaded song, audio, live-play).
- `session`: `sessionRelays` (session context + cursor store).
- `document`: `documentRelays` (`SongDocumentContext` + `loadedSongStore`).
- `SonataSession.Provider` contributions gain a **required** `relays: Relayed[]` field (`defineWrapperSlot<P>`'s extra
  props): audio → `[audioStore.relay]`, live-play → `[store.relay]`, recording → `[recordingRelay]`. A wrapper that
  forgets its relay is a tsc error, not a view that throws "outside its Provider".

### 2. Player: the playback instance (`apps/sonata/plugins/player/web`)

Split `scope.tsx` into:

- **`PlaybackHalf`** — `CursorStoreProvider > SongDocumentProvider > DocumentSession > SonataSession.Provider.Wrap`
  with `SonataSession.Effect.Mount`, `SongSettingsMount`, the host's `effects` and the music link (§3).
- **`ViewHalf`** — `PlayerViewProvider` with `ShownEffects` and the host's children.

`SonataPlayerScope` keeps its API and gains one optional prop:

```tsx
<SonataPlayerScope>{…}</SonataPlayerScope>                         // local, as today (mini-player): halves nested
<SonataPlayerScope instance={{ key, effects }}>{…}</SonataPlayerScope> // page-level instance
```

With `instance`, the view attaches to a module-level **instance registry** (`internal/instances.ts`), keyed by `key`:

- `attach(key, origin, keepPath)` — raises `<KeepScopePath path={keepPath}><PlaybackHalf>…<RelayCapture/></PlaybackHalf>`
  at `origin` the first time; returns the instance's `RelayLink`. The view renders `<RelayProvide link><ViewHalf/>`.
- `detach(key)` — the last view leaving: if the session is playing, offer it to the background music service (§3); kept
  → the instance lives on as the **background instance**; otherwise `remove()` it (as today: the song stops, the kept
  playhead restores the position, paused, next time). Removal is deferred a microtask so a StrictMode / remount re-attach
  cancels it.
- One background instance per page: a new one pauses and disposes the previous. A background instance with no view is
  disposed when it stops being the service's current music (stopped, replaced by Isle).
- Re-attaching to the background instance makes it foreground again (it leaves the service, keeps playing, nothing
  reloads).

`kept-state` gains `KeepScopePath({ path })` (re-provides a captured `useKeepScope()` path), so the raised half keeps
writing the playhead and tempo under the tab's `t:<tabId>` place — reloads still restore it.

`SonataLayout` passes `instance={{ key: useSurfaceTabId(), effects: <Sonata.PlaybackEffect.Mount/> }}`; the
mini-player stays local (a preview's music ends with the preview).

### 3. Background music: Sonata as a source

`music/background` additions (reducer + tests in `shared/protocol.ts`):

- Event `adopt { sourceId, acrossApps }`: music an app played in its view, outliving the view — becomes `current`
  (playing, a claim to the other browser tabs) when the user keeps music across apps; unchanged otherwise. Handle:
  `useMusicSource(id, …).adopt(): boolean` (answers whether it was kept).
- Source contract: optional `useAvailable` (Sonata is listed only while it has a background instance) and
  `ownVolume: true` (the panel hides the device slider for it and `gain` is not applied — Sonata keeps its master volume;
  forcing the service's 0.6 default on a song would be a jump on hand-off).

Player: a per-scope **music link** replaces `audio/engine`'s `BackgroundMusicYield` (the yield is a playback-lifecycle
concern; left in the engine it would pause the background instance itself the moment it resumes):

- foreground (local scope, or an attached instance): `useForegroundMusic(isPlaying)` — as today.
- background instance: two-way, edge-triggered sync with the service — service `playing` changes (popover, remote
  claim, Sonata starting in another tab) → session play / pause; session `isPlaying` changes (song end) → service
  pause / resume; no longer `current` → pause and dispose.

The shell contributes `BackgroundMusic.Source({ id: "sonata", app: sonataApp, kind: "Song", useTitle, usePlayer,
useAvailable, ownVolume: true })`; `usePlayer({ playing })` drives the background instance through the registry;
`useTitle` reads the title the instance publishes (a `Sonata.PlaybackEffect` calling `useCurrentSong` →
`usePublishPlaybackTitle`).

### 4. App-level effects that must follow the playback

New shell slot `Sonata.PlaybackEffect` (app-only, mounted with the instance — at the page root while it is in the
background). Moved from `Sonata.Effect` (verify each reads only session / document / page contexts):
`record-play` (else a re-attach records a second play), `ug-recording-video` (the recording claim is the transport
driver), `loop-options`, `ug-alignment-sync`, `chord-grid-persist`, `ultimate-guitar-persist`. Staying in `Sonata.Effect`
(view keyboard shortcuts): `tempo-shortcuts`, `loop-shortcuts`. `Sonata.Provider` (library background play) stays in
the view: a play requested while hydrating is dropped if the view leaves first.

`useBarSeek` is left as is: re-opening the player on a `;bar=N` route seeks to that bar by design ("a song opened
while already loaded … seeks to the URL's bar"), and the rail brings Sonata back at its library, not the player.

Implementation note: `RelayCapture` opts out of the React Compiler (`"use no memo"`) — compiled, its loop of
`use(context)` was memoized on the relay set and the view kept the first captured values.

## Behaviour

| Situation | Result |
|---|---|
| Maximized, playing, rail switch away — across-apps on | keeps playing; music button shows "Song · Sonata", pause / resume / stop; Isle's auto-play gives way |
| … across-apps off | stops (as today); coming back restores the position, paused |
| Rail back to Sonata in that tab | same instance: still playing, no reload; leaves the music button |
| Desktop: two Sonata windows | both play (both shown, foreground); closing one while playing hands it to the background, pausing any previous background instance |
| Another browser tab plays (service music or a Sonata song) | the background instance pauses |
| Tab closed while backgrounded | plays on; disposed when stopped or replaced |

## Verification

- bun: `protocol.test.ts` — `adopt` with across-apps on / off, a remote claim pausing an adopted source.
- bun: instance registry — attach / detach / re-attach cancels removal, background hand-off, one background instance,
  dispose when no longer current.
- vitest: `context-relay` (values follow the host, fallback until captured); the music panel hides the slider for an
  `ownVolume` source and lists only available sources.
- `./equin check`, `./equin test` on the touched plugins.
- Manual on the build (browser MCP): play a song → rail to Isle (music button shows it, audio continues, position
  advances) → pause / resume from the popover → rail back (same position, playing) → toggle across-apps off and repeat
  (stops); desktop two windows; second browser tab claim.
